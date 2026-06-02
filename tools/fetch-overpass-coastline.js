#!/usr/bin/env node
'use strict'

const fs = require('fs')
const https = require('https')
const path = require('path')

const DEFAULT_ENDPOINT = 'https://overpass-api.de/api/interpreter'
const DEFAULT_BBOX = [6.6, 42.9, 7.8, 43.9]
const DEFAULT_OUTPUT = path.join(__dirname, '..', 'data', 'sources', 'cote-azur-coastline.geojson')

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

  const bbox = args.bbox || DEFAULT_BBOX
  const output = path.resolve(args.output || DEFAULT_OUTPUT)
  const endpoint = args.endpoint || DEFAULT_ENDPOINT
  fs.mkdirSync(path.dirname(output), { recursive: true })

  const query = buildQuery(bbox)
  console.log(`Fetching OSM coastline from Overpass for bbox ${bbox.join(',')}`)
  const response = await post(endpoint, query)
  const geojson = overpassToGeoJson(JSON.parse(response), bbox)
  fs.writeFileSync(output, `${JSON.stringify(geojson, null, 2)}\n`)
  console.log(`Wrote ${output}`)
  console.log(`Features: ${geojson.features.length}`)
}

function buildQuery (bbox) {
  const [minLon, minLat, maxLon, maxLat] = bbox
  return `[out:json][timeout:180];
way["natural"="coastline"](${minLat},${minLon},${maxLat},${maxLon});
out geom;`
}

function post (endpoint, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(endpoint)
    const payload = `data=${encodeURIComponent(body)}`
    const request = https.request({
      method: 'POST',
      hostname: url.hostname,
      path: `${url.pathname}${url.search}`,
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'content-length': Buffer.byteLength(payload),
        'accept': 'application/json',
        'user-agent': 'signalk-distance-to-shore/0.1.0'
      }
    }, (response) => {
      let data = ''
      response.setEncoding('utf8')
      response.on('data', (chunk) => { data += chunk })
      response.on('end', () => {
        if (response.statusCode !== 200) {
          reject(new Error(`Overpass returned HTTP ${response.statusCode}: ${data.slice(0, 200)}`))
          return
        }
        resolve(data)
      })
    })
    request.on('error', reject)
    request.end(payload)
  })
}

function overpassToGeoJson (data, bbox) {
  const features = []
  for (const element of data.elements || []) {
    if (element.type !== 'way' || !Array.isArray(element.geometry) || element.geometry.length < 2) continue
    features.push({
      type: 'Feature',
      properties: {
        osmType: element.type,
        osmId: element.id,
        tags: element.tags || {}
      },
      geometry: {
        type: 'LineString',
        coordinates: element.geometry.map((node) => [node.lon, node.lat])
      }
    })
  }

  return {
    type: 'FeatureCollection',
    generator: 'signalk-distance-to-shore/tools/fetch-overpass-coastline.js',
    source: 'OpenStreetMap natural=coastline via Overpass API',
    bbox,
    fetchedAt: new Date().toISOString(),
    features
  }
}

function parseArgs (argv) {
  const args = {}
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--help' || arg === '-h') args.help = true
    else if (arg === '--bbox') args.bbox = parseBbox(argv[++i])
    else if (arg === '--output' || arg === '-o') args.output = argv[++i]
    else if (arg === '--endpoint') args.endpoint = argv[++i]
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

function printHelp () {
  console.log(`Usage: npm run fetch:coastline:bbox -- [options]

Options:
  --bbox <minLon,minLat,maxLon,maxLat>
  --output <file>
  --endpoint <url>

Default bbox:
  ${DEFAULT_BBOX.join(',')}
`)
}
