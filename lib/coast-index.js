'use strict'

const fs = require('fs')
const path = require('path')
const zlib = require('zlib')
const { VectorTile } = require('@mapbox/vector-tile')
const { PbfReader } = require('pbf')
const { PMTiles } = require('pmtiles')
const {
  bearingTrue,
  distanceToSegmentMeters,
  expandBboxMeters,
  pointInBbox
} = require('./geo-distance')

const DEFAULT_DATA_PATH = path.join(__dirname, '..', 'data', 'coast-db', 'mediterranean')
const FALLBACK_DATA_PATH = path.join(__dirname, '..', 'data', 'rough-antibes-v1.json')
const TILE_CACHE_LIMIT = 64
const DEFAULT_PMTILES_LAYER = 'coastline'

function loadCoastIndex (dataPath = DEFAULT_DATA_PATH, options = {}) {
  const resolvedPath = path.resolve(dataPath)
  if (!fs.existsSync(resolvedPath) && dataPath === DEFAULT_DATA_PATH) {
    return loadCoastIndex(FALLBACK_DATA_PATH, options)
  }
  const stat = fs.statSync(resolvedPath)
  if (stat.isDirectory()) {
    return loadTiledCoastIndex(path.join(resolvedPath, 'manifest.json'))
  }
  if (path.basename(resolvedPath) === 'manifest.json') {
    return loadTiledCoastIndex(resolvedPath)
  }
  if (path.extname(resolvedPath).toLowerCase() === '.pmtiles') {
    return loadPmtilesCoastIndex(resolvedPath, options.pmtiles || options)
  }

  const data = JSON.parse(fs.readFileSync(resolvedPath, 'utf8'))
  return createCoastIndex(data, resolvedPath)
}

function loadTiledCoastIndex (manifestPath) {
  const resolvedPath = path.resolve(manifestPath)
  const manifest = JSON.parse(fs.readFileSync(resolvedPath, 'utf8'))
  validateManifest(manifest)

  const baseDir = path.dirname(resolvedPath)
  const cache = new Map()
  const tiles = manifest.tiles.map((tile) => ({
    id: tile.id,
    bbox: tile.bbox,
    path: path.resolve(baseDir, tile.path),
    scale: tile.scale || manifest.scale
  }))

  return {
    name: manifest.name || 'coast-db',
    version: manifest.version,
    sourcePath: resolvedPath,
    findNearest: (position, options = {}) => findNearest(tiles, position, {
      ...options,
      loadSegments: (tile) => loadTileSegments(tile, cache)
    })
  }
}

function loadPmtilesCoastIndex (pmtilesPath, options = {}) {
  const resolvedPath = path.resolve(pmtilesPath)
  const source = new LocalFileSource(resolvedPath)
  const archive = new PMTiles(source)
  const cache = new Map()
  const headerPromise = archive.getHeader()
  const layerName = options.layerName || DEFAULT_PMTILES_LAYER
  const requestedZoom = Number.isInteger(options.zoom) ? options.zoom : null

  return {
    name: path.basename(resolvedPath),
    version: 'pmtiles',
    sourcePath: resolvedPath,
    findNearest: async (position, findOptions = {}) => {
      const header = await headerPromise
      const zoom = requestedZoom || header.maxZoom
      if (!isValidPosition(position) || zoom < header.minZoom || zoom > header.maxZoom) return null

      const searchRadiusMeters = numberOr(findOptions.searchRadiusMeters, 10000)
      const candidateTiles = tilesForSearch(position, searchRadiusMeters, zoom)
      let nearest = null

      for (const tile of candidateTiles) {
        const segments = await loadPmtilesTileSegments({ archive, cache, layerName, tile })
        for (const segment of segments) {
          const measurement = distanceToSegmentMeters(position, segment.start, segment.end)
          if (!nearest || measurement.distance < nearest.distance) {
            nearest = {
              distance: measurement.distance,
              closestPoint: measurement.closestPoint,
              bearingTrue: bearingTrue(position, measurement.closestPoint),
              tileId: `${tile.z}-${tile.x}-${tile.y}`
            }
          }
        }
      }

      if (!nearest || nearest.distance > searchRadiusMeters) return null
      return nearest
    }
  }
}

