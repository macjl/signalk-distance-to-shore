'use strict'

const fs = require('fs')
const path = require('path')
const { PMTiles } = require('pmtiles')
const { loadCoastIndex } = require('./lib/coast-index')
const { buildSchema } = require('./lib/plugin-schema')

const PLUGIN_ID = 'distance-to-shore'
const PUBLISH_SOURCE = 'signalk-distance-to-shore'
const DEFAULT_CHART_PATH = path.join(__dirname, 'data', 'charts', 'french-mediterranean.pmtiles')
const INPUT_POSITION_PATH = 'navigation.position'
const COASTLINE_LAYER = 'coastline'
const DISTANCE_ZOOM = 12
const CHART_RESOURCE_IDENTIFIER = 'distance-to-shore-coastline'
const PUBLISHED_PATHS = {
  distance: 'navigation.distanceToShore',
  closestPoint: 'navigation.shore.closestPoint',
  bearingTrue: 'navigation.shore.bearingTrue'
}

const DEFAULT_OPTIONS = {
  pmtilesPath: '',
  publishChartResource: true,
  tickIntervalMs: 1000,
  searchRadiusMeters: 10000
}

module.exports = function createPlugin (app) {
  let options = DEFAULT_OPTIONS
  let timer = null
  let coastIndex = null
  let runtime = inactiveRuntime()
  let tickRunning = false
  let chartResourceProviderRegistered = false
  let chartResourcesPromise = Promise.resolve({})
  let routerChartFiles = new Map()

  const plugin = {
    id: PLUGIN_ID,
    name: 'Distance To Shore',
    description: 'Publishes distance from navigation.position to the nearest known coastline.',
    schema: buildSchema,
    registerWithRouter,
    start,
    stop
  }

  return plugin

  function start (pluginOptions) {
    options = normalizeOptions(mergeOptions(DEFAULT_OPTIONS, pluginOptions || {}))
    runtime = inactiveRuntime()

    try {
      coastIndex = loadCoastIndex(options.pmtilesPath || DEFAULT_CHART_PATH, {
        pmtiles: {
          layerName: COASTLINE_LAYER,
          zoom: DISTANCE_ZOOM
        }
      })
      runtime.dataSource = coastIndex.sourcePath
    } catch (error) {
      runtime.status = 'error'
      runtime.error = error.message
      app.error && app.error(`Distance To Shore failed to load coast index: ${error.message}`)
      setStatus()
      return
    }

    registerChartResourceProvider()
    chartResourcesPromise = buildChartResources()
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

      const nearestResult = coastIndex.findNearest(position, {
        searchRadiusMeters: options.searchRadiusMeters
      })
      const nearest = nearestResult && typeof nearestResult.then === 'function'
        ? await nearestResult
        : nearestResult

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

  function registerWithRouter (router) {
    router.get('/charts', async (req, res) => {
      const resources = await chartResourcesPromise
      res.json(Object.values(resources).map((resource) => resource.identifier))
    })

    router.get('/charts/:fileName', async (req, res) => {
      const resource = routerChartFiles.get(req.params.fileName)
      if (!resource) {
        res.status(404).json({ error: 'Chart not found' })
        return
      }
      res.sendFile(resource.path)
    })
  }

  function registerChartResourceProvider () {
    if (chartResourceProviderRegistered || typeof app.registerResourceProvider !== 'function') return
    app.registerResourceProvider({
      type: 'charts',
      methods: {
        listResources: async () => chartResourcesPromise,
        getResource: async (id) => {
          const resources = await chartResourcesPromise
          if (resources[id]) return resources[id]
          throw new Error('Chart not found')
        },
        setResource: async () => {
          throw new Error('Not implemented')
        },
        deleteResource: async () => {
          throw new Error('Not implemented')
        }
      }
    })
    chartResourceProviderRegistered = true
  }

  async function buildChartResources () {
    routerChartFiles = new Map()
    if (!options.publishChartResource) return {}

    const chartPath = path.resolve(options.pmtilesPath || DEFAULT_CHART_PATH)
    if (!fs.existsSync(chartPath)) return {}
    if (path.extname(chartPath).toLowerCase() !== '.pmtiles') return {}

    const source = new LocalFileSource(chartPath)
    const archive = new PMTiles(source)
    const header = await archive.getHeader()
    const metadata = await archive.getMetadata().catch(() => ({}))
    const fileName = path.basename(chartPath)
    const identifier = CHART_RESOURCE_IDENTIFIER
    const resource = {
      identifier,
      name: metadata.name || `Distance To Shore Coastline - ${fileName}`,
      description: metadata.description || 'Coastline used by signalk-distance-to-shore.',
      type: 'tilelayer',
      minzoom: header.minZoom,
      maxzoom: header.maxZoom,
      bounds: [header.minLon, header.minLat, header.maxLon, header.maxLat],
      format: 'pbf',
      url: `/plugins/${PLUGIN_ID}/charts/${encodeURIComponent(fileName)}`,
      layers: metadata.vector_layers || [],
      attribution: metadata.attribution
    }
    routerChartFiles.set(fileName, { path: chartPath, resource })
    return { [identifier]: resource }
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
  const merged = { ...defaults, ...overrides }
  return merged
}

function normalizeOptions (rawOptions) {
  const legacyChartPath = rawOptions.charts && rawOptions.charts.path
  const legacyChartEnabled = rawOptions.charts && rawOptions.charts.enabled

  return {
    ...rawOptions,
    pmtilesPath: rawOptions.pmtilesPath || rawOptions.dataPath || legacyChartPath || '',
    publishChartResource: legacyChartEnabled === false ? false : rawOptions.publishChartResource !== false,
    tickIntervalMs: Math.max(250, numberOr(rawOptions.tickIntervalMs, DEFAULT_OPTIONS.tickIntervalMs)),
    searchRadiusMeters: Math.max(20, numberOr(rawOptions.searchRadiusMeters, DEFAULT_OPTIONS.searchRadiusMeters))
  }
}

function numberOr (value, fallback) {
  return Number.isFinite(value) ? value : fallback
}

class LocalFileSource {
  constructor (filePath) {
    this.filePath = filePath
  }

  getKey () {
    return this.filePath
  }

  async getBytes (offset, length) {
    const handle = await fs.promises.open(this.filePath, 'r')
    try {
      const buffer = Buffer.alloc(length)
      const result = await handle.read(buffer, 0, length, offset)
      return { data: buffer.subarray(0, result.bytesRead).buffer.slice(buffer.byteOffset, buffer.byteOffset + result.bytesRead) }
    } finally {
      await handle.close()
    }
  }
}
