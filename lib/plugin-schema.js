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
        title: 'Coast index JSON path',
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
