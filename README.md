# Signal K Distance To Shore

Signal K plugin that publishes the distance from the vessel position to the nearest known coastline.

This plugin intentionally uses an unsigned distance model: it does not try to decide whether the vessel is on land or at sea. It reports how close the position is to a known coast segment, which is useful for display, rules, alerts and simulators that need a minimum shore clearance.

The bundled dataset is derived from OpenStreetMap coastline data. It is non-certified auxiliary information, not a navigation chart.

## Installation

Install from the Signal K AppStore once the package is available, or manually from a Signal K server configuration directory:

```sh
npm install signalk-distance-to-shore
```

Then enable and configure the plugin from the Signal K Admin UI.

By default the plugin reads:

- `navigation.position`

And publishes:

- `navigation.distanceToShore`
- `navigation.shore.closestPoint`
- `navigation.shore.bearingTrue`

All distances are in meters. Bearings are in radians, following normal Signal K conventions.

## Configuration

Main options:

- `inputPositionPath`: Signal K position path to read, default `navigation.position`
- `dataPath`: custom coast database path; blank uses the bundled Mediterranean dataset
- `tickIntervalMs`: calculation interval, default `1000`
- `searchRadiusMeters`: maximum coast search radius, default `10000`
- `publishing.distancePath`: output distance path, default `navigation.distanceToShore`
- `publishing.closestPointPath`: output closest coast position path, default `navigation.shore.closestPoint`
- `publishing.bearingTruePath`: output bearing to closest coast path, default `navigation.shore.bearingTrue`

## Data Format

The runtime coastline database is precomputed into a tiled JSON gzip format:

```text
data/coast-db/mediterranean/
  manifest.json
  tiles/
    12-2129-1495.json.gz
```

The plugin also supports the original development fixture format:

```json
{
  "version": 1,
  "tiles": [
    {
      "id": "rough-antibes-main",
      "bbox": [7.02, 43.52, 7.20, 43.66],
      "segments": [
        [[7.05, 43.56], [7.08, 43.57]]
      ]
    }
  ]
}
```

Coordinates are stored as `[longitude, latitude]`. Each tile has a bounding box `[minLon, minLat, maxLon, maxLat]`.

The default dataset is `data/coast-db/mediterranean`, generated from the processed OpenStreetMap `natural=coastline` shapefile for a broad Mediterranean bbox. The smaller `data/coast-db/cote-azur` dataset is kept as a fast development fixture, and `data/rough-antibes-v1.json` is kept as a minimal fallback fixture.

## Building Coast Data

For a local area, fetch coastline data from OSM Overpass:

```sh
npm run fetch:coastline:bbox -- --bbox 6.6,42.9,7.8,43.9 --output data/sources/cote-azur-coastline.geojson
```

Then build the optimized tiled database:

```sh
npm run build:coast-db -- --source data/sources/cote-azur-coastline.geojson --output data/coast-db/cote-azur --bbox 6.6,42.9,7.8,43.9 --zoom 12 --name cote-azur-osm
```

To build the Mediterranean dataset from the processed OSM coastline shapefile:

```sh
npm run fetch:coastline
npm run build:coast-db -- --source data/sources/coastlines-split-4326.zip --output data/coast-db/mediterranean --bbox -6,30,37,46.5 --zoom 12 --name mediterranean-osm
```

For larger production datasets, download the processed OSM coastline shapefile:

```sh
npm run fetch:coastline
```

The default download is `https://osmdata.openstreetmap.de/download/coastlines-split-4326.zip`. It is large, so the Overpass flow is preferable for small development regions.

## Data Attribution

The generated coastline data is derived from OpenStreetMap and must keep appropriate OpenStreetMap attribution.

- © OpenStreetMap contributors
- https://www.openstreetmap.org/copyright

Treat the data as non-certified auxiliary information, not as a navigation chart.

## Simulator Use

The sailboat simulator can consume `navigation.distanceToShore` and stop the virtual boat when the value is below a configured clearance, for example 20 meters.

It can also consume `navigation.shore.bearingTrue` to allow recovery headings away from shore when the boat is already too close.

## Publishing

The package is discoverable by the Signal K AppStore through the `signalk-node-server-plugin` keyword. The GitHub release workflow publishes to npm, following the same pattern as `signalk-compass-calibrator`.
