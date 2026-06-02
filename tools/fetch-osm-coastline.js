#!/usr/bin/env node
'use strict'

const fs = require('fs')
const https = require('https')
const path = require('path')

const DEFAULT_URL = 'https://osmdata.openstreetmap.de/download/coastlines-split-4326.zip'
const DEFAULT_OUTPUT = path.join(__dirname, '..', 'data', 'sources', 'coastlines-split-4326.zip')

main().catch((error) => {
  console.error(error.message)
  process.exitCode = 1
})

async function main () {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    printHelp()
    return
  }

  const url = args.url || DEFAULT_URL
  const output = path.resolve(args.output || DEFAULT_OUTPUT)
  fs.mkdirSync(path.dirname(output), { recursive: true })

  const size = await contentLength(url)
  if (size) {
    console.log(`Source size: ${(size / 1024 / 1024).toFixed(1)} MiB`)
  }
  console.log(`Downloading ${url}`)
  console.log(`Writing ${output}`)
  await download(url, output)
}

function contentLength (url) {
  return new Promise((resolve) => {
    const request = https.request(url, { method: 'HEAD' }, (response) => {
      if (isRedirect(response)) {
        resolve(contentLength(response.headers.location))
        return
      }
      const length = Number(response.headers['content-length'])
      resolve(Number.isFinite(length) ? length : null)
    })
    request.on('error', () => resolve(null))
    request.end()
  })
}

function download (url, output) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(output)
    const request = https.get(url, (response) => {
      if (isRedirect(response)) {
        file.close()
        fs.rmSync(output, { force: true })
        download(response.headers.location, output).then(resolve, reject)
        return
      }
      if (response.statusCode !== 200) {
        reject(new Error(`Download failed with HTTP ${response.statusCode}`))
        return
      }

      const length = Number(response.headers['content-length'])
      let received = 0
      response.on('data', (chunk) => {
        received += chunk.length
        if (Number.isFinite(length) && length > 0) {
          process.stdout.write(`\r${((received / length) * 100).toFixed(1)}%`)
        }
      })
      response.pipe(file)
      file.on('finish', () => {
        file.close(() => {
          process.stdout.write('\n')
          resolve()
        })
      })
    })
    request.on('error', reject)
    file.on('error', reject)
  })
}

function isRedirect (response) {
  return response.statusCode >= 300 && response.statusCode < 400 && response.headers.location
}

function parseArgs (argv) {
  const args = {}
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--help' || arg === '-h') args.help = true
    else if (arg === '--url') args.url = argv[++i]
    else if (arg === '--output' || arg === '-o') args.output = argv[++i]
    else throw new Error(`Unknown argument: ${arg}`)
  }
  return args
}

function printHelp () {
  console.log(`Usage: npm run fetch:coastline -- [options]

Options:
  --url <url>       Coastline ZIP URL
  --output <file>   Output ZIP path

Default source:
  ${DEFAULT_URL}
`)
}
