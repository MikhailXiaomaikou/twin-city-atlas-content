// Build the bundled basemap tiles for the atlas: open data → compact JSON tiles under basemap/<city>/{z}/{x}/{y}.json
// Sources (all open licences, see README): Natural Earth 10m (public domain), TfL open data via oobrien/vis,
// OS OpenData boundaries, PCT route network (OSM/CycleStreets), a central-London OSM extract (pgraph-python).
import fs from 'node:fs';
import path from 'node:path';
import geojsonvt from 'geojson-vt';

const DATA = path.resolve(process.argv[2] || '../data');
const OUT = path.resolve(process.argv[3] || '../out');
const EXTENT = 4096;
const load = (f) => JSON.parse(fs.readFileSync(path.join(DATA, f), 'utf8'));
const fc = (features) => ({ type: 'FeatureCollection', features });
const feat = (geometry, properties = {}) => ({ type: 'Feature', properties, geometry });

/* ------------------------------------------------------------------ geometry helpers */
function bboxOf(geom) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const walk = (c) => {
    if (typeof c[0] === 'number') { if (c[0] < x0) x0 = c[0]; if (c[0] > x1) x1 = c[0]; if (c[1] < y0) y0 = c[1]; if (c[1] > y1) y1 = c[1]; return; }
    for (const x of c) walk(x);
  };
  walk(geom.coordinates);
  return [x0, y0, x1, y1];
}
const overlaps = (a, b) => a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];
function clipFC(features, bbox) { return features.filter((f) => f.geometry && overlaps(bboxOf(f.geometry), bbox)); }
function centroid(ring) {
  let a = 0, cx = 0, cy = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const f = ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
    a += f; cx += (ring[j][0] + ring[i][0]) * f; cy += (ring[j][1] + ring[i][1]) * f;
  }
  if (!a) return ring[0];
  return [cx / (3 * a), cy / (3 * a)];
}
function largestRing(geom) {
  const rings = geom.type === 'Polygon' ? [geom.coordinates[0]] : geom.coordinates.map((p) => p[0]);
  let best = rings[0], bestA = -1;
  for (const r of rings) {
    let a = 0;
    for (let i = 0, j = r.length - 1; i < r.length; j = i++) a += r[j][0] * r[i][1] - r[i][0] * r[j][1];
    if (Math.abs(a) > bestA) { bestA = Math.abs(a); best = r; }
  }
  return best;
}
// tile ranges for a lon/lat bbox at zoom z
function tileRange(bbox, z) {
  const n = 2 ** z;
  const tx = (lon) => Math.floor(((lon + 180) / 360) * n);
  const ty = (lat) => { const r = (lat * Math.PI) / 180; return Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n); };
  return { x0: Math.max(0, tx(bbox[0])), x1: Math.min(n - 1, tx(bbox[2])), y0: Math.max(0, ty(bbox[3])), y1: Math.min(n - 1, ty(bbox[1])) };
}

/* ------------------------------------------------------------------ Natural Earth (shared) */
function naturalEarth(region) {
  const ne = (f) => clipFC(load(`ne/${f}.geojson`).features, region);
  const land = ne('ne_10m_land').map((f) => feat(f.geometry));
  const lakes = ne('ne_10m_lakes').concat(ne('ne_10m_lakes_europe')).map((f) => feat(f.geometry, { n: f.properties.name || '' }));
  const rivers = ne('ne_10m_rivers_lake_centerlines').concat(ne('ne_10m_rivers_europe'))
    .map((f) => feat(f.geometry, { n: f.properties.name || '', r: Math.round(f.properties.scalerank || 9) }));
  const urban = ne('ne_10m_urban_areas').map((f) => feat(f.geometry));
  const admin = ne('ne_10m_admin_0_boundary_lines_land').map((f) => feat(f.geometry));
  const roads = ne('ne_10m_roads').map((f) => feat(f.geometry, { t: /Major/.test(f.properties.type) ? 2 : /Secondary/.test(f.properties.type) ? 1 : 0 }));
  const rail = ne('ne_10m_railroads').map((f) => feat(f.geometry));
  const places = ne('ne_10m_populated_places').map((f) => feat(f.geometry, {
    n: f.properties.NAME, z: f.properties.NAME_ZH || '', r: f.properties.SCALERANK, p: f.properties.POP_MAX || 0, c: f.properties.FEATURECLA && /capital/i.test(f.properties.FEATURECLA) ? 1 : 0,
  }));
  return { land, lakes, rivers, urban, admin, roads, rail, places };
}

