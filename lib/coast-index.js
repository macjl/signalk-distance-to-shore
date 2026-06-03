'use strict'

const zlib = require('zlib')
const { VectorTile } = require('@mapbox/vector-tile')
const { PbfReader } = require('pbf')
const {
  bearingTrue,
  distanceToSegmentMeters,
  expandBboxMeters,
  minDistanceToBboxMeters
} = require('./geo-distance')

// At zoom 12, each tile is ~9.8 km wide at the equator.
// The cache is sized to hold the full search window (all tiles in the bbox) × CACHE_BUFFER_FACTOR,
// so position drift doesn't force re-fetching tiles that were just loaded.
const EARTH_CIRCUMFERENCE_METERS = 2 * Math.PI * 6371008.8
const TILE_CACHE_MIN = 64
const TILE_CACHE_MAX = 2048
const CACHE_BUFFER_FACTOR = 2

// Hierarchical multi-resolution filter: descend from a coarse start zoom down to the detail
// zoom, pruning branches where no coastline exists at the coarser level.
//
// Correctness guarantee: the tile source must ensure that if a tile at zoom N is non-empty,
// its parent tile at zoom N-1 is also non-empty. For the companion world-coastline PMTiles
// (built from OSM data with snapGrid=1 at z8+), this holds because every real coastline
// segment is longer than the ~38 m collapse threshold at zoom 8. For custom tile sources,
// verify or enforce this invariant in the build pipeline.
//
// The start zoom is chosen so that the search bbox covers ≤ 9 tiles at that level,
// giving a small initial batch while still leaving enough zoom levels to prune from.
const PREFILTER_THRESHOLD_TILES = 25  // min fine tiles before hierarchy is worth activating

const DEFAULT_CHART_LAYER = 'coastline'
const DEFAULT_CHART_ZOOM = 12

