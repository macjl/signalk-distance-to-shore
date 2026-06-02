'use strict'

const fs = require('fs')
const path = require('path')
const zlib = require('zlib')
const {
  bearingTrue,
  distanceToSegmentMeters,
  expandBboxMeters,
  pointInBbox
} = require('./geo-distance')

const DEFAULT_DATA_PATH = path.join(__dirname, '..', 'data', 'coast-db', 'mediterranean')
const FALLBACK_DATA_PATH = path.join(__dirname, '..', 'data', 'rough-antibes-v1.json')
const TILE_CACHE_LIMIT = 64

function loadCoastIndex (dataPath = DEFAULT_DATA_PATH) {
  const resolvedPath = path.resolve(dataPath)
  if (!fs.existsSync(resolvedPath) && dataPath === DEFAULT_DATA_PATH) {
    return loadCoastIndex(FALLBACK_DATA_PATH)
  }
  const stat = fs.statSync(resolvedPath)
  if (stat.isDirectory()) {
    return loadTiledCoastIndex(path.join(resolvedPath, 'manifest.json'))
  }
  if (path.basename(resolvedPath) === 'manifest.json') {
    return loadTiledCoastIndex(resolvedPath)
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
