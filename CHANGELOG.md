# Changelog

## Unreleased

- Move world PMTiles generation and world dataset distribution to `signalk-distance-to-shore-world-coastline`.
- Remove world PMTiles assets from the plugin package.
- Use standard Signal K chart resources served by a chart provider for distance calculations.
- Remove direct chart publishing and PMTiles serving from this plugin.
- Simplify plugin configuration to `chartResourceId`, interval, and search radius.
- Use fixed Signal K input and output paths.

## 0.1.0

- Initial plugin scaffold.
- Add a precomputed coastline tile format with bundled Mediterranean and Côte d'Azur sample data.
- Publish distance to nearest coastline from `navigation.position`.
- Publish closest shore position and bearing to closest shore.
- Add OpenStreetMap coastline data build tools.
- Add PMTiles/MVT runtime support for distance calculations.
- Add a bundled French Mediterranean PMTiles chart resource for Freeboard.
- Add npm and Signal K AppStore publishing metadata.
