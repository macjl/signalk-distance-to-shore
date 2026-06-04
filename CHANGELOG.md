# Changelog

## 0.2.0

- Replace breadth-first hierarchical pre-filter with a depth-first search that applies early exit at every zoom level. Once a coastline is found at distance D, any tile whose bounding box is already ≥ D away is skipped — pruning entire subtrees at coarse zoom levels before they are ever fetched. This reduces tile fetches by up to ×1900 for large search radii.
- Recover gracefully from a stale device access request after a Signal K server restart: if polling the stored request returns "not found", the request is silently recreated instead of failing permanently.

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
