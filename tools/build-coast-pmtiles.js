#!/usr/bin/env node
'use strict'

const fs = require('fs')
const path = require('path')
const zlib = require('zlib')
const vtpbf = require('vt-pbf')
const { Compression, TileType, zxyToTileId } = require('pmtiles')

const DEFAULT_SOURCE = path.join(__dirname, '..', 'data', 'coast-db', 'mediterranean')
const DEFAULT_OUTPUT = path.join(__dirname, '..', 'data', 'charts', 'french-mediterranean.pmtiles')
const DEFAULT_BBOX = [2.6, 41.2, 9.8, 43.95]
const DEFAULT_MIN_ZOOM = 6
const DEFAULT_MAX_ZOOM = 12
const DEFAULT_LAYER = 'coastline'
const DEFAULT_EXTENT = 4096
const DEFAULT_BUFFER = 64

main().catch((error) => {
  console.error(error.stack || error.message)
  process.exitCode = 1
})

async function main () {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    printHelp()
    return
  }

  const geojsonVt = (await import('geojson-vt')).default
  const source = path.resolve(args.source || DEFAULT_SOURCE)
  const output = path.resolve(args.output || DEFAULT_OUTPUT)
  const bbox = args.bbox || DEFAULT_BBOX
  const minZoom = args.minZoom || DEFAULT_MIN_ZOOM
  const maxZoom = args.maxZoom || DEFAULT_MAX_ZOOM
  const layerName = args.layer || DEFAULT_LAYER
  const name = args.name || 'Distance To Shore Coastline - French Mediterranean'
  const description = args.description || 'Coastline used by signalk-distance-to-shore.'
  const attribution = args.attribution || '© OpenStreetMap contributors'
  const startedAt = Date.now()

  const featureCollection = await loadSourceAsGeoJson(source, bbox)
  const tileIndex = geojsonVt(featureCollection, {
    minZoom,
    maxZoom,
    indexMaxZoom: maxZoom,
    extent: DEFAULT_EXTENT,
    buffer: DEFAULT_BUFFER,
    tolerance: 0
  })

  const tiles = []
  for (let z = minZoom; z <= maxZoom; z += 1) {
    const range = tileRangeForBbox(bbox, z)
    for (let x = range.minX; x <= range.maxX; x += 1) {
      for (let y = range.minY; y <= range.maxY; y += 1) {
        const tile = tileIndex.getTile(z, x, y)
        if (!tile || tile.features.length === 0) continue
        const mvt = Buffer.from(vtpbf.fromGeojsonVt({ [layerName]: tile }))
        tiles.push({
          tileId: zxyToTileId(z, x, y),
          z,
          x,
          y,
          data: zlib.gzipSync(mvt)
        })
      }
    }
  }

  const metadata = {
    name,
    description,
    attribution,
    version: '1.0.0',
    vector_layers: [
      {
        id: layerName,
        description: 'Coastline segments used by signalk-distance-to-shore.',
        minzoom: minZoom,
        maxzoom: maxZoom,
        fields: {}
      }
    ]
  }

  fs.mkdirSync(path.dirname(output), { recursive: true })
  writePmtiles({
    output,
    tiles,
    metadata,
    minZoom,
    maxZoom,
    bbox,
    center: centerForBbox(bbox, maxZoom)
  })

  const elapsedSeconds = (Date.now() - startedAt) / 1000
  console.log(`Wrote ${output}`)
  console.log(`Features: ${featureCollection.features.length}`)
  console.log(`Tiles: ${tiles.length}`)
  console.log(`Elapsed: ${elapsedSeconds.toFixed(1)} s`)
}

async function loadSourceAsGeoJson (source, bbox) {
  const stat = fs.statSync(source)
  const extension = stat.isDirectory() ? '' : path.extname(source).toLowerCase()
  if (stat.isDirectory() || path.basename(source) === 'manifest.json') {
    return loadCoastDbAsGeoJson(source, bbox)
  }
  if (extension === '.shp') {
    return await loadShapefileAsGeoJson(source, bbox)
  }
  if (extension === '.json' || extension === '.geojson') {
    return loadGeoJsonSource(source, bbox)
  }
  throw new Error(`Unsupported source format: ${extension || 'directory without manifest'}`)
}

