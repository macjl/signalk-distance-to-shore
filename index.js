'use strict'

const { DEFAULT_DATA_PATH, loadCoastIndex } = require('./lib/coast-index')
const { buildSchema } = require('./lib/plugin-schema')

const PLUGIN_ID = 'distance-to-shore'
const PUBLISH_SOURCE = 'signalk-distance-to-shore'

const DEFAULT_OPTIONS = {
  enabled: true,
  inputPositionPath: 'navigation.position',
  dataPath: '',
  tickIntervalMs: 1000,
  searchRadiusMeters: 10000,
  publishing: {
    source: PUBLISH_SOURCE,
    distancePath: 'navigation.distanceToShore',
    closestPointPath: 'navigation.shore.closestPoint',
    bearingTruePath: 'navigation.shore.bearingTrue'
  }
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

    if (!options.enabled) {
      runtime.status = 'disabled'
      setStatus()
      return
    }

    try {
      coastIndex = loadCoastIndex(options.dataPath || DEFAULT_DATA_PATH)
      runtime.dataSource = coastIndex.sourcePath
    } catch (error) {
      runtime.status = 'error'
      runtime.error = error.message
      app.error && app.error(`Distance To Shore failed to load coast index: ${error.message}`)
      setStatus()
      return
    }

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

  function tick () {
    if (tickRunning || !coastIndex) return
    tickRunning = true
    try {
      const position = readPosition(options.inputPositionPath)
      if (!position) {
        runtime.status = 'waitingForPosition'
        setStatus()
        return
      }

      const nearest = coastIndex.findNearest(position, {
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
      { path: options.publishing.distancePath, value: nearest.distance },
      { path: options.publishing.closestPointPath, value: nearest.closestPoint },
      { path: options.publishing.bearingTruePath, value: nearest.bearingTrue }
    ])
  }

  function publish (values) {
    if (!app.handleMessage) return
    const filteredValues = values.filter((entry) => entry.path)
    if (filteredValues.length === 0) return

    app.handleMessage(PLUGIN_ID, {
      updates: [
        {
          $source: options.publishing.source,
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
  const merged = { ...defaults, ...overrides }
  merged.publishing = { ...defaults.publishing, ...(overrides.publishing || {}) }
  return merged
}

function normalizeOptions (rawOptions) {
  return {
    ...rawOptions,
    tickIntervalMs: Math.max(250, numberOr(rawOptions.tickIntervalMs, DEFAULT_OPTIONS.tickIntervalMs)),
    searchRadiusMeters: Math.max(20, numberOr(rawOptions.searchRadiusMeters, DEFAULT_OPTIONS.searchRadiusMeters))
  }
}

function numberOr (value, fallback) {
  return Number.isFinite(value) ? value : fallback
}
