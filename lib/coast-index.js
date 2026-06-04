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

// Depth-first hierarchical search: at every zoom level, tiles are sorted by their minimum
// distance to the query position and visited nearest-first. As soon as a coastline is found
// at distance D, any tile whose bbox is already ≥ D away is skipped — both at the detail
// zoom and at every intermediate zoom, pruning entire subtrees before they are loaded.
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
      const startZoom = hierarchyStartZoom(searchRadiusMeters, resource.minzoom, zoom)
      const useHierarchy = candidateTiles.length >= PREFILTER_THRESHOLD_TILES && startZoom < zoom

      let nearest = null

      if (useHierarchy) {
        // Depth-first descent with early exit at every zoom level.
        const searchBbox = expandBboxMeters(
          [position.longitude, position.latitude, position.longitude, position.latitude],
          searchRadiusMeters
        )

        const descend = async (tiles, z) => {
          const sorted = tiles
            .map(tile => ({ tile, minDist: minDistanceToBboxMeters(position, tileToBbox(tile)) }))
            .sort((a, b) => a.minDist - b.minDist)

          for (const { tile, minDist } of sorted) {
            if (nearest && minDist >= nearest.distance) break

            const segments = await loadChartResourceTileSegments({ resource, fetchImpl, fetchOptions, cache, cacheLimit, layerName, tile })

            if (z === zoom) {
              // Leaf: compute distance to each coastline segment.
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
            } else if (segments.length > 0) {
              // Intermediate: recurse into the children of this tile within the search area.
              await descend(childTilesInBbox(tile, z + 1, searchBbox), z + 1)
            }
          }
        }

        await descend(tilesForSearch(position, searchRadiusMeters, startZoom), startZoom)
      } else {
        // Small radius: flat loop with early exit at the detail zoom.
        const sortedTiles = candidateTiles
          .map(tile => ({ tile, minDist: minDistanceToBboxMeters(position, tileToBbox(tile)) }))
          .sort((a, b) => a.minDist - b.minDist)

        for (const { tile, minDist } of sortedTiles) {
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

// Return the 4 children of `parent` at `childZoom` that intersect `searchBbox`.
// Every tile has exactly four children: (x*2, y*2), (x*2+1, y*2), (x*2, y*2+1), (x*2+1, y*2+1).
// Children whose bbox lies entirely outside the search area are discarded early.
function childTilesInBbox (parent, childZoom, searchBbox) {
  const cx = parent.x * 2
  const cy = parent.y * 2
  return [
    { z: childZoom, x: cx,     y: cy     },
    { z: childZoom, x: cx + 1, y: cy     },
    { z: childZoom, x: cx,     y: cy + 1 },
    { z: childZoom, x: cx + 1, y: cy + 1 }
  ].filter(tile => {
    const b = tileToBbox(tile)
    return b[0] <= searchBbox[2] && b[2] >= searchBbox[0] &&
           b[1] <= searchBbox[3] && b[3] >= searchBbox[1]
  })
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

// Compute a cache size that comfortably covers the detail-zoom search window.
// With depth-first descent and early exit the actual tiles visited per tick are far
// fewer than the full window, but sizing to the full window × CACHE_BUFFER_FACTOR
// ensures a warm cache for position drift between ticks.
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
