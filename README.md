# Signal K Distance To Shore

Signal K plugin that publishes the distance from the vessel position to the nearest known coastline.

The plugin uses a standard Signal K chart resource served by a chart provider, such as `signalk-charts-provider-simple`. It reads coastline line geometries from vector tiles, calculates the nearest coastline from `navigation.position`, and publishes the result as Signal K paths.

This is auxiliary OpenStreetMap-derived information. It is not a certified navigation chart.

## Quick Start

The recommended setup uses the companion world coastline chart and the `signalk-charts-provider-simple` chart provider.

**1. Install the chart provider**

Install [`signalk-charts-provider-simple`](https://github.com/dirkwa/signalk-charts-provider-simple) from the Signal K AppStore, or:

```sh
npm install signalk-charts-provider-simple
```

**2. Download the world coastline chart**

Download the latest `world-display-z0-z11-runtime-z12.mbtiles.zip` from the [signalk-distance-to-shore-world-coastline releases](https://github.com/macjl/signalk-distance-to-shore-world-coastline/releases/latest), unzip it, and point `signalk-charts-provider-simple` at the directory containing the `.mbtiles` file.

The chart will be registered as `world-display-z0-z11-runtime-z12` in Signal K.

**3. Install this plugin**

Install `signalk-distance-to-shore` from the Signal K AppStore, or:

```sh
npm install signalk-distance-to-shore
```

**4. Enable and approve**

Enable the plugin in Signal K Admin UI. It defaults to the `world-display-z0-z11-runtime-z12` chart resource and a 1000 km search radius — no configuration change is needed.

On a secured server, the plugin will request chart access automatically. Approve the request in **Security › Access Requests** with `readonly` permission.

---

Other chart providers and chart sources can also be used; see *Configuration* and *Chart Resource Format* below.

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

- `chartResourceId`: Signal K chart resource identifier. Default: `world-display-z0-z11-runtime-z12`
- `searchRadiusKm`: maximum coastline search radius in kilometres. Default: `1000`
- `tickIntervalMs`: calculation interval in milliseconds. Default: `1000`
- `signalKAccessToken`: optional fallback bearer token (normally not needed — the plugin requests access automatically)

Example configuration (these are the defaults; no change is required for the recommended setup):

```json
{
  "chartResourceId": "world-display-z0-z11-runtime-z12",
  "searchRadiusKm": 1000,
  "tickIntervalMs": 1000
}
```

Thanks to the depth-first search algorithm, a 1000 km search radius costs no more than a 10 km radius in normal coastal navigation — the algorithm finds the nearest shore in a few tile fetches and discards everything else.

On secured production servers, Signal K chart resource HTTP endpoints may require authentication even when they are called from another local plugin. The plugin starts without a token. If a chart resource request returns HTTP 401, it automatically submits a Signal K device access request.

Approve the request in Signal K Admin UI under Security > Access Requests. `readonly` permission is sufficient. After approval, the plugin stores the returned device token in its local plugin data and reuses it on later starts.

`signalKAccessToken` and `SIGNALK_DISTANCE_TO_SHORE_TOKEN` are still supported as manual fallback options. If the configured token already includes the `Bearer ` prefix, the plugin keeps it as-is. Otherwise it sends it as a bearer token automatically.

## Search Algorithm

Distance calculations use a depth-first hierarchical search across zoom levels. Starting from a coarse zoom level, the algorithm visits tiles sorted by their minimum possible distance to the vessel. As soon as a coastline segment is found at distance D, any tile at any zoom level whose bounding box is already ≥ D away is skipped — pruning its entire subtree without loading it. In typical coastal navigation the nearest shore is found in the first few tiles at each zoom level, and almost everything else is discarded immediately.

This makes large search radii practical. A 1000 km radius processes roughly as fast as a 10 km radius: the algorithm dives straight to the nearest coastline and prunes the rest. Tile responses are cached between ticks; after the first tick, nearly all accesses are cache hits.

The tile cache is sized automatically based on the configured search radius.

### Correctness requirement for chart tiles

For the hierarchical pruning to be correct, the chart tile source must satisfy one invariant: **if a tile at zoom level N contains any coastline data, its parent tile at zoom N-1 must also be non-empty**, all the way up to the coarsest zoom level used. Without this guarantee, the algorithm could discard a coarse tile as empty and miss real coastline that only appears at finer zoom levels.

The world coastline dataset from `signalk-distance-to-shore-world-coastline` is built to honour this invariant: even the shortest coastline segment at zoom 12 propagates upward through all parent tiles. Custom chart sources must enforce the same property in their tile build pipeline.

## Chart Resource Format

The configured Signal K chart resource must be:

- vector MVT/PBF tiles
- line geometries
- coastline layer named `coastline`
- zoom `12` available for distance calculations

Zooms `0` to `11` are useful for Freeboard display, but the runtime distance calculation uses zoom `12`.

The plugin validates the chart resource metadata at startup. If the resource is raster, missing the `coastline` layer, or missing zoom 12, it reports a clear error in the plugin status.

Custom chart sources must also satisfy the parent-tile invariant described under *Search Algorithm*: every tile that contains coastline data must have non-empty ancestors at all coarser zoom levels.

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
