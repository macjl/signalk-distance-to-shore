#!/usr/bin/env node
'use strict'

const fs = require('fs')
const path = require('path')
const zlib = require('zlib')

const DEFAULT_SOURCE = path.join(__dirname, '..', 'data', 'sources', 'coastlines-split-4326.zip')
const DEFAULT_OUTPUT = path.join(__dirname, '..', 'data', 'coast-db', 'cote-azur')
const DEFAULT_BBOX = [6.6, 42.9, 7.8, 43.9]
const DEFAULT_ZOOM = 10
const DEFAULT_SCALE = 10000000

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

  const source = path.resolve(args.source || DEFAULT_SOURCE)
  const output = path.resolve(args.output || DEFAULT_OUTPUT)
  const bbox = args.bbox || DEFAULT_BBOX
  const zoom = args.zoom || DEFAULT_ZOOM
  const scale = args.scale || DEFAULT_SCALE
  const name = args.name || path.basename(output)

  const startedAt = Date.now()
  const segments = await readSegments(source, bbox)
  if (segments.length === 0) {
    throw new Error(`No coastline segments found in bbox ${bbox.join(',')}`)
  }

  const tiles = buildTiles(segments, { zoom, scale })
  writeTileDb({ output, name, bbox, zoom, scale, source, tiles, startedAt })
}

async function readSegments (source, bbox) {
  if (!fs.existsSync(source)) {
    throw new Error(`Source file does not exist: ${source}`)
  }

  const extension = path.extname(source).toLowerCase()
  if (extension === '.json' || extension === '.geojson') {
    return readGeoJsonSegments(source, bbox)
  }
  if (extension === '.zip') {
    return readShapefileZipSegments(source, bbox)
  }
  if (extension === '.shp') {
    return readShapefileSegments(source, bbox)
  }

  throw new Error(`Unsupported source format: ${extension}`)
}

function readGeoJsonSegments (source, bbox) {
  const geojson = JSON.parse(fs.readFileSync(source, 'utf8'))
  const features = geojson.type === 'FeatureCollection'
    ? geojson.features
    : [{ type: 'Feature', geometry: geojson, properties: {} }]

  const segments = []
  for (const feature of features) {
    addGeometrySegments(segments, feature.geometry, bbox)
  }
  return segments
}

async function readShapefileZipSegments (source, bbox) {
  const tempDir = fs.mkdtempSync(path.join(path.dirname(source), '.coast-shp-'))
  try {
    await extractZip(source, tempDir)
    const shp = findFirstFile(tempDir, '.shp')
    if (!shp) throw new Error(`No .shp file found in ${source}`)
    return await readShapefileSegments(shp, bbox)
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true })
  }
}

function extractZip (source, outputDir) {
  const yauzl = require('yauzl')
  return new Promise((resolve, reject) => {
    yauzl.open(source, { lazyEntries: true }, (openError, zipfile) => {
      if (openError) {
        reject(openError)
        return
      }

      zipfile.readEntry()
      zipfile.on('entry', (entry) => {
        if (/\/$/.test(entry.fileName)) {
          zipfile.readEntry()
          return
        }

        const entryPath = path.resolve(outputDir, entry.fileName)
        const safeOutputDir = path.resolve(outputDir)
        if (!entryPath.startsWith(`${safeOutputDir}${path.sep}`)) {
          reject(new Error(`Unsafe zip entry path: ${entry.fileName}`))
          zipfile.close()
          return
        }

        fs.mkdirSync(path.dirname(entryPath), { recursive: true })
        zipfile.openReadStream(entry, (streamError, readStream) => {
          if (streamError) {
            reject(streamError)
            return
          }

          const writeStream = fs.createWriteStream(entryPath)
          readStream.pipe(writeStream)
          writeStream.on('finish', () => {
            zipfile.readEntry()
          })
          writeStream.on('error', reject)
          readStream.on('error', reject)
        })
      })
      zipfile.on('end', resolve)
      zipfile.on('error', reject)
    })
  })
}

async function readShapefileSegments (source, bbox) {
  const shapefile = require('shapefile')
  const segments = []
  const collection = await shapefile.open(source)
  while (true) {
    const result = await collection.read()
    if (result.done) break
    addGeometrySegments(segments, result.value.geometry, bbox)
  }
  return segments
}

function addGeometrySegments (segments, geometry, bbox) {
  if (!geometry) return
  if (geometry.type === 'LineString') {
    addLineSegments(segments, geometry.coordinates, bbox)
  } else if (geometry.type === 'MultiLineString') {
    for (const line of geometry.coordinates) addLineSegments(segments, line, bbox)
  } else if (geometry.type === 'GeometryCollection') {
    for (const child of geometry.geometries) addGeometrySegments(segments, child, bbox)
  }
}

function addLineSegments (segments, coordinates, bbox) {
  for (let i = 1; i < coordinates.length; i += 1) {
    const start = coordinates[i - 1]
    const end = coordinates[i]
    if (!validCoordinate(start) || !validCoordinate(end)) continue
    const segment = [
      [start[0], start[1]],
      [end[0], end[1]]
    ]
    if (segmentIntersectsBbox(segment, bbox)) segments.push(segment)
  }
}

function buildTiles (segments, options) {
  const byId = new Map()
  for (const segment of segments) {
    for (const tile of segmentTiles(segment, options.zoom)) {
      const id = `${tile.z}-${tile.x}-${tile.y}`
      if (!byId.has(id)) {
        byId.set(id, {
          id,
          z: tile.z,
          x: tile.x,
          y: tile.y,
          bbox: tileBounds(tile.x, tile.y, tile.z),
          segments: []
        })
      }
      byId.get(id).segments.push(quantizeSegment(segment, options.scale))
    }
  }
  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id))
}

