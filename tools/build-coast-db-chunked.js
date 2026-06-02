#!/usr/bin/env node
'use strict'

const fs = require('fs')
const path = require('path')
const zlib = require('zlib')

const DEFAULT_ZOOM = 12
const DEFAULT_SCALE = 10000000
const DEFAULT_BBOX = [-180, -85.05112878, 180, 85.05112878]
const DEFAULT_CHUNK_SIZE = 128

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

  const source = path.resolve(required(args.source, 'source'))
  const output = path.resolve(required(args.output, 'output'))
  const bbox = args.bbox || DEFAULT_BBOX
  const zoom = args.zoom || DEFAULT_ZOOM
  const scale = args.scale || DEFAULT_SCALE
  const chunkSize = args.chunkSize || DEFAULT_CHUNK_SIZE
  const name = args.name || path.basename(output)
  const startedAt = Date.now()

  fs.rmSync(output, { recursive: true, force: true })
  fs.mkdirSync(path.join(output, 'tiles'), { recursive: true })

  const worldMin = lonLatToTile(bbox[0], bbox[3], zoom)
  const worldMax = lonLatToTile(bbox[2], bbox[1], zoom)
  const manifestTiles = []
  let segmentReferences = 0
  let chunkNumber = 0

  for (let xStart = worldMin.x; xStart <= worldMax.x; xStart += chunkSize) {
    const xEnd = Math.min(worldMax.x, xStart + chunkSize - 1)
    chunkNumber += 1
    const chunkStartedAt = Date.now()
    const tiles = await buildChunk(source, { bbox, zoom, scale, xStart, xEnd })
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
    const elapsed = ((Date.now() - chunkStartedAt) / 1000).toFixed(1)
    console.log(`Chunk ${chunkNumber}: x ${xStart}-${xEnd}, tiles ${tiles.length}, elapsed ${elapsed} s`)
    if (global.gc) global.gc()
  }

  manifestTiles.sort((a, b) => a.id.localeCompare(b.id))
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

async function buildChunk (source, options) {
  const shapefile = require('shapefile')
  const byId = new Map()
  const collection = await shapefile.open(source)

  while (true) {
    const result = await collection.read()
    if (result.done) break
    addGeometrySegments(byId, result.value.geometry, options)
  }

  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id))
}

function addGeometrySegments (byId, geometry, options) {
  if (!geometry) return
  if (geometry.type === 'LineString') {
    addLineSegments(byId, geometry.coordinates, options)
  } else if (geometry.type === 'MultiLineString') {
    for (const line of geometry.coordinates) addLineSegments(byId, line, options)
  } else if (geometry.type === 'GeometryCollection') {
    for (const child of geometry.geometries) addGeometrySegments(byId, child, options)
  }
}

function addLineSegments (byId, coordinates, options) {
  for (let i = 1; i < coordinates.length; i += 1) {
    const start = coordinates[i - 1]
    const end = coordinates[i]
    if (!validCoordinate(start) || !validCoordinate(end)) continue
    const segment = [
      [start[0], start[1]],
      [end[0], end[1]]
    ]
    if (!segmentIntersectsBbox(segment, options.bbox)) continue
    addSegmentTiles(byId, segment, options)
  }
}

function addSegmentTiles (byId, segment, options) {
  const minLon = Math.min(segment[0][0], segment[1][0])
  const maxLon = Math.max(segment[0][0], segment[1][0])
  const minLat = Math.min(segment[0][1], segment[1][1])
  const maxLat = Math.max(segment[0][1], segment[1][1])
  const topLeft = lonLatToTile(minLon, maxLat, options.zoom)
  const bottomRight = lonLatToTile(maxLon, minLat, options.zoom)
  const xStart = Math.max(topLeft.x, options.xStart)
  const xEnd = Math.min(bottomRight.x, options.xEnd)
  if (xStart > xEnd) return

  const quantized = quantizeSegment(segment, options.scale)
  for (let x = xStart; x <= xEnd; x += 1) {
    for (let y = topLeft.y; y <= bottomRight.y; y += 1) {
      const id = `${options.zoom}-${x}-${y}`
      if (!byId.has(id)) {
        byId.set(id, {
          id,
          z: options.zoom,
          x,
          y,
          bbox: tileBounds(x, y, options.zoom),
          segments: []
        })
      }
      byId.get(id).segments.push(quantized)
    }
  }
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
    else if (arg === '--zoom' || arg === '-z') args.zoom = parseInteger(argv[++i], 'zoom')
    else if (arg === '--scale') args.scale = parseInteger(argv[++i], 'scale')
    else if (arg === '--chunk-size') args.chunkSize = parseInteger(argv[++i], 'chunk-size')
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

function required (value, name) {
  if (!value) throw new Error(`Missing required --${name}`)
  return value
}

function printHelp () {
  console.log(`Usage: node tools/build-coast-db-chunked.js --source <lines.shp> --output <dir> [options]

Options:
  --source <file>        Input .shp file
  --output <dir>         Output coast DB directory
  --bbox <minLon,minLat,maxLon,maxLat>
  --zoom <z>             Web Mercator tile zoom, default ${DEFAULT_ZOOM}
  --scale <n>            Coordinate quantization scale, default ${DEFAULT_SCALE}
  --chunk-size <n>       Number of tile columns per pass, default ${DEFAULT_CHUNK_SIZE}
  --name <name>          Database name
`)
}
