#!/bin/sh
# Download the open data the bundled basemap is built from (see README.md). Usage: sh fetch.sh <data-dir>
set -e
D=${1:-data}
mkdir -p "$D/ne" "$D/london"
NE=https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson
for f in ne_10m_land ne_10m_lakes ne_10m_lakes_europe ne_10m_rivers_lake_centerlines ne_10m_rivers_europe ne_10m_urban_areas \
         ne_10m_admin_0_boundary_lines_land ne_10m_roads ne_10m_railroads ne_10m_populated_places; do
  curl -sSL -o "$D/ne/$f.geojson" "$NE/$f.geojson"
done
O=https://raw.githubusercontent.com/oobrien/vis/master
curl -sSL -o "$D/london/tlrn.json" "$O/london_boundaries/london_tfl_road_network_tlrn.json"
curl -sSL -o "$D/london/thames.json" "$O/tubecreature/data/river_thames_simp.json"
curl -sSL -o "$D/london/nr_lines.json" "$O/tubecreature/data/nr_lines.json"
curl -sSL -o "$D/london/nr_stations.json" "$O/tubecreature/data/nr_stations.json"
curl -sSL -o "$D/london/tfl_lines.json" "$O/tubecreature/data/tfl_lines.json"
curl -sSL -o "$D/london/tfl_stations.json" "$O/tubecreature/data/tfl_stations.json"
curl -sSL -o "$D/london/london_wards_2011_centroids.json" "$O/tubecreature/data/london_wards_2011_centroids.json"
curl -sSL -o "$D/london/boroughs_hq.geojson" https://raw.githubusercontent.com/radoi90/housequest-data/master/london_boroughs.geojson
curl -sSL -o "$D/london/pgraph_london.json" https://raw.githubusercontent.com/petercorke/pgraph-python/master/examples/london.json
curl -sSL -o "$D/london/rnet_full.geojson" https://media.githubusercontent.com/media/npct/pct-outputs-regional-notR/master/commute/lsoa/london/rnet_full.geojson
echo "done: $D"
