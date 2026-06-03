'use strict'

const assert = require('node:assert/strict')
const test = require('node:test')
const zlib = require('node:zlib')
const geojsonvt = require('geojson-vt').default
const vtpbf = require('vt-pbf')
const { createChartResourceCoastIndex } = require('../lib/coast-index')
const { minDistanceToBboxMeters } = require('../lib/geo-distance')

// ---------------------------------------------------------------------------
// minDistanceToBboxMeters
// ---------------------------------------------------------------------------

test('minDistanceToBboxMeters returns 0 when position is inside bbox', () => {
  assert.equal(minDistanceToBboxMeters({ latitude: 0, longitude: 0 }, [-1, -1, 1, 1]), 0)
})

test('minDistanceToBboxMeters returns 0 when position is on bbox edge', () => {
  assert.equal(minDistanceToBboxMeters({ latitude: 0, longitude: 1 }, [-1, -1, 1, 1]), 0)
})

test('minDistanceToBboxMeters returns approximate distance to nearest edge', () => {
  // Position is 1° north of the bbox top edge (top at lat=1°)
  const dist = minDistanceToBboxMeters({ latitude: 2, longitude: 0 }, [-1, -1, 1, 1])
  // 1° latitude ≈ 111 km
  assert.ok(dist > 110000 && dist < 112000, `expected ~111 km, got ${dist}`)
})

test('minDistanceToBboxMeters returns larger distance for diagonal position', () => {
  const diagonal = minDistanceToBboxMeters({ latitude: 2, longitude: 2 }, [-1, -1, 1, 1])
  const edge = minDistanceToBboxMeters({ latitude: 2, longitude: 0 }, [-1, -1, 1, 1])
  assert.ok(diagonal > edge, 'corner distance should exceed edge-only distance')
})

// ---------------------------------------------------------------------------
// Hierarchical filter — correctness
// ---------------------------------------------------------------------------

// The coast tile used throughout these tests: a line from (-1°, 0°) to (1°, 0°)
// placed at z12 / x=2048 / y=2047 (just north of the equator).
// Position (0, 0) lies on this line, so expected distance ≈ 0.
const COAST_Z12_X = 2048
const COAST_Z12_Y = 2047

test('findNearest with large radius finds coast correctly (hierarchy active)', async () => {
  // 50 km radius → ~25 z12 tiles → hierarchy is activated (threshold = 16)
  const index = createChartResourceCoastIndex({
    resourceId: 'test-coastline',
    signalKBaseUrl: 'http://signalk.test',
    fetchImpl: createAllNonEmptyFetch()
  })

  const nearest = await index.findNearest(
    { latitude: 0, longitude: 0 },
    { searchRadiusMeters: 50000 }
  )

  assert.ok(nearest !== null, 'should find a coast')
  assert.ok(nearest.distance < 1, `expected distance ≈ 0, got ${nearest.distance}`)
})

test('findNearest returns null when all tiles are empty (open ocean)', async () => {
  // All tile requests → 404. Hierarchy terminates at first zoom level, zero z12 fetches.
  const index = createChartResourceCoastIndex({
    resourceId: 'test-coastline',
    signalKBaseUrl: 'http://signalk.test',
    fetchImpl: createAllEmptyFetch()
  })

  const nearest = await index.findNearest(
    { latitude: 0, longitude: 0 },
    { searchRadiusMeters: 50000 }
  )

  assert.equal(nearest, null)
})

test('findNearest with sparse coast finds the correct result after hierarchy pruning', async () => {
  // Only tiles that are direct ancestors of COAST_Z12_X/Y are non-empty.
  // All other tiles return 404. The hierarchy should prune ocean branches and
  // still reach the one coast tile.
  const index = createChartResourceCoastIndex({
    resourceId: 'test-coastline',
    signalKBaseUrl: 'http://signalk.test',
    fetchImpl: createSparseFetch(COAST_Z12_X, COAST_Z12_Y)
  })

  const nearest = await index.findNearest(
    { latitude: 0, longitude: 0 },
    { searchRadiusMeters: 100000 }
  )

  assert.ok(nearest !== null, 'should find a coast despite sparse tiles')
  assert.ok(nearest.distance < 1, `expected distance ≈ 0, got ${nearest.distance}`)
})

// ---------------------------------------------------------------------------
// Hierarchical filter — efficiency
// ---------------------------------------------------------------------------

test('findNearest fetches far fewer tiles when coast is sparse (hierarchy pruning)', async () => {
  // At 100 km radius, the naive grid would cover ~400 z12 tiles.
  // With hierarchical pruning on a sparse coast (1 coastline tile), total fetches
  // across all zoom levels should be well under 30.
  const fetched = []

  const index = createChartResourceCoastIndex({
    resourceId: 'test-coastline',
    signalKBaseUrl: 'http://signalk.test',
    fetchImpl: createTrackingSparseFetch(fetched, COAST_Z12_X, COAST_Z12_Y)
  })

  await index.findNearest(
    { latitude: 0, longitude: 0 },
    { searchRadiusMeters: 100000 }
  )

  const tileFetches = fetched.filter(p => /\/\d+\/\d+\/\d+$/.test(p))
  assert.ok(
    tileFetches.length < 30,
    `expected < 30 tile fetches with sparse coast, got ${tileFetches.length}: ${tileFetches.join(', ')}`
  )
})

