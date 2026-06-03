# Signal K Distance To Shore

Signal K plugin that publishes the distance from the vessel position to the nearest known coastline.

The plugin uses a standard Signal K chart resource served by a chart provider, such as `signalk-charts-provider-simple`. It reads coastline line geometries from vector tiles, calculates the nearest coastline from `navigation.position`, and publishes the result as Signal K paths.

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

- `chartResourceId`: Signal K chart resource identifier to use for calculations
- `signalKAccessToken`: optional Signal K bearer token when chart resources require authentication
- `tickIntervalMs`: calculation interval, default `1000`
- `searchRadiusMeters`: maximum coastline search radius, default `10000`

Example configuration:

```json
{
  "chartResourceId": "world-display-z0-z11-runtime-z12",
  "tickIntervalMs": 1000,
  "searchRadiusMeters": 10000
}
```

On secured production servers, Signal K chart resource HTTP endpoints may require authentication even when they are called from another local plugin. In that case, create a Signal K access token and set `signalKAccessToken`, or provide the same value with the `SIGNALK_DISTANCE_TO_SHORE_TOKEN` environment variable.

If the token already includes the `Bearer ` prefix, the plugin keeps it as-is. Otherwise it sends it as a bearer token automatically.

## Chart Resource Format

The configured Signal K chart resource must be:

- vector MVT/PBF tiles
- line geometries
- coastline layer named `coastline`
- zoom `12` available for distance calculations

Zooms `0` to `11` are useful for Freeboard display, but the runtime distance calculation uses zoom `12`.

The plugin validates the chart resource metadata at startup. If the resource is raster, missing the `coastline` layer, or missing zoom 12, it reports a clear error in the plugin status.

## World Coastline Dataset

A world coastline dataset and build tooling are maintained in a separate GitHub repository:

https://github.com/macjl/signalk-distance-to-shore-world-coastline

That repository documents the source data, generation commands, checksums, and release assets. Install the generated chart in a Signal K chart provider, then configure this plugin with the chart resource identifier reported by the provider.

The world archive uses:

- `z0-z11`: simplified tiles for display
- `z12`: precise tiles for distance calculations
- layer: `coastline`

The chart provider may expose several chart resources from the same directory. This plugin does not auto-select between them: `chartResourceId` selects the single resource used for distance calculations.

## Freeboard Chart Resource

This plugin does not publish or serve chart resources. Use the configured chart provider to expose the same coastline chart to Freeboard. This keeps chart distribution, discovery, and display in the standard chart provider path, while this plugin focuses only on distance calculations.

## Data Attribution

The bundled and downloadable coastline data is derived from OpenStreetMap and must keep appropriate attribution.

- OpenStreetMap contributors
- https://www.openstreetmap.org/copyright

## Simulator Use

The sailboat simulator can consume `navigation.distanceToShore` and stop the virtual boat when the value is below a configured clearance, for example 20 meters.

It can also consume `navigation.shore.bearingTrue` to allow recovery headings away from shore when the boat is already too close.
