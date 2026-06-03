'use strict'

function buildSchema () {
  return {
    type: 'object',
    title: 'Distance To Shore',
    description: 'Publishes distance from navigation.position to the nearest known coastline segment.',
    properties: {
      pmtilesPath: {
        type: 'string',
        title: 'PMTiles coastline file',
        description: 'Path to a PMTiles v3 / MVT file containing coastline line geometries in a coastline layer. Blank uses the bundled French Mediterranean sample.',
        default: ''
      },
      publishChartResource: {
        type: 'boolean',
        title: 'Publish Freeboard chart resource',
        default: true
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