/* ------------------------------------------------------------------ London layers */
const TFL_LINES = {
  Bakerloo: 'bakerloo', Central: 'central', Circle: 'circle', District: 'district', 'Hammersmith & City': 'hc', Jubilee: 'jubilee',
  Metropolitan: 'metropolitan', Northern: 'northern', Piccadilly: 'piccadilly', Victoria: 'victoria', 'Waterloo & City': 'wc',
  DLR: 'dlr', 'London Overground': 'overground', 'Elizabeth line': 'elizabeth', Tramlink: 'tram', 'Cable Car': 'cable', 'Emirates Air Line': 'cable',
  'IFS Cloud Cable Car': 'cable',
};
function londonLayers(bbox) {
  const out = {};
  // water: the Thames (OS VectorMap District via oobrien/vis)
  out.thames = load('london/thames.json').features.map((f) => feat(f.geometry));
  // boroughs: outlines + label points
  const boroughs = load('london/boroughs_hq.geojson').features;
  out.boro = boroughs.map((f) => feat({ type: 'MultiLineString', coordinates: f.geometry.type === 'Polygon' ? f.geometry.coordinates : f.geometry.coordinates.flat() }));
  out.borolbl = boroughs.map((f) => feat({ type: 'Point', coordinates: centroid(largestRing(f.geometry)) }, { n: f.properties.name.replace(/ upon Thames$/, '').replace(/^Kensington and Chelsea$/, 'Kensington & Chelsea').replace(/^Hammersmith and Fulham$/, 'Hammersmith & Fulham').replace(/^Barking and Dagenham$/, 'Barking & Dagenham') }));
  // ward centroids as neighbourhood names
  out.ward = load('london/london_wards_2011_centroids.json').features
    .map((f) => feat(f.geometry, { n: String(f.properties.name || '').replace(/ Ward$/i, '').replace(/\s*\(.*\)$/, '') }))
    .filter((f) => f.properties.n && f.properties.n.length < 28);
  // TfL road network: road polygons
  out.tlrn = load('london/tlrn.json').features.map((f) => feat(f.geometry));
  // OSM-based route network (PCT): every street a cycle route uses; busier segments drawn earlier
  out.rnet = load('london/rnet_full.geojson').features.map((f) => feat(f.geometry, { c: (f.properties.bicycle || 0) >= 40 ? 2 : (f.properties.bicycle || 0) >= 8 ? 1 : 0 }));
  // central London streets with names (OSM extract)
  const pg = load('london/pgraph_london.json');
  const nodes = new Map(Object.entries(pg.nodes).map(([id, ll]) => [String(id), [ll[1], ll[0]]]));
  out.street = [];
  for (const [name, , ids] of pg.ways) {
    const coords = ids.map((i) => nodes.get(String(i))).filter(Boolean);
    if (coords.length >= 2) out.street.push(feat({ type: 'LineString', coordinates: coords }, { n: name && name !== 'null' ? name : '' }));
  }
  // National Rail lines and stations (clipped), TfL lines and stations
  out.rail = clipFC(load('london/nr_lines.json').features, bbox).map((f) => feat(f.geometry));
  const tfl = [];
  for (const f of load('london/tfl_lines.json').features) {
    const lines = (f.properties.lines || []).filter((l) => !(l.opened && l.opened > 2026) && !(l.closed && l.closed <= 2026) && !/Crossrail 2|Thameslink/.test(l.name));
    if (!lines.length) continue;
    const keys = Array.from(new Set(lines.map((l) => TFL_LINES[l.name] || 'other'))).filter((k) => k !== 'other');
    if (!keys.length) continue;
    tfl.push(feat(f.geometry, { k: keys.join(',') }));
  }
  out.tfl = tfl;
  const stations = [];
  const seen = new Set();
  for (const f of load('london/tfl_stations.json').features) {
    const names = (f.properties.lines || []).map((l) => l.name);
    const keys = Array.from(new Set(names.map((n) => TFL_LINES[n] || 'other')));
    const tube = keys.some((k) => !['overground', 'elizabeth', 'tram', 'cable', 'dlr', 'other'].includes(k));
    stations.push(feat(f.geometry, { n: f.properties.name, k: tube ? 't' : keys.includes('dlr') ? 'd' : 'o', m: keys.length }));
    seen.add(f.properties.name.toLowerCase().replace(/ (station|rail station)$/, ''));
  }
  for (const f of clipFC(load('london/nr_stations.json').features, bbox)) {
    const n = String(f.properties.name || '').trim();
    if (!n || seen.has(n.toLowerCase())) continue;
    stations.push(feat(f.geometry, { n, k: 'r', m: 1 }));
  }
  out.stn = stations;
  return out;
}

/* ------------------------------------------------------------------ tile encoding */
// geojson-vt tile feature → [tags, [flat ring/line ...]] with integer coordinates in the 0..4096 tile space
function encode(f, tagFn) {
  const geom = f.type === 1 ? [f.geometry.flat()] : f.geometry.map((part) => part.flat());
  const tags = tagFn ? tagFn(f.tags || {}) : 0;
  return tags === 0 ? [0, geom] : [tags, geom];
}

const CITIES = {
  london: {
    region: [-12, 46, 11, 61.5],
    city: [-0.66, 51.21, 0.37, 51.75],
    cityZoom: [9, 14],
  },
  fuzhou: {
    region: [111, 19.5, 126, 32.5],
    city: [118.85, 25.72, 119.8, 26.5],
    cityZoom: [9, 13],
  },
};