class LocalFileSource {
  constructor (filePath) {
    this.filePath = filePath
    this.size = fs.statSync(filePath).size
  }

  getKey () {
    return this.filePath
  }

  async getBytes (offset, length) {
    const handle = await fs.promises.open(this.filePath, 'r')
    try {
      const buffer = Buffer.alloc(length)
      const result = await handle.read(buffer, 0, length, offset)
      return { data: buffer.subarray(0, result.bytesRead).buffer.slice(buffer.byteOffset, buffer.byteOffset + result.bytesRead) }
    } finally {
      await handle.close()
    }
  }
}

async function loadPmtilesTileSegments ({ archive, cache, layerName, tile }) {
  const key = `${tile.z}/${tile.x}/${tile.y}`
  if (cache.has(key)) {
    const cached = cache.get(key)
    cache.delete(key)
    cache.set(key, cached)
    return cached
  }

  const tileResult = await archive.getZxy(tile.z, tile.x, tile.y)
  if (!tileResult) {
    cache.set(key, [])
    return []
  }

  const vectorTile = new VectorTile(new PbfReader(new Uint8Array(tileResult.data)))
  const layer = vectorTile.layers[layerName]
  const segments = []
  if (layer) {
    for (let i = 0; i < layer.length; i += 1) {
      const feature = layer.feature(i).toGeoJSON(tile.x, tile.y, tile.z)
      addGeoJsonSegments(segments, feature.geometry)
    }
  }

  cache.set(key, segments)
  while (cache.size > TILE_CACHE_LIMIT) {
    const oldestKey = cache.keys().next().value
    cache.delete(oldestKey)
  }
  return segments
}

function addGeoJsonSegments (segments, geometry) {
  if (!geometry) return
  if (geometry.type === 'LineString') {
    addCoordinateSegments(segments, geometry.coordinates)
  } else if (geometry.type === 'MultiLineString') {
    for (const line of geometry.coordinates) addCoordinateSegments(segments, line)
  } else if (geometry.type === 'GeometryCollection') {
    for (const child of geometry.geometries) addGeoJsonSegments(segments, child)
  }
}

function addCoordinateSegments (segments, coordinates) {
  for (let i = 1; i < coordinates.length; i += 1) {
    const start = coordinates[i - 1]
    const end = coordinates[i]
    if (!validCoordinate(start) || !validCoordinate(end)) continue
    segments.push({
      start: coordinateToPosition(start),
      end: coordinateToPosition(end)
    })
  }
}

function createCoastIndex (data, sourcePath = '') {
  validateData(data)
  const tiles = data.tiles.map((tile) => ({
    id: tile.id,
    bbox: tile.bbox,
    segments: tile.segments.map((segment) => ({
      start: coordinateToPosition(segment[0]),
      end: coordinateToPosition(segment[1])
    }))
  }))

  return {
    name: data.name || 'coast-index',
    version: data.version,
    sourcePath,
    findNearest: (position, options = {}) => findNearest(tiles, position, options)
  }
}

function findNearest (tiles, position, options = {}) {
  if (!isValidPosition(position)) return null

  const searchRadiusMeters = numberOr(options.searchRadiusMeters, 10000)
  const loadSegments = typeof options.loadSegments === 'function'
    ? options.loadSegments
    : (tile) => tile.segments
  const candidates = tiles.filter((tile) => {
    return pointInBbox(position, expandBboxMeters(tile.bbox, searchRadiusMeters))
  })

  let nearest = null
  for (const tile of candidates) {
    for (const segment of loadSegments(tile)) {
      const measurement = distanceToSegmentMeters(position, segment.start, segment.end)
      if (!nearest || measurement.distance < nearest.distance) {
        nearest = {
          distance: measurement.distance,
          closestPoint: measurement.closestPoint,
          bearingTrue: bearingTrue(position, measurement.closestPoint),
          tileId: tile.id
        }
      }
    }
  }

  if (!nearest || nearest.distance > searchRadiusMeters) return null
  return nearest
}