test('findNearest does not activate hierarchy for small radius (below threshold)', async () => {
  // 10 km radius → ~16 z12 tiles (4×4 when position falls on a tile corner) → below PREFILTER_THRESHOLD_TILES (25), no hierarchy.
  // Only z12 tiles should be fetched (no coarse zoom tiles).
  const fetched = []

  const index = createChartResourceCoastIndex({
    resourceId: 'test-coastline',
    signalKBaseUrl: 'http://signalk.test',
    fetchImpl: createTrackingSparseFetch(fetched, COAST_Z12_X, COAST_Z12_Y)
  })

  await index.findNearest(
    { latitude: 0, longitude: 0 },
    { searchRadiusMeters: 10000 }
  )

  const coarseFetches = fetched.filter(p => {
    const m = p.match(/\/(\d+)\/\d+\/\d+$/)
    return m && Number(m[1]) < 12
  })
  assert.equal(coarseFetches.length, 0, 'no coarse-zoom fetches expected for small radius')
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Returns the MVT tile data for the coast line (lat=0, from lon=-1 to lon=1).
// Correct for z12/x2048/y2047. Returned for ancestor tiles too: the geographic
// coordinates will be wrong at coarse zooms, but segments.length > 0, which is
// all the hierarchy needs to classify a tile as non-empty.
function makeCoastTileData () {
  const index = geojsonvt({
    type: 'FeatureCollection',
    features: [{
      type: 'Feature',
      properties: {},
      geometry: {
        type: 'LineString',
        coordinates: [[-1, 0], [1, 0]]
      }
    }]
  }, { maxZoom: 12, indexMaxZoom: 12, tolerance: 0, extent: 4096, buffer: 64 })

  return zlib.gzipSync(Buffer.from(vtpbf.fromGeojsonVt({
    coastline: index.getTile(12, 2048, 2047)
  }, { version: 2, extent: 4096 })))
}

function makeResourceMetadata () {
  return {
    identifier: 'test-coastline',
    name: 'Test Coastline',
    bounds: [-180, -85.0511288, 180, 85.0511288],
    minzoom: 0,
    maxzoom: 12,
    format: 'pbf',
    type: 'tilelayer',
    url: '/signalk/v1/api/resources/charts/test-coastline/{z}/{x}/{y}',
    layers: ['coastline']
  }
}

// Every tile request returns the coast data (used to verify correctness with hierarchy active).
function createAllNonEmptyFetch () {
  const tile = makeCoastTileData()
  return async (url) => {
    const parsed = new URL(url)
    if (parsed.pathname === '/signalk/v2/api/resources/charts/test-coastline') {
      return jsonResponse(makeResourceMetadata())
    }
    if (/\/\d+\/\d+\/\d+$/.test(parsed.pathname)) return binaryResponse(tile)
    return new Response('', { status: 404 })
  }
}

// Resource metadata only; all tile requests return 404 (open ocean).
function createAllEmptyFetch () {
  return async (url) => {
    const parsed = new URL(url)
    if (parsed.pathname === '/signalk/v2/api/resources/charts/test-coastline') {
      return jsonResponse(makeResourceMetadata())
    }
    return new Response('', { status: 404 })
  }
}

// Only tiles that are direct ancestors of (coastX, coastY) at z12 return data.
// All others return 404.
function createSparseFetch (coastX, coastY) {
  return buildSparseFetch(makeCoastTileData(), coastX, coastY, null)
}

function createTrackingSparseFetch (fetchedPaths, coastX, coastY) {
  return buildSparseFetch(makeCoastTileData(), coastX, coastY, fetchedPaths)
}

function buildSparseFetch (coastTile, coastX, coastY, trackList) {
  return async (url) => {
    const parsed = new URL(url)

    if (parsed.pathname === '/signalk/v2/api/resources/charts/test-coastline') {
      return jsonResponse(makeResourceMetadata())
    }

    const match = parsed.pathname.match(/\/(\d+)\/(\d+)\/(\d+)$/)
    if (match) {
      const [, z, x, y] = match.map(Number)
      if (trackList) trackList.push(parsed.pathname)

      // A tile (z, x, y) is an ancestor of the coast tile if, when you shift the
      // coast tile's coordinates right by (12 - z) bits, you get (x, y).
      const delta = 12 - z
      if (x === (coastX >> delta) && y === (coastY >> delta)) {
        return binaryResponse(coastTile)
      }
      return new Response('', { status: 404 })
    }

    return new Response('', { status: 404 })
  }
}

function jsonResponse (data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' }
  })
}

function binaryResponse (data) {
  return new Response(data, {
    status: 200,
    headers: { 'content-type': 'application/x-protobuf' }
  })
}