function createChartResourceCoastIndex (options = {}) {
  const resourceId = options.resourceId || options.chartResourceId || ''
  if (!resourceId) throw new Error('Chart resource id is required')
  const signalKBaseUrl = options.signalKBaseUrl || 'http://127.0.0.1:3000'
  const fetchImpl = options.fetchImpl || globalThis.fetch
  if (typeof fetchImpl !== 'function') throw new Error('No fetch implementation available for chart resources')
  const fetchOptions = buildFetchOptions(options)

  const cache = new Map()
  const layerName = options.layerName || DEFAULT_CHART_LAYER
  const zoom = Number.isInteger(options.zoom) ? options.zoom : DEFAULT_CHART_ZOOM
  let resource = null
  let resourcePromise = null

  return {
    name: resourceId,
    version: 'chart-resource',
    sourcePath: `chart:${resourceId}`,
    findNearest: async (position, findOptions = {}) => {
      resource = await getChartResource()
      if (!isValidPosition(position) || !positionInBounds(position, resource.bounds)) return null

      const searchRadiusMeters = numberOr(findOptions.searchRadiusMeters, 10000)
      const cacheLimit = cacheSizeForRadius(searchRadiusMeters, zoom)
      const candidateTiles = tilesForSearch(position, searchRadiusMeters, zoom)

      // Hierarchical descent: start from a coarse zoom and work down to the detail zoom,
      // pruning tile branches where no coastline exists. Only activated when the search area
      // is large enough to justify the overhead (≥ PREFILTER_THRESHOLD_TILES detail tiles)
      // and when the tile source serves at least one zoom level below the detail zoom.
      const startZoom = hierarchyStartZoom(searchRadiusMeters, resource.minzoom, zoom)
      const fineTiles = (candidateTiles.length >= PREFILTER_THRESHOLD_TILES && startZoom < zoom)
        ? await hierarchicalFilter({ position, searchRadiusMeters, startZoom, targetZoom: zoom, resource, fetchImpl, fetchOptions, cache, cacheLimit, layerName })
        : candidateTiles

      // Sort remaining tiles from nearest bbox to farthest so we can prune early.
      const sortedTiles = fineTiles
        .map(tile => ({ tile, minDist: minDistanceToBboxMeters(position, tileToBbox(tile)) }))
        .sort((a, b) => a.minDist - b.minDist)

      let nearest = null

      for (const { tile, minDist } of sortedTiles) {
        // Once the closest possible point in this tile is already farther than our
        // current best, every remaining tile (sorted order) is also farther — stop.
        if (nearest && minDist >= nearest.distance) break

        const segments = await loadChartResourceTileSegments({ resource, fetchImpl, fetchOptions, cache, cacheLimit, layerName, tile })
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

  async function getChartResource () {
    if (resource) return resource
    if (!resourcePromise) {
      resourcePromise = loadChartResource({ resourceId, signalKBaseUrl, fetchImpl, fetchOptions, layerName, zoom })
        .then((loadedResource) => {
          resource = loadedResource
          return loadedResource
        })
        .catch((error) => {
          resourcePromise = null
          throw error
        })
    }
    return resourcePromise
  }
}

// Descend from startZoom to targetZoom, keeping at each level only the tiles whose parent
// at the previous level contained at least one coastline segment. Any branch that is
// entirely ocean or entirely land interior is pruned, so only coastline-adjacent tiles
// reach the detail zoom.
//
// Bit-shift (>> 1) converts (x, y) at zoom Z to the parent tile at zoom Z-1, equivalent
// to Math.floor(x / 2) for non-negative integers.
async function hierarchicalFilter ({ position, searchRadiusMeters, startZoom, targetZoom, resource, fetchImpl, fetchOptions, cache, cacheLimit, layerName }) {
  let activeTiles = tilesForSearch(position, searchRadiusMeters, startZoom)

  for (let z = startZoom; z < targetZoom; z++) {
    const nonEmpty = []
    for (const tile of activeTiles) {
      const segments = await loadChartResourceTileSegments({ resource, fetchImpl, fetchOptions, cache, cacheLimit, layerName, tile })
      if (segments.length > 0) nonEmpty.push(tile)
    }

    if (nonEmpty.length === 0) return []  // no coastline anywhere in the search area

    const nonEmptyKeys = new Set(nonEmpty.map(t => `${t.x}/${t.y}`))
    activeTiles = tilesForSearch(position, searchRadiusMeters, z + 1)
      .filter(tile => nonEmptyKeys.has(`${tile.x >> 1}/${tile.y >> 1}`))
  }

  return activeTiles
}

// Return the coarsest zoom at which the search bbox spans ≤ 3 tiles per side (≤ 9 tiles
// total), clamped to resource.minzoom. This bounds the initial fetch count while leaving
// enough zoom levels below it to make pruning worthwhile.
function hierarchyStartZoom (searchRadiusMeters, minzoom, targetZoom) {
  for (let z = targetZoom - 1; z >= minzoom; z--) {
    const tileWidthMeters = EARTH_CIRCUMFERENCE_METERS / (2 ** z)
    const tilesPerSide = Math.ceil(2 * searchRadiusMeters / tileWidthMeters) + 1
    if (tilesPerSide <= 3) return z
  }
  return minzoom
}

// Compute how many cache slots are needed to hold the detail search window plus all
// intermediate hierarchy levels, with a drift buffer.
// Intermediate levels form a geometric series summing to ~1/3 of the detail count,
// so detail × CACHE_BUFFER_FACTOR × 4/3 is a tight upper bound. The simpler
// detail × CACHE_BUFFER_FACTOR is used here since CACHE_BUFFER_FACTOR already
// provides comfortable headroom.
function cacheSizeForRadius (searchRadiusMeters, zoom) {
  const tileWidthMeters = EARTH_CIRCUMFERENCE_METERS / (2 ** zoom)
  const tilesPerSide = Math.ceil(2 * searchRadiusMeters / tileWidthMeters) + 2
  return Math.max(TILE_CACHE_MIN, Math.min(TILE_CACHE_MAX, tilesPerSide * tilesPerSide * CACHE_BUFFER_FACTOR))
}

// Convert a tile (z/x/y) to its geographic bbox [minLon, minLat, maxLon, maxLat].
function tileToBbox (tile) {
  const n = 2 ** tile.z
  const lonMin = (tile.x / n) * 360 - 180
  const lonMax = ((tile.x + 1) / n) * 360 - 180
  const latMax = toDeg(Math.atan(Math.sinh(Math.PI * (1 - 2 * tile.y / n))))
  const latMin = toDeg(Math.atan(Math.sinh(Math.PI * (1 - 2 * (tile.y + 1) / n))))
  return [lonMin, latMin, lonMax, latMax]
}

function toDeg (radians) {
  return radians * 180 / Math.PI
}

async function loadChartResource ({ resourceId, signalKBaseUrl, fetchImpl, fetchOptions, layerName, zoom }) {
  const resourceUrl = new URL(`/signalk/v2/api/resources/charts/${encodeURIComponent(resourceId)}`, signalKBaseUrl)
  const response = await fetchImpl(resourceUrl.toString(), fetchOptions)
  if (!response || response.status === 404) {
    throw new Error(`Chart resource '${resourceId}' was not found`)
  }
  if (!response.ok) {
    throw chartHttpError(`Chart resource '${resourceId}'`, response.status)
  }

  const resource = await response.json()
  const format = String(resource.format || '').toLowerCase()
  if (format !== 'pbf') {
    throw new Error(`Chart resource '${resourceId}' must be vector MVT/PBF; got '${resource.format || 'unknown'}'`)
  }

  const layers = normalizeLayers(resource.layers || resource.chartLayers || [])
  if (!layers.includes(layerName)) {
    throw new Error(`Chart resource '${resourceId}' must expose a '${layerName}' layer`)
  }

  if (!Number.isFinite(resource.minzoom) || !Number.isFinite(resource.maxzoom) || zoom < resource.minzoom || zoom > resource.maxzoom) {
    throw new Error(`Chart resource '${resourceId}' must provide zoom ${zoom}`)
  }

  const tileUrlTemplate = resource.url || resource.tilemapUrl
  if (!tileUrlTemplate) {
    throw new Error(`Chart resource '${resourceId}' does not expose a tile URL`)
  }

  return {
    id: resourceId,
    bounds: resource.bounds,
    tileUrlTemplate,
    signalKBaseUrl,
    minzoom: resource.minzoom
  }
}

async function loadChartResourceTileSegments ({ resource, fetchImpl, fetchOptions, cache, cacheLimit, layerName, tile }) {
  const key = `${tile.z}/${tile.x}/${tile.y}`
  if (cache.has(key)) {
    const cached = cache.get(key)
    cache.delete(key)
    cache.set(key, cached)
    return cached
  }

  const tileUrl = buildTileUrl(resource.tileUrlTemplate, resource.signalKBaseUrl, tile)
  const response = await fetchImpl(tileUrl, fetchOptions)
  if (!response || response.status === 404 || response.status === 204) {
    cache.set(key, [])
    return []
  }
  if (!response.ok) {
    throw chartHttpError(`Chart tile ${key}`, response.status)
  }

  const tileData = await response.arrayBuffer()
  const raw = Buffer.from(tileData)
  const data = isGzip(raw) ? zlib.gunzipSync(raw) : raw
  const vectorTile = new VectorTile(new PbfReader(new Uint8Array(data)))
  const layer = vectorTile.layers[layerName]
  const segments = []
  if (layer) {
    for (let i = 0; i < layer.length; i += 1) {
      const feature = layer.feature(i).toGeoJSON(tile.x, tile.y, tile.z)
      addGeoJsonSegments(segments, feature.geometry)
    }
  }

  cache.set(key, segments)
  while (cache.size > cacheLimit) {
    const oldestKey = cache.keys().next().value
    cache.delete(oldestKey)
  }
  return segments
}

function buildFetchOptions (options) {
  const headers = { ...(options.headers || {}) }
  const accessToken = stringOr(options.accessToken, options.signalKAccessToken)

  if (accessToken) {
    headers.Authorization = /^Bearer\s+/i.test(accessToken) ? accessToken : `Bearer ${accessToken}`
  }

  return Object.keys(headers).length > 0 ? { headers } : undefined
}

function stringOr (...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return ''
}

function chartHttpError (subject, status) {
  const message = status === 401
    ? `${subject} returned HTTP 401. Distance To Shore will request Signal K device access automatically when possible.`
    : `${subject} returned HTTP ${status}`
  const error = new Error(message)
  error.statusCode = status
  if (status === 401) {
    error.code = 'SIGNALK_AUTH_REQUIRED'
  }
  return error
}

function buildTileUrl (template, signalKBaseUrl, tile) {
  const path = template
    .replace('{z}', String(tile.z))
    .replace('{x}', String(tile.x))
    .replace('{y}', String(tile.y))
  return new URL(path, signalKBaseUrl).toString()
}

function normalizeLayers (layers) {
  if (!Array.isArray(layers)) return []
  return layers.map((layer) => {
    if (typeof layer === 'string') return layer
    return layer && (layer.id || layer.name)
  }).filter(Boolean)
}

function isGzip (buffer) {
  return buffer.length >= 2 && buffer[0] === 0x1f && buffer[1] === 0x8b
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

function coordinateToPosition (coordinate) {
  return {
    longitude: coordinate[0],
    latitude: coordinate[1]
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

function positionInBounds (position, bounds) {
  if (!Array.isArray(bounds) || bounds.length !== 4) return true
  return position.longitude >= bounds[0] &&
    position.latitude >= bounds[1] &&
    position.longitude <= bounds[2] &&
    position.latitude <= bounds[3]
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
  createChartResourceCoastIndex
}