function loadCoastDbAsGeoJson (source, bbox) {
  const manifestPath = resolveManifestPath(source)
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  if (manifest.version !== 2 || !Array.isArray(manifest.tiles)) {
    throw new Error('Only coast-db v2 manifests are supported')
  }

  const baseDir = path.dirname(manifestPath)
  const seen = new Set()
  const features = []

  for (const tile of manifest.tiles) {
    if (!bboxIntersects(tile.bbox, bbox)) continue
    const raw = zlib.gunzipSync(fs.readFileSync(path.join(baseDir, tile.path)))
    const data = JSON.parse(raw.toString('utf8'))
    const scale = data.scale || tile.scale || manifest.scale
    for (const segment of data.segments) {
      const coordinates = [
        [segment[0] / scale, segment[1] / scale],
        [segment[2] / scale, segment[3] / scale]
      ]
      if (!segmentIntersectsBbox(coordinates, bbox)) continue
      const key = segmentKey(coordinates)
      if (seen.has(key)) continue
      seen.add(key)
      features.push({
        type: 'Feature',
        properties: {},
        geometry: {
          type: 'LineString',
          coordinates
        }
      })
    }
  }

  if (features.length === 0) throw new Error(`No coastline segments found in bbox ${bbox.join(',')}`)
  return {
    type: 'FeatureCollection',
    features
  }
}

async function loadShapefileAsGeoJson (source, bbox) {
  const shapefile = require('shapefile')
  const collection = await shapefile.open(source)
  const seen = new Set()
  const features = []

  while (true) {
    const result = await collection.read()
    if (result.done) break
    addGeometryFeatures(features, seen, result.value.geometry, bbox)
  }

  if (features.length === 0) throw new Error(`No coastline segments found in bbox ${bbox.join(',')}`)
  return {
    type: 'FeatureCollection',
    features
  }
}

function loadGeoJsonSource (source, bbox) {
  const geojson = JSON.parse(fs.readFileSync(source, 'utf8'))
  const features = geojson.type === 'FeatureCollection'
    ? geojson.features
    : [{ type: 'Feature', geometry: geojson, properties: {} }]
  const seen = new Set()
  const output = []

  for (const feature of features) {
    addGeometryFeatures(output, seen, feature.geometry, bbox)
  }

  if (output.length === 0) throw new Error(`No coastline segments found in bbox ${bbox.join(',')}`)
  return {
    type: 'FeatureCollection',
    features: output
  }
}

function addGeometryFeatures (features, seen, geometry, bbox) {
  if (!geometry) return
  if (geometry.type === 'LineString') {
    addLineFeatures(features, seen, geometry.coordinates, bbox)
  } else if (geometry.type === 'MultiLineString') {
    for (const line of geometry.coordinates) addLineFeatures(features, seen, line, bbox)
  } else if (geometry.type === 'GeometryCollection') {
    for (const child of geometry.geometries) addGeometryFeatures(features, seen, child, bbox)
  }
}

function addLineFeatures (features, seen, coordinates, bbox) {
  for (let i = 1; i < coordinates.length; i += 1) {
    const start = coordinates[i - 1]
    const end = coordinates[i]
    if (!validCoordinate(start) || !validCoordinate(end)) continue
    const segment = [
      [start[0], start[1]],
      [end[0], end[1]]
    ]
    if (!segmentIntersectsBbox(segment, bbox)) continue
    const key = segmentKey(segment)
    if (seen.has(key)) continue
    seen.add(key)
    features.push({
      type: 'Feature',
      properties: {},
      geometry: {
        type: 'LineString',
        coordinates: segment
      }
    })
  }
}

