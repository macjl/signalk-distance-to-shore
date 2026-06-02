'use strict'

const EARTH_RADIUS_METERS = 6371008.8

function distanceToSegmentMeters (position, start, end) {
  const origin = {
    latitude: position.latitude,
    longitude: position.longitude
  }
  const point = project(position, origin)
  const a = project(start, origin)
  const b = project(end, origin)
  const closest = closestPointOnSegment(point, a, b)

  return {
    distance: Math.hypot(point.x - closest.x, point.y - closest.y),
    closestPoint: unproject(closest, origin)
  }
}

function bearingTrue (from, to) {
  const lat1 = toRad(from.latitude)
  const lat2 = toRad(to.latitude)
  const deltaLon = toRad(to.longitude - from.longitude)
  const y = Math.sin(deltaLon) * Math.cos(lat2)
  const x = Math.cos(lat1) * Math.sin(lat2) -
    Math.sin(lat1) * Math.cos(lat2) * Math.cos(deltaLon)

  return wrap360Rad(Math.atan2(y, x))
}

function expandBboxMeters (bbox, meters) {
  const minLat = bbox[1]
  const maxLat = bbox[3]
  const centerLat = (minLat + maxLat) / 2
  const latDelta = metersToLatitudeDegrees(meters)
  const lonDelta = metersToLongitudeDegrees(meters, centerLat)

  return [
    bbox[0] - lonDelta,
    bbox[1] - latDelta,
    bbox[2] + lonDelta,
    bbox[3] + latDelta
  ]
}

function pointInBbox (position, bbox) {
  return position.longitude >= bbox[0] &&
    position.latitude >= bbox[1] &&
    position.longitude <= bbox[2] &&
    position.latitude <= bbox[3]
}

function metersToLatitudeDegrees (meters) {
  return toDeg(meters / EARTH_RADIUS_METERS)
}

function metersToLongitudeDegrees (meters, latitude) {
  const cosLat = Math.max(0.01, Math.cos(toRad(latitude)))
  return toDeg(meters / (EARTH_RADIUS_METERS * cosLat))
}

function project (position, origin) {
  const lat = toRad(position.latitude)
  const lon = toRad(position.longitude)
  const originLat = toRad(origin.latitude)
  const originLon = toRad(origin.longitude)

  return {
    x: (lon - originLon) * Math.cos(originLat) * EARTH_RADIUS_METERS,
    y: (lat - originLat) * EARTH_RADIUS_METERS
  }
}

function unproject (point, origin) {
  const originLat = toRad(origin.latitude)
  const originLon = toRad(origin.longitude)

  return {
    latitude: toDeg((point.y / EARTH_RADIUS_METERS) + originLat),
    longitude: normalizeLongitude(toDeg((point.x / (Math.cos(originLat) * EARTH_RADIUS_METERS)) + originLon))
  }
}

function closestPointOnSegment (point, start, end) {
  const dx = end.x - start.x
  const dy = end.y - start.y
  const lengthSquared = dx * dx + dy * dy

  if (lengthSquared === 0) return start

  const t = clamp(((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSquared, 0, 1)
  return {
    x: start.x + t * dx,
    y: start.y + t * dy
  }
}

function clamp (value, min, max) {
  return Math.min(max, Math.max(min, value))
}

function normalizeLongitude (longitude) {
  return ((longitude + 540) % 360) - 180
}

function wrap360Rad (angle) {
  const fullCircle = 2 * Math.PI
  return ((angle % fullCircle) + fullCircle) % fullCircle
}

function toRad (degrees) {
  return degrees * Math.PI / 180
}

function toDeg (radians) {
  return radians * 180 / Math.PI
}

module.exports = {
  bearingTrue,
  distanceToSegmentMeters,
  expandBboxMeters,
  pointInBbox
}