function writeTileDb ({ output, name, bbox, zoom, scale, source, tiles, startedAt }) {
  fs.rmSync(output, { recursive: true, force: true })
  fs.mkdirSync(path.join(output, 'tiles'), { recursive: true })

  let segmentReferences = 0
  const manifestTiles = []
  for (const tile of tiles) {
    const tilePath = path.join('tiles', `${tile.z}-${tile.x}-${tile.y}.json.gz`)
    const payload = {
      version: 2,
      id: tile.id,
      tile: { z: tile.z, x: tile.x, y: tile.y },
      bbox: tile.bbox,
      scale,
      segments: tile.segments
    }
    fs.writeFileSync(path.join(output, tilePath), zlib.gzipSync(JSON.stringify(payload)))
    segmentReferences += tile.segments.length
    manifestTiles.push({
      id: tile.id,
      z: tile.z,
      x: tile.x,
      y: tile.y,
      bbox: tile.bbox,
      path: tilePath,
      scale,
      segmentCount: tile.segments.length
    })
  }

  const manifest = {
    version: 2,
    name,
    generatedAt: new Date().toISOString(),
    source: path.basename(source),
    bbox,
    tileZoom: zoom,
    scale,
    tileCount: manifestTiles.length,
    segmentReferenceCount: segmentReferences,
    tiles: manifestTiles
  }
  fs.writeFileSync(path.join(output, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)

  const elapsedSeconds = (Date.now() - startedAt) / 1000
  console.log(`Wrote ${output}`)
  console.log(`Tiles: ${manifest.tileCount}`)
  console.log(`Segment references: ${manifest.segmentReferenceCount}`)
  console.log(`Elapsed: ${elapsedSeconds.toFixed(1)} s`)
}

function segmentTiles (segment, zoom) {
  const minLon = Math.min(segment[0][0], segment[1][0])
  const maxLon = Math.max(segment[0][0], segment[1][0])
  const minLat = Math.min(segment[0][1], segment[1][1])
  const maxLat = Math.max(segment[0][1], segment[1][1])
  const topLeft = lonLatToTile(minLon, maxLat, zoom)
  const bottomRight = lonLatToTile(maxLon, minLat, zoom)
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

function tileBounds (x, y, z) {
  const n = 2 ** z
  const minLon = x / n * 360 - 180
  const maxLon = (x + 1) / n * 360 - 180
  const maxLat = tileYToLatitude(y, n)
  const minLat = tileYToLatitude(y + 1, n)
  return [minLon, minLat, maxLon, maxLat]
}

function tileYToLatitude (y, n) {
  const rad = Math.atan(Math.sinh(Math.PI * (1 - 2 * y / n)))
  return rad * 180 / Math.PI
}

function quantizeSegment (segment, scale) {
  return [
    Math.round(segment[0][0] * scale),
    Math.round(segment[0][1] * scale),
    Math.round(segment[1][0] * scale),
    Math.round(segment[1][1] * scale)
  ]
}

function segmentIntersectsBbox (segment, bbox) {
  const minLon = Math.min(segment[0][0], segment[1][0])
  const maxLon = Math.max(segment[0][0], segment[1][0])
  const minLat = Math.min(segment[0][1], segment[1][1])
  const maxLat = Math.max(segment[0][1], segment[1][1])
  return maxLon >= bbox[0] && minLon <= bbox[2] && maxLat >= bbox[1] && minLat <= bbox[3]
}

function validCoordinate (coordinate) {
  return Array.isArray(coordinate) &&
    Number.isFinite(coordinate[0]) &&
    Number.isFinite(coordinate[1])
}

function findFirstFile (dir, extension) {
  const entries = fs.readdirSync(dir, { withFileTypes: true })
  for (const entry of entries) {
    const entryPath = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      const found = findFirstFile(entryPath, extension)
      if (found) return found
    } else if (entry.name.toLowerCase().endsWith(extension)) {
      return entryPath
    }
  }
  return null
}

function parseArgs (argv) {
  const args = {}
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--help' || arg === '-h') args.help = true
    else if (arg === '--source' || arg === '-s') args.source = argv[++i]
    else if (arg === '--output' || arg === '-o') args.output = argv[++i]
    else if (arg === '--bbox') args.bbox = parseBbox(argv[++i])
    else if (arg === '--zoom' || arg === '-z') args.zoom = parseInteger(argv[++i], 'zoom')
    else if (arg === '--scale') args.scale = parseInteger(argv[++i], 'scale')
    else if (arg === '--name') args.name = argv[++i]
    else throw new Error(`Unknown argument: ${arg}`)
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
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Invalid ${name}: ${value}`)
  }
  return parsed
}

function clamp (value, min, max) {
  return Math.min(max, Math.max(min, value))
}

function clampInteger (value, min, max) {
  return Math.trunc(clamp(value, min, max))
}

function printHelp () {
  console.log(`Usage: npm run build:coast-db -- [options]

Options:
  --source <file>        Input .zip, .shp, .geojson, or .json
  --output <dir>         Output coast DB directory
  --bbox <minLon,minLat,maxLon,maxLat>
  --zoom <z>             Web Mercator tile zoom, default ${DEFAULT_ZOOM}
  --scale <n>            Coordinate quantization scale, default ${DEFAULT_SCALE}
  --name <name>          Database name

Defaults:
  source: ${DEFAULT_SOURCE}
  output: ${DEFAULT_OUTPUT}
  bbox:   ${DEFAULT_BBOX.join(',')}
`)
}
