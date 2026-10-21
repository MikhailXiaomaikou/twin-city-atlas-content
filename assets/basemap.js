/* 双城图志 · bundled basemap
 *
 * A vector basemap drawn by this script from compact JSON tiles in basemap/<city>/{z}/{x}/{y}.json, so the map works
 * without any third-party tile server. The tiles are built from open data (Natural Earth, OpenStreetMap-derived
 * networks, OS OpenData boundaries, TfL open data); see README. Two Leaflet layers: a GridLayer that paints the
 * geometry of each tile on a canvas, and a label layer that places names once per view with collision checks.
 *
 * window.TCABasemap.create({ map, city, base, theme, font }) → { grid, labels, setTheme, addTo, remove, ready }
 */
(function (root) {
  'use strict';

  const EXTENT = 4096;
  const TILE = 256;
  const CACHE_MAX = 600;

  // Official TfL line colours.
  const TFL_COLORS = {
    bakerloo: '#B36305', central: '#E32017', circle: '#FFD300', district: '#00782A', hc: '#F3A9BB', jubilee: '#A0A5A9',
    metropolitan: '#9B0056', northern: '#000000', piccadilly: '#003688', victoria: '#0098D4', wc: '#95CDBA',
    dlr: '#00A4A7', overground: '#EE7C0E', elizabeth: '#6950A1', tram: '#84B817', cable: '#E21836',
  };
  const PALETTES = {
    light: {
      water: '#c5d6e2', land: '#f0efea', urban: '#e8e6df', landLine: '#d8dfe4',
      admin: '#9aa3ab', boro: '#b9b3a9', river: '#b7cad8',
      rnet: '#ffffff', rnetCase: '#d6d2c8', street: '#ffffff', streetCase: '#cfcbc1',
      tlrn: '#fbe7b3', tlrnCase: '#e2c784', neroad: '#f2d58f', neroadCase: '#d9b86a',
      rail: '#a8a39a', railGap: '#f0efea',
      stnFill: '#ffffff', stnRing: '#30393f', railStn: '#7d8790',
      ink: '#2b343c', ink2: '#56626c', ink3: '#7a858f', halo: '#f0efea', waterInk: '#4f6f86', tflDim: 1,
    },
    dark: {
      water: '#0f161d', land: '#1b232b', urban: '#202a33', landLine: '#28323b',
      admin: '#4d5964', boro: '#3b4654', river: '#1c3040',
      rnet: '#2d3842', rnetCase: '#1b232b', street: '#333f4a', streetCase: '#1b232b',
      tlrn: '#3f4a56', tlrnCase: '#55626f', neroad: '#4c5867', neroadCase: '#5d6b7a',
      rail: '#5a6672', railGap: '#1b232b',
      stnFill: '#1b232b', stnRing: '#c8d1da', railStn: '#8a96a1',
      ink: '#d9e0e6', ink2: '#aeb9c3', ink3: '#8b97a2', halo: '#1b232b', waterInk: '#7fa3bd', tflDim: 0.85,
    },
  };

  const lon2x = (lon, z) => ((lon + 180) / 360) * 2 ** z;
  const lat2y = (lat, z) => { const r = (lat * Math.PI) / 180; return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z; };
  const key = (z, x, y) => `${z}/${x}/${y}`;

  function create(opts) {
    const L = root.L;
    const map = opts.map;
    const city = opts.city;
    const base = (opts.base || 'basemap').replace(/\/$/, '');
    let palette = PALETTES[opts.theme === 'dark' ? 'dark' : 'light'];
    const font = opts.font || '"Barlow", system-ui, "PingFang SC", "Noto Sans SC", sans-serif';
    const cache = new Map(); // tile key → data (or null for an empty tile)
    const pending = new Map();
    let index = null;
    let failed = false;
    let labelRaf = 0;

    const ready = fetch(`${base}/${city}/index.json`, { cache: 'force-cache' })
      .then((r) => { if (!r.ok) throw new Error(`index ${r.status}`); return r.json(); })
      .then((ix) => {
        index = { zoom: ix.zoom, cityZoom: ix.cityZoom, has: new Map() };
        for (const [z, arr] of Object.entries(ix.tiles)) {
          const s = new Set();
          for (let i = 0; i < arr.length; i += 2) s.add(`${arr[i]}/${arr[i + 1]}`);
          index.has.set(Number(z), s);
        }
        return index;
      })
      .catch((e) => { failed = true; if (opts.onError) opts.onError(e); throw e; });

    /** The tile actually stored for a requested tile: itself, or the nearest stored ancestor (overzoom). */
    function nativeFor(z, x, y) {
      const n = 2 ** z;
      let zz = Math.min(z, index.zoom[1]);
      let xx = Math.floor((((x % n) + n) % n) / 2 ** (z - zz));
      let yy = Math.floor(y / 2 ** (z - zz));
      while (zz >= index.zoom[0]) {
        if (index.has.get(zz) && index.has.get(zz).has(`${xx}/${yy}`)) return { z: zz, x: xx, y: yy };
        zz -= 1; xx = Math.floor(xx / 2); yy = Math.floor(yy / 2);
      }
      return null;
    }
    function loadNative(t) {
      const k = key(t.z, t.x, t.y);
      if (cache.has(k)) return Promise.resolve(cache.get(k));
      if (pending.has(k)) return pending.get(k);
      const p = fetch(`${base}/${city}/${t.z}/${t.x}/${t.y}.json`, { cache: 'force-cache' })
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null)
        .then((data) => {
          pending.delete(k);
          if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
          cache.set(k, data);
          return data;
        });
      pending.set(k, p);
      return p;
    }
    /** Data for a requested tile plus the transform from the stored tile's extent space into this tile's. */
    function tileData(z, x, y) {
      return ready.then(() => {
        const t = nativeFor(z, x, y);
        if (!t) return null;
        const d = z - t.z;
        const s = 2 ** d;
        const n = 2 ** z;
        const wx = ((x % n) + n) % n;
        const ox = (wx - t.x * s) * (EXTENT / s);
        const oy = (y - t.y * s) * (EXTENT / s);
        return loadNative(t).then((data) => (data ? { data, s, ox, oy, nz: t.z, nx: t.x, ny: t.y } : null));
      });
    }

    /* ------------------------------------------------------------------ styles */
    const lw = (z, table) => { // width in px by zoom, linear between the listed stops
      const zs = Object.keys(table).map(Number).sort((a, b) => a - b);
      if (z <= zs[0]) return table[zs[0]];
      if (z >= zs[zs.length - 1]) return table[zs[zs.length - 1]];
      for (let i = 1; i < zs.length; i += 1) if (z <= zs[i]) { const a = zs[i - 1], b = zs[i]; return table[a] + ((table[b] - table[a]) * (z - a)) / (b - a); }
      return table[zs[0]];
    };
    const W = {
      rnet: { 11: 0.6, 12: 0.8, 13: 1, 14: 1.6, 15: 2.6, 16: 4, 17: 6, 18: 9 },
      street: { 13: 0.9, 14: 1.5, 15: 2.6, 16: 4.2, 17: 6.5, 18: 10 },
      tlrn: { 10: 1, 12: 1.2, 14: 1.8, 16: 3, 18: 5 },
      neroad: { 5: 0.8, 8: 1.2, 10: 1.8, 12: 2.2, 14: 3, 16: 5 },
      rail: { 9: 0.8, 11: 1, 13: 1.4, 15: 2, 17: 3 },
      tfl: { 9: 1.2, 10: 1.5, 11: 2, 12: 2.4, 13: 2.6, 14: 3, 16: 4, 18: 6 },
      river: { 3: 0.5, 6: 0.8, 9: 1.2, 12: 2, 14: 3 },
    };

    function path(ctx, parts, T) {
      ctx.beginPath();
      for (const p of parts) {
        for (let i = 0; i < p.length; i += 2) {
          const px = (p[i] - T.ox) * T.s;
          const py = (p[i + 1] - T.oy) * T.s;
          if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
        }
      }
    }
    function strokeAll(ctx, items, T, color, width, dash, cap) {
      if (!items || !items.length || width <= 0) return;
      ctx.strokeStyle = color;
      ctx.lineWidth = width;
      ctx.lineCap = cap || 'round';
      ctx.lineJoin = 'round';
      ctx.setLineDash(dash || []);
      path(ctx, items.flatMap((it) => it[1]), T);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    function fillAll(ctx, items, T, color) {
      if (!items || !items.length) return;
      ctx.fillStyle = color;
      path(ctx, items.flatMap((it) => it[1]), T);
      ctx.fill('evenodd');
    }

    /** Paint one tile. `z` is the map zoom; T carries the stored tile and its transform; k = px per extent unit. */
    function paint(ctx, z, T, k, dpr) {
      const P = palette;
      const d = T.data;
      ctx.setTransform(dpr * k, 0, 0, dpr * k, 0, 0);
      const px = (w) => w / k; // line widths are given in CSS px
      ctx.fillStyle = P.water;
      ctx.fillRect(-EXTENT, -EXTENT, EXTENT * 3, EXTENT * 3);
      fillAll(ctx, d.land, T, P.land);
      if (z <= 10) fillAll(ctx, d.urban, T, P.urban);
      strokeAll(ctx, d.river, T, P.river, px(lw(z, W.river)));
      fillAll(ctx, d.lake, T, P.water);
      fillAll(ctx, d.water, T, P.water);
      if (z <= 10) strokeAll(ctx, d.admin, T, P.admin, px(z <= 6 ? 0.8 : 1.2), [px(4), px(3)], 'butt');
      if (d.boro) strokeAll(ctx, d.boro, T, P.boro, px(z >= 13 ? 1.2 : 0.9), [px(1.5), px(3)], 'butt');
      // streets: casing then fill, quieter roads first
      if (d.rnet) {
        const groups = [[], [], []];
        for (const it of d.rnet) groups[it[0] || 0].push(it);
        const base0 = lw(z, W.rnet);
        const widths = [base0, base0 * 1.35, base0 * 1.75];
        if (z >= 14) for (let c = 0; c < 3; c += 1) strokeAll(ctx, groups[c], T, P.rnetCase, px(widths[c] + 1.4));
        for (let c = 0; c < 3; c += 1) strokeAll(ctx, groups[c], T, P.rnet, px(widths[c]));
      }
      if (d.street) {
        const w = lw(z, W.street);
        if (z >= 14) strokeAll(ctx, d.street, T, P.streetCase, px(w + 1.6));
        strokeAll(ctx, d.street, T, P.street, px(w));
      }
      if (d.tlrn) {
        strokeAll(ctx, d.tlrn, T, P.tlrnCase, px(lw(z, W.tlrn)), null, 'butt');
        fillAll(ctx, d.tlrn, T, P.tlrn);
      }
      if (d.neroad) {
        const w = lw(z, W.neroad);
        strokeAll(ctx, d.neroad, T, P.neroadCase, px(w + 1.2));
        strokeAll(ctx, d.neroad.filter((it) => it[0] !== 2), T, P.tlrn, px(w * 0.8));
        strokeAll(ctx, d.neroad.filter((it) => it[0] === 2), T, P.neroad, px(w));
      }
      const railItems = (d.rail || []).concat(d.nerail || []);
      if (railItems.length) {
        const w = lw(z, W.rail);
        strokeAll(ctx, railItems, T, P.rail, px(w), null, 'butt');
        if (z >= 12) strokeAll(ctx, railItems, T, P.railGap, px(Math.max(0.5, w * 0.45)), [px(5), px(5)], 'butt');
      }
      if (d.tfl) {
        const w = lw(z, W.tfl);
        const byLine = new Map();
        for (const it of d.tfl) { const k0 = String(it[0]).split(',')[0]; if (!byLine.has(k0)) byLine.set(k0, []); byLine.get(k0).push(it); }
        if (z >= 13) strokeAll(ctx, d.tfl, T, P.land, px(w + 1.6));
        for (const [line, items] of byLine) strokeAll(ctx, items, T, line === 'northern' && palette === PALETTES.dark ? '#8d99a4' : TFL_COLORS[line] || P.rail, px(w));
      }
      if (d.stn && z >= 11) {
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        for (const it of d.stn) {
          const [name, kind, m] = it[0];
          const g = it[1][0];
          const x = (g[0] - T.ox) * T.s * k;
          const y = (g[1] - T.oy) * T.s * k;
          if (x < -8 || y < -8 || x > TILE + 8 || y > TILE + 8) continue;
          if (kind === 'r') {
            if (z < 13) continue;
            const r = z >= 15 ? 3.5 : 2.5;
            ctx.fillStyle = P.railStn;
            ctx.fillRect(x - r, y - r, r * 2, r * 2);
            continue;
          }
          const r = (z >= 15 ? 4.2 : z >= 13 ? 3.4 : 2.6) + (m >= 2 ? 0.9 : 0);
          ctx.beginPath();
          ctx.arc(x, y, r, 0, Math.PI * 2);
          ctx.fillStyle = P.stnFill;
          ctx.fill();
          ctx.lineWidth = m >= 2 ? 2 : 1.5;
          ctx.strokeStyle = kind === 'o' ? TFL_COLORS.overground : kind === 'd' ? TFL_COLORS.dlr : P.stnRing;
          ctx.stroke();
          void name;
        }
      }
    }

    /* ------------------------------------------------------------------ the grid layer */
    const Grid = L.GridLayer.extend({
      createTile(coords, done) {
        const dpr = Math.min(3, root.devicePixelRatio || 1);
        const tile = document.createElement('canvas');
        tile.width = TILE * dpr;
        tile.height = TILE * dpr;
        tile.style.width = `${TILE}px`;
        tile.style.height = `${TILE}px`;
        tileData(coords.z, coords.x, coords.y).then((T) => {
          const ctx = tile.getContext('2d');
          if (T) paint(ctx, coords.z, T, TILE / EXTENT, dpr);
          else { ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.fillStyle = palette.water; ctx.fillRect(0, 0, TILE, TILE); }
          done(null, tile);
          scheduleLabels();
        }).catch((e) => done(e, tile));
        return tile;
      },
      getAttribution() { return '底图数据 © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap</a> contributors · Natural Earth · OS OpenData · TfL'; },
    });
    const grid = new Grid({ tileSize: TILE, updateWhenZooming: false, keepBuffer: 2, className: 'tiles-local' });

    /* ------------------------------------------------------------------ labels */
    const Labels = L.Layer.extend({
      onAdd(m) {
        if (!m.getPane('tcaBaseLabels')) { const pane = m.createPane('tcaBaseLabels'); pane.style.zIndex = 350; pane.style.pointerEvents = 'none'; }
        this._canvas = L.DomUtil.create('canvas', 'leaflet-zoom-hide basemap-labels', m.getPane('tcaBaseLabels'));
        this._onReset = () => scheduleLabels();
        m.on('moveend zoomend viewreset resize', this._onReset);
        scheduleLabels();
      },
      onRemove(m) {
        m.off('moveend zoomend viewreset resize', this._onReset);
        if (this._canvas && this._canvas.parentNode) this._canvas.parentNode.removeChild(this._canvas);
        this._canvas = null;
      },
    });
    const labels = new Labels();

    function scheduleLabels() {
      if (labelRaf) return;
      labelRaf = root.requestAnimationFrame(() => { labelRaf = 0; drawLabels(); });
    }
    function textOf(it, layer) {
      const t = it[0];
      if (layer === 'place') return { text: t[0], sub: t[1] && t[1] !== t[0] ? t[1] : '', rank: t[2], cap: t[3] };
      if (layer === 'stn') return { text: t[0], kind: t[1], m: t[2] };
      if (layer === 'river') return { text: t[0], rank: t[1] };
      return { text: typeof t === 'string' ? t : '' };
    }
    /** Place names once per view, in priority order, skipping overlaps. */
    function drawLabels() {
      const canvas = labels._canvas;
      if (!canvas || !map || !index) return;
      const size = map.getSize();
      const dpr = Math.min(3, root.devicePixelRatio || 1);
      if (canvas.width !== size.x * dpr || canvas.height !== size.y * dpr) {
        canvas.width = size.x * dpr; canvas.height = size.y * dpr;
        canvas.style.width = `${size.x}px`; canvas.style.height = `${size.y}px`;
      }
      L.DomUtil.setPosition(canvas, map.containerPointToLayerPoint([0, 0]));
      const ctx = canvas.getContext('2d');
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, size.x, size.y);
      const z = map.getZoom();
      if (z !== Math.round(z)) return;
      const P = palette;
      const pb = map.getPixelBounds();
      const tx0 = Math.floor(pb.min.x / TILE), tx1 = Math.floor(pb.max.x / TILE);
      const ty0 = Math.floor(pb.min.y / TILE), ty1 = Math.floor(pb.max.y / TILE);
      const n = 2 ** z;
      const cands = [];
      const seen = new Set();
      const origin = map.getPixelOrigin();
      const toPt = (T, ex, ey) => { // stored-tile extent coords → container point
        const gx = ((T.nx + ex / EXTENT) * T.s) * TILE; // global pixel at zoom z
        const gy = ((T.ny + ey / EXTENT) * T.s) * TILE;
        return [gx - origin.x + map._getMapPanePos().x, gy - origin.y + map._getMapPanePos().y];
      };
      for (let x = tx0; x <= tx1; x += 1) {
        for (let y = ty0; y <= ty1; y += 1) {
          if (y < 0 || y >= n) continue;
          const t = nativeFor(z, x, y);
          if (!t) continue;
          const data = cache.get(key(t.z, t.x, t.y));
          if (!data) continue;
          const s = 2 ** (z - t.z);
          const T = { nz: t.z, nx: t.x + Math.floor(x / n) * (2 ** t.z), ny: t.y, s };
          const wx = ((x % n) + n) % n;
          // the part of the stored tile that this tile shows
          const ex0 = (wx - t.x * s) * (EXTENT / s), ey0 = (y - t.y * s) * (EXTENT / s), span = EXTENT / s;
          const inside = (ex, ey) => ex >= ex0 && ex < ex0 + span && ey >= ey0 && ey < ey0 + span;
          const pointLayers = [['place', 10, 3, 10], ['borolbl', 20, 10, 12], ['ward', 60, 13, 99], ['stn', 40, 13, 99]];
          for (const [layer, prio, zmin, zmax] of pointLayers) {
            if (!data[layer] || z < zmin || z > zmax) continue;
            for (const it of data[layer]) {
              const g = it[1][0];
              if (!inside(g[0], g[1])) continue;
              const info = textOf(it, layer);
              if (!info.text) continue;
              if (layer === 'stn' && !(info.kind !== 'r' ? (z >= 14 || (z >= 13 && info.m >= 2)) : z >= 15)) continue;
              if (layer === 'place' && info.rank > (z <= 4 ? 2 : z <= 6 ? 5 : z <= 8 ? 7 : 10)) continue;
              const id = `${layer}|${info.text}|${Math.round(g[0] / 40)}|${Math.round(g[1] / 40)}`;
              if (seen.has(id)) continue;
              seen.add(id);
              const [cx, cy] = toPt(T, g[0], g[1]);
              cands.push({ layer, info, x: cx, y: cy, prio: prio + (layer === 'place' ? info.rank : layer === 'stn' ? (info.kind === 'r' ? 8 : 3 - Math.min(3, info.m)) : 0) });
            }
          }
          const lineLayers = [['river', 30, 7, 13], ['street', 70, 15, 99]];
          for (const [layer, prio, zmin, zmax] of lineLayers) {
            if (!data[layer] || z < zmin || z > zmax) continue;
            for (const it of data[layer]) {
              const info = textOf(it, layer);
              if (!info.text) continue;
              for (const part of it[1]) {
                // the longest fairly straight run of this line, inside the tile
                const pts = [];
                for (let i = 0; i < part.length; i += 2) if (inside(part[i], part[i + 1])) pts.push(toPt(T, part[i], part[i + 1])); else if (pts.length) break;
                if (pts.length < 2) continue;
                let best = null;
                for (let i = 0; i < pts.length - 1; i += 1) {
                  let j = i + 1;
                  const a0 = Math.atan2(pts[j][1] - pts[i][1], pts[j][0] - pts[i][0]);
                  let len = Math.hypot(pts[j][0] - pts[i][0], pts[j][1] - pts[i][1]);
                  while (j + 1 < pts.length) {
                    const a1 = Math.atan2(pts[j + 1][1] - pts[j][1], pts[j + 1][0] - pts[j][0]);
                    let da = Math.abs(a1 - a0); if (da > Math.PI) da = Math.PI * 2 - da;
                    if (da > 0.35) break;
                    len += Math.hypot(pts[j + 1][0] - pts[j][0], pts[j + 1][1] - pts[j][1]);
                    j += 1;
                  }
                  if (!best || len > best.len) best = { i, j, len };
                }
                if (!best) continue;
                const a = pts[best.i], b = pts[best.j];
                const id = `${layer}|${info.text}|${Math.round((a[0] + b[0]) / 60)}|${Math.round((a[1] + b[1]) / 60)}`;
                if (seen.has(id)) continue;
                seen.add(id);
                let angle = Math.atan2(b[1] - a[1], b[0] - a[0]);
                if (angle > Math.PI / 2) angle -= Math.PI; else if (angle < -Math.PI / 2) angle += Math.PI;
                cands.push({ layer, info, x: (a[0] + b[0]) / 2, y: (a[1] + b[1]) / 2, angle, room: best.len, prio });
              }
            }
          }
        }
      }
      cands.sort((p, q) => p.prio - q.prio);
      const placed = [];
      const hit = (r) => placed.some((o) => r.x0 < o.x1 && r.x1 > o.x0 && r.y0 < o.y1 && r.y1 > o.y0);
      ctx.textBaseline = 'middle';
      ctx.lineJoin = 'round';
      let count = 0;
      for (const c of cands) {
        if (count > 260) break;
        let size = 11, weight = '500', color = P.ink2, dy = 0, italic = false, anchor = 'left', upper = false, spacing = 0;
        if (c.layer === 'place') { size = c.info.rank <= 1 ? 14 : c.info.rank <= 4 ? 12.5 : 11; weight = c.info.rank <= 4 ? '700' : '500'; color = P.ink; anchor = 'center'; }
        else if (c.layer === 'borolbl') { size = z >= 12 ? 12.5 : 11.5; weight = '600'; color = P.ink3; anchor = 'center'; upper = true; spacing = 1; }
        else if (c.layer === 'ward') { size = 11; weight = '500'; color = P.ink3; anchor = 'center'; italic = true; }
        else if (c.layer === 'stn') { size = c.info.m >= 2 ? 11.5 : 10.5; weight = c.info.m >= 2 ? '600' : '500'; color = c.info.kind === 'r' ? P.ink3 : P.ink; dy = c.info.kind === 'r' ? 9 : 10; anchor = 'center'; }
        else if (c.layer === 'river') { size = 11.5; italic = true; color = P.waterInk; anchor = 'center'; }
        else if (c.layer === 'street') { size = 10.5; color = P.ink2; anchor = 'center'; }
        const text = upper ? c.info.text.toUpperCase() : c.info.text;
        ctx.font = `${italic ? 'italic ' : ''}${weight} ${size}px ${font}`;
        if (spacing && 'letterSpacing' in ctx) ctx.letterSpacing = `${spacing}px`; else if ('letterSpacing' in ctx) ctx.letterSpacing = '0px';
        const w = ctx.measureText(text).width;
        if (c.angle != null && c.room < w + 10) continue;
        let rect;
        if (c.angle != null) {
          const hw = (w + 6) / 2, hh = size * 0.7;
          const ex = Math.abs(Math.cos(c.angle)) * hw + Math.abs(Math.sin(c.angle)) * hh;
          const ey = Math.abs(Math.sin(c.angle)) * hw + Math.abs(Math.cos(c.angle)) * hh;
          rect = { x0: c.x - ex, x1: c.x + ex, y0: c.y - ey, y1: c.y + ey };
        } else {
          const x0 = anchor === 'center' ? c.x - w / 2 - 2 : c.x + 4;
          rect = { x0, x1: x0 + w + 4, y0: c.y + dy - size * 0.65, y1: c.y + dy + size * 0.65 };
        }
        if (rect.x1 < 0 || rect.y1 < 0 || rect.x0 > size.x || rect.y0 > size.y) continue;
        if (hit(rect)) continue;
        placed.push(rect);
        count += 1;
        ctx.save();
        ctx.translate(c.x, c.y + dy);
        if (c.angle != null) ctx.rotate(c.angle);
        ctx.textAlign = anchor === 'center' ? 'center' : 'left';
        const tx = anchor === 'center' ? 0 : 6;
        ctx.lineWidth = 3;
        ctx.strokeStyle = P.halo;
        ctx.strokeText(text, tx, 0);
        ctx.fillStyle = color;
        ctx.fillText(text, tx, 0);
        if (c.layer === 'place' && c.info.sub && z <= 8) {
          ctx.font = `400 ${Math.max(9, size - 3)}px ${font}`;
          ctx.strokeText(c.info.sub, tx, size);
          ctx.fillStyle = P.ink3;
          ctx.fillText(c.info.sub, tx, size);
        }
        ctx.restore();
      }
    }

    return {
      grid,
      labels,
      ready,
      get failed() { return failed; },
      setTheme(theme) {
        const next = PALETTES[theme === 'dark' ? 'dark' : 'light'];
        if (next === palette) return;
        palette = next;
        if (grid._map) grid.redraw();
        scheduleLabels();
      },
      addTo(m) { grid.addTo(m); labels.addTo(m); grid.bringToBack(); return this; },
      remove() { if (grid._map) grid.remove(); if (labels._map) labels.remove(); },
    };
  }

  root.TCABasemap = { create, TFL_COLORS, PALETTES };
})(window);
