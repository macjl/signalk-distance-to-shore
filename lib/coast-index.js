'use strict'

const zlib = require('zlib')
const { VectorTile } = require('@mapbox/vector-tile')
const { PbfReader } = require('pbf')
const {
  bearingTrue,
  distanceToSegmentMeters,
  expandBboxMeters
} = require('./geo-distance')

const TILE_CACHE_LIMIT = 64
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
      const candidateTiles = tilesForSearch(position, searchRadiusMeters, zoom)
      let nearest = null

      for (const tile of candidateTiles) {
        const segments = await loadChartResourceTileSegments({ resource, fetchImpl, fetchOptions, cache, layerName, tile })
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
    signalKBaseUrl
  }
}

async function loadChartResourceTileSegments ({ resource, fetchImpl, fetchOptions, cache, layerName, tile }) {
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
  while (cache.size > TILE_CACHE_LIMIT) {
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