function buildCity(key) {
  const C = CITIES[key];
  const ne = naturalEarth(C.region);
  const layers = [
    // name, features, minZ, maxZ, {buffer, tolerance, tag}
    ['land', ne.land, 3, 14, { buffer: 32, tolerance: 2 }],
    ['lake', ne.lakes, 3, 14, { buffer: 32, tolerance: 2, tag: (t) => t.n || 0 }],
    ['river', ne.rivers, 3, 14, { buffer: 32, tolerance: 2, tag: (t) => [t.n, t.r] }],
    ['urban', ne.urban, 5, 10, { buffer: 16, tolerance: 4 }],
    ['admin', ne.admin, 3, 10, { buffer: 16, tolerance: 2 }],
    ['neroad', ne.roads, 5, 14, { buffer: 32, tolerance: 2, tag: (t) => t.t }],
    ['nerail', ne.rail, 6, 8, { buffer: 32, tolerance: 2 }],
    ['place', ne.places, 3, 10, { buffer: 0, tolerance: 0, tag: (t) => [t.n, t.z, t.r, t.c] }],
  ];
  if (key === 'london') {
    const L = londonLayers(C.city);
    layers.push(
      ['water', L.thames, 9, 14, { buffer: 32, tolerance: 2 }],
      ['boro', L.boro, 9, 14, { buffer: 8, tolerance: 3 }],
      ['borolbl', L.borolbl, 9, 12, { buffer: 0, tolerance: 0, tag: (t) => t.n }],
      ['ward', L.ward, 13, 14, { buffer: 0, tolerance: 0, tag: (t) => t.n }],
      ['tlrn', L.tlrn, 10, 14, { buffer: 32, tolerance: 2 }],
      ['rnet', L.rnet, 11, 14, { buffer: 32, tolerance: 2, tag: (t) => t.c, minZByTag: (t) => (t.c === 2 ? 11 : t.c === 1 ? 12 : 13) }],
      ['street', L.street, 13, 14, { buffer: 32, tolerance: 1, tag: (t) => t.n || 0 }],
      ['rail', L.rail, 9, 14, { buffer: 32, tolerance: 2 }],
      ['tfl', L.tfl, 9, 14, { buffer: 32, tolerance: 2, tag: (t) => t.k }],
      ['stn', L.stn, 11, 14, { buffer: 0, tolerance: 0, tag: (t) => [t.n, t.k, t.m], minZByTag: (t) => (t.k === 't' && t.m >= 2 ? 11 : t.k === 't' ? 12 : 13) }],
    );
  }
  const indexes = layers.map(([name, features, minZ, maxZ, o]) => {
    const feats = o.minZByTag ? features : features;
    const idx = new geojsonvt(fc(feats), { maxZoom: maxZ, indexMaxZoom: Math.min(maxZ, 6), indexMaxPoints: 100000, buffer: o.buffer, tolerance: o.tolerance, extent: EXTENT });
    return { name, minZ, maxZ, idx, tag: o.tag, minZByTag: o.minZByTag };
  });
  const index = {};
  let files = 0, bytes = 0;
  const dir = path.join(OUT, key);
  fs.rmSync(dir, { recursive: true, force: true });
  for (let z = 3; z <= C.cityZoom[1]; z += 1) {
    const bbox = z >= C.cityZoom[0] ? C.city : C.region;
    const r = tileRange(bbox, z);
    index[z] = [];
    for (let x = r.x0; x <= r.x1; x += 1) {
      for (let y = r.y0; y <= r.y1; y += 1) {
        const tile = {};
        let any = false;
        for (const L of indexes) {
          if (z < L.minZ || z > L.maxZ) continue;
          const t = L.idx.getTile(z, x, y);
          if (!t || !t.features.length) continue;
          const items = [];
          for (const f of t.features) {
            if (L.minZByTag && z < L.minZByTag(f.tags || {})) continue;
            items.push(encode(f, L.tag));
          }
          if (items.length) { tile[L.name] = items; any = true; }
        }
        if (!any) continue;
        const p = path.join(dir, String(z), String(x));
        fs.mkdirSync(p, { recursive: true });
        const s = JSON.stringify(tile);
        fs.writeFileSync(path.join(p, `${y}.json`), s);
        files += 1; bytes += s.length;
        index[z].push(x, y);
      }
    }
  }
  fs.writeFileSync(path.join(dir, 'index.json'), JSON.stringify({ zoom: [3, C.cityZoom[1]], city: C.city, cityZoom: C.cityZoom, tiles: index }));
  console.log(key, 'tiles', files, 'bytes', (bytes / 1e6).toFixed(1), 'MB', Object.fromEntries(Object.entries(index).map(([z, a]) => [z, a.length / 2])));
}

for (const key of (process.argv[4] || 'london,fuzhou').split(',')) buildCity(key);
