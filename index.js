'use strict'

const { createChartResourceCoastIndex } = require('./lib/coast-index')
const { buildSchema } = require('./lib/plugin-schema')

const PLUGIN_ID = 'distance-to-shore'
const PUBLISH_SOURCE = 'signalk-distance-to-shore'
const INPUT_POSITION_PATH = 'navigation.position'
const DEFAULT_SIGNAL_K_BASE_URL = 'http://127.0.0.1:3000'
const PUBLISHED_PATHS = {
  distance: 'navigation.distanceToShore',
  closestPoint: 'navigation.shore.closestPoint',
  bearingTrue: 'navigation.shore.bearingTrue'
}

const DEFAULT_OPTIONS = {
  chartResourceId: '',
  tickIntervalMs: 1000,
  searchRadiusMeters: 10000
}

module.exports = function createPlugin (app) {
  let options = DEFAULT_OPTIONS
  let timer = null
  let coastIndex = null
  let runtime = inactiveRuntime()
  let tickRunning = false

  const plugin = {
    id: PLUGIN_ID,
    name: 'Distance To Shore',
    description: 'Publishes distance from navigation.position to the nearest known coastline.',
    schema: buildSchema,
    start,
    stop
  }

  return plugin

  function start (pluginOptions) {
    options = normalizeOptions(mergeOptions(DEFAULT_OPTIONS, pluginOptions || {}))
    runtime = inactiveRuntime()

    if (!options.chartResourceId) {
      runtime.status = 'error'
      runtime.error = 'No chart resource selected'
      setStatus()
      return
    }

    coastIndex = createChartResourceCoastIndex({
      resourceId: options.chartResourceId,
      signalKBaseUrl: options.signalKBaseUrl || DEFAULT_SIGNAL_K_BASE_URL,
      fetchImpl: options.fetchImpl
    })
    runtime.dataSource = `chart:${options.chartResourceId}`

    tick()
    timer = setInterval(() => { tick() }, options.tickIntervalMs)
    setStatus()
  }

  function stop () {
    if (timer) clearInterval(timer)
    timer = null
    coastIndex = null
    runtime.status = 'inactive'
    setStatus()
  }

  async function tick () {
    if (tickRunning || !coastIndex) return
    tickRunning = true
    try {
      const position = readPosition(INPUT_POSITION_PATH)
      if (!position) {
        runtime.status = 'waitingForPosition'
        setStatus()
        return
      }

      const nearest = await coastIndex.findNearest(position, {
        searchRadiusMeters: options.searchRadiusMeters
      })

      if (!nearest) {
        runtime.status = 'outOfRange'
        runtime.position = position
        runtime.distanceToShore = null
        setStatus()
        return
      }

      runtime.status = 'ok'
      runtime.position = position
      runtime.distanceToShore = nearest.distance
      runtime.closestPoint = nearest.closestPoint
      runtime.bearingTrue = nearest.bearingTrue
      runtime.tileId = nearest.tileId
      publishNearest(nearest)
      setStatus()
    } catch (error) {
      runtime.status = 'error'
      runtime.error = error.message
      app.error && app.error(`Distance To Shore tick failed: ${error.message}`)
      setStatus()
    } finally {
      tickRunning = false
    }
  }

  function readPosition (path) {
    if (!path || typeof app.getSelfPath !== 'function') return null
    const value = app.getSelfPath(`${path}.value`)
    if (!value || !Number.isFinite(value.latitude) || !Number.isFinite(value.longitude)) return null

    return {
      latitude: value.latitude,
      longitude: value.longitude
    }
  }

  function publishNearest (nearest) {
    publish([
      { path: PUBLISHED_PATHS.distance, value: nearest.distance },
      { path: PUBLISHED_PATHS.closestPoint, value: nearest.closestPoint },
      { path: PUBLISHED_PATHS.bearingTrue, value: nearest.bearingTrue }
    ])
  }

  function publish (values) {
    if (!app.handleMessage) return
    const filteredValues = values.filter((entry) => entry.path)
    if (filteredValues.length === 0) return

    app.handleMessage(PLUGIN_ID, {
      updates: [
        {
          $source: PUBLISH_SOURCE,
          values: filteredValues
        }
      ]
    })
  }

  function setStatus () {
    if (typeof app.setPluginStatus !== 'function') return

    if (runtime.status === 'ok') {
      app.setPluginStatus(`Distance to shore ${runtime.distanceToShore.toFixed(1)} m`)
    } else if (runtime.status === 'outOfRange') {
      app.setPluginStatus('No coastline found within search radius')
    } else if (runtime.status === 'waitingForPosition') {
      app.setPluginStatus('Waiting for navigation.position')
    } else if (runtime.status === 'error') {
      app.setPluginStatus(`Error: ${runtime.error}`)
    } else {
      app.setPluginStatus(runtime.status)
    }
  }
}

function inactiveRuntime () {
  return {
    status: 'inactive',
    dataSource: '',
    position: null,
    distanceToShore: null,
    closestPoint: null,
    bearingTrue: null,
    tileId: '',
    error: ''
  }
}

function mergeOptions (defaults, overrides) {
  return { ...defaults, ...overrides }
}

function normalizeOptions (rawOptions) {
  return {
    ...rawOptions,
    chartResourceId: rawOptions.chartResourceId || '',
    tickIntervalMs: Math.max(250, numberOr(rawOptions.tickIntervalMs, DEFAULT_OPTIONS.tickIntervalMs)),
    searchRadiusMeters: Math.max(20, numberOr(rawOptions.searchRadiusMeters, DEFAULT_OPTIONS.searchRadiusMeters))
  }
}

function numberOr (value, fallback) {
  return Number.isFinite(value) ? value : fallback
}
