'use strict'

function buildSchema () {
  return {
    type: 'object',
    title: 'Distance To Shore',
    description: 'Publishes distance from navigation.position to the nearest known coastline segment.',
    properties: {
      chartResourceId: {
        type: 'string',
        title: 'Chart resource identifier',
        description: 'Signal K chart resource served by a chart provider. It must be a vector MVT/PBF tilelayer with a coastline layer and zoom 12.',
        default: ''
      },
      signalKAccessToken: {
        type: 'string',
        title: 'Signal K access token',
        description: 'Optional fallback bearer token. When left empty, the plugin automatically requests Signal K device access after the first authenticated chart resource HTTP 401.',
        default: ''
      },
      tickIntervalMs: {
        type: 'number',
        title: 'Calculation interval in milliseconds',
        default: 1000,
        minimum: 250
      },
      searchRadiusMeters: {
        type: 'number',
        title: 'Maximum coastline search radius in meters',
        default: 10000,
        minimum: 20
      }
    }
  }
}

module.exports = {
  buildSchema
}