function writePmtiles ({ output, tiles, metadata, minZoom, maxZoom, bbox, center }) {
  tiles.sort((a, b) => a.tileId - b.tileId)

  let tileOffset = 0
  const entries = tiles.map((tile) => {
    const entry = {
      tileId: tile.tileId,
      offset: tileOffset,
      length: tile.data.length,
      runLength: 1
    }
    tileOffset += tile.data.length
    return entry
  })

  const rootDirectory = serializeDirectory(entries)
  const metadataBytes = Buffer.from(JSON.stringify(metadata), 'utf8')
  const headerLength = 127
  const rootDirectoryOffset = headerLength
  const jsonMetadataOffset = rootDirectoryOffset + rootDirectory.length
  const tileDataOffset = jsonMetadataOffset + metadataBytes.length
  const tileDataLength = tileOffset

  const header = Buffer.alloc(headerLength)
  header.writeUInt16LE(0x4d50, 0)
  header.writeUInt8(3, 7)
  writeUint64(header, 8, rootDirectoryOffset)
  writeUint64(header, 16, rootDirectory.length)
  writeUint64(header, 24, jsonMetadataOffset)
  writeUint64(header, 32, metadataBytes.length)
  writeUint64(header, 40, tileDataOffset)
  writeUint64(header, 48, 0)
  writeUint64(header, 56, tileDataOffset)
  writeUint64(header, 64, tileDataLength)
  writeUint64(header, 72, tiles.length)
  writeUint64(header, 80, entries.length)
  writeUint64(header, 88, tiles.length)
  header.writeUInt8(1, 96)
  header.writeUInt8(Compression.None, 97)
  header.writeUInt8(Compression.Gzip, 98)
  header.writeUInt8(TileType.Mvt, 99)
  header.writeUInt8(minZoom, 100)
  header.writeUInt8(maxZoom, 101)
  writeCoord(header, 102, bbox[0])
  writeCoord(header, 106, bbox[1])
  writeCoord(header, 110, bbox[2])
  writeCoord(header, 114, bbox[3])
  header.writeUInt8(center.zoom, 118)
  writeCoord(header, 119, center.longitude)
  writeCoord(header, 123, center.latitude)

  const fd = fs.openSync(output, 'w')
  try {
    fs.writeSync(fd, header)
    fs.writeSync(fd, rootDirectory)
    fs.writeSync(fd, metadataBytes)
    for (const tile of tiles) fs.writeSync(fd, tile.data)
  } finally {
    fs.closeSync(fd)
  }
}

function serializeDirectory (entries) {
  const chunks = []
  writeVarint(chunks, entries.length)

  let previousTileId = 0
  for (const entry of entries) {
    writeVarint(chunks, entry.tileId - previousTileId)
    previousTileId = entry.tileId
  }
  for (const entry of entries) writeVarint(chunks, entry.runLength)
  for (const entry of entries) writeVarint(chunks, entry.length)
  for (let i = 0; i < entries.length; i += 1) {
    const previous = entries[i - 1]
    const entry = entries[i]
    const expectedOffset = previous ? previous.offset + previous.length : 0
    writeVarint(chunks, i > 0 && entry.offset === expectedOffset ? 0 : entry.offset + 1)
  }

  return Buffer.from(chunks)
}

function writeVarint (chunks, value) {
  let remaining = value
  while (remaining > 0x7f) {
    chunks.push((remaining & 0x7f) | 0x80)
    remaining = Math.floor(remaining / 128)
  }
  chunks.push(remaining)
}

function writeUint64 (buffer, offset, value) {
  buffer.writeUInt32LE(value >>> 0, offset)
  buffer.writeUInt32LE(Math.floor(value / 4294967296), offset + 4)
}

function writeCoord (buffer, offset, value) {
  buffer.writeInt32LE(Math.round(value * 10000000), offset)
}

function resolveManifestPath (source) {
  const stat = fs.statSync(source)
  if (stat.isDirectory()) return path.join(source, 'manifest.json')
  return source
}

function segmentKey (coordinates) {
  const a = `${coordinates[0][0]},${coordinates[0][1]}`
  const b = `${coordinates[1][0]},${coordinates[1][1]}`
  return a < b ? `${a}|${b}` : `${b}|${a}`
}