function loadTileSegments (tile, cache) {
  if (cache.has(tile.path)) {
    const cached = cache.get(tile.path)
    cache.delete(tile.path)
    cache.set(tile.path, cached)
    return cached
  }

  const raw = zlib.gunzipSync(fs.readFileSync(tile.path))
  const data = JSON.parse(raw.toString('utf8'))
  const scale = data.scale || tile.scale
  const segments = data.segments.map((segment) => ({
    start: scaledCoordinateToPosition(segment[0], segment[1], scale),
    end: scaledCoordinateToPosition(segment[2], segment[3], scale)
  }))

  cache.set(tile.path, segments)
  while (cache.size > TILE_CACHE_LIMIT) {
    const oldestKey = cache.keys().next().value
    cache.delete(oldestKey)
  }
  return segments
}

function validateData (data) {
  if (!data || data.version !== 1 || !Array.isArray(data.tiles)) {
    throw new Error('Unsupported coast index format')
  }

  for (const tile of data.tiles) {
    if (!tile.id || !Array.isArray(tile.bbox) || tile.bbox.length !== 4 || !Array.isArray(tile.segments)) {
      throw new Error('Invalid coast index tile')
    }
  }
}

function validateManifest (manifest) {
  if (
    !manifest ||
    manifest.version !== 2 ||
    !Number.isFinite(manifest.scale) ||
    !Array.isArray(manifest.tiles)
  ) {
    throw new Error('Unsupported coast tile manifest format')
  }

  for (const tile of manifest.tiles) {
    if (!tile.id || !Array.isArray(tile.bbox) || tile.bbox.length !== 4 || !tile.path) {
      throw new Error('Invalid coast tile manifest entry')
    }
  }
}

function coordinateToPosition (coordinate) {
  return {
    longitude: coordinate[0],
    latitude: coordinate[1]
  }
}

function scaledCoordinateToPosition (longitude, latitude, scale) {
  return {
    longitude: longitude / scale,
    latitude: latitude / scale
  }
}

function tilesForSearch (position, searchRadiusMeters, zoom) {
  const bbox = expandBboxMeters([
    position.longitude,
    position.latitude,
    position.longitude,
    position.latitude
  ], searchRadiusMeters)
  const topLeft = lonLatToTile(bbox[0], bbox[3], zoom)
  const bottomRight = lonLatToTile(bbox[2], bbox[1], zoom)
  const tiles = []
  for (let x = topLeft.x; x <= bottomRight.x; x += 1) {
    for (let y = topLeft.y; y <= bottomRight.y; y += 1) {
      tiles.push({ z: zoom, x, y })
    }
  }
  return tiles
}

function lonLatToTile (longitude, latitude, zoom) {
  const latRad = clamp(latitude, -85.05112878, 85.05112878) * Math.PI / 180
  const n = 2 ** zoom
  const x = Math.floor(((longitude + 180) / 360) * n)
  const y = Math.floor((1 - Math.log(Math.tan(latRad) + (1 / Math.cos(latRad))) / Math.PI) / 2 * n)
  return {
    x: clampInteger(x, 0, n - 1),
    y: clampInteger(y, 0, n - 1)
  }
}

function clamp (value, min, max) {
  return Math.min(max, Math.max(min, value))
}

function clampInteger (value, min, max) {
  return Math.trunc(clamp(value, min, max))
}

function validCoordinate (coordinate) {
  return Array.isArray(coordinate) &&
    Number.isFinite(coordinate[0]) &&
    Number.isFinite(coordinate[1])
}

function isValidPosition (position) {
  return position &&
    Number.isFinite(position.latitude) &&
    Number.isFinite(position.longitude) &&
    position.latitude >= -90 &&
    position.latitude <= 90 &&
    position.longitude >= -180 &&
    position.longitude <= 180
}

function numberOr (value, fallback) {
  return Number.isFinite(value) ? value : fallback
}

module.exports = {
  DEFAULT_DATA_PATH,
  createCoastIndex,
  loadCoastIndex
}
