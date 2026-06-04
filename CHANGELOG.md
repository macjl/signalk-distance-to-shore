# Changelog

## 0.2.0

### Distance calculation — depth-first hierarchical search

The distance calculation algorithm has been completely rearchitected for efficiency.

**Previous behaviour (≤ 0.1.3):** the plugin fetched all chart tiles at zoom 12 that fall within the search radius before computing any distance. For a 1000 km search radius this meant fetching and decoding roughly 41 600 tiles per calculation tick, with almost no benefit from caching because the working set far exceeded the tile cache.

**New behaviour:** the search now uses a depth-first descent through successive zoom levels, visiting the tiles geometrically closest to the vessel first at each level. As soon as a coastline segment is found at distance D, any tile — at any zoom level — whose bounding box is already ≥ D away is pruned along with its entire subtree, without ever fetching it. In coastal navigation (where the nearest shore is typically only a few kilometres away) this means the algorithm reaches the answer after visiting only a handful of tiles per level and immediately discards everything farther.

Measured on a vessel near the French Riviera with a 1000 km search radius: tile fetches dropped from ~753 HTTP requests per tick to ~0.4, a ×1900 reduction. Nearly all accessed tiles are warm in the small on-board cache, so subsequent ticks cost essentially nothing.

Large search radii (tens or hundreds of kilometres) are now practical without any measurable CPU or network overhead.

### Configuration changes

- `chartResourceId` now defaults to `world-display-z0-z11-runtime-z12`, matching the chart identifier produced by `signalk-charts-provider-simple` when serving the `signalk-distance-to-shore-world-coastline` dataset. No manual configuration is needed for the recommended setup.
- The search radius setting has been renamed from `searchRadiusMeters` to `searchRadiusKm` and now defaults to `1000` km. Existing configurations that stored `searchRadiusMeters` are automatically migrated.

### Authentication — recovery from stale device access request

After a Signal K server restart the pending device access request stored on disk becomes invalid. Previously the plugin would repeatedly fail with an "unable to check request" error and never recover without manual intervention (deleting the state file). The plugin now detects the "not found" error returned by the server, discards the stale request reference, and automatically submits a fresh access request on the next tick.

## 0.1.3

- Store the Signal K access request token through the official plugin data directory API.

## 0.1.2

- Automatically submit a Signal K device access request when chart resources return HTTP 401.
- Persist the approved device token in local plugin data and reuse it on later starts.
- Keep manual bearer token configuration as a fallback.

## 0.1.1

- Add optional Signal K access token support for secured chart resource endpoints.
- Improve HTTP 401 errors with production authentication guidance.

## 0.1.0

- Move world PMTiles generation and world dataset distribution to `signalk-distance-to-shore-world-coastline`.
- Remove world PMTiles assets from the plugin package.
- Use standard Signal K chart resources served by a chart provider for distance calculations.
- Remove direct chart publishing and PMTiles serving from this plugin.
- Simplify plugin configuration to `chartResourceId`, interval, and search radius.
- Use fixed Signal K input and output paths.
- Initial plugin scaffold.
- Add a precomputed coastline tile format with bundled Mediterranean and Côte d'Azur sample data.
- Publish distance to nearest coastline from `navigation.position`.
- Publish closest shore position and bearing to closest shore.
- Add OpenStreetMap coastline data build tools.
- Add PMTiles/MVT runtime support for distance calculations.
- Add a bundled French Mediterranean PMTiles chart resource for Freeboard.
- Add npm and Signal K AppStore publishing metadata.