function segmentIntersectsBbox (coordinates, bbox) {
  const minLon = Math.min(coordinates[0][0], coordinates[1][0])
  const maxLon = Math.max(coordinates[0][0], coordinates[1][0])
  const minLat = Math.min(coordinates[0][1], coordinates[1][1])
  const maxLat = Math.max(coordinates[0][1], coordinates[1][1])
  return maxLon >= bbox[0] && minLon <= bbox[2] && maxLat >= bbox[1] && minLat <= bbox[3]
}

function validCoordinate (coordinate) {
  return Array.isArray(coordinate) &&
    Number.isFinite(coordinate[0]) &&
    Number.isFinite(coordinate[1])
}

function bboxIntersects (a, b) {
  return a[2] >= b[0] && a[0] <= b[2] && a[3] >= b[1] && a[1] <= b[3]
}

function tileRangeForBbox (bbox, zoom) {
  const topLeft = lonLatToTile(bbox[0], bbox[3], zoom)
  const bottomRight = lonLatToTile(bbox[2], bbox[1], zoom)
  return {
    minX: topLeft.x,
    maxX: bottomRight.x,
    minY: topLeft.y,
    maxY: bottomRight.y
  }
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

function centerForBbox (bbox, zoom) {
  return {
    longitude: (bbox[0] + bbox[2]) / 2,
    latitude: (bbox[1] + bbox[3]) / 2,
    zoom
  }
}

function clamp (value, min, max) {
  return Math.min(max, Math.max(min, value))
}

function clampInteger (value, min, max) {
  return Math.trunc(clamp(value, min, max))
}

function parseArgs (argv) {
  const args = {}
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--help' || arg === '-h') args.help = true
    else if (arg === '--source' || arg === '-s') args.source = argv[++i]
    else if (arg === '--output' || arg === '-o') args.output = argv[++i]
    else if (arg === '--bbox') args.bbox = parseBbox(argv[++i])
    else if (arg === '--minzoom') args.minZoom = parseInteger(argv[++i], 'minzoom')
    else if (arg === '--maxzoom') args.maxZoom = parseInteger(argv[++i], 'maxzoom')
    else if (arg === '--layer') args.layer = argv[++i]
    else if (arg === '--name') args.name = argv[++i]
    else if (arg === '--description') args.description = argv[++i]
    else if (arg === '--attribution') args.attribution = argv[++i]
    else throw new Error(`Unknown argument: ${arg}`)
  }
  if (args.minZoom && args.maxZoom && args.minZoom > args.maxZoom) {
    throw new Error('minzoom must be lower than or equal to maxzoom')
  }
  return args
}

function parseBbox (value) {
  const bbox = String(value).split(',').map(Number)
  if (bbox.length !== 4 || bbox.some((entry) => !Number.isFinite(entry))) {
    throw new Error(`Invalid bbox: ${value}`)
  }
  if (bbox[0] >= bbox[2] || bbox[1] >= bbox[3]) {
    throw new Error(`Invalid bbox ordering: ${value}`)
  }
  return bbox
}

function parseInteger (value, name) {
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`Invalid ${name}: ${value}`)
  }
  return parsed
}

function printHelp () {
  console.log(`Usage: npm run build:coast-pmtiles -- [options]

Options:
  --source <file|dir>       Input .shp, .geojson, coast-db directory, or manifest.json
  --output <file>           Output .pmtiles file
  --bbox <minLon,minLat,maxLon,maxLat>
  --minzoom <z>             Minimum vector tile zoom, default ${DEFAULT_MIN_ZOOM}
  --maxzoom <z>             Maximum vector tile zoom, default ${DEFAULT_MAX_ZOOM}
  --layer <name>            MVT layer name, default ${DEFAULT_LAYER}
  --name <name>             Chart display name
  --description <text>      Chart description
  --attribution <text>      Chart attribution

Defaults:
  source: ${DEFAULT_SOURCE}
  output: ${DEFAULT_OUTPUT}
  bbox:   ${DEFAULT_BBOX.join(',')}
`)
}
