'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const zlib = require('node:zlib')
const createPlugin = require('../index')
const { createCoastIndex, loadCoastIndex } = require('../lib/coast-index')
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

test('coast index returns nearest segment inside the search radius', () => {
  const index = createCoastIndex({
    version: 1,
    tiles: [
      {
        id: 'test-tile',
        bbox: [0, 0, 1, 1],
        segments: [
          [[0, 0], [1, 0]]
        ]
      }
    ]
  })

  const nearest = index.findNearest(
    { latitude: 0.001, longitude: 0.5 },
    { searchRadiusMeters: 500 }
  )

  assert.equal(nearest.tileId, 'test-tile')
  assert.ok(nearest.distance > 111)
  assert.ok(nearest.distance < 112)
  assert.equal(nearest.closestPoint.latitude, 0)
})

test('coast index returns null when no segment is close enough', () => {
  const index = createCoastIndex({
    version: 1,
    tiles: [
      {
        id: 'test-tile',
        bbox: [0, 0, 1, 1],
        segments: [
          [[0, 0], [1, 0]]
        ]
      }
    ]
  })

  const nearest = index.findNearest(
    { latitude: 2, longitude: 2 },
    { searchRadiusMeters: 500 }
  )

  assert.equal(nearest, null)
})

test('tiled coast index loads gzip tile candidates on demand', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coast-db-'))
  try {
    fs.mkdirSync(path.join(dir, 'tiles'))
    const tile = {
      version: 2,
      id: '0-0-0',
      tile: { z: 0, x: 0, y: 0 },
      bbox: [-180, -85, 180, 85],
      scale: 10000000,
      segments: [
        [0, 0, 10000000, 0]
      ]
    }
    fs.writeFileSync(path.join(dir, 'tiles', '0-0-0.json.gz'), zlib.gzipSync(JSON.stringify(tile)))
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({
      version: 2,
      name: 'test-db',
      scale: 10000000,
      tiles: [
        {
          id: '0-0-0',
          z: 0,
          x: 0,
          y: 0,
          bbox: [-180, -85, 180, 85],
          path: 'tiles/0-0-0.json.gz',
          segmentCount: 1
        }
      ]
    }))

    const index = loadCoastIndex(dir)
    const nearest = index.findNearest(
      { latitude: 0.001, longitude: 0.5 },
      { searchRadiusMeters: 500 }
    )

    assert.equal(nearest.tileId, '0-0-0')
    assert.ok(nearest.distance > 111)
    assert.ok(nearest.distance < 112)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('plugin publishes distance details from navigation position', () => {
  const messages = []
  let status = ''
  const app = {
    getSelfPath: (path) => {
      if (path === 'navigation.position.value') {
        return { latitude: 43.62, longitude: 7.16 }
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
    dataPath: '',
    searchRadiusMeters: 20000
  })
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
