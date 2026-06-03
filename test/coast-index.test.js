'use strict'

const assert = require('node:assert/strict')
const test = require('node:test')
const zlib = require('node:zlib')
const geojsonvt = require('geojson-vt').default
const vtpbf = require('vt-pbf')
const createPlugin = require('../index')
const { createChartResourceCoastIndex } = require('../lib/coast-index')
const { distanceToSegmentMeters } = require('../lib/geo-distance')

test('distance to a segment is zero for a point on the segment', () => {
  const result = distanceToSegmentMeters(
    { latitude: 0, longitude: 0.5 },
    { latitude: 0, longitude: 0 },
    { latitude: 0, longitude: 1 }
  )

  assert.ok(result.distance < 0.001)
  assert.equal(result.closestPoint.latitude, 0)
  assert.equal(result.closestPoint.longitude, 0.5)
})

test('distance to an east west segment is measured in meters', () => {
  const result = distanceToSegmentMeters(
    { latitude: 0.001, longitude: 0.5 },
    { latitude: 0, longitude: 0 },
    { latitude: 0, longitude: 1 }
  )

  assert.ok(result.distance > 111)
  assert.ok(result.distance < 112)
})

test('chart resource coast index reads MVT tiles from a Signal K chart provider', async () => {
  const index = createChartResourceCoastIndex({
    resourceId: 'test-coastline',
    signalKBaseUrl: 'http://signalk.test',
    fetchImpl: createChartProviderFetch()
  })

  const nearest = await index.findNearest(
    { latitude: 0, longitude: 0 },
    { searchRadiusMeters: 20000 }
  )

  assert.equal(nearest.distance, 0)
  assert.equal(nearest.closestPoint.longitude > -0.1, true)
  assert.equal(nearest.closestPoint.longitude < 0.1, true)
})

test('chart resource coast index sends an access token when configured', async () => {
  const requests = []
  const providerFetch = createChartProviderFetch()
  const index = createChartResourceCoastIndex({
    resourceId: 'test-coastline',
    signalKBaseUrl: 'http://signalk.test',
    accessToken: 'test-token',
    fetchImpl: async (url, options) => {
      requests.push({ url, options })
      return providerFetch(url, options)
    }
  })

  const nearest = await index.findNearest(
    { latitude: 0, longitude: 0 },
    { searchRadiusMeters: 20000 }
  )

  assert.equal(nearest.distance, 0)
  assert.equal(requests.length > 1, true)
  assert.equal(requests.every((request) => request.options.headers.Authorization === 'Bearer test-token'), true)
})

test('chart resource coast index reports authentication failures clearly', async () => {
  const index = createChartResourceCoastIndex({
    resourceId: 'test-coastline',
    signalKBaseUrl: 'http://signalk.test',
    fetchImpl: async () => new Response('', { status: 401 })
  })

  await assert.rejects(
    () => index.findNearest({ latitude: 0, longitude: 0 }),
    /Configure signalKAccessToken or SIGNALK_DISTANCE_TO_SHORE_TOKEN/
  )
})

test('plugin publishes distance details from navigation position', async () => {
  const messages = []
  let status = ''
  const app = {
    getSelfPath: (path) => {
      if (path === 'navigation.position.value') {
        return { latitude: 0, longitude: 0 }
      }
      return null
    },
    handleMessage: (id, message) => {
      messages.push({ id, message })
    },
    setPluginStatus: (value) => {
      status = value
    }
  }
  const plugin = createPlugin(app)

  plugin.start({
    chartResourceId: 'test-coastline',
    signalKBaseUrl: 'http://signalk.test',
    fetchImpl: createChartProviderFetch(),
    searchRadiusMeters: 20000,
    tickIntervalMs: 10000
  })
  await waitFor(() => messages.length > 0)
  plugin.stop()

  assert.equal(messages.length >= 1, true)
  const values = messages[0].message.updates[0].values
  assert.equal(values.some((entry) => entry.path === 'navigation.distanceToShore'), true)
  assert.equal(values.some((entry) => entry.path === 'navigation.shore.closestPoint'), true)
  assert.equal(values.some((entry) => entry.path === 'navigation.shore.bearingTrue'), true)
  assert.equal(values.some((entry) => entry.path === 'navigation.shore.clearance'), false)
  assert.equal(values.some((entry) => entry.path === 'navigation.shore.warning'), false)
  assert.equal(typeof status, 'string')
})

function createChartProviderFetch () {
  const tile = zlib.gzipSync(createCoastlineMvtTile())
  return async (url) => {
    const parsed = new URL(url)
    if (parsed.pathname === '/signalk/v2/api/resources/charts/test-coastline') {
      return jsonResponse({
        identifier: 'test-coastline',
        name: 'Test Coastline',
        bounds: [-180, -85.0511288, 180, 85.0511288],
        minzoom: 0,
        maxzoom: 12,
        format: 'pbf',
        type: 'tilelayer',
        url: '/signalk/v1/api/resources/charts/test-coastline/{z}/{x}/{y}',
        layers: ['coastline']
      })
    }
    if (parsed.pathname.startsWith('/signalk/v1/api/resources/charts/test-coastline/')) {
      return binaryResponse(tile)
    }
    return new Response('', { status: 404 })
  }
}

function createCoastlineMvtTile () {
  const index = geojsonvt({
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        properties: {},
        geometry: {
          type: 'LineString',
          coordinates: [[-1, 0], [1, 0]]
        }
      }
    ]
  }, {
    maxZoom: 12,
    indexMaxZoom: 12,
    tolerance: 0,
    extent: 4096,
    buffer: 64
  })
  return vtpbf.fromGeojsonVt({
    coastline: index.getTile(12, 2048, 2047)
  }, {
    version: 2,
    extent: 4096
  })
}

function jsonResponse (data) {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { 'content-type': 'application/json' }
  })
}

function binaryResponse (data) {
  return new Response(data, {
    status: 200,
    headers: { 'content-type': 'application/x-protobuf' }
  })
}

async function waitFor (predicate) {
  const started = Date.now()
  while (!predicate()) {
    if (Date.now() - started > 1000) throw new Error('Timed out waiting for condition')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}
