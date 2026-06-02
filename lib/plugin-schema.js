'use strict'

function buildSchema () {
  return {
    type: 'object',
    title: 'Distance To Shore',
    description: 'Publishes distance from navigation.position to the nearest known coastline segment.',
    properties: {
      enabled: {
        type: 'boolean',
        title: 'Enable plugin',
        default: true
      },
      inputPositionPath: {
        type: 'string',
        title: 'Input position path',
        default: 'navigation.position'
      },
      dataPath: {
        type: 'string',
        title: 'Coast index path',
        description: 'Path to a coast-db directory, manifest.json, v1 JSON file, or PMTiles/MVT file.',
        default: ''
      },
      pmtiles: {
        type: 'object',
        title: 'PMTiles / MVT settings',
        properties: {
          layerName: {
            type: 'string',
            title: 'Coastline layer name',
            default: 'coastline'
          },
          zoom: {
            type: 'number',
            title: 'Tile zoom used for distance calculations',
            default: 12,
            minimum: 0,
            maximum: 22
          }
        }
      },
      charts: {
        type: 'object',
        title: 'Freeboard chart resource',
        properties: {
          enabled: {
            type: 'boolean',
            title: 'Publish PMTiles chart resource',
            default: true
          },
          path: {
            type: 'string',
            title: 'PMTiles chart path',
            description: 'Defaults to the bundled French Mediterranean PMTiles chart.',
            default: ''
          },
          identifier: {
            type: 'string',
            title: 'Chart resource identifier',
            default: 'distance-to-shore-french-mediterranean'
          },
          name: {
            type: 'string',
            title: 'Chart name',
            default: 'Distance To Shore Coastline - French Mediterranean'
          },
          description: {
            type: 'string',
            title: 'Chart description',
            default: 'Coastline used by signalk-distance-to-shore for the French Mediterranean area.'
          }
        }
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
      },
      publishing: {
        type: 'object',
        title: 'Published paths',
        properties: {
          source: {
            type: 'string',
            title: 'Signal K source label',
            default: 'signalk-distance-to-shore'
          },
          distancePath: {
            type: 'string',
            title: 'Distance path',
            default: 'navigation.distanceToShore'
          },
          closestPointPath: {
            type: 'string',
            title: 'Closest shore point path',
            default: 'navigation.shore.closestPoint'
          },
          bearingTruePath: {
            type: 'string',
            title: 'Bearing to closest shore path',
            default: 'navigation.shore.bearingTrue'
          }
        }
      }
    }
  }
}

module.exports = {
  buildSchema
}
