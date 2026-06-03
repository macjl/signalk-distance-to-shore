# Signal K Distance To Shore

Signal K plugin that publishes the distance from the vessel position to the nearest known coastline.

The plugin uses a PMTiles v3 archive containing Mapbox Vector Tiles. It reads coastline line geometries, calculates the nearest coastline from `navigation.position`, and publishes the result as Signal K paths.

This is auxiliary OpenStreetMap-derived information. It is not a certified navigation chart.

## Installation

Install from the Signal K AppStore once the package is available, or manually from a Signal K server configuration directory:

```sh
npm install signalk-distance-to-shore
```

Then enable and configure the plugin from the Signal K Admin UI.

## Published Paths

The plugin always reads:

- `navigation.position`

The plugin always publishes:

- `navigation.distanceToShore`
- `navigation.shore.closestPoint`
- `navigation.shore.bearingTrue`

All distances are in meters. Bearings are in radians, following normal Signal K conventions.

## Configuration

The user-facing options are intentionally small:

- `pmtilesPath`: path to the active PMTiles coastline file
- `publishChartResource`: publish the active PMTiles file as a Signal K chart resource for Freeboard
- `tickIntervalMs`: calculation interval, default `1000`
- `searchRadiusMeters`: maximum coastline search radius, default `10000`

If `pmtilesPath` is blank, the plugin uses the bundled French Mediterranean sample:

```text
data/charts/french-mediterranean.pmtiles
```

For a real installation, place PMTiles files in a persistent Signal K data directory, for example:

```text
~/.signalk/plugin-config-data/distance-to-shore/charts/
```

The directory may contain multiple `.pmtiles` files. The plugin does not choose automatically between them: `pmtilesPath` selects the single active file used for both distance calculations and the Freeboard chart resource. This keeps behavior predictable when several regional or world datasets are installed.

## PMTiles Format

The configured file must be:

- PMTiles v3
- MVT tile type
- line geometries
- coastline layer named `coastline`
- zoom `12` available for distance calculations

Zooms `0` to `11` are useful for Freeboard display, but the runtime distance calculation uses zoom `12`.

Example configuration:

```json
{
  "pmtilesPath": "/home/node/.signalk/plugin-config-data/distance-to-shore/charts/world-display-z0-z11-runtime-z12.pmtiles",
  "publishChartResource": true,
  "tickIntervalMs": 1000,
  "searchRadiusMeters": 10000
}
```

## World Coastline Dataset

A world PMTiles dataset is available in a separate GitHub repository:

https://github.com/macjl/signalk-distance-to-shore-world-coastline

That repository documents the source data, generation commands, checksums, and GitHub release asset.

The world archive uses:

- `z0-z11`: simplified tiles for display
- `z12`: precise tiles for distance calculations
- layer: `coastline`

Download the release asset and configure `pmtilesPath` to point to the downloaded file.

## Freeboard Chart Resource

When `publishChartResource` is true, the plugin registers the active PMTiles file as a Signal K `charts` resource.

It also serves the archive from:

```text
/plugins/distance-to-shore/charts/<file-name>.pmtiles
```

This lets Freeboard display the exact coastline layer used by the plugin as a map overlay. The layer is auxiliary debug/awareness data, not a certified navigation chart.

## Data Attribution

The bundled and downloadable coastline data is derived from OpenStreetMap and must keep appropriate attribution.

- OpenStreetMap contributors
- https://www.openstreetmap.org/copyright

## Simulator Use

The sailboat simulator can consume `navigation.distanceToShore` and stop the virtual boat when the value is below a configured clearance, for example 20 meters.

It can also consume `navigation.shore.bearingTrue` to allow recovery headings away from shore when the boat is already too close.

