/* 双城图志 · Twin City Atlas — front end.
 * Plain ES2020, no build step, no framework. Reads content.json (read-only, treated as untrusted text:
 * every data string reaches the DOM through textContent / attributes, never innerHTML).
 */
(function () {
  'use strict';

  /* ------------------------------------------------------------------ constants */

  const CONTENT_PATH = 'content.json';
  const PUBLIC_CONTENT_URL = 'https://mikhailxiaomaikou.github.io/twin-city-atlas-content/content.json';
  const DAY = 86400000;
  const STALE_DAYS = 30;
  // Date-only verification stamps in the data are midnights in China Standard Time (e.g. 1788624000000 =
  // 2026-09-06 00:00 UTC+8), so verification dates are read on that clock for both cities.
  const VERIFY_TZ = 'Asia/Shanghai';
  const STORE_CITY = 'tca.city';
  const STORE_THEME = 'tca.theme';
  const TOKEN_RE = /^[A-Za-z0-9._~-]+$/;
  const EARTH_RADIUS_KM = 6371.0088;

  const CITIES = {
    LONDON: { key: 'LONDON', zh: '伦敦', en: 'London', token: 'london', tz: 'Europe/London', ref: { lat: 51.5073, lng: -0.1276, label: 'Charing Cross' } },
    FUZHOU: { key: 'FUZHOU', zh: '福州', en: 'Fuzhou', token: 'fuzhou', tz: 'Asia/Shanghai', ref: { lat: 26.0761, lng: 119.2969, label: '城区参考点' } },
  };
  const CITY_ORDER = ['LONDON', 'FUZHOU'];

  const CATEGORIES = {
    CULTURE: { glyph: '文', zh: '文化', terms: '文化 博物馆 美术馆 展览 历史 寺 culture museum gallery' },
    COURSE: { glyph: '课', zh: '课程', terms: '课程 培训 学习 讲座 course class' },
    FOOD: { glyph: '食', zh: '美食', terms: '美食 食物 小吃 市场 餐饮 food market' },
    NATURE: { glyph: '园', zh: '自然', terms: '自然 公园 园 山 湖 nature park' },
    CHESS: { glyph: '棋', zh: '棋类', terms: '棋 国际象棋 围棋 棋会 chess go' },
    SCHOOL: { glyph: '校', zh: '校园', terms: '校园 学校 大学 school campus university' },
  };
  const CATEGORY_ORDER = Object.keys(CATEGORIES);

  const STATUS = {
    SCHEDULED: { zh: '已排期' },
    CONFIRMED: { zh: '已确认' },
    OPEN: { zh: '开放报名' },
    TENTATIVE: { zh: '待确认', warn: true },
    POSTPONED: { zh: '已延期', warn: true },
    RESCHEDULED: { zh: '已改期', warn: true },
    SOLD_OUT: { zh: '名额已满', warn: true },
    FULL: { zh: '名额已满', warn: true },
    CANCELLED: { zh: '已取消', warn: true, cancelled: true },
    CANCELED: { zh: '已取消', warn: true, cancelled: true },
  };

  // Fuzhou region names → [汉字, pinyin] so a region written either way gets one road-sign plate.
  const FUZHOU_REGIONS = [
    ['鼓楼', 'Gulou'], ['台江', 'Taijiang'], ['仓山', 'Cangshan'], ['晋安', 'Jin\u2019an', 'Jinan'], ['马尾', 'Mawei'],
    ['长乐', 'Changle'], ['闽侯', 'Minhou'], ['西湖', 'Xihu', 'West Lake'], ['于山', 'Yushan'], ['乌山', 'Wushan'],
    ['屏山', 'Pingshan'], ['三坊七巷', 'Sanfang Qixiang'], ['上下杭', 'Shangxiahang'], ['烟台山', 'Yantaishan'],
    ['怡山', 'Yishan'], ['鼓山', 'Gushan'], ['金山', 'Jinshan'], ['大学城', 'Daxuecheng', 'University Town'],
    ['东街口', 'Dongjiekou'], ['南后街', 'Nanhou Jie', 'Nanhou Street'], ['五一广场', 'Wuyi Guangchang', 'Wuyi Square'],
  ];
  const FUZHOU_REGION_INDEX = new Map();
  for (const [zh, py, ...alt] of FUZHOU_REGIONS) {
    for (const name of [zh, py, ...alt]) FUZHOU_REGION_INDEX.set(regionKey(name), [zh, py]);
  }

  const TILE_URL = {
    light: 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png',
    dark: 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
  };
  const TILE_ATTRIBUTION = '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions" target="_blank" rel="noopener noreferrer">CARTO</a>';

  /* ------------------------------------------------------------------ small utilities */

  const doc = document;
  const root = doc.documentElement;
  const $ = (sel, el = doc) => el.querySelector(sel);
  const $$ = (sel, el = doc) => Array.from(el.querySelectorAll(sel));
  const pad = (n) => String(n).padStart(2, '0');
  const mqDesktop = window.matchMedia('(min-width: 1024px)');
  const mqWide = window.matchMedia('(min-width: 700px)');
  const mqReduce = window.matchMedia('(prefers-reduced-motion: reduce)');
  const mqDark = window.matchMedia('(prefers-color-scheme: dark)');

  let collator;
  try { collator = new Intl.Collator('zh-Hans-CN-u-co-pinyin', { numeric: true, sensitivity: 'base' }); } catch (e) { collator = new Intl.Collator(undefined, { numeric: true }); }
  const cmp = (a, b) => collator.compare(a, b);

  const store = {
    get(key) { try { return window.localStorage.getItem(key); } catch (e) { return null; } },
    set(key, value) { try { window.localStorage.setItem(key, value); } catch (e) { /* storage unavailable: keep working */ } },
  };

  /** Build an element. attrs: class, text, on<Event>, boolean/attribute values. Children: nodes or strings (as text). */
  function h(tag, attrs, ...kids) {
    const el = doc.createElement(tag);
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        if (v == null || v === false) continue;
        if (k === 'class') el.className = v;
        else if (k === 'text') el.textContent = v;
        else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
        else if (v === true) el.setAttribute(k, '');
        else el.setAttribute(k, String(v));
      }
    }
    append(el, kids);
    return el;
  }
  function append(el, kids) {
    for (const kid of kids) {
      if (kid == null || kid === false) continue;
      if (Array.isArray(kid)) append(el, kid);
      else el.appendChild(typeof kid === 'string' || typeof kid === 'number' ? doc.createTextNode(String(kid)) : kid);
    }
    return el;
  }

  const ICONS = {
    search: [['circle', { cx: 7, cy: 7, r: 4.5 }], ['path', { d: 'M10.5 10.5 14 14' }]],
    x: [['path', { d: 'M4 4l8 8M12 4l-8 8' }]],
    copy: [['rect', { x: 5.5, y: 5.5, width: 8, height: 8, rx: 1 }], ['path', { d: 'M3 10.5V3.5a1 1 0 0 1 1-1h6.5' }]],
    ext: [['path', { d: 'M9 3h4v4M13 3 7.5 8.5M11.5 9.5V13h-9V4.5H6' }]],
    back: [['path', { d: 'M10 3 5 8l5 5' }]],
    chev: [['path', { d: 'M6 3l5 5-5 5' }]],
    cal: [['rect', { x: 2.5, y: 3.5, width: 11, height: 10, rx: 1 }], ['path', { d: 'M2.5 6.5h11M5.5 2v3M10.5 2v3M6 10h4M8 8v4' }]],
    sun: [['circle', { cx: 8, cy: 8, r: 2.8 }], ['path', { d: 'M8 1.5v1.6M8 12.9v1.6M1.5 8h1.6M12.9 8h1.6M3.4 3.4l1.1 1.1M11.5 11.5l1.1 1.1M3.4 12.6l1.1-1.1M11.5 4.5l1.1-1.1' }]],
    moon: [['path', { d: 'M13 9.6A5.5 5.5 0 1 1 6.4 3a4.4 4.4 0 0 0 6.6 6.6z' }]],
    auto: [['circle', { cx: 8, cy: 8, r: 5.5 }], ['path', { d: 'M8 2.5a5.5 5.5 0 0 1 0 11z', fill: 'currentColor', stroke: 'none' }]],
    fit: [['path', { d: 'M2.5 6V2.5H6M10 2.5h3.5V6M13.5 10v3.5H10M6 13.5H2.5V10' }], ['circle', { cx: 8, cy: 8, r: 1.6 }]],
    warn: [['path', { d: 'M8 2.2 14.2 13H1.8z' }], ['path', { d: 'M8 6.5v3M8 11.3v.2' }]],
  };
  function icon(name) {
    const NS = 'http://www.w3.org/2000/svg';
    const svg = doc.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 16 16');
    svg.setAttribute('class', 'icon');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    for (const [tag, attrs] of ICONS[name] || []) {
      const node = doc.createElementNS(NS, tag);
      for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
      svg.appendChild(node);
    }
    return svg;
  }

  function str(v) {
    if (typeof v === 'string') return v.trim();
    if (typeof v === 'number' && Number.isFinite(v)) return String(v);
    return '';
  }
  function num(v) {
    const n = typeof v === 'number' ? v : (typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN);
    return Number.isFinite(n) ? n : null;
  }
  function decimals(n) {
    if (n == null) return 0;
    const s = String(Math.abs(n));
    const m = s.match(/^(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/i);
    if (!m) return 0;
    return Math.max(0, (m[2] || '').length - Number(m[3] || 0));
  }
  function fold(s) { return String(s).normalize('NFKC').toLowerCase(); }
  function hasCJK(s) { return /[\u3400-\u9fff\uf900-\ufaff]/.test(s); }
  function regionKey(s) {
    return fold(s).trim().replace(/\s+(district|area|scenic area)$/, '').replace(/区$/, '').replace(/\s+/g, ' ');
  }

  /** Accept only absolute http(s) URLs for links. */
  function safeUrl(u) {
    try {
      const url = new URL(String(u));
      return url.protocol === 'https:' || url.protocol === 'http:' ? url : null;
    } catch (e) { return null; }
  }
  /** Key for matching sources[] to places/events/series: host case, "www.", protocol and trailing slash ignored. */
  function urlKey(u) {
    const url = safeUrl(u);
    if (!url) return fold(str(u)).replace(/\/+$/, '');
    const host = url.host.toLowerCase().replace(/^www\./, '');
    const path = url.pathname.replace(/\/+$/, '');
    return host + path + url.search;
  }
  function domainOf(u) {
    const url = safeUrl(u);
    return url ? url.hostname.replace(/^www\./, '') : str(u);
  }
  function pathOf(u) {
    const url = safeUrl(u);
    if (!url) return '';
    const p = url.pathname + url.search;
    return p === '/' ? '' : p;
  }

  function extLink(u, text, cls = 'link ext') {
    const url = safeUrl(u);
    if (!url) return h('span', { class: 'muted' }, text || str(u) || '无有效链接');
    return h('a', { class: cls, href: url.href, target: '_blank', rel: 'noopener noreferrer' },
      h('span', null, text || url.href), icon('ext'), h('span', { class: 'vh' }, '（在新窗口打开）'));
  }

  function haversineKm(a, b) {
    const rad = (x) => (x * Math.PI) / 180;
    const dLat = rad(b.lat - a.lat);
    const dLng = rad(b.lng - a.lng);
    const s = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
    return 2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(s));
  }
  function nearestCity(lat, lng) {
    let best = null;
    let bestKm = Infinity;
    for (const key of CITY_ORDER) {
      const km = haversineKm({ lat, lng }, CITIES[key].ref);
      if (km < bestKm) { bestKm = km; best = key; }
    }
    return bestKm < 400 ? best : null;
  }
  function fmtCoord(lat, lng, latDp, lngDp = latDp) {
    return `${Math.abs(lat).toFixed(latDp)}° ${lat >= 0 ? 'N' : 'S'} · ${Math.abs(lng).toFixed(lngDp)}° ${lng >= 0 ? 'E' : 'W'}`;
  }
  const nf0 = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 0 });

  /* ------------------------------------------------------------------ time */

  const dtfCache = new Map();
  function dtf(tz, opts) {
    const key = tz + JSON.stringify(opts);
    let f = dtfCache.get(key);
    if (!f) { f = new Intl.DateTimeFormat('zh-CN', Object.assign({ timeZone: tz }, opts)); dtfCache.set(key, f); }
    return f;
  }
  const PARTS_OPTS = { year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric', weekday: 'short', hourCycle: 'h23' };
  function partsOf(ts, tz) {
    const p = {};
    for (const x of dtf(tz, PARTS_OPTS).formatToParts(ts)) p[x.type] = x.value;
    return { y: +p.year, mo: +p.month, d: +p.day, h: (+p.hour) % 24, mi: +p.minute, s: +p.second, wd: p.weekday };
  }
  function validTz(tz) {
    if (!tz) return null;
    try { dtf(tz, { hour: 'numeric' }); return tz; } catch (e) { return null; }
  }
  const dayIndex = (ts, tz) => { const p = partsOf(ts, tz); return Math.round(Date.UTC(p.y, p.mo - 1, p.d) / DAY); };
  const offsetMin = (ts, tz) => {
    const p = partsOf(ts, tz);
    return Math.round((Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s) - Math.floor(ts / 1000) * 1000) / 60000);
  };
  const ymd = (ts, tz) => { const p = partsOf(ts, tz); return `${p.y}-${pad(p.mo)}-${pad(p.d)}`; };
  const hm = (ts, tz) => { const p = partsOf(ts, tz); return `${pad(p.h)}:${pad(p.mi)}`; };
  const md = (ts, tz) => { const p = partsOf(ts, tz); return `${p.mo}月${p.d}日`; };
  const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
  function dayLabelFromIndex(idx) {
    const d = new Date(idx * DAY);
    return { md: `${d.getUTCMonth() + 1}月${d.getUTCDate()}日`, short: `${d.getUTCMonth() + 1}/${d.getUTCDate()}`, wd: WEEKDAYS[d.getUTCDay()] };
  }
  function utcLabel(min) {
    const sign = min >= 0 ? '+' : '−';
    const a = Math.abs(min);
    return `UTC${sign}${Math.floor(a / 60)}${a % 60 ? ':' + pad(a % 60) : ''}`;
  }
  function zoneShort(ts, tz) {
    const off = offsetMin(ts, tz);
    if (tz === 'Europe/London') return off === 60 ? 'BST' : 'GMT';
    return utcLabel(off);
  }
  function cityOfTz(tz) {
    for (const key of CITY_ORDER) if (CITIES[key].tz === tz) return key;
    return null;
  }
  function tzName(tz) {
    const key = cityOfTz(tz);
    return key ? `${CITIES[key].zh}时间` : `${tz} 时间`;
  }
  /** Next instant (to the minute) at which tz changes its UTC offset, searching up to ~14 months ahead. */
  function nextOffsetChange(from, tz) {
    const base = offsetMin(from, tz);
    const step = 6 * 3600e3;
    for (let t = from + step; t < from + 430 * DAY; t += step) {
      if (offsetMin(t, tz) !== base) {
        let lo = t - step;
        let hi = t;
        while (hi - lo > 60000) {
          const mid = lo + Math.floor((hi - lo) / 2 / 60000) * 60000;
          if (offsetMin(mid, tz) === base) lo = mid; else hi = mid;
        }
        return hi;
      }
    }
    return null;
  }

  /** "今天 / 昨天 / n 天前" counted in calendar days on the verification clock. */
  function agoText(ts, now = Date.now()) {
    const n = dayIndex(now, VERIFY_TZ) - dayIndex(ts, VERIFY_TZ);
    if (n <= 0) return '今天';
    if (n === 1) return '昨天';
    return `${n} 天前`;
  }
  const isStale = (ts, now = Date.now()) => now - ts > STALE_DAYS * DAY;

  /** Countdown to an event: 进行中 / n 分钟后 / n 小时后 / 明天 / n 天后. */
  function untilText(start, end, tz, now = Date.now()) {
    if (now >= start && now < end) return { text: '进行中', live: true };
    if (now >= Math.max(start, end)) return { text: '已结束', past: true };
    const diff = start - now;
    const days = dayIndex(start, tz) - dayIndex(now, tz);
    if (diff < 3600e3) return { text: `${Math.max(1, Math.round(diff / 60000))} 分钟后` };
    if (days <= 0 || diff < 12 * 3600e3) return { text: `${Math.round(diff / 3600e3)} 小时后` };
    if (days === 1) return { text: '明天' };
    return { text: `${days} 天后` };
  }
  function deadlineText(deadline, tz, now = Date.now()) {
    const when = `${md(deadline, tz)} ${hm(deadline, tz)}`;
    if (deadline <= now) return { text: `已于 ${when} 截止`, past: true };
    const left = untilText(deadline, deadline + 1, tz, now).text.replace(/后$/, '');
    return { text: `截止 ${when}（${tzName(tz)}）· 还剩 ${left}` };
  }

  /* ------------------------------------------------------------------ data normalisation */

  function catInfo(key) {
    if (CATEGORIES[key]) return Object.assign({ key }, CATEGORIES[key]);
    return { key, glyph: '点', zh: key ? key.charAt(0) + key.slice(1).toLowerCase() : '未分类', terms: '', unknown: true };
  }

  function postcodeDistrict(address) {
    const m = String(address || '').toUpperCase().match(/\b([A-Z]{1,2}\d[A-Z\d]?)\s*\d[A-Z]{2}\b/);
    if (!m) return '';
    const d = m[1].match(/^([A-Z]{1,2}\d{1,2})[A-Z]?$/);
    return d ? d[1] : m[1];
  }

  function regionPlate(city, region, districts) {
    if (!region) return { kind: 'plain', main: '未标注区域', sub: '' };
    if (city === 'FUZHOU') {
      const hit = FUZHOU_REGION_INDEX.get(regionKey(region));
      if (hit) return { kind: 'zh', main: hit[0], sub: hit[1] };
      return hasCJK(region) ? { kind: 'zh', main: region, sub: '' } : { kind: 'zh', main: region, sub: '', latin: true };
    }
    return { kind: 'en', main: region, code: districts || '', sub: '' };
  }

  function normalizePlace(raw) {
    if (!raw || typeof raw !== 'object') return null;
    if (raw.hidden === true || raw.isPrivate === true) return null;
    const id = str(raw.id);
    if (!id) return null;
    const lat = num(raw.latitude);
    const lng = num(raw.longitude);
    const hasCoords = lat != null && lng != null && Math.abs(lat) <= 90 && Math.abs(lng) <= 180 && !(lat === 0 && lng === 0);
    let city = str(raw.city).toUpperCase();
    if (!CITIES[city]) city = hasCoords ? nearestCity(lat, lng) : null;
    if (!city) return null;
    const category = str(raw.category).toUpperCase();
    const cat = catInfo(category);
    const region = str(raw.region);
    const fz = city === 'FUZHOU' && region ? FUZHOU_REGION_INDEX.get(regionKey(region)) : null;
    const radius = num(raw.arrivalRadiusMeters);
    return {
      id,
      name: str(raw.name) || id,
      category,
      cat,
      lat: hasCoords ? lat : null,
      lng: hasCoords ? lng : null,
      hasCoords,
      latDec: decimals(lat),
      lngDec: decimals(lng),
      address: str(raw.address),
      description: str(raw.description),
      sourceUrl: str(raw.sourceUrl),
      verifiedAt: num(raw.verifiedAt),
      region,
      groupKey: region ? (fz ? 'fz:' + fz[0] : regionKey(region)) : '~',
      radius: radius != null && radius > 0 ? radius : null,
      openingInfo: str(raw.openingInfo),
      sourceVersion: num(raw.sourceVersion),
      city,
      plate: null,
      search: '',
    };
  }

  function normalize(json) {
    if (!json || typeof json !== 'object' || Array.isArray(json)) throw new Error('shape');
    const list = (k) => (Array.isArray(json[k]) ? json[k] : []);
    const hiddenPlaceIds = new Set();
    const places = [];
    const seen = new Set();
    for (const raw of list('places')) {
      if (raw && typeof raw === 'object' && (raw.hidden === true || raw.isPrivate === true)) { hiddenPlaceIds.add(str(raw.id)); continue; }
      const p = normalizePlace(raw);
      if (p && !seen.has(p.id)) { seen.add(p.id); places.push(p); }
    }

    // Region plates: London plates carry the most common postcode district of the places in that region.
    const groups = new Map();
    for (const p of places) {
      const k = p.city + '|' + p.groupKey;
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(p);
    }
    for (const members of groups.values()) {
      const tally = new Map();
      for (const p of members) {
        const d = p.city === 'LONDON' ? postcodeDistrict(p.address) : '';
        if (d) tally.set(d, (tally.get(d) || 0) + 1);
      }
      const district = Array.from(tally.entries()).sort((a, b) => b[1] - a[1] || cmp(a[0], b[0]))[0];
      const label = members.map((p) => p.region).filter(Boolean).sort(cmp)[0] || '';
      const plate = regionPlate(members[0].city, label, district ? district[0] : '');
      for (const p of members) {
        p.plate = plate;
        p.search = fold([p.name, p.address, p.region, plate.main, plate.sub, p.description, p.openingInfo, p.cat.zh, p.cat.terms, p.category, CITIES[p.city].zh, CITIES[p.city].en].join(' '));
      }
    }
    places.sort((a, b) => cmp(a.name, b.name) || cmp(a.id, b.id));
    const placeById = new Map(places.map((p) => [p.id, p]));

    const seriesById = new Map();
    for (const raw of list('series')) {
      if (!raw || typeof raw !== 'object') continue;
      const id = str(raw.id);
      if (!id || seriesById.has(id)) continue;
      if (hiddenPlaceIds.has(str(raw.placeId))) continue;
      seriesById.set(id, { id, placeId: str(raw.placeId), title: str(raw.title), organizer: str(raw.organizer), sourceUrl: str(raw.sourceUrl) });
    }

    const events = [];
    const seenEv = new Set();
    for (const raw of list('events')) {
      if (!raw || typeof raw !== 'object') continue;
      const id = str(raw.id);
      const start = num(raw.startUtc);
      if (!id || start == null || seenEv.has(id)) continue;
      const placeId = str(raw.placeId);
      if (hiddenPlaceIds.has(placeId)) continue; // never surface events at hidden or private places
      seenEv.add(id);
      const place = placeById.get(placeId) || null;
      let end = num(raw.endUtc);
      if (end == null || end < start) end = start;
      const tz = validTz(str(raw.timeZone)) || (place ? CITIES[place.city].tz : 'Europe/London');
      const statusRaw = str(raw.status);
      const series = seriesById.get(str(raw.seriesId)) || null;
      const city = place ? place.city : cityOfTz(tz);
      const priceMinor = num(raw.priceMinor);
      events.push({
        id,
        title: str(raw.title) || (series && series.title) || '未命名活动',
        start,
        end,
        tz,
        status: statusRaw.toUpperCase(),
        statusRaw,
        deadline: num(raw.registrationDeadlineUtc),
        priceMinor,
        currency: str(raw.currency).toUpperCase(),
        sourceUrl: str(raw.sourceUrl),
        verifiedAt: num(raw.verifiedAt),
        sourceVersion: num(raw.sourceVersion),
        placeId,
        place,
        series,
        city,
      });
    }
    events.sort((a, b) => a.start - b.start || cmp(a.title, b.title) || cmp(a.id, b.id));

    const sources = [];
    for (const raw of list('sources')) {
      if (!raw || typeof raw !== 'object') continue;
      const url = str(raw.url);
      sources.push({
        id: str(raw.id),
        url,
        key: urlKey(url),
        verifiedAt: num(raw.verifiedAt),
        validUntil: num(raw.validUntil),
        status: str(raw.status),
        license: str(raw.license),
      });
    }
    const sourcesByKey = new Map();
    for (const s of sources) {
      if (!sourcesByKey.has(s.key)) sourcesByKey.set(s.key, []);
      sourcesByKey.get(s.key).push(s);
    }

    // Which places / events / series cite each URL.
    const refs = new Map();
    const ref = (u) => {
      const k = urlKey(u);
      if (!refs.has(k)) refs.set(k, { places: [], events: [], series: [] });
      return refs.get(k);
    };
    for (const p of places) if (p.sourceUrl) ref(p.sourceUrl).places.push(p);
    for (const e of events) if (e.sourceUrl) ref(e.sourceUrl).events.push(e);
    for (const s of seriesById.values()) if (s.sourceUrl) ref(s.sourceUrl).series.push(s);
    for (const s of sources) {
      const r = refs.get(s.key) || { places: [], events: [], series: [] };
      s.refs = r;
      const cities = new Set();
      for (const p of r.places) cities.add(p.city);
      for (const e of r.events) if (e.city) cities.add(e.city);
      for (const se of r.series) { const p = placeById.get(se.placeId); if (p) cities.add(p.city); }
      s.city = CITY_ORDER.find((c) => cities.has(c)) || null;
      s.tz = s.city ? CITIES[s.city].tz : VERIFY_TZ;
    }
    sources.sort((a, b) => cmp(domainOf(a.url), domainOf(b.url)) || cmp(a.url, b.url) || cmp(a.id, b.id));

    const eventsByPlace = new Map();
    for (const e of events) {
      if (!e.placeId) continue;
      if (!eventsByPlace.has(e.placeId)) eventsByPlace.set(e.placeId, []);
      eventsByPlace.get(e.placeId).push(e);
    }

    return {
      meta: { format: str(json.format), version: str(json.version), kind: str(json.kind), coordinateSystem: str(json.coordinateSystem) },
      places, placeById, events, eventsByPlace, seriesById, sources, sourcesByKey,
    };
  }

  /* ------------------------------------------------------------------ state */

  const state = {
    data: null,
    city: 'BOTH',
    tab: 'places',
    placeId: null,
    query: '',
    cats: new Set(),
    mapCity: 'LONDON',
    themePref: 'system',
    listScroll: 0,
    mapsOff: false,
    pastOpen: false,
    partition: '',
  };

  const els = {
    atlas: $('.atlas'),
    panel: $('#panel'),
    scroll: $('[data-scroll]'),
    views: { places: $('#view-places'), events: $('#view-events'), sources: $('#view-sources') },
    tabs: $$('.tab'),
    announcer: $('[data-announcer]'),
    mapzone: $('.mapzone'),
  };

  function announce(text) {
    els.announcer.textContent = '';
    window.setTimeout(() => { els.announcer.textContent = text; }, 30);
  }

  const now = () => Date.now();
  const isUpcoming = (e, t = now()) => Math.max(e.end, e.start) > t;
  const cityLabel = (c) => (c === 'BOTH' ? '双城' : CITIES[c].zh);
  const inCity = (c) => state.city === 'BOTH' || c === state.city;

  /* ------------------------------------------------------------------ routing (bare hash tokens) */

  function currentToken() {
    if (state.tab === 'places' && state.placeId) return state.placeId;
    if (state.tab === 'events') return 'events';
    if (state.tab === 'sources') return 'sources';
    return state.city === 'BOTH' ? 'both' : CITIES[state.city].token;
  }
  function writeHash() {
    const token = currentToken();
    if (!TOKEN_RE.test(token)) return;
    if (readHash() === token) return;
    try { history.replaceState(null, '', location.pathname + location.search + '#' + token); } catch (e) { /* sandboxed */ }
  }
  function readHash() {
    let t = location.hash.replace(/^#/, '');
    try { t = decodeURIComponent(t); } catch (e) { return null; }
    return TOKEN_RE.test(t) ? t : null;
  }
  /** Apply a token from the address bar or an in-page link. Returns true when it was understood. */
  function route(token, opts = {}) {
    if (!token) return false;
    const low = token.toLowerCase();
    if (low === 'london' || low === 'fuzhou' || low === 'both') {
      state.placeId = null;
      setCity(low.toUpperCase(), { render: false });
      setTab('places', { render: false });
      render();
      return true;
    }
    if (low === 'places' || low === 'events' || low === 'sources') {
      setTab(low, opts);
      return true;
    }
    if (state.data && state.data.placeById.has(token)) {
      openPlace(token, opts);
      return true;
    }
    return false;
  }

  /* ------------------------------------------------------------------ city / tab / theme */

  function setCity(city, opts = {}) {
    if (!['LONDON', 'FUZHOU', 'BOTH'].includes(city)) city = 'BOTH';
    const changed = city !== state.city;
    state.city = city;
    store.set(STORE_CITY, city);
    els.atlas.dataset.city = city;
    if (city !== 'BOTH') setMapCity(city);
    for (const b of $$('[data-set-city]')) b.setAttribute('aria-pressed', String(b.dataset.setCity === city));
    if (state.placeId && state.data) {
      const p = state.data.placeById.get(state.placeId);
      if (p && !inCity(p.city)) { state.placeId = null; selectOnMap(null); }
    }
    if (changed) state.cats.clear();
    if (opts.render !== false) {
      render();
      if (changed && state.data) announce(`已切换到${cityLabel(city)}：${countPlaces()} 处地点`);
    }
    refreshMaps({ refit: changed && !state.placeId });
  }
  function setMapCity(city) {
    state.mapCity = city;
    els.atlas.dataset.mapcity = city;
    for (const b of $$('[data-map-city]')) b.setAttribute('aria-pressed', String(b.dataset.mapCity === city));
  }

  function setTab(tab, opts = {}) {
    if (!els.views[tab]) tab = 'places';
    const changed = state.tab !== tab;
    state.tab = tab;
    for (const t of els.tabs) {
      const on = t.dataset.tab === tab;
      t.setAttribute('aria-selected', String(on));
      t.tabIndex = on ? 0 : -1;
    }
    for (const [k, v] of Object.entries(els.views)) v.hidden = k !== tab;
    if (opts.render !== false) {
      render();
      if (changed) scrollPanelTop();
    }
  }

  const THEME_CYCLE = ['system', 'light', 'dark'];
  const THEME_TEXT = { system: '跟随系统', light: '浅色', dark: '深色' };
  function effectiveTheme() {
    if (state.themePref === 'light' || state.themePref === 'dark') return state.themePref;
    return mqDark.matches ? 'dark' : 'light';
  }
  function applyTheme() {
    if (state.themePref === 'system') root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', state.themePref);
    const btn = $('[data-theme-toggle]');
    const next = THEME_CYCLE[(THEME_CYCLE.indexOf(state.themePref) + 1) % THEME_CYCLE.length];
    btn.setAttribute('aria-label', `主题：${THEME_TEXT[state.themePref]}。点击切换为${THEME_TEXT[next]}`);
    btn.title = `主题：${THEME_TEXT[state.themePref]}（点击切换为${THEME_TEXT[next]}）`;
    $('[data-theme-text]').textContent = THEME_TEXT[state.themePref];
    $('[data-theme-icon]').replaceChildren(icon(state.themePref === 'system' ? 'auto' : state.themePref === 'light' ? 'sun' : 'moon'));
    updateTiles();
  }

  /* ------------------------------------------------------------------ maps */

  const maps = {};

  function initMaps() {
    const L = window.L;
    if (!L || typeof L.map !== 'function') { mapsOff(); return; }
    try {
      for (const key of CITY_ORDER) {
        const el = doc.getElementById(key === 'LONDON' ? 'map-london' : 'map-fuzhou');
        const frame = el.closest('.mapframe');
        const ref = CITIES[key].ref;
        const map = L.map(el, {
          zoomControl: false,
          minZoom: 3,
          maxZoom: 19,
          zoomSnap: 0.5,
          wheelPxPerZoomLevel: 90,
          center: [ref.lat, ref.lng],
          zoom: 12,
          fadeAnimation: !mqReduce.matches,
          zoomAnimation: !mqReduce.matches,
          markerZoomAnimation: !mqReduce.matches,
        });
        map.attributionControl.setPrefix('<a href="https://leafletjs.com" target="_blank" rel="noopener noreferrer">Leaflet</a>');
        L.control.zoom({ position: 'topright', zoomInTitle: '放大', zoomOutTitle: '缩小' }).addTo(map);
        const FitControl = L.Control.extend({
          options: { position: 'topright' },
          onAdd() {
            const wrap = L.DomUtil.create('div', 'leaflet-bar fitctl');
            const b = h('button', { type: 'button', title: '显示全部点位', 'aria-label': `显示${CITIES[key].zh}全部点位` }, icon('fit'));
            b.addEventListener('click', () => fitCity(key, true));
            wrap.appendChild(b);
            L.DomEvent.disableClickPropagation(wrap);
            return wrap;
          },
        });
        new FitControl().addTo(map);
        const m = { key, map, el, frame, layer: L.layerGroup().addTo(map), markers: new Map(), ring: null, selected: null, fitted: false, pendingFocus: null, tiles: null, theme: effectiveTheme(), tileErr: 0, tileOk: 0 };
        m.tiles = L.tileLayer(TILE_URL[m.theme], { subdomains: 'abcd', maxZoom: 20, attribution: TILE_ATTRIBUTION })
          .on('tileerror', () => { m.tileErr += 1; updateTileNotice(m); })
          .on('tileload', () => { m.tileOk += 1; updateTileNotice(m); })
          .addTo(map);
        el.setAttribute('aria-label', `${CITIES[key].zh}地图：可用方向键平移，加减号缩放；点位可用 Tab 键选择`);
        const band = () => { m.el.dataset.zoomband = map.getZoom() < 13 ? 'far' : 'near'; };
        map.on('zoomend', band);
        band();
        maps[key] = m;
        if ('ResizeObserver' in window) {
          new ResizeObserver(() => onMapResize(m)).observe(el);
        }
      }
    } catch (err) {
      mapsOff();
    }
  }

  function mapsOff() {
    state.mapsOff = true;
    root.classList.add('no-map');
    for (const k of Object.keys(maps)) delete maps[k];
  }

  function updateTileNotice(m) {
    const note = $('[data-tile-notice]', m.frame);
    const failing = m.tileErr >= 2 && m.tileOk === 0;
    if (failing && note.hidden) {
      note.replaceChildren(icon('warn'), h('span', null, '底图暂时无法加载，点位与列表仍可使用。'));
      note.hidden = false;
      m.frame.classList.add('is-untiled');
    } else if (!failing && m.tileOk > 0 && !note.hidden) {
      note.hidden = true;
      m.frame.classList.remove('is-untiled');
    }
  }
  function updateTiles() {
    const theme = effectiveTheme();
    for (const m of Object.values(maps)) {
      if (!m.tiles || m.theme === theme) continue;
      m.theme = theme;
      m.tileErr = 0;
      m.tileOk = 0;
      m.tiles.setUrl(TILE_URL[theme]);
    }
  }

  function mapVisible(m) { return m.el.offsetWidth > 10 && m.el.offsetHeight > 10; }

  function onMapResize(m) {
    if (!mapVisible(m)) return;
    m.map.invalidateSize({ animate: false });
    if (m.pendingFocus) {
      const p = m.pendingFocus;
      m.pendingFocus = null;
      flyTo(m, p, false);
      m.fitted = true;
    } else if (!m.fitted && state.data) {
      fitCity(m.key, false);
    }
  }

  /** After a layout change: resize visible maps; optionally refit them. */
  function refreshMaps(opts = {}) {
    if (state.mapsOff) return;
    if (opts.refit) for (const m of Object.values(maps)) if (!m.selected) m.fitted = false;
    window.requestAnimationFrame(() => {
      for (const m of Object.values(maps)) if (mapVisible(m)) onMapResize(m);
    });
  }

  function fitCity(key, animate) {
    const m = maps[key];
    if (!m || !state.data) return;
    if (!mapVisible(m)) { m.fitted = false; return; }
    const pts = state.data.places.filter((p) => p.city === key && p.hasCoords).map((p) => [p.lat, p.lng]);
    const anim = animate && !mqReduce.matches;
    if (!pts.length) {
      m.map.setView([CITIES[key].ref.lat, CITIES[key].ref.lng], 12, { animate: anim });
    } else {
      const small = m.el.offsetHeight < 420;
      m.map.fitBounds(window.L.latLngBounds(pts), {
        paddingTopLeft: [28, small ? 64 : 86],
        paddingBottomRight: [56, 30],
        maxZoom: 15,
        animate: anim,
      });
    }
    m.fitted = true;
  }

  function buildMarkers() {
    if (state.mapsOff) return;
    const L = window.L;
    for (const m of Object.values(maps)) {
      m.layer.clearLayers();
      m.markers.clear();
      m.selected = null;
      if (m.ring) { m.ring.remove(); m.ring = null; }
      m.fitted = false;
    }
    for (const p of state.data.places) {
      const m = maps[p.city];
      if (!m || !p.hasCoords) continue;
      const pin = h('span', { class: 'pin', 'data-cat': p.category, 'aria-hidden': 'true' }, p.cat.glyph);
      const marker = L.marker([p.lat, p.lng], {
        icon: L.divIcon({ className: 'pin-wrap', html: pin, iconSize: [26, 26], iconAnchor: [13, 13] }),
        keyboard: true,
        riseOnHover: true,
      });
      marker.bindTooltip(h('span', null, p.name), { direction: 'top', offset: [0, -15], className: 'atlas-tip', opacity: 1 });
      marker.on('click', () => openPlace(p.id, { from: 'map', focus: true }));
      marker.on('mouseover', () => setHot(p.id, true));
      marker.on('mouseout', () => setHot(p.id, false));
      marker.addTo(m.layer);
      const el = marker.getElement();
      if (el) {
        el.setAttribute('aria-label', `${p.name}（${p.cat.zh}）`);
        el.dataset.id = p.id;
        el.addEventListener('keydown', (ev) => {
          if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); openPlace(p.id, { from: 'map', focus: true }); }
        });
        el.addEventListener('focus', () => { setHot(p.id, true); marker.openTooltip(); });
        el.addEventListener('blur', () => { setHot(p.id, false); marker.closeTooltip(); });
      }
      m.markers.set(p.id, marker);
    }
    refreshMaps({ refit: true });
  }

  function markerEl(id) {
    const p = state.data && state.data.placeById.get(id);
    const m = p && maps[p.city];
    const mk = m && m.markers.get(id);
    return mk ? { m, mk, el: mk.getElement() } : null;
  }

  function setHot(id, on) {
    const row = els.panel.querySelector(`.row[data-id="${CSS.escape(id)}"]`);
    if (row) row.classList.toggle('is-hot', on);
    const hit = markerEl(id);
    if (hit && hit.el) {
      hit.el.classList.toggle('is-hot', on);
      hit.mk.setZIndexOffset(on ? 1500 : hit.m.selected === id ? 2000 : 0);
    }
  }

  function selectOnMap(place, opts = {}) {
    for (const m of Object.values(maps)) {
      if (m.selected) {
        const old = m.markers.get(m.selected);
        if (old && old.getElement()) old.getElement().classList.remove('is-selected');
        if (old) old.setZIndexOffset(0);
        m.selected = null;
      }
      if (m.ring) { m.ring.remove(); m.ring = null; }
    }
    if (!place || !place.hasCoords) return;
    const m = maps[place.city];
    if (!m) return;
    const mk = m.markers.get(place.id);
    if (mk) {
      m.selected = place.id;
      if (mk.getElement()) mk.getElement().classList.add('is-selected');
      mk.setZIndexOffset(2000);
    }
    if (place.radius) {
      m.ring = window.L.circle([place.lat, place.lng], { radius: place.radius, className: 'arrival-ring', interactive: false }).addTo(m.map);
    }
    if (opts.fly !== false) {
      if (mapVisible(m)) flyTo(m, place, true);
      else m.pendingFocus = place;
    }
  }

  function flyTo(m, place, animate) {
    const L = window.L;
    const ll = L.latLng(place.lat, place.lng);
    const span = Math.max(place.radius || 80, 60) * 2 * 3.6;
    let z = m.map.getBoundsZoom(ll.toBounds(span), false, L.point(24, 24));
    z = Math.max(13, Math.min(17, z));
    if (!animate || mqReduce.matches) m.map.setView(ll, z, { animate: false });
    else m.map.flyTo(ll, z, { duration: 0.75 });
    m.fitted = true;
  }

  function applyMarkerFilter(matchIds) {
    for (const m of Object.values(maps)) {
      for (const [id, mk] of m.markers) {
        const el = mk.getElement();
        if (!el) continue;
        const muted = matchIds != null && !matchIds.has(id) && id !== state.placeId;
        el.classList.toggle('is-muted', muted);
        el.tabIndex = muted ? -1 : 0;
        if (muted) el.setAttribute('aria-hidden', 'true'); else el.removeAttribute('aria-hidden');
      }
    }
  }

  /* ------------------------------------------------------------------ shared render helpers */

  function glyph(cat, small) {
    return h('span', { class: small ? 'glyph glyph--sm' : 'glyph', 'data-cat': cat.key, 'aria-hidden': 'true' }, cat.glyph);
  }

  function plateEl(plate, size) {
    const lg = size === 'lg' ? ' plate--lg' : '';
    if (plate.kind === 'en') {
      return h('span', { class: 'plate plate--en' + lg, lang: 'en' },
        h('span', { class: 'plate__main' }, plate.main, plate.code ? h('span', { class: 'plate__code' }, plate.code) : null),
        h('span', { class: 'plate__rule', 'aria-hidden': 'true' }),
        plate.sub ? h('span', { class: 'plate__sub' }, plate.sub) : null);
    }
    if (plate.kind === 'zh') {
      return h('span', { class: 'plate plate--zh' + lg },
        h('span', { class: 'plate__main', lang: plate.latin ? 'en' : null }, plate.main),
        plate.sub ? h('span', { class: 'plate__sub', lang: 'en' }, plate.sub) : null);
    }
    return h('span', { class: 'plate plate--plain' }, h('span', { class: 'plate__main' }, plate.main));
  }
  function cityPlate(key) {
    return key === 'LONDON'
      ? plateEl({ kind: 'en', main: 'London', sub: '伦敦 · England' })
      : plateEl({ kind: 'zh', main: '福州', sub: 'Fuzhou' });
  }

  /** <span data-rel="ago"> refreshed every minute. */
  function freshness(ts, cls) {
    if (ts == null) return h('span', { class: cls + ' muted' }, '未注明核验');
    const el = h('span', { class: cls, 'data-rel': 'ago', 'data-ts': ts, title: `核验于 ${ymd(ts, VERIFY_TZ)}` });
    paintRel(el);
    return el;
  }
  function paintRel(el) {
    const t = now();
    const ts = Number(el.dataset.ts);
    const kind = el.dataset.rel;
    if (kind === 'ago') {
      el.textContent = agoText(ts, t);
      el.classList.toggle('stale', isStale(ts, t));
    } else if (kind === 'until') {
      const u = untilText(ts, Number(el.dataset.end), el.dataset.tz, t);
      el.textContent = u.text;
      el.classList.toggle('is-live', !!u.live);
    } else if (kind === 'deadline') {
      const d = deadlineText(ts, el.dataset.tz, t);
      el.textContent = d.text;
      el.classList.toggle('deadline-past', !!d.past);
    } else if (kind === 'day') {
      const n = Number(el.dataset.day) - dayIndex(t, el.dataset.tz);
      el.textContent = n === 0 ? '今天' : n === 1 ? '明天' : n === -1 ? '昨天' : n > 0 ? `${n} 天后` : `${-n} 天前`;
    }
  }
  function refreshRelative() { for (const el of $$('[data-rel]')) paintRel(el); }

  function copyButton(getText, label, fallbackTarget) {
    const btn = h('button', { type: 'button', class: 'btn btn--quiet', 'aria-label': label }, icon('copy'), h('span', null, '复制'));
    btn.addEventListener('click', () => {
      const text = getText();
      const done = (ok) => {
        const span = btn.querySelector('span');
        span.textContent = ok ? '已复制' : '已选中';
        btn.classList.toggle('is-done', ok);
        announce(ok ? '已复制到剪贴板' : '无法直接写入剪贴板，已选中文本，请按 Ctrl+C 或长按复制');
        window.setTimeout(() => { span.textContent = '复制'; btn.classList.remove('is-done'); }, 2200);
      };
      const fallback = () => {
        const target = typeof fallbackTarget === 'function' ? fallbackTarget() : fallbackTarget;
        if (target) selectText(target);
        done(false);
      };
      try {
        if (!navigator.clipboard || typeof navigator.clipboard.writeText !== 'function') { fallback(); return; }
        navigator.clipboard.writeText(text).then(() => done(true), fallback);
      } catch (e) { fallback(); }
    });
    return btn;
  }
  function selectText(target) {
    if (target instanceof HTMLInputElement) { target.focus(); target.select(); return; }
    const range = doc.createRange();
    range.selectNodeContents(target);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  }

  function countPlaces() {
    if (!state.data) return 0;
    return state.data.places.filter((p) => inCity(p.city)).length;
  }
  function renderCounts() {
    const d = state.data;
    const set = (k, v) => { const el = $(`[data-count="${k}"]`); if (el) el.textContent = d ? String(v) : ''; };
    if (!d) return;
    set('places', countPlaces());
    set('events', d.events.filter((e) => (state.city === 'BOTH' || e.city === state.city) && isUpcoming(e)).length);
    set('sources', d.sources.length);
  }

  function scroller() { return mqDesktop.matches ? els.scroll : doc.scrollingElement; }
  function scrollPanelTop() {
    if (mqDesktop.matches) { els.scroll.scrollTop = 0; return; }
    const top = els.panel.getBoundingClientRect().top;
    const sticky = getComputedStyle(els.mapzone).position === 'sticky' && !state.mapsOff;
    const offset = sticky ? els.mapzone.offsetHeight : 0;
    if (top < offset || top > window.innerHeight * 0.6) {
      window.scrollTo({ top: Math.max(0, window.scrollY + top - offset), behavior: 'auto' });
    }
  }

  /* ------------------------------------------------------------------ view: places list */

  function placeFilter() {
    const d = state.data;
    const terms = fold(state.query).split(/\s+/).filter(Boolean);
    const cityPlaces = d.places.filter((p) => inCity(p.city));
    const byQuery = terms.length ? cityPlaces.filter((p) => terms.every((t) => p.search.includes(t))) : cityPlaces;
    const counts = new Map();
    for (const p of byQuery) counts.set(p.category, (counts.get(p.category) || 0) + 1);
    const shown = state.cats.size ? byQuery.filter((p) => state.cats.has(p.category)) : byQuery;
    return { cityPlaces, byQuery, shown, counts, active: terms.length > 0 || state.cats.size > 0 };
  }

  function renderPlaces() {
    const view = els.views.places;
    const d = state.data;
    const cityPlaces = d.places.filter((p) => inCity(p.city));
    const keys = CATEGORY_ORDER.filter((k) => cityPlaces.some((p) => p.category === k));
    const extra = Array.from(new Set(cityPlaces.map((p) => p.category).filter((k) => !CATEGORIES[k]))).sort(cmp);
    for (const k of Array.from(state.cats)) if (!keys.includes(k) && !extra.includes(k)) state.cats.delete(k);

    const input = h('input', {
      type: 'search', id: 'place-search', value: state.query, placeholder: '搜索名称、地址、区域、开放安排…', autocomplete: 'off', spellcheck: 'false', enterkeyhint: 'search',
      'aria-describedby': 'place-result',
    });
    input.value = state.query;
    const clear = h('button', { type: 'button', class: 'search__clear', 'aria-label': '清除搜索' }, icon('x'));
    clear.hidden = !state.query;
    input.addEventListener('input', () => { state.query = input.value; clear.hidden = !state.query; updateResults(); });
    input.addEventListener('keydown', (e) => { if (e.key === 'Escape' && input.value) { e.preventDefault(); input.value = ''; state.query = ''; clear.hidden = true; updateResults(); } });
    clear.addEventListener('click', () => { input.value = ''; state.query = ''; clear.hidden = true; updateResults(); input.focus(); });

    const chipAll = h('button', { type: 'button', class: 'chip chip--all', 'aria-pressed': String(state.cats.size === 0), 'data-chip': '' }, '全部', h('span', { class: 'num' }));
    chipAll.addEventListener('click', () => { state.cats.clear(); updateResults(); });
    const chips = [chipAll];
    for (const k of keys.concat(extra)) {
      const cat = catInfo(k);
      const b = h('button', { type: 'button', class: 'chip', 'aria-pressed': String(state.cats.has(k)), 'data-chip': k, title: CATEGORIES[k] ? `${cat.zh}（${k}）` : k },
        glyph(cat, true), h('span', null, cat.zh), h('span', { class: 'num' }));
      b.addEventListener('click', () => {
        if (state.cats.has(k)) state.cats.delete(k); else state.cats.add(k);
        updateResults();
      });
      chips.push(b);
    }

    const results = h('div', { class: 'results', 'data-results': '' });
    const resultLine = h('p', { class: 'resultline', id: 'place-result', 'aria-live': 'polite', 'data-resultline': '' });
    const toolbar = h('div', { class: 'toolbar' },
      h('div', { class: 'search', role: 'search' },
        h('label', { class: 'vh', for: 'place-search' }, '搜索地点'),
        icon('search'), input, clear),
      h('div', { class: 'chips', role: 'group', 'aria-label': '按类别筛选（可多选）' }, chips),
      resultLine);

    view.replaceChildren(...[
      state.mapsOff ? h('p', { class: 'notice-inline' }, '地图组件未能加载。列表、活动和来源仍可正常使用；每个地点都附有在外部地图中打开的链接。') : null,
      toolbar, results].filter(Boolean));
    updateResults();
  }

  function updateResults() {
    const view = els.views.places;
    const results = $('[data-results]', view);
    if (!results) return;
    const f = placeFilter();

    for (const chip of $$('[data-chip]', view)) {
      const k = chip.dataset.chip;
      const n = k ? f.counts.get(k) || 0 : f.byQuery.length;
      chip.querySelector('.num').textContent = String(n);
      chip.setAttribute('aria-pressed', String(k ? state.cats.has(k) : state.cats.size === 0));
      chip.classList.toggle('is-zero', n === 0);
      chip.setAttribute('aria-label', `${k ? catInfo(k).zh : '全部类别'}，${n} 处`);
    }

    const line = $('[data-resultline]', view);
    const where = cityLabel(state.city);
    line.replaceChildren();
    if (f.active) {
      append(line, [`${where} · 共 ${f.cityPlaces.length} 处，`, h('b', null, `显示 ${f.shown.length} 处`)]);
      if (state.query.trim()) append(line, [`（搜索“${state.query.trim()}”）`]);
    } else {
      append(line, [`${where} · `, h('b', null, `${f.cityPlaces.length} 处地点`), '，按区域排列']);
    }

    results.replaceChildren();
    if (!f.shown.length) {
      const clearBtn = h('button', { type: 'button', class: 'btn' }, '清除搜索和筛选');
      clearBtn.addEventListener('click', () => {
        state.query = ''; state.cats.clear();
        const input = $('#place-search'); if (input) input.value = '';
        const c = $('.search__clear', view); if (c) c.hidden = true;
        updateResults();
        if (input) input.focus();
      });
      const other = state.city !== 'BOTH' && state.query.trim()
        ? state.data.places.filter((p) => p.city !== state.city && fold(state.query).split(/\s+/).filter(Boolean).every((t) => p.search.includes(t))).length
        : 0;
      const actions = [clearBtn];
      if (other) {
        const otherCity = state.city === 'LONDON' ? 'FUZHOU' : 'LONDON';
        const b = h('button', { type: 'button', class: 'btn' }, `在${CITIES[otherCity].zh}有 ${other} 处匹配`);
        b.addEventListener('click', () => setCity(otherCity));
        actions.push(b);
      }
      results.appendChild(h('div', { class: 'empty' },
        h('p', { class: 'empty__title' }, f.cityPlaces.length ? '没有符合条件的地点' : `${cityLabel(state.city)}暂无公开地点`),
        h('p', null, f.cityPlaces.length ? '搜索会查找名称、地址、区域、说明和开放安排。试试更短的词，或去掉类别筛选。' : '内容后台还没有为这座城市发布地点。'),
        h('div', { class: 'empty__actions' }, actions)));
    } else {
      const cities = state.city === 'BOTH' ? CITY_ORDER : [state.city];
      for (const c of cities) {
        const list = f.shown.filter((p) => p.city === c);
        if (!list.length) continue;
        const section = h('section', { class: 'citysection', 'data-city': c, 'aria-label': `${CITIES[c].zh}，${list.length} 处` });
        if (state.city === 'BOTH') {
          section.appendChild(h('h2', { class: 'citysection__head' }, cityPlate(c), h('span', { class: 'meta' }, `${list.length} 处地点`)));
        }
        for (const g of groupByRegion(list)) {
          const head = h('h3', { class: 'group__head' }, plateEl(g.plate), h('span', { class: 'group__count', 'aria-label': `${g.places.length} 处` }, String(g.places.length)));
          const ul = h('ul', { class: 'rows', role: 'list' }, g.places.map((p) => h('li', null, placeRow(p))));
          section.appendChild(h('section', { class: 'group' }, head, ul));
        }
        results.appendChild(section);
      }
    }
    applyMarkerFilter(f.active ? new Set(f.shown.map((p) => p.id)) : null);
  }

  function groupByRegion(list) {
    const map = new Map();
    for (const p of list) {
      if (!map.has(p.groupKey)) map.set(p.groupKey, { key: p.groupKey, plate: p.plate, places: [] });
      map.get(p.groupKey).places.push(p);
    }
    const sortName = (g) => (g.key === '~' ? '\uffff' : g.plate.sub || g.plate.main);
    return Array.from(map.values()).sort((a, b) => cmp(sortName(a), sortName(b)));
  }

  function placeRow(p) {
    const a = h('a', { class: 'row', href: '#' + p.id, 'data-id': p.id, 'data-city': p.city, 'data-route': p.id },
      glyph(p.cat),
      h('span', { class: 'row__name' }, p.name),
      freshness(p.verifiedAt, 'row__fresh'),
      h('span', { class: 'row__meta' }, `${p.cat.zh} · ${p.region || '未标注区域'}`),
      p.openingInfo ? h('span', { class: 'row__excerpt' }, p.openingInfo) : null);
    a.addEventListener('pointerenter', () => setHot(p.id, true));
    a.addEventListener('pointerleave', () => setHot(p.id, false));
    a.addEventListener('focus', () => setHot(p.id, true));
    a.addEventListener('blur', () => setHot(p.id, false));
    return a;
  }

  /* ------------------------------------------------------------------ view: place detail */

  function openPlace(id, opts = {}) {
    const d = state.data;
    const p = d && d.placeById.get(id);
    if (!p) return;
    if (state.tab === 'places' && !state.placeId) state.listScroll = scroller().scrollTop;
    state.placeId = id;
    if (!inCity(p.city)) setCity(p.city, { render: false });
    if (state.city === 'BOTH') setMapCity(p.city);
    setTab('places', { render: false });
    render();
    selectOnMap(p);
    scrollPanelTop();
    if (opts.focus !== false) {
      const head = $('.detail__name', els.views.places);
      if (head) head.focus({ preventScroll: true });
    }
    if (opts.from === 'map') announce(`已打开 ${p.name}`);
  }

  function closePlace() {
    const id = state.placeId;
    state.placeId = null;
    selectOnMap(null);
    render();
    const sc = scroller();
    if (mqDesktop.matches) sc.scrollTop = state.listScroll;
    const row = id && els.views.places.querySelector(`.row[data-id="${CSS.escape(id)}"]`);
    if (row) {
      row.focus({ preventScroll: mqDesktop.matches });
      if (!mqDesktop.matches) scrollRowIntoView(row);
    }
  }
  function scrollRowIntoView(row) {
    const sticky = getComputedStyle(els.mapzone).position === 'sticky' && !state.mapsOff ? els.mapzone.offsetHeight : 0;
    const r = row.getBoundingClientRect();
    if (r.top < sticky + 8 || r.bottom > window.innerHeight) {
      window.scrollTo({ top: window.scrollY + r.top - sticky - 80, behavior: 'auto' });
    }
  }

  function renderDetail(p) {
    const view = els.views.places;
    const d = state.data;
    const back = h('button', { type: 'button', class: 'btn btn--quiet detail__back' }, icon('back'), `返回地点列表`);
    back.addEventListener('click', closePlace);

    const addrText = h('p', null, p.address || '地址未注明');
    const head = h('header', { class: 'detail__head' },
      h('p', { class: 'detail__kicker' }, glyph(p.cat, true), h('span', null, p.cat.zh), h('span', { class: 'sep', 'aria-hidden': 'true' }, '/'), h('span', null, `${CITIES[p.city].zh} ${CITIES[p.city].en}`)),
      h('h2', { class: 'detail__name', tabindex: '-1' }, p.name),
      h('div', null, plateEl(p.plate)),
      h('div', { class: 'detail__address' }, addrText, p.address ? copyButton(() => p.address, '复制地址', addrText) : null));

    const parts = [back, head];
    if (p.description) parts.push(h('p', { class: 'detail__desc' }, p.description));
    parts.push(h('section', { class: 'openinfo', 'data-city': p.city, 'aria-labelledby': 'open-label' },
      h('h3', { class: 'label', id: 'open-label' }, '开放与安排'),
      h('p', null, p.openingInfo || '数据中没有开放与安排信息，请查看来源。')));

    // events here
    const evs = d.eventsByPlace.get(p.id) || [];
    const t = now();
    const up = evs.filter((e) => isUpcoming(e, t));
    const pastN = evs.length - up.length;
    if (evs.length) {
      const sec = h('section', { class: 'section', 'aria-labelledby': 'ev-here' }, h('h3', { class: 'label', id: 'ev-here' }, `这里的活动`));
      if (up.length) {
        sec.appendChild(h('ul', { class: 'minievents', role: 'list' }, up.map((e) => h('li', { class: 'minievent' },
          h('p', { class: 'minievent__when' }, `${md(e.start, e.tz)} ${WEEKDAYS[new Date(dayIndex(e.start, e.tz) * DAY).getUTCDay()]} ${timeRange(e, e.tz)} · `, relSpan('until', e)),
          h('p', { class: 'minievent__title' }, e.title),
          icsButton(e, true)))));
      } else {
        sec.appendChild(h('p', { class: 'muted' }, '暂无即将举行的活动。'));
      }
      if (pastN) {
        const b = h('button', { type: 'button', class: 'btn btn--quiet' }, `已结束 ${pastN} 场，在活动页查看`);
        b.addEventListener('click', () => { state.pastOpen = true; setTab('events'); });
        sec.appendChild(h('p', { class: 'muted' }, b));
      }
      parts.push(sec);
    }

    // survey: coordinates, radius, precision
    const survey = h('section', { class: 'section', 'aria-labelledby': 'pos-label' }, h('h3', { class: 'label', id: 'pos-label' }, '位置', h('span', { class: 'en', lang: 'en' }, 'WGS84')));
    if (p.hasCoords) {
      // Each axis keeps the precision the data actually has (capped at 6 dp) — no padded zeros.
      const coordText = h('span', { class: 'mono' }, fmtCoord(p.lat, p.lng, Math.min(6, p.latDec), Math.min(6, p.lngDec)));
      const latRes = 0.5 * Math.pow(10, -p.latDec) * 111320;
      const lngRes = 0.5 * Math.pow(10, -p.lngDec) * 111320 * Math.cos((p.lat * Math.PI) / 180);
      const res = Math.max(latRes, lngRes);
      const resText = res < 1 ? '优于 ±1 m' : `约 ±${nf0.format(res)} m`;
      const coarse = res >= 5 ? `（纬度 ${p.latDec} 位、经度 ${p.lngDec} 位小数）` : `（${Math.min(p.latDec, p.lngDec)} 位以上小数）`;
      const dl = h('dl', { class: 'facts' },
        h('dt', null, '坐标'), h('dd', null, h('span', { class: 'coords' }, coordText, copyButton(() => `${p.lat}, ${p.lng}`, '复制坐标', coordText))),
        h('dt', null, '数值精度'), h('dd', null, resText, h('span', { class: 'muted' }, coarse)),
        h('dt', null, '到达半径'), h('dd', null, p.radius ? `${nf0.format(p.radius)} m${state.mapsOff ? '' : '（地图上的虚线圈）'}` : '未注明'));
      survey.appendChild(dl);
      survey.appendChild(h('p', { class: 'note' }, '地图点是这个地点的代表位置，不一定是入口或门牌所在处；请按地址和现场标识寻找。'));
      const links = [extLink(`https://www.openstreetmap.org/?mlat=${p.lat}&mlon=${p.lng}#map=18/${p.lat}/${p.lng}`, 'OpenStreetMap', 'btn')];
      if (p.city === 'FUZHOU') {
        links.push(extLink(`https://uri.amap.com/marker?position=${p.lng},${p.lat}&name=${encodeURIComponent(p.name)}&coordinate=wgs84&callnative=1`, '高德地图', 'btn'));
      } else {
        links.push(extLink(`https://www.google.com/maps/search/?api=1&query=${p.lat},${p.lng}`, 'Google 地图', 'btn'));
      }
      survey.appendChild(h('div', { class: 'maplinks' }, links));
    } else {
      survey.appendChild(h('p', { class: 'note' }, '数据中没有有效坐标，因此不在地图上显示。'));
    }
    parts.push(survey);

    // verification + sources
    const src = h('section', { class: 'section', 'aria-labelledby': 'src-label' }, h('h3', { class: 'label', id: 'src-label' }, '来源与核验'));
    src.appendChild(verifyLine(p.verifiedAt, p.sourceVersion));
    if (p.sourceUrl) {
      src.appendChild(h('p', { class: 'srcmain' }, extLink(p.sourceUrl, domainOf(p.sourceUrl) + pathOf(p.sourceUrl))));
      const matches = d.sourcesByKey.get(urlKey(p.sourceUrl)) || [];
      if (matches.length) src.appendChild(h('div', { class: 'srcnotes' }, matches.map((s) => sourceNote(s))));
    } else {
      src.appendChild(h('p', { class: 'muted' }, '数据未提供来源链接。'));
    }
    parts.push(src);

    view.replaceChildren(h('article', { class: 'detail', 'data-city': p.city }, parts));
    applyMarkerFilter(null);
  }

  function verifyLine(ts, version) {
    if (ts == null) return h('p', { class: 'verify' }, '核验日期未注明', version != null ? ` · 资料版本 v${version}` : '');
    const stale = isStale(ts);
    const line = h('p', { class: 'verify' + (stale ? ' is-stale' : '') },
      h('span', null, '核验于 ', h('time', { class: 'mono', datetime: ymd(ts, VERIFY_TZ) }, ymd(ts, VERIFY_TZ))),
      h('span', { class: 'sep', 'aria-hidden': 'true' }, '·'),
      h('span', { 'data-rel': 'ago', 'data-ts': ts }, agoText(ts)),
      version != null ? h('span', { class: 'sep', 'aria-hidden': 'true' }, '·') : null,
      version != null ? h('span', null, `资料版本 v${version}`) : null,
      stale ? h('span', { class: 'verify__warn' }, `已超过 ${STALE_DAYS} 天未核验，出发前请先看来源页面。`) : null);
    return line;
  }

  function sourceNote(s) {
    const t = now();
    const expired = s.validUntil != null && s.validUntil < t;
    return h('div', { class: 'srcnote' },
      h('p', null, h('span', { class: 'k' }, '来源记录'), s.status || '未注明状态'),
      s.license ? h('p', null, h('span', { class: 'k' }, '许可'), s.license) : null,
      h('p', null, h('span', { class: 'k' }, '核验'), s.verifiedAt != null ? ymd(s.verifiedAt, VERIFY_TZ) : '未注明',
        s.validUntil != null ? `；有效至 ${ymd(s.validUntil, s.tz)} ${hm(s.validUntil, s.tz)}（${tzName(s.tz)}）` : '',
        expired ? h('span', { class: 'badge' }, '已过期') : null));
  }

  /* ------------------------------------------------------------------ events */

  function timeRange(e, tz) {
    const a = hm(e.start, tz);
    if (e.end <= e.start) return a;
    const sameDay = dayIndex(e.start, tz) === dayIndex(e.end, tz);
    return `${a}–${sameDay ? '' : (dayIndex(e.end, tz) - dayIndex(e.start, tz) === 1 ? '次日 ' : md(e.end, tz) + ' ')}${hm(e.end, tz)}`;
  }
  function relSpan(kind, e) {
    const el = h('span', { class: kind === 'until' ? 'countdown' : null, 'data-rel': kind, 'data-ts': e.start, 'data-end': e.end, 'data-tz': e.tz });
    paintRel(el);
    return el;
  }
  function priceText(e) {
    if (e.priceMinor === 0) return '免费';
    if (e.priceMinor == null) return '费用见来源';
    try {
      const f = new Intl.NumberFormat('zh-CN', { style: 'currency', currency: e.currency || 'XXX' });
      const digits = f.resolvedOptions().maximumFractionDigits;
      return f.format(e.priceMinor / Math.pow(10, digits));
    } catch (err) {
      return `${(e.priceMinor / 100).toFixed(2)} ${e.currency}`.trim();
    }
  }
  function otherTz(e) {
    return cityOfTz(e.tz) === 'FUZHOU' ? CITIES.LONDON.tz : CITIES.FUZHOU.tz;
  }

  function eventItem(e, opts = {}) {
    const st = STATUS[e.status] || null;
    const statusText = st ? st.zh : (e.statusRaw || '状态未注明');
    const ot = otherTz(e);
    const cityKey = e.city || cityOfTz(e.tz);
    const placeLink = e.place
      ? h('a', { class: 'placelink', href: '#' + e.place.id, 'data-route': e.place.id }, glyph(e.place.cat, true), h('span', null, `${e.place.name}${e.place.region ? ' · ' + e.place.region : ''}`))
      : h('p', { class: 'muted' }, '地点资料未公开或缺失');
    const facts = [h('dt', null, '费用'), h('dd', null, priceText(e))];
    if (e.deadline != null) {
      const dl = h('span', { 'data-rel': 'deadline', 'data-ts': e.deadline, 'data-tz': e.tz });
      paintRel(dl);
      facts.push(h('dt', null, '报名'), h('dd', null, dl));
    }
    if (e.series) {
      facts.push(h('dt', null, '系列'), h('dd', null, e.series.title || e.series.id, e.series.organizer ? ` · 主办 ${e.series.organizer}` : '',
        e.series.sourceUrl && urlKey(e.series.sourceUrl) !== urlKey(e.sourceUrl) ? [' · ', extLink(e.series.sourceUrl, '系列页面')] : null));
    }
    const when = h('div', { class: 'ev__when' },
      h('time', { class: 'ev__start', datetime: new Date(e.start).toISOString() }, hm(e.start, e.tz)),
      e.end > e.start ? h('span', { class: 'ev__end' }, `至 ${dayIndex(e.end, e.tz) !== dayIndex(e.start, e.tz) ? '次日 ' : ''}${hm(e.end, e.tz)}`) : null,
      h('span', { class: 'ev__zone' }, tzName(e.tz)));
    const tags = h('p', { class: 'ev__tags' },
      opts.past ? h('span', { class: 'countdown' }, '已结束') : relSpan('until', e),
      h('span', { class: 'status' + (st && st.warn ? ' is-warn' : '') }, statusText),
      h('span', { class: 'other-time' }, `${tzName(ot)} ${md(e.start, ot)} ${timeRange(e, ot)}`));
    const art = h('article', { class: 'ev' + (st && st.cancelled ? ' is-cancelled' : ''), 'data-city': cityKey || null, 'data-event': e.id },
      when,
      h('div', { class: 'ev__body' },
        h('h4', { class: 'ev__title' }, e.title),
        placeLink,
        tags,
        h('dl', { class: 'facts' }, facts),
        h('div', { class: 'ev__actions' },
          e.sourceUrl ? extLink(e.sourceUrl, domainOf(e.sourceUrl)) : h('span', { class: 'muted' }, '无来源链接'),
          opts.past ? null : icsButton(e))));
    if (e.place) {
      art.addEventListener('pointerenter', () => setHot(e.place.id, true));
      art.addEventListener('pointerleave', () => setHot(e.place.id, false));
    }
    return art;
  }

  function groupByDay(list) {
    const map = new Map();
    for (const e of list) {
      const key = ymd(e.start, e.tz);
      if (!map.has(key)) map.set(key, { key, idx: dayIndex(e.start, e.tz), events: [] });
      map.get(key).events.push(e);
    }
    return Array.from(map.values()).sort((a, b) => a.idx - b.idx);
  }

  function dayGroup(g, opts = {}) {
    const lbl = dayLabelFromIndex(g.idx);
    const refTz = state.city === 'FUZHOU' ? CITIES.FUZHOU.tz : CITIES.LONDON.tz;
    const cities = Array.from(new Set(g.events.map((e) => e.city).filter(Boolean)));
    const rel = h('span', { class: 'evday__rel', 'data-rel': 'day', 'data-day': g.idx, 'data-tz': refTz });
    paintRel(rel);
    const sorted = g.events.slice().sort((a, b) => (opts.past ? b.start - a.start : a.start - b.start) || cmp(a.id, b.id));
    return h('section', { class: 'evday', id: (opts.past ? 'past-' : 'day-') + g.key, 'data-day': g.idx },
      h('h3', { class: 'evday__head' },
        h('span', { class: 'evday__date' }, `${lbl.md} ${lbl.wd}`),
        state.city === 'BOTH' && cities.length ? h('span', { class: 'evday__city' }, cities.map((c) => CITIES[c].zh).join(' / ') + ' 当地日期') : null,
        rel),
      h('div', { class: 'evlist' }, sorted.map((e) => eventItem(e, opts))));
  }

  function weekStrip(upcoming) {
    const t = now();
    const refTz = state.city === 'FUZHOU' ? CITIES.FUZHOU.tz : CITIES.LONDON.tz;
    const today = dayIndex(t, refTz);
    const week0 = today - ((today + 3) % 7); // Monday of this week
    const last = upcoming.reduce((m, e) => Math.max(m, dayIndex(e.start, e.tz)), today);
    const n = Math.max(8, Math.min(16, Math.ceil((last - week0 + 1) / 7)));
    const buckets = Array.from({ length: n }, () => []);
    let later = 0;
    for (const e of upcoming) {
      const w = Math.floor((dayIndex(e.start, e.tz) - week0) / 7);
      if (w >= 0 && w < n) buckets[w].push(e); else if (w >= n) later += 1;
    }
    const cols = buckets.map((list, i) => {
      const start = week0 + i * 7;
      const lbl = dayLabelFromIndex(start);
      const end = dayLabelFromIndex(start + 6);
      const marks = list.slice(0, 7).map((e) => h('i', { 'data-city': e.city || null }));
      if (list.length > 7) marks[6] = h('i', { class: 'more' });
      const label = `${lbl.md}–${end.md}：${list.length ? list.length + ' 场' : '没有活动'}`;
      const attrs = { class: 'week' + (i === 0 ? ' is-now' : ''), type: 'button', 'aria-label': (i === 0 ? '本周，' : '') + label, title: label };
      if (!list.length) attrs.disabled = true;
      // Label only this week and weeks that contain the 1st of a month, so 16 columns never collide.
      const monthStart = Array.from({ length: 7 }, (_, k) => new Date((start + k) * DAY)).find((dt) => dt.getUTCDate() === 1);
      const tag = i === 0 ? '本周' : monthStart ? `${monthStart.getUTCMonth() + 1}月` : '';
      const b = h('button', attrs, h('span', { class: 'week__bar', 'aria-hidden': 'true' }, marks), h('span', { class: 'week__label', 'aria-hidden': 'true' }, tag));
      if (list.length) {
        b.addEventListener('click', () => {
          const target = $$('.evday', els.views.events).find((s) => Number(s.dataset.day) >= start && !s.id.startsWith('past-'));
          if (target) {
            target.scrollIntoView({ block: 'start', behavior: mqReduce.matches ? 'auto' : 'smooth' });
            const h3 = target.querySelector('.evday__head');
            if (h3) { h3.tabIndex = -1; h3.focus({ preventScroll: true }); }
          }
        });
      }
      return b;
    });
    const total = upcoming.length;
    return h('section', { class: 'weeks', 'aria-label': '按周分布' },
      h('p', { class: 'weeks__head' }, h('span', null, `本周起 ${n} 周 · `, h('b', null, `${total - later} 场`), later ? `，之后还有 ${later} 场` : ''), h('span', null, `${tzName(refTz)}`)),
      h('div', { class: 'weeks__strip' }, cols));
  }

  function renderEvents() {
    const view = els.views.events;
    const d = state.data;
    const t = now();
    const list = d.events.filter((e) => state.city === 'BOTH' || e.city === state.city);
    const upcoming = list.filter((e) => isUpcoming(e, t));
    const past = list.filter((e) => !isUpcoming(e, t));
    state.partition = partitionKey();
    const parts = [weekStrip(upcoming)];
    if (upcoming.length) {
      parts.push(h('div', { class: 'evgroups' }, groupByDay(upcoming).map((g) => dayGroup(g))));
    } else {
      const lastPast = past.slice().sort((a, b) => b.end - a.end)[0];
      const where = state.city === 'BOTH' ? '两座城市' : CITIES[state.city].zh;
      const toPast = h('button', { type: 'button', class: 'btn' }, `查看已结束的 ${past.length} 场`);
      toPast.addEventListener('click', () => {
        const det = $('details.past', view);
        if (det) { det.open = true; state.pastOpen = true; det.scrollIntoView({ block: 'start', behavior: mqReduce.matches ? 'auto' : 'smooth' }); det.querySelector('summary').focus({ preventScroll: true }); }
      });
      const toPlaces = h('button', { type: 'button', class: 'btn' }, '查看地点的常规安排');
      toPlaces.addEventListener('click', () => setTab('places'));
      parts.push(h('div', { class: 'empty' },
        h('p', { class: 'empty__title' }, `${where}暂时没有即将举行的活动`),
        lastPast
          ? h('p', null, `最近一场“${lastPast.title}”已于 ${md(lastPast.end, lastPast.tz)}（${tzName(lastPast.tz)}）结束。新场次随 content.json 更新出现在这里，每一场都附来源链接和日历文件。`)
          : h('p', null, '新场次随 content.json 更新出现在这里，每一场都附来源链接和日历文件。'),
        h('p', null, '常规开放时间与每周安排记录在各地点的“开放与安排”里。'),
        h('div', { class: 'empty__actions' }, past.length ? toPast : null, toPlaces)));
    }
    if (past.length) {
      const det = h('details', { class: 'past' },
        h('summary', null, icon('chev'), `已结束 (${past.length})`),
        groupByDay(past).reverse().map((g) => dayGroup(g, { past: true })));
      det.open = state.pastOpen;
      det.addEventListener('toggle', () => { state.pastOpen = det.open; });
      parts.push(det);
    }
    view.replaceChildren(...parts);
    applyMarkerFilter(null);
  }
  function partitionKey() {
    const d = state.data;
    if (!d) return '';
    const t = now();
    return d.events.filter((e) => isUpcoming(e, t)).length + ':' + dayIndex(t, CITIES.LONDON.tz);
  }

  /* ------------------------------------------------------------------ calendar (.ics) */

  function icsEscape(s) {
    return String(s).replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r\n|\r|\n/g, '\\n');
  }
  function icsStamp(ts) {
    const d = new Date(ts);
    return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
  }
  /** Fold a content line at 75 octets (UTF-8), never splitting a character. */
  function icsFold(line) {
    const enc = new TextEncoder();
    const out = [];
    let cur = '';
    let bytes = 0;
    for (const ch of line) {
      const b = enc.encode(ch).length;
      if (bytes + b > 75) { out.push(cur); cur = ' ' + ch; bytes = 1 + b; } else { cur += ch; bytes += b; }
    }
    out.push(cur);
    return out.join('\r\n');
  }
  function buildICS(e) {
    const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Twin City Atlas//双城图志//ZH', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH', 'BEGIN:VEVENT'];
    lines.push(`UID:${icsEscape(e.id)}@twin-city-atlas`);
    lines.push(`DTSTAMP:${icsStamp(now())}`);
    lines.push(`DTSTART:${icsStamp(e.start)}`);
    if (e.end > e.start) lines.push(`DTEND:${icsStamp(e.end)}`);
    lines.push(`SUMMARY:${icsEscape(e.title)}`);
    if (e.place) {
      lines.push(`LOCATION:${icsEscape([e.place.name, e.place.address].filter(Boolean).join(', '))}`);
      if (e.place.hasCoords) lines.push(`GEO:${e.place.lat};${e.place.lng}`);
    }
    const url = safeUrl(e.sourceUrl);
    if (url) lines.push(`URL:${url.href}`);
    const desc = [
      `当地时间：${md(e.start, e.tz)} ${timeRange(e, e.tz)}（${e.tz}）`,
      `费用：${priceText(e)}`,
      e.deadline != null ? `报名截止：${md(e.deadline, e.tz)} ${hm(e.deadline, e.tz)}（${tzName(e.tz)}）` : null,
      e.series ? `系列：${e.series.title}${e.series.organizer ? '（主办 ' + e.series.organizer + '）' : ''}` : null,
      url ? `来源：${url.href}` : null,
      e.verifiedAt != null ? `资料核验于 ${ymd(e.verifiedAt, VERIFY_TZ)}，出发前请以来源为准。` : '出发前请以来源为准。',
    ].filter(Boolean).join('\n');
    lines.push(`DESCRIPTION:${icsEscape(desc)}`);
    const st = STATUS[e.status];
    if (st && st.cancelled) lines.push('STATUS:CANCELLED');
    lines.push('END:VEVENT', 'END:VCALENDAR');
    return lines.map(icsFold).join('\r\n') + '\r\n';
  }
  function icsButton(e, compact) {
    const b = h('button', { type: 'button', class: compact ? 'btn btn--quiet' : 'btn', 'aria-label': `把“${e.title}”加入日历（下载 .ics 文件）` }, icon('cal'), h('span', null, '加入日历'));
    b.addEventListener('click', () => {
      const blob = new Blob([buildICS(e)], { type: 'text/calendar;charset=utf-8' });
      const href = URL.createObjectURL(blob);
      const a = h('a', { href, download: `${e.id.replace(/[^A-Za-z0-9._-]+/g, '-') || 'event'}.ics` });
      doc.body.appendChild(a);
      a.click();
      a.remove();
      window.setTimeout(() => URL.revokeObjectURL(href), 5000);
      announce('已生成日历文件');
    });
    return b;
  }

  /* ------------------------------------------------------------------ view: sources */

  function renderSources() {
    const view = els.views.sources;
    const d = state.data;
    const t = now();
    const urlInput = h('input', { type: 'text', readonly: true, value: PUBLIC_CONTENT_URL, 'aria-label': '应用内容地址', spellcheck: 'false' });
    urlInput.addEventListener('focus', () => urlInput.select());
    const latest = [...d.places.map((p) => p.verifiedAt), ...d.events.map((e) => e.verifiedAt), ...d.sources.map((s) => s.verifiedAt)]
      .filter((x) => x != null).reduce((m, x) => Math.max(m, x), 0);
    const km = haversineKm(CITIES.LONDON.ref, CITIES.FUZHOU.ref);
    const meta = [['format', d.meta.format], ['version', d.meta.version], ['kind', d.meta.kind], ['coordinateSystem', d.meta.coordinateSystem]];
    const rows = CITY_ORDER.map((c) => {
      const evs = d.events.filter((e) => e.city === c);
      return h('tr', { 'data-city': c },
        h('th', { scope: 'row' }, CITIES[c].zh),
        h('td', null, String(d.places.filter((p) => p.city === c).length)),
        h('td', null, String(evs.filter((e) => isUpcoming(e, t)).length)),
        h('td', null, String(evs.length)));
    });

    const datafile = h('section', { class: 'datafile', 'aria-labelledby': 'datafile-title' },
      h('h2', { class: 'datafile__title', id: 'datafile-title' }, '数据文件'),
      h('p', { class: 'privacy' }, '仅包含公开来源的公共资料，不含任何个人记录。'),
      h('div', null,
        h('span', { class: 'label' }, '应用内容地址（电脑版与安卓版从这里更新）'),
        h('div', { class: 'urlbox' }, urlInput, copyButton(() => PUBLIC_CONTENT_URL, '复制应用内容地址', urlInput))),
      h('p', null, h('a', { class: 'link ext', href: CONTENT_PATH, target: '_blank', rel: 'noopener noreferrer' }, h('span', null, '打开原始 content.json'), icon('ext'), h('span', { class: 'vh' }, '（在新窗口打开）'))),
      h('dl', { class: 'metagrid' }, meta.map(([k, v]) => h('div', null, h('dt', { lang: 'en' }, k), h('dd', null, v || '未注明')))),
      h('table', { class: 'counts' },
        h('caption', { class: 'vh' }, '各城市条目数'),
        h('thead', null, h('tr', null, h('th', { scope: 'col' }, '城市'), h('th', { scope: 'col' }, '地点'), h('th', { scope: 'col' }, '即将举行'), h('th', { scope: 'col' }, '活动总数'))),
        h('tbody', null, rows)),
      h('dl', { class: 'facts' },
        h('dt', null, '最近核验'), h('dd', null, latest ? [h('span', { class: 'mono' }, ymd(latest, VERIFY_TZ)), '（', h('span', { 'data-rel': 'ago', 'data-ts': latest }, agoText(latest)), '）'] : '未注明'),
        h('dt', null, '两城距离'), h('dd', null, h('span', { class: 'mono' }, `${nf0.format(km)} km`), `（大圆距离，${CITIES.LONDON.ref.label} 至福州${CITIES.FUZHOU.ref.label}）`),
        h('dt', null, '底图'), h('dd', null, '© OpenStreetMap contributors © CARTO')));

    const groups = new Map();
    for (const s of d.sources) {
      const k = s.city || 'NONE';
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(s);
    }
    const order = (state.city === 'FUZHOU' ? ['FUZHOU', 'LONDON'] : CITY_ORDER).concat('NONE');
    const sections = order.filter((k) => groups.has(k)).map((k) => {
      const list = groups.get(k);
      return h('section', { class: 'srcgroup', 'data-city': k === 'NONE' ? null : k },
        h('h2', { class: 'srcgroup__head' },
          k === 'NONE' ? plateEl({ kind: 'plain', main: '未直接关联' }) : cityPlate(k),
          h('span', { class: 'group__count' }, `${list.length} 条`)),
        k === 'NONE' ? h('p', { class: 'muted' }, '这些来源的链接与任何地点、活动或系列的来源链接都不一致，通常是补充核对用的页面。') : null,
        h('ol', { class: 'srclist', role: 'list' }, list.map((s) => sourceItem(s, t))));
    });

    view.replaceChildren(datafile, ...sections,
      h('p', { class: 'foot' }, '底图 © OpenStreetMap contributors © CARTO。地图组件 Leaflet（BSD-2-Clause）。字体 Barlow、IBM Plex Mono（SIL Open Font License）。'));
    applyMarkerFilter(null);
  }

  function sourceItem(s, t) {
    const expired = s.validUntil != null && s.validUntil < t;
    const refs = [];
    for (const p of s.refs.places) refs.push(h('a', { href: '#' + p.id, 'data-route': p.id, class: 'link' }, p.name));
    for (const e of s.refs.events) refs.push(h('span', null, `活动：${e.title}`));
    for (const se of s.refs.series) refs.push(h('span', null, `系列：${se.title || se.id}`));
    return h('li', { class: 'src' },
      h('div', { class: 'src__head' },
        h('span', { class: 'src__domain' }, extLink(s.url, domainOf(s.url))),
        s.verifiedAt != null ? h('span', { class: 'src__date' }, `核验 ${ymd(s.verifiedAt, VERIFY_TZ)}`) : null),
      pathOf(s.url) ? h('p', { class: 'src__path' }, pathOf(s.url)) : null,
      s.status ? h('p', { class: 'src__status' }, s.status) : null,
      s.license ? h('p', { class: 'src__meta' }, h('span', { class: 'k' }, '许可'), s.license) : null,
      s.validUntil != null
        ? h('p', { class: 'src__meta' }, h('span', { class: 'k' }, '有效至'), `${ymd(s.validUntil, s.tz)} ${hm(s.validUntil, s.tz)}（${tzName(s.tz)}）`, expired ? h('span', { class: 'badge' }, '已过期') : null)
        : null,
      refs.length ? h('p', { class: 'src__refs' }, h('span', null, '用于'), refs) : null);
  }

  /* ------------------------------------------------------------------ render dispatcher, states */

  function render() {
    if (!state.data) return;
    renderCounts();
    if (state.tab === 'places') {
      const p = state.placeId && state.data.placeById.get(state.placeId);
      if (p) renderDetail(p); else { state.placeId = null; renderPlaces(); }
    } else if (state.tab === 'events') {
      renderEvents();
    } else {
      renderSources();
    }
    writeHash();
  }

  function showLoading() {
    els.views[state.tab].replaceChildren(h('div', { class: 'state', role: 'status' },
      h('p', { class: 'state__title' }, '正在读取 content.json…'),
      h('div', { class: 'state__line', 'aria-hidden': 'true' }),
      h('p', { class: 'state__body' }, '地点、活动和来源都来自同一份公开数据文件。')));
  }
  function showError(err) {
    let why = '网络连接失败，或文件暂时无法访问。';
    if (err && /^HTTP (\d+)/.test(err.message)) why = `服务器返回 ${err.message.slice(5)}。`;
    else if (err instanceof SyntaxError) why = '文件内容不是有效的 JSON。';
    else if (err && err.message === 'shape') why = '文件结构与预期不符。';
    const retry = h('button', { type: 'button', class: 'btn' }, '重试');
    retry.addEventListener('click', () => load());
    els.views[state.tab].replaceChildren(h('div', { class: 'state state--error', role: 'alert' },
      h('p', { class: 'state__title' }, '无法读取 content.json'),
      h('p', { class: 'state__body' }, why, ' 地图和时钟仍可使用；稍后重试，或直接打开数据文件检查。'),
      h('div', { class: 'empty__actions' }, retry, h('a', { class: 'btn', href: CONTENT_PATH, target: '_blank', rel: 'noopener noreferrer' }, '打开 content.json', icon('ext')))));
    retry.focus({ preventScroll: true });
  }

  async function load() {
    showLoading();
    try {
      const res = await fetch(CONTENT_PATH, { cache: 'no-cache' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      state.data = normalize(json);
    } catch (err) {
      state.data = null;
      showError(err);
      return;
    }
    buildMarkers();
    const token = readHash();
    if (!route(token, { focus: false })) render();
    refreshMaps({ refit: !state.placeId });
  }

  /* ------------------------------------------------------------------ clocks (every minute) */

  let dstCache = null;
  function clockDiffText(t) {
    const lo = offsetMin(t, CITIES.LONDON.tz);
    const fo = offsetMin(t, CITIES.FUZHOU.tz);
    const diff = (fo - lo) / 60;
    if (!dstCache || (dstCache.at != null && t >= dstCache.at)) {
      const a = nextOffsetChange(t, CITIES.LONDON.tz);
      const b = nextOffsetChange(t, CITIES.FUZHOU.tz);
      const at = [a, b].filter((x) => x != null).sort((x, y) => x - y)[0] ?? null;
      dstCache = { at };
    }
    const fmtH = (x) => `${Number.isInteger(x) ? x : x.toFixed(1)} 小时`;
    const out = [['时差 ', h('b', null, fmtH(diff))]];
    if (dstCache.at != null) {
      const after = (offsetMin(dstCache.at + 60000, CITIES.FUZHOU.tz) - offsetMin(dstCache.at + 60000, CITIES.LONDON.tz)) / 60;
      out.push(`，${md(dstCache.at, CITIES.LONDON.tz)}起 ${fmtH(after)}`);
    }
    return out;
  }
  function tickClocks() {
    const t = now();
    const iso = new Date(t).toISOString();
    const days = {};
    for (const key of CITY_ORDER) {
      const tz = CITIES[key].tz;
      const p = partsOf(t, tz);
      days[key] = { idx: dayIndex(t, tz), wd: p.wd, md: `${p.mo}月${p.d}日` };
      for (const el of $$(`[data-clock="${key}"]`)) { el.textContent = `${pad(p.h)}:${pad(p.mi)}`; if (el.tagName === 'TIME') el.setAttribute('datetime', iso); }
      for (const el of $$(`[data-clock-mini="${key}"]`)) el.textContent = `${pad(p.h)}:${pad(p.mi)}`;
      const zone = zoneShort(t, tz);
      for (const el of $$(`[data-zone="${key}"]`)) { el.textContent = key === 'LONDON' ? zone : utcLabel(offsetMin(t, tz)); el.title = utcLabel(offsetMin(t, tz)); }
      for (const el of $$(`[data-cap-sub="${key}"]`)) el.textContent = `${p.wd} ${p.mo}月${p.d}日 · ${zone}`;
    }
    const differs = days.LONDON.idx !== days.FUZHOU.idx;
    for (const key of CITY_ORDER) for (const el of $$(`[data-day="${key}"]`)) el.textContent = differs ? days[key].wd : '';
    const diffEl = $('[data-clock-diff]');
    if (diffEl) diffEl.replaceChildren(...clockDiffText(t).flat());
  }

  function renderSurveyLine() {
    const el = $('[data-surveyline]');
    if (!el) return;
    const a = CITIES.LONDON.ref;
    const b = CITIES.FUZHOU.ref;
    const km = haversineKm(a, b);
    el.replaceChildren(
      h('span', { class: 'surveyline__end' }, h('span', null, `伦敦 · ${a.label}`), h('span', { class: 'mono' }, fmtCoord(a.lat, a.lng, 4))),
      h('span', { class: 'surveyline__span' }, h('span', { class: 'mono' }, `${nf0.format(km)} km`), h('span', null, '大圆距离')),
      h('span', { class: 'surveyline__end' }, h('span', null, `福州 · ${b.label}`), h('span', { class: 'mono' }, fmtCoord(b.lat, b.lng, 4))));
  }

  function tick() {
    tickClocks();
    refreshRelative();
    if (state.data && state.tab === 'events' && partitionKey() !== state.partition) {
      const y = scroller().scrollTop;
      renderEvents();
      scroller().scrollTop = y;
    }
    if (state.data) renderCounts();
  }
  function scheduleTick() {
    tick();
    window.setTimeout(scheduleTick, 60000 - (Date.now() % 60000) + 40);
  }

  /* ------------------------------------------------------------------ events wiring */

  function wire() {
    for (const b of $$('[data-set-city]')) b.addEventListener('click', () => setCity(b.dataset.setCity));
    for (const b of $$('[data-map-city]')) {
      b.addEventListener('click', () => { setMapCity(b.dataset.mapCity); refreshMaps(); });
    }
    for (const t of els.tabs) {
      t.addEventListener('click', () => setTab(t.dataset.tab));
      t.addEventListener('keydown', (e) => {
        const i = els.tabs.indexOf(t);
        let j = null;
        if (e.key === 'ArrowRight') j = (i + 1) % els.tabs.length;
        else if (e.key === 'ArrowLeft') j = (i - 1 + els.tabs.length) % els.tabs.length;
        else if (e.key === 'Home') j = 0;
        else if (e.key === 'End') j = els.tabs.length - 1;
        if (j == null) return;
        e.preventDefault();
        els.tabs[j].focus();
        setTab(els.tabs[j].dataset.tab);
      });
    }
    $('[data-theme-toggle]').addEventListener('click', () => {
      state.themePref = THEME_CYCLE[(THEME_CYCLE.indexOf(state.themePref) + 1) % THEME_CYCLE.length];
      store.set(STORE_THEME, state.themePref);
      applyTheme();
    });
    const onScheme = () => { if (state.themePref === 'system') updateTiles(); };
    if (mqDark.addEventListener) mqDark.addEventListener('change', onScheme); else if (mqDark.addListener) mqDark.addListener(onScheme);
    const onLayout = () => refreshMaps();
    for (const mq of [mqDesktop, mqWide]) { if (mq.addEventListener) mq.addEventListener('change', onLayout); else if (mq.addListener) mq.addListener(onLayout); }

    $('[data-home]').addEventListener('click', (e) => {
      e.preventDefault();
      state.placeId = null;
      selectOnMap(null);
      setTab('places', { render: false });
      render();
      scrollPanelTop();
    });

    // In-page links carry bare tokens; apply them without adding history entries.
    doc.addEventListener('click', (e) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const a = e.target.closest && e.target.closest('a[data-route]');
      if (!a) return;
      e.preventDefault();
      route(a.dataset.route, { focus: true });
    });
    window.addEventListener('hashchange', () => {
      const token = readHash();
      if (token && token !== currentToken()) route(token, { focus: false });
    });
    doc.addEventListener('visibilitychange', () => { if (!doc.hidden) tick(); });
  }

  /* ------------------------------------------------------------------ boot */

  function boot() {
    const savedTheme = store.get(STORE_THEME);
    state.themePref = THEME_CYCLE.includes(savedTheme) ? savedTheme : 'system';
    const token = readHash();
    const low = token && token.toLowerCase();
    const savedCity = store.get(STORE_CITY);
    let city = ['LONDON', 'FUZHOU', 'BOTH'].includes(savedCity) ? savedCity : 'BOTH';
    if (low === 'london' || low === 'fuzhou' || low === 'both') city = low.toUpperCase();
    if (token && /^(london|fuzhou)-/.test(low) && city !== 'BOTH') city = low.startsWith('london') ? 'LONDON' : 'FUZHOU';
    state.city = city;
    els.atlas.dataset.city = city;
    setMapCity(city === 'FUZHOU' ? 'FUZHOU' : 'LONDON');
    for (const b of $$('[data-set-city]')) b.setAttribute('aria-pressed', String(b.dataset.setCity === city));
    if (low === 'events' || low === 'sources') setTab(low, { render: false });

    initMaps();
    applyTheme();
    renderSurveyLine();
    wire();
    scheduleTick();
    load();
  }

  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', boot); else boot();
})();
