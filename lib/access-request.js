'use strict'

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

const DEFAULT_SIGNAL_K_BASE_URL = 'http://127.0.0.1:3000'

function createAccessRequestManager (options = {}) {
  const signalKBaseUrl = options.signalKBaseUrl || DEFAULT_SIGNAL_K_BASE_URL
  const fetchImpl = options.fetchImpl || globalThis.fetch
  if (typeof fetchImpl !== 'function') throw new Error('No fetch implementation available for Signal K access requests')

  const stateFile = options.stateFile || defaultStateFile(options)
  let state = loadState(stateFile)
  if (!state.clientId) {
    state.clientId = crypto.randomUUID()
    saveState(stateFile, state)
  }

  return {
    getStoredToken: () => stringOr(state.accessToken),
    getClientId: () => state.clientId,
    getPendingHref: () => stringOr(state.requestHref),
    clearToken,
    requestAccess,
    pollAccessRequest
  }

  function clearToken () {
    state.accessToken = ''
    state.tokenExpirationTime = ''
    saveState(stateFile, state)
  }

  async function requestAccess () {
    if (state.requestHref) return pollAccessRequest()

    const response = await fetchJson('/signalk/v1/access/requests', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        clientId: state.clientId,
        description: options.description || 'Signal K Distance To Shore'
      })
    })

    return handleAccessReply(response)
  }

  async function pollAccessRequest () {
    if (!state.requestHref) return { state: 'IDLE' }
    const response = await fetchJson(state.requestHref)
    return handleAccessReply(response)
  }

  function handleAccessReply (reply) {
    if (!reply || typeof reply !== 'object') {
      throw new Error('Signal K access request returned an invalid response')
    }

    if (reply.state === 'PENDING') {
      state.requestHref = reply.href || state.requestHref || requestHrefFromId(reply.requestId)
      saveState(stateFile, state)
      return { state: 'PENDING', href: state.requestHref, clientId: state.clientId }
    }

    const accessRequest = reply.accessRequest || {}
    if (reply.state === 'COMPLETED' && accessRequest.permission === 'APPROVED' && accessRequest.token) {
      state.accessToken = accessRequest.token
      state.tokenExpirationTime = accessRequest.expirationTime || ''
      state.requestHref = ''
      saveState(stateFile, state)
      return {
        state: 'APPROVED',
        accessToken: state.accessToken,
        expirationTime: state.tokenExpirationTime,
        clientId: state.clientId
      }
    }

    if (reply.state === 'COMPLETED' && accessRequest.permission === 'DENIED') {
      state.requestHref = ''
      saveState(stateFile, state)
      return { state: 'DENIED', clientId: state.clientId }
    }

    if (reply.state === 'COMPLETED' && reply.statusCode) {
      state.requestHref = ''
      saveState(stateFile, state)
      return {
        state: 'ERROR',
        statusCode: reply.statusCode,
        message: reply.message || `Signal K access request completed with HTTP ${reply.statusCode}`,
        clientId: state.clientId
      }
    }

    throw new Error(`Unsupported Signal K access request state '${reply.state || 'unknown'}'`)
  }

  async function fetchJson (urlOrPath, init) {
    const url = new URL(urlOrPath, signalKBaseUrl)
    const response = await fetchImpl(url.toString(), init)
    const data = await readJson(response)
    if (!response || !response.ok) {
      const message = data && data.message ? data.message : `Signal K access request returned HTTP ${response && response.status}`
      const error = new Error(message)
      error.statusCode = response && response.status
      error.reply = data
      throw error
    }
    return data
  }
}

function isAuthRequiredError (error) {
  return Boolean(error && (error.code === 'SIGNALK_AUTH_REQUIRED' || error.statusCode === 401))
}

function defaultStateFile (options) {
  const pluginId = options.pluginId || 'distance-to-shore'
  if (options.app && typeof options.app.getDataDirPath === 'function') {
    return path.join(options.app.getDataDirPath(), 'access-state.json')
  }

  const root = options.configPath || process.cwd()
  return path.join(root, 'plugin-config-data', pluginId, 'access-state.json')
}

function loadState (stateFile) {
  try {
    return JSON.parse(fs.readFileSync(stateFile, 'utf8'))
  } catch (error) {
    return {}
  }
}

function saveState (stateFile, state) {
  fs.mkdirSync(path.dirname(stateFile), { recursive: true })
  fs.writeFileSync(stateFile, JSON.stringify(state, null, 2))
}

async function readJson (response) {
  if (!response) return null
  const text = await response.text()
  if (!text) return null
  try {
    return JSON.parse(text)
  } catch (error) {
    return { message: text }
  }
}

function requestHrefFromId (requestId) {
  return requestId ? `/signalk/v1/requests/${requestId}` : ''
}

function stringOr (value) {
  return typeof value === 'string' && value.trim() ? value.trim() : ''
}

module.exports = {
  createAccessRequestManager,
  isAuthRequiredError
}
