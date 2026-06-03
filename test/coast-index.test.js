'use strict'

const assert = require('node:assert/strict')
const test = require('node:test')
const os = require('node:os')
const path = require('node:path')
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
    /request Signal K device access automatically/
  )
})

test('plugin requests Signal K device access automatically after HTTP 401', async () => {
  const messages = []
  const statuses = []
  const accessRequests = []
  const providerFetch = createChartProviderFetch()
  let pollCount = 0
  const stateFile = path.join(os.tmpdir(), `signalk-distance-to-shore-${Date.now()}-${Math.random()}.json`)

  const fetchImpl = async (url, options = {}) => {
    const parsed = new URL(url)
    const auth = options.headers && options.headers.Authorization

    if (parsed.pathname === '/signalk/v1/access/requests' && options.method === 'POST') {
      accessRequests.push(JSON.parse(options.body))
      return jsonResponse({
        state: 'PENDING',
        statusCode: 202,
        requestId: 'request-1',
        href: '/signalk/v1/requests/request-1'
      }, 202)
    }

    if (parsed.pathname === '/signalk/v1/requests/request-1') {
      pollCount += 1
      if (pollCount === 1) {
        return jsonResponse({
          state: 'COMPLETED',
          statusCode: 200,
          accessRequest: {
            permission: 'APPROVED',
            token: 'approved-token'
          }
        })
      }
    }

    if (parsed.pathname.startsWith('/signalk/v1/api/resources/charts/test-coastline/') ||
      parsed.pathname === '/signalk/v2/api/resources/charts/test-coastline') {
      if (auth !== 'Bearer approved-token') return new Response('', { status: 401 })
      return providerFetch(url, options)
    }

    return new Response('', { status: 404 })
  }

  const app = {
    config: { configPath: os.tmpdir() },
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
      statuses.push(value)
    }
  }
  const plugin = createPlugin(app)

  plugin.start({
    chartResourceId: 'test-coastline',
    signalKBaseUrl: 'http://signalk.test',
    fetchImpl,
    accessStateFile: stateFile,
    searchRadiusMeters: 20000,
    tickIntervalMs: 250
  })

  await waitFor(() => messages.length > 0, 2000)
  plugin.stop()

  assert.equal(accessRequests.length, 1)
  assert.equal(accessRequests[0].description, 'Signal K Distance To Shore coastline resource reader')
  assert.equal(typeof accessRequests[0].clientId, 'string')
  assert.equal(messages.length >= 1, true)
  assert.equal(statuses.some((status) => status.includes('Waiting for Signal K access approval')), true)
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

async function waitFor (predicate, timeout = 1000) {
  const started = Date.now()
  while (!predicate()) {
    if (Date.now() - started > timeout) throw new Error('Timed out waiting for condition')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}
