/* 双城图志 · Twin City Atlas — front end.
 * Plain ES2020, no build step, no framework. Reads content.json (read-only, treated as untrusted text:
 * every data string reaches the DOM through textContent / attributes, never innerHTML).
 */
(function () {
  'use strict';

  /* ------------------------------------------------------------------ constants */

  const CONTENT_PATH = 'content.json';
  const GUIDE_PATH = 'guide/london.json'; // web-only London guide layer (the apps read content.json only)
  const PUBLIC_CONTENT_URL = 'https://mikhailxiaomaikou.github.io/twin-city-atlas-content/content.json';
  const CLUSTER_SRC = 'vendor/leaflet.markercluster/leaflet.markercluster.js';
  const DAY = 86400000;
  const STALE_DAYS = 30;
  const AGING_DAYS = 21; // rows show their verification age only from here on
  // Date-only verification stamps in the data are midnights in China Standard Time (e.g. 1788624000000 =
  // 2026-09-06 00:00 UTC+8), so verification dates are read on that clock for both cities.
  const VERIFY_TZ = 'Asia/Shanghai';
  const STORE_CITY = 'tca.city';
  const STORE_THEME = 'tca.theme';
  const STORE_PLAN = 'tca.plan';
  const TOKEN_RE = /^[A-Za-z0-9._~-]+$/;
  const EARTH_RADIUS_KM = 6371.0088;
  const CORE_KM = 5; // the first view of a city frames the places within this distance of its reference point
  const OUTER_KM = 6; // London places this far out, outside any named area, are grouped as 外伦敦
  const SERIES_SPAN = 31 * DAY; // sessions of one series closer than this collapse into one row
  const NO_CAT = 'UNCATEGORISED';

  const CITIES = {
    LONDON: { key: 'LONDON', zh: '伦敦', en: 'London', token: 'london', tz: 'Europe/London', ref: { lat: 51.5073, lng: -0.1276, label: 'Charing Cross' } },
    FUZHOU: { key: 'FUZHOU', zh: '福州', en: 'Fuzhou', token: 'fuzhou', tz: 'Asia/Shanghai', ref: { lat: 26.0761, lng: 119.2969, label: '城区参考点' } },
  };
  const CITY_ORDER = ['LONDON', 'FUZHOU'];

  const CATEGORIES = {
    LANDMARK: { glyph: '景', zh: '名胜', terms: '名胜 景点 地标 宫 教堂 塔 桥 landmark sight palace abbey cathedral tower bridge' },
    CULTURE: { glyph: '文', zh: '文化', terms: '文化 博物馆 美术馆 展览 历史 寺 culture museum gallery' },
    VIEW: { glyph: '望', zh: '观景', terms: '观景 登高 夜景 日落 游船 缆车 view viewpoint skyline sunset' },
    NATURE: { glyph: '园', zh: '自然', terms: '自然 公园 园 山 湖 nature park garden' },
    FOOD: { glyph: '食', zh: '美食', terms: '美食 食物 小吃 市场 餐饮 下午茶 咖啡 food market tea coffee' },
    NIGHT: { glyph: '夜', zh: '夜生活', terms: '夜生活 剧院 音乐剧 演出 酒馆 酒吧 爵士 喜剧 night theatre musical show pub bar' },
    SHOP: { glyph: '购', zh: '购物', terms: '购物 百货 商店 书店 市集 shop shopping store bookshop' },
    STROLL: { glyph: '街', zh: '街区', terms: '街区 漫步 散步 运河 街头艺术 stroll walk street canal' },
    COURSE: { glyph: '课', zh: '课程', terms: '课程 培训 学习 讲座 course class' },
    CHESS: { glyph: '棋', zh: '棋类', terms: '棋 国际象棋 围棋 棋会 chess go' },
    SCHOOL: { glyph: '校', zh: '校园', terms: '校园 学校 大学 school campus university' },
  };
  const CATEGORY_ORDER = Object.keys(CATEGORIES);

  const STATUS = {
    SCHEDULED: { zh: '已排期', quiet: true },
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
  // Historic quarters that sit inside a district: listed under the district plate, named in the row.
  const FUZHOU_PARENT = { 三坊七巷: '鼓楼', 南后街: '鼓楼' };
  const FUZHOU_REGION_INDEX = new Map();
  for (const [zh, py, ...alt] of FUZHOU_REGIONS) {
    for (const name of [zh, py, ...alt]) FUZHOU_REGION_INDEX.set(regionKey(name), [zh, py]);
  }

  // London neighbourhoods → a handful of areas, so the list groups places that are a short walk apart.
  // Areas are ordered from Charing Cross outwards by the distance of their places; anything farther than
  // OUTER_KM that is not named here goes to 外伦敦.
  const LONDON_AREAS = [
    { key: 'westend', en: 'West End', zh: '西区 · 考文特花园', regions: ['Trafalgar Square', 'Covent Garden', 'Strand', 'Aldwych', 'West End', 'Holborn', 'Fitzrovia', 'Soho', 'Leicester Square', 'Chinatown'] },
    { key: 'westminster', en: 'Westminster', zh: '威斯敏斯特 · 圣詹姆斯', regions: ['Westminster', 'St James\'s', 'Whitehall', 'Victoria', 'Pimlico', 'Mayfair', 'Piccadilly', 'Green Park'] },
    { key: 'bloomsbury', en: 'Bloomsbury', zh: '布鲁姆斯伯里 · 国王十字', regions: ['Bloomsbury', 'Euston', 'St Pancras', 'King\'s Cross', 'Russell Square'] },
    { key: 'southbank', en: 'South Bank', zh: '南岸 · 萨瑟克', regions: ['South Bank', 'Bankside', 'London Bridge', 'Waterloo', 'Bermondsey', 'Elephant & Castle', 'Southwark', 'Borough', 'Lambeth'] },
    { key: 'city', en: 'City', zh: '金融城 · 伦敦塔', regions: ['City of London', 'Tower Hill', 'Barbican', 'Clerkenwell', 'Smithfield', 'Temple', 'Farringdon', 'Aldgate'] },
    { key: 'east', en: 'East End', zh: '东区 · 肖迪奇', regions: ['Spitalfields', 'Shoreditch', 'Brick Lane', 'Whitechapel', 'Bethnal Green', 'Hackney'] },
    { key: 'kensington', en: 'Kensington', zh: '南肯辛顿 · 海德公园', regions: ['South Kensington', 'Kensington Gardens', 'Hyde Park', 'Bayswater', 'Knightsbridge', 'Kensington', 'Notting Hill', 'Holland Park'] },
    { key: 'regents', en: 'Regent\'s Park', zh: '摄政公园 · 卡姆登', regions: ['Regent\'s Park', 'Camden Town', 'Camden', 'Primrose Hill', 'Marylebone', 'Little Venice', 'Paddington'] },
    { key: 'chelsea', en: 'Chelsea', zh: '切尔西 · 巴特西', regions: ['Chelsea', 'Battersea'] },
    { key: 'docklands', en: 'Greenwich', zh: '格林威治 · 道克兰', regions: ['Greenwich', 'Docklands', 'Canary Wharf', 'Rotherhithe', 'Wapping', 'Limehouse'] },
    { key: 'north', en: 'Hampstead', zh: '汉普斯特德 · 北伦敦', regions: ['Hampstead', 'Highgate', 'Alexandra Palace'] },
  ];
  const OUTER_AREA = { key: 'outer', en: 'Outer London', zh: '外伦敦', outer: true, regions: [] };
  const LONDON_AREA_INDEX = new Map();
  for (const a of LONDON_AREAS) for (const r of a.regions) LONDON_AREA_INDEX.set(regionKey(r), a);

  // Hosts that serve many unrelated pages: never used on their own to tie a source to a place.
  const SHARED_HOST_RE = /(^|\.)(wikipedia\.org|wikidata\.org|wikimedia\.org|doogal\.co\.uk|openstreetmap\.org|blogspot\.com|wordpress\.com|github\.io|jotform\.com|eventbrite\.[a-z.]+|google\.[a-z.]+|englishchess\.org\.uk|gov\.uk|gov\.cn)$/;
  // Reference works cited for a place's coordinates (listed under 位置 › 坐标依据).
  const COORD_HOST_RE = /(^|\.)(wikipedia\.org|wikidata\.org|doogal\.co\.uk|openstreetmap\.org|latlong\.net|mapcarta\.com|geohack\.toolforge\.org)$/;
  const GENERIC_WORDS = new Set(['london', 'the', 'park', 'parks', 'gardens', 'garden', 'royal', 'museum', 'market', 'chess', 'club', 'library', 'college', 'centre', 'center', 'church', 'school', 'street', 'house', 'gallery', 'campus', 'university', 'south', 'north', 'east', 'west', 'hall']);
  const HOW_ZH = { postcode: '按邮编对应', coords: '按坐标对应', name: '按名称对应', region: '按区域名对应', site: '按网站对应', guide: '攻略资料引用' };
  const GUIDE_LICENSE = '仅整理必要事实；原始网页及图片版权归来源方。';

  // Basemap tiles, in order of preference. When a provider is unreachable (blocked network, outage) the map falls
  // back to the next one; OpenStreetMap's own tiles have no dark style, so they are inverted in dark mode (CSS).
  const OSM_ATTRIBUTION = '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap</a> contributors';
  const TILE_PROVIDERS = [
    {
      key: 'carto',
      url: { light: 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', dark: 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png' },
      opts: { subdomains: 'abcd', maxZoom: 20, attribution: `${OSM_ATTRIBUTION} &copy; <a href="https://carto.com/attributions" target="_blank" rel="noopener noreferrer">CARTO</a>` },
    },
    {
      key: 'osm',
      url: { light: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png', dark: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png' },
      opts: { maxNativeZoom: 19, maxZoom: 20, attribution: OSM_ATTRIBUTION },
    },
  ];
  const STORE_TILES = 'tca.tiles'; // remembers a fallback for a day, so a blocked provider is not retried on every load
  const TILE_FAIL = 4; // errors with no tile loaded before giving up on a provider

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
  const smooth = () => (mqReduce.matches ? 'auto' : 'smooth');

  let collator;
  try { collator = new Intl.Collator('zh-Hans-CN-u-co-pinyin', { numeric: true, sensitivity: 'base' }); } catch { collator = new Intl.Collator(undefined, { numeric: true }); }
  const cmp = (a, b) => collator.compare(a, b);

  const store = {
    get(key) { try { return window.localStorage.getItem(key); } catch { return null; } },
    set(key, value) { try { window.localStorage.setItem(key, value); } catch { /* storage unavailable: keep working */ } },
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
    down: [['path', { d: 'M3.5 6 8 10.5 12.5 6' }]],
    up: [['path', { d: 'M3.5 10 8 5.5 12.5 10' }]],
    cal: [['rect', { x: 2.5, y: 3.5, width: 11, height: 10, rx: 1 }], ['path', { d: 'M2.5 6.5h11M5.5 2v3M10.5 2v3M6 10h4M8 8v4' }]],
    sun: [['circle', { cx: 8, cy: 8, r: 2.8 }], ['path', { d: 'M8 1.5v1.6M8 12.9v1.6M1.5 8h1.6M12.9 8h1.6M3.4 3.4l1.1 1.1M11.5 11.5l1.1 1.1M3.4 12.6l1.1-1.1M11.5 4.5l1.1-1.1' }]],
    moon: [['path', { d: 'M13 9.6A5.5 5.5 0 1 1 6.4 3a4.4 4.4 0 0 0 6.6 6.6z' }]],
    auto: [['circle', { cx: 8, cy: 8, r: 5.5 }], ['path', { d: 'M8 2.5a5.5 5.5 0 0 1 0 11z', fill: 'currentColor', stroke: 'none' }]],
    fit: [['path', { d: 'M2.5 6V2.5H6M10 2.5h3.5V6M13.5 10v3.5H10M6 13.5H2.5V10' }], ['circle', { cx: 8, cy: 8, r: 1.6 }]],
    warn: [['path', { d: 'M8 2.2 14.2 13H1.8z' }], ['path', { d: 'M8 6.5v3M8 11.3v.2' }]],
    locate: [['circle', { cx: 8, cy: 8, r: 4.2 }], ['circle', { cx: 8, cy: 8, r: 1.3, fill: 'currentColor', stroke: 'none' }], ['path', { d: 'M8 1.5v2.3M8 12.2v2.3M1.5 8h2.3M12.2 8h2.3' }]],
    pin: [['path', { d: 'M8 14.2s-4.3-4.4-4.3-7.6a4.3 4.3 0 0 1 8.6 0c0 3.2-4.3 7.6-4.3 7.6z' }], ['circle', { cx: 8, cy: 6.5, r: 1.5 }]],
    star: [['path', { d: 'M8 1.9l1.8 3.8 4.1.5-3 2.9.8 4.1L8 11.2l-3.7 2 .8-4.1-3-2.9 4.1-.5z' }]],
    'star-on': [['path', { d: 'M8 1.9l1.8 3.8 4.1.5-3 2.9.8 4.1L8 11.2l-3.7 2 .8-4.1-3-2.9 4.1-.5z', fill: 'currentColor' }]],
    swap: [['path', { d: 'M3 5.5h9.5M10 3l2.5 2.5L10 8M13 10.5H3.5M6 8l-2.5 2.5L6 13' }]],
    walk: [['circle', { cx: 8.6, cy: 2.8, r: 1.3 }], ['path', { d: 'M7.6 5.5 6.4 9.2l2.3 1.6.7 3.6M7.6 5.5l2.2 1.6 1.9.4M6.4 9.2l-1.6 4.3M7.6 5.5 5.3 6.8 4.6 8.8' }]],
    tube: [['circle', { cx: 8, cy: 8, r: 5 }], ['path', { d: 'M1.8 8h12.4' }]],
    route: [['circle', { cx: 3.5, cy: 12.5, r: 1.5 }], ['circle', { cx: 12.5, cy: 3.5, r: 1.5 }], ['path', { d: 'M5 12.5h4.5a2.5 2.5 0 0 0 0-5h-3a2.5 2.5 0 0 1 0-5H11' }]],
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
    return fold(s).trim().replace(/[\u2018\u2019]/g, '\'').replace(/\s+(district|area|scenic area)$/, '').replace(/区$/, '').replace(/\s+/g, ' ');
  }
  /** Letters and digits only: for comparing names against URL slugs. */
  function compact(s) { return fold(s).replace(/['\u2019.]/g, '').replace(/[^a-z0-9\u3400-\u9fff]+/g, ''); }
  const terms = (q) => fold(q).split(/\s+/).filter(Boolean);

  /** Accept only absolute http(s) URLs for links. */
  function safeUrl(u) {
    try {
      const url = new URL(String(u));
      return url.protocol === 'https:' || url.protocol === 'http:' ? url : null;
    } catch { return null; }
  }
  /** Key for matching sources[] to places/events/series: protocol, "www.", host case, a trailing slash,
   *  tracking parameters and parameter order are ignored; meaningful queries (?postcode=, ?aid=) are kept. */
  function urlKey(u) {
    const url = safeUrl(u);
    if (!url) return fold(str(u)).replace(/\/+$/, '');
    const host = url.host.toLowerCase().replace(/^www\./, '');
    const path = url.pathname.replace(/\/+$/, '');
    const sp = new window.URLSearchParams(url.search);
    for (const k of Array.from(sp.keys())) if (/^(utm_|mc_)|^(fbclid|gclid)$/i.test(k)) sp.delete(k);
    sp.sort();
    const q = sp.toString();
    return host + path + (q ? '?' + q : '');
  }
  function hostOf(u) {
    const url = safeUrl(u);
    return url ? url.hostname.toLowerCase().replace(/^www\./, '') : '';
  }
  function domainOf(u) {
    const url = safeUrl(u);
    return url ? url.hostname.replace(/^www\./, '') : str(u);
  }
  function pathOf(u) {
    const url = safeUrl(u);
    if (!url) return '';
    let p = url.pathname + url.search;
    try { p = decodeURI(p); } catch { /* keep encoded */ }
    return p === '/' ? '' : p;
  }
  /** The site a URL belongs to (registrable domain), or '' for shared hosts. */
  function siteOf(u) {
    const host = hostOf(u);
    if (!host || SHARED_HOST_RE.test(host)) return '';
    const p = host.split('.');
    if (p.length >= 3 && p[p.length - 1].length === 2 && /^(co|ac|org|gov|ltd|plc|net|sch|nhs|me|com|edu)$/.test(p[p.length - 2])) return p.slice(-3).join('.');
    return p.slice(-2).join('.');
  }

  function extLink(u, text, cls = 'link ext', attrs) {
    const url = safeUrl(u);
    if (!url) return h('span', { class: 'muted' }, str(u) ? `${str(u)}（不是可打开的网页链接）` : '无有效链接');
    return h('a', Object.assign({ class: cls, href: url.href, target: '_blank', rel: 'noopener noreferrer' }, attrs || {}),
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
  const fmtKm = (km) => (km < 10 ? km.toFixed(1) : nf0.format(km));

  /* ------------------------------------------------------------------ text: provenance preambles, schedules, highlights */

  // "馆方参观页列示（伦敦当地时间）：" and similar lead-ins say where the hours come from, not what they are.
  const PREAMBLE_RE = /^[^：。；，列]{0,22}?(?:列示|时间表|开放时间表?|页面|官网|常规棋会|营业时间)[^：。；]{0,12}?(?:（[^（）]{0,10}当地时间）)?：/;
  const LOCAL_TIME_RE = /（(?:伦敦|福州)当地时间）/g;
  const SCHED_START_RE = /^(?:\d{4}年|\d{4}-\d{2}-\d{2}|\d{1,2}月|周[一二三四五六日]|每(?:日|天|周)|工作日|平日|周末|节假日|银行假日)/;
  const SCHED_HAS_RE = /\d{1,2}:\d{2}|闭|休市|休息|开放|关门|关闭/;
  const WEEKDAY_PAREN = '(?:（周[一二三四五六日]）)?';
  // Dates, date ranges and time ranges that must not break across lines.
  const NOWRAP_RE = new RegExp([
    '\\d{4}-\\d{2}-\\d{2}(?:\\s*(?:至|–|—)\\s*\\d{4}-\\d{2}-\\d{2})?',
    `(?:\\d{4}年)?\\d{1,2}月\\d{1,2}日?${WEEKDAY_PAREN}\\s*(?:至|–|—|-)\\s*(?:\\d{4}年)?(?:\\d{1,2}月)?\\d{1,2}日${WEEKDAY_PAREN}`,
    `(?:\\d{4}年)?\\d{1,2}月\\d{1,2}日${WEEKDAY_PAREN}`,
    '(?:次日\\s*)?\\d{1,2}:\\d{2}\\s*[–—-]\\s*(?:次日\\s*)?\\d{1,2}:\\d{2}',
  ].join('|'), 'g');

  /** Text → nodes, with dates and time ranges wrapped so they never split over two lines. */
  function richText(s) {
    const text = String(s);
    const out = [];
    let last = 0;
    NOWRAP_RE.lastIndex = 0;
    let m;
    while ((m = NOWRAP_RE.exec(text))) {
      if (m.index > last) out.push(text.slice(last, m.index));
      out.push(h('span', { class: /\d:\d\d/.test(m[0]) ? 'tm' : 'nw' }, m[0]));
      last = m.index + m[0].length;
    }
    if (last < text.length) out.push(text.slice(last));
    return out;
  }

  /** Split at top-level separators (not inside （…） or (…)). Returns [{text, sep}] where sep preceded the piece. */
  function splitTop(text, seps) {
    const out = [];
    let depth = 0;
    let cur = '';
    let sep = '';
    for (const ch of text) {
      if (ch === '（' || ch === '(') depth += 1;
      else if ((ch === '）' || ch === ')') && depth > 0) depth -= 1;
      if (depth === 0 && seps.includes(ch)) {
        out.push({ text: cur, sep });
        cur = '';
        sep = ch;
        continue;
      }
      cur += ch;
    }
    out.push({ text: cur, sep });
    return out.filter((x) => x.text.trim());
  }

  function splitPreamble(text) {
    const m = String(text).match(PREAMBLE_RE);
    if (!m) return { lead: '', body: String(text) };
    return { lead: m[0].slice(0, -1), body: String(text).slice(m[0].length) };
  }
  /** One-glance version of the opening info for list rows: no provenance lead-in, no "local time" note. */
  function excerptOf(text) {
    if (!text) return '';
    return splitPreamble(text).body.replace(LOCAL_TIME_RE, '').trim();
  }
  /** A sentence that lists several dated or weekday schedules → list items; otherwise null. */
  function scheduleItems(sentence) {
    const parts = splitTop(sentence, '，；');
    const isStart = (t) => SCHED_START_RE.test(t.trim()) && SCHED_HAS_RE.test(t);
    if (parts.length < 3 || parts.filter((x) => isStart(x.text)).length < 2) return null;
    const items = [];
    for (const x of parts) {
      if (!items.length || isStart(x.text) || x.sep === '；') items.push(x.text.trim());
      else items[items.length - 1] += x.sep + x.text;
    }
    return items.length >= 2 ? items : null;
  }

  /** fold() character by character, with a map from each folded position back to the original string. */
  function foldMap(s) {
    let f = '';
    const at = [];
    let i = 0;
    for (const ch of s) {
      const x = fold(ch);
      for (let k = 0; k < x.length; k += 1) at.push(i);
      f += x;
      i += ch.length;
    }
    at.push(i);
    return { f, at };
  }
  /** Wrap occurrences of search terms in <mark>. */
  function highlight(text, qs) {
    const s = String(text);
    if (!qs || !qs.length) return [s];
    const { f, at } = foldMap(s);
    const spans = [];
    for (const t of qs) {
      let i = f.indexOf(t);
      while (i !== -1 && t) { spans.push([at[i], at[i + t.length]]); i = f.indexOf(t, i + t.length); }
    }
    if (!spans.length) return [s];
    spans.sort((a, b) => a[0] - b[0]);
    const merged = [];
    for (const sp of spans) {
      const last = merged[merged.length - 1];
      if (last && sp[0] <= last[1]) last[1] = Math.max(last[1], sp[1]); else merged.push(sp.slice());
    }
    const out = [];
    let pos = 0;
    for (const [a, b] of merged) {
      if (a > pos) out.push(s.slice(pos, a));
      out.push(h('mark', null, s.slice(a, b)));
      pos = b;
    }
    if (pos < s.length) out.push(s.slice(pos));
    return out;
  }
  /** Keyword in context: a short window of `text` around the first matching term, or null. */
  function kwic(text, qs, before = 14, after = 44) {
    const s = String(text);
    const { f, at } = foldMap(s);
    let best = -1;
    let len = 0;
    for (const t of qs) {
      const i = f.indexOf(t);
      if (i !== -1 && (best === -1 || at[i] < best)) { best = at[i]; len = at[i + t.length] - at[i]; }
    }
    if (best === -1) return null;
    const a = Math.max(0, best - before);
    const b = Math.min(s.length, best + len + after);
    return (a > 0 ? '…' : '') + s.slice(a, b) + (b < s.length ? '…' : '');
  }

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
    try { dtf(tz, { hour: 'numeric' }); return tz; } catch { return null; }
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
  /** Day index (days since 1970-01-01) → labels. */
  function dayLabel(idx) {
    const d = new Date(idx * DAY);
    return { md: `${d.getUTCMonth() + 1}月${d.getUTCDate()}日`, short: `${d.getUTCMonth() + 1}/${d.getUTCDate()}`, wd: WEEKDAYS[d.getUTCDay()], dow: d.getUTCDay(), mo: d.getUTCMonth() + 1, d: d.getUTCDate() };
  }
  const mondayOf = (idx) => idx - (((idx % 7) + 7 + 3) % 7); // day 0 (1970-01-01) was a Thursday
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
    from = Math.floor(from / 60000) * 60000; // minute-aligned, so the answer is the exact transition minute
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
  function ageDays(ts, now = Date.now()) { return dayIndex(now, VERIFY_TZ) - dayIndex(ts, VERIFY_TZ); }
  function agoText(ts, now = Date.now()) {
    const n = ageDays(ts, now);
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
  /** A length of time: n 分钟 / n 小时 (under two days) / n 天. */
  function durationText(ms) {
    if (ms < 3600e3) return `${Math.max(1, Math.round(ms / 60000))} 分钟`;
    if (ms < 48 * 3600e3) return `${Math.round(ms / 3600e3)} 小时`;
    return `${Math.round(ms / DAY)} 天`;
  }
  function deadlineText(deadline, tz, now = Date.now()) {
    const when = `${md(deadline, tz)} ${hm(deadline, tz)}`;
    if (deadline <= now) return { text: `已于 ${when} 截止`, past: true };
    return { text: `截止 ${when}（${tzName(tz)}）· 还剩 ${durationText(deadline - now)}` };
  }

  /* ------------------------------------------------------------------ data normalisation */

  function catInfo(key) {
    if (CATEGORIES[key]) return Object.assign({ key }, CATEGORIES[key]);
    if (!key || key === NO_CAT) return { key: NO_CAT, glyph: '点', zh: '未分类', terms: '未分类', unknown: true };
    return { key, glyph: '点', zh: key.charAt(0) + key.slice(1).toLowerCase(), terms: '', unknown: true };
  }

  const UK_PC_RE = /\b([A-Z]{1,2}\d[A-Z\d]?)\s*\+?\s*(\d[A-Z]{2})\b/g;
  function postcodesIn(s) {
    const out = [];
    for (const m of String(s || '').toUpperCase().matchAll(UK_PC_RE)) out.push(m[1] + m[2]);
    return out;
  }
  /** London address → { outward: 'WC1B', district: 'WC1', full: 'WC1B3DG' } (any part may be ''). */
  function postcodeOf(address) {
    const up = String(address || '').toUpperCase();
    const full = up.match(/\b([A-Z]{1,2}\d[A-Z\d]?)\s*(\d[A-Z]{2})\b/);
    let outward = full ? full[1] : '';
    if (!outward) {
      const all = Array.from(up.matchAll(/\b((?:EC|WC|NW|SE|SW|N|E|W)\d{1,2}[A-Z]?)\b/g));
      outward = all.length ? all[all.length - 1][1] : '';
    }
    const d = outward.match(/^([A-Z]{1,2}\d{1,2})[A-Z]?$/);
    return { outward, district: d ? d[1] : outward, full: full ? full[1] + full[2] : '' };
  }

  function regionPlate(city, region, district) {
    if (!region) return { kind: 'plain', main: '未标注区域', sub: '' };
    if (city === 'FUZHOU') {
      const hit = FUZHOU_REGION_INDEX.get(regionKey(region));
      if (hit) return { kind: 'zh', main: hit[0], sub: hit[1] };
      return hasCJK(region) ? { kind: 'zh', main: region, sub: '' } : { kind: 'zh', main: region, sub: '', latin: true };
    }
    return { kind: 'en', main: region, code: district || '', sub: '' };
  }
  /** Postcode districts of a group: one code, a range within one letter prefix (WC1–WC2), or nothing. */
  function districtRange(members) {
    const ds = Array.from(new Set(members.map((p) => p.district).filter(Boolean)));
    if (!ds.length) return '';
    if (ds.length === 1) return ds[0];
    const parsed = ds.map((x) => x.match(/^([A-Z]+)(\d+)$/));
    if (parsed.every(Boolean) && new Set(parsed.map((m) => m[1])).size === 1) {
      const nums = parsed.map((m) => Number(m[2])).sort((a, b) => a - b);
      return `${parsed[0][1]}${nums[0]}–${parsed[0][1]}${nums[nums.length - 1]}`;
    }
    return '';
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
    const category = str(raw.category).toUpperCase() || NO_CAT;
    const cat = catInfo(category);
    const region = str(raw.region);
    const radius = num(raw.arrivalRadiusMeters);
    const address = str(raw.address);
    const pc = city === 'LONDON' ? postcodeOf(address) : { outward: '', district: '', full: '' };
    const openingInfo = str(raw.openingInfo);
    return {
      id,
      name: str(raw.name) || id,
      category: cat.key,
      cat,
      lat: hasCoords ? lat : null,
      lng: hasCoords ? lng : null,
      hasCoords,
      latDec: decimals(lat),
      lngDec: decimals(lng),
      address,
      description: str(raw.description),
      sourceUrl: str(raw.sourceUrl),
      verifiedAt: num(raw.verifiedAt),
      region,
      radius: radius != null && radius > 0 ? radius : null,
      openingInfo,
      excerpt: excerptOf(openingInfo),
      sourceVersion: num(raw.sourceVersion),
      city,
      postcode: pc.outward,
      district: pc.district,
      pcFull: pc.full,
      km: hasCoords ? haversineKm(CITIES[city].ref, { lat, lng }) : null,
      plate: null,
      group: null,
      rank: 0,
      search: '',
    };
  }

  /** Assign each place to a list group (London area / Fuzhou district) and order groups from the centre out. */
  function assignGroups(places) {
    const groups = new Map();
    for (const p of places) {
      let key;
      let area = null;
      let fz = null;
      if (p.city === 'LONDON') {
        area = p.region ? LONDON_AREA_INDEX.get(regionKey(p.region)) || null : null;
        if (!area && p.km != null && p.km > OUTER_KM) area = OUTER_AREA;
        key = area ? 'area:' + area.key : p.region ? 'r:' + regionKey(p.region) : '~';
      } else {
        const hit = p.region ? FUZHOU_REGION_INDEX.get(regionKey(p.region)) : null;
        const parent = hit && FUZHOU_PARENT[hit[0]];
        fz = parent ? FUZHOU_REGION_INDEX.get(regionKey(parent)) || [parent, ''] : hit;
        key = fz ? 'fz:' + fz[0] : p.region ? 'r:' + regionKey(p.region) : '~';
      }
      const gk = p.city + '|' + key;
      if (!groups.has(gk)) groups.set(gk, { key: gk, city: p.city, area, fz, places: [] });
      groups.get(gk).places.push(p);
      p.plate = regionPlate(p.city, p.region, p.district);
    }
    const avgKm = (list) => {
      const ks = list.map((p) => p.km).filter((x) => x != null);
      return ks.length ? ks.reduce((a, b) => a + b, 0) / ks.length : 999;
    };
    for (const g of groups.values()) {
      const label = g.places.map((p) => p.region).filter(Boolean).sort(cmp)[0] || '';
      if (g.area) g.plate = { kind: 'en', main: g.area.en, code: districtRange(g.places), sub: g.area.zh };
      else if (g.fz) g.plate = { kind: 'zh', main: g.fz[0], sub: g.fz[1] };
      else g.plate = regionPlate(g.city, label, districtRange(g.places));
      g.outer = !!(g.area && g.area.outer);
      g.rank = g.key.endsWith('|~') ? 1e7 : (g.outer ? 1e6 : 0) + avgKm(g.places);
      // inside a group: neighbourhoods nearest the centre first, then by name
      const regionKm = new Map();
      for (const p of g.places) {
        const rk = regionKey(p.region || '~');
        if (!regionKm.has(rk)) regionKm.set(rk, avgKm(g.places.filter((x) => regionKey(x.region || '~') === rk)));
      }
      g.places.sort((a, b) => (g.outer ? (a.km || 0) - (b.km || 0) : regionKm.get(regionKey(a.region || '~')) - regionKm.get(regionKey(b.region || '~'))) || cmp(a.name, b.name));
      g.places.forEach((p, i) => { p.group = g; p.rank = i; });
    }
    return groups;
  }

  /** Coordinates written in source notes: decimal pairs (51.5194, -0.1269 / 51.522°N 0.129°W) and DMS. */
  function coordsIn(s) {
    const out = [];
    const text = String(s || '');
    for (const m of text.matchAll(/(\d{1,3})°\s*(\d{1,2})′\s*(?:([\d.]+)″)?\s*([NS])[\s,，、]*(\d{1,3})°\s*(\d{1,2})′\s*(?:([\d.]+)″)?\s*([EW])/g)) {
      out.push({
        lat: (Number(m[1]) + Number(m[2]) / 60 + (Number(m[3]) || 0) / 3600) * (m[4] === 'S' ? -1 : 1),
        lng: (Number(m[5]) + Number(m[6]) / 60 + (Number(m[7]) || 0) / 3600) * (m[8] === 'W' ? -1 : 1),
      });
    }
    for (const m of text.matchAll(/(-?\d{1,3}\.\d{3,})\s*°?\s*([NS])?(?:\s*[,，、]\s*|\s+)(-?\d{1,3}\.\d{3,})\s*°?\s*([EW])?/g)) {
      let lat = Number(m[1]);
      let lng = Number(m[3]);
      if (m[2] === 'S') lat = -Math.abs(lat);
      if (m[4] === 'W') lng = -Math.abs(lng);
      if (Math.abs(lat) <= 90 && Math.abs(lng) <= 180) out.push({ lat, lng });
    }
    return out;
  }

  /**
   * Tie each source record to the place(s) it supports. content.json has no explicit link, so, in order:
   * 1 the URL is some place's / event's / series' source URL; 2 a full UK postcode in the URL or note matches
   * a place address; 3 coordinates in the note fall within 300 m of a place; 4 a place name appears in the note
   * or URL; 5 a distinctive word of a place's name or area appears in the URL of a site several places share;
   * 6 the site is used by exactly one place. The first rule that finds something wins. `candidates` also holds
   * hidden places: a source that only matches those is dropped.
   */
  function linkSources(sources, places, events, series, hidden, allById) {
    const byId = new Map(places.map((p) => [p.id, p]));
    const all = places.concat(hidden);
    const refs = new Map();
    const ref = (u) => {
      const k = urlKey(u);
      if (!refs.has(k)) refs.set(k, { places: [], events: [], series: [], ids: new Set() });
      return refs.get(k);
    };
    for (const p of places) if (p.sourceUrl) { const r = ref(p.sourceUrl); r.places.push(p); r.ids.add(p.id); }
    for (const e of events) if (e.sourceUrl) { const r = ref(e.sourceUrl); r.events.push(e); if (e.place) r.ids.add(e.place.id); }
    for (const s of series) if (s.sourceUrl) { const r = ref(s.sourceUrl); r.series.push(s); if (byId.has(s.placeId)) r.ids.add(s.placeId); }
    const bySite = new Map();
    for (const [k, r] of refs) {
      const site = siteOf('https://' + k);
      if (!site || !r.ids.size) continue;
      if (!bySite.has(site)) bySite.set(site, new Set());
      for (const id of r.ids) bySite.get(site).add(id);
    }
    const byPc = new Map();
    for (const p of all) for (const pc of postcodesIn(p.address)) { if (!byPc.has(pc)) byPc.set(pc, []); byPc.get(pc).push(p.id); }
    const nameSegs = all.map((p) => {
      const segs = [];
      for (const raw of String(p.name).split(/\s+[·—–]\s+|,\s+/)) {
        const seg = raw.replace(/^the\s+/i, '').trim();
        if (/[a-z]/i.test(seg) && seg.length >= 8) segs.push(seg);
        const bare = seg.replace(/\s+(market|museum|park|gardens|library|club)$/i, '');
        if (bare !== seg && bare.length >= 8) segs.push(bare);
      }
      return { id: p.id, segs };
    });
    const tokensOf = (p) => Array.from(new Set(fold(`${p.name} ${p.region}`).replace(/['\u2019]/g, '').split(/[^a-z]+/).filter((w) => w.length >= 6 && !GENERIC_WORDS.has(w))));

    const out = [];
    for (const s of sources) {
      if (s.force) {
        // guide records name their place: no guessing
        s.placeIds = s.force.filter((id) => allById.has(id));
        if (!s.placeIds.length) continue;
        s.how = s.placeIds.some((id) => urlKey(allById.get(id).sourceUrl) === s.key) ? 'url' : 'guide';
        s.refs = { places: [], events: [], series: [] };
        out.push(s);
        continue;
      }
      const exact = refs.get(s.key);
      let ids = [];
      let how = '';
      if (exact && exact.ids.size) { ids = Array.from(exact.ids); how = 'url'; }
      let decoded = s.url;
      try { decoded = decodeURIComponent(s.url.replace(/\+/g, ' ')); } catch { /* keep raw */ }
      const note = s.status;
      if (!ids.length) {
        for (const pc of postcodesIn(decoded).concat(postcodesIn(note))) for (const id of byPc.get(pc) || []) if (!ids.includes(id)) ids.push(id);
        if (ids.length) how = 'postcode';
      }
      if (!ids.length) {
        for (const c of coordsIn(note)) {
          let best = null;
          let bestKm = 0.3;
          for (const p of all) if (p.lat != null) { const km = haversineKm(c, p); if (km < bestKm) { bestKm = km; best = p.id; } }
          if (best && !ids.includes(best)) ids.push(best);
        }
        if (ids.length) how = 'coords';
      }
      if (!ids.length) {
        const hay = fold(note);
        const slug = compact(decoded);
        for (const n of nameSegs) if (n.segs.some((g) => hay.includes(fold(g)) || slug.includes(compact(g)))) ids.push(n.id);
        if (ids.length > 2) ids = [];
        if (ids.length) how = 'name';
      }
      const site = siteOf(s.url);
      const siteIds = site && bySite.get(site);
      if (!ids.length) {
        // a site several places use (e.g. the Royal Parks): a distinctive name word in the page path decides
        const pool = siteIds && siteIds.size > 1 ? Array.from(siteIds).map((id) => byId.get(id)).filter(Boolean) : [];
        const path = compact(pathOf(s.url));
        const hits = pool.filter((p) => tokensOf(p).some((w) => path.includes(w)));
        if (hits.length === 1) { ids = [hits[0].id]; how = 'region'; }
      }
      if (!ids.length && siteIds && siteIds.size === 1) { ids = Array.from(siteIds); how = 'site'; }
      const visible = ids.filter((id) => byId.has(id));
      if (ids.length && !visible.length) continue; // only about hidden or private places: never listed
      s.placeIds = visible;
      s.how = visible.length ? how : '';
      s.refs = exact ? { places: exact.places, events: exact.events, series: exact.series } : { places: [], events: [], series: [] };
      out.push(s);
    }
    return out;
  }

  /* ------------------------------------------------------------------ guide layer (guide/london.json, web only) */

  /** A verification day 'YYYY-MM-DD' → the stamp the content data uses for dates (midnight China Standard Time). */
  function dayStamp(key) {
    const m = String(key || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
    return m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) - 8 * 3600e3 : null;
  }
  /** Validate the guide file: places with an id, coordinates and a known shape; drop ones whose dates have passed. */
  function readGuide(guide, json) {
    const out = { ok: false, error: null, places: [], overlays: {}, routes: [], tips: [], updated: '', ended: 0, held: 0 };
    if (!guide) return out;
    if (guide instanceof Error) { out.error = guide; return out; }
    if (typeof guide !== 'object' || !Array.isArray(guide.places)) { out.error = new Error('shape'); return out; }
    const contentIds = new Set((Array.isArray(json.places) ? json.places : []).map((r) => r && str(r.id)));
    const today = window.TCAPlanner ? window.TCAPlanner.londonParts(now()).key : '';
    const seen = new Set();
    for (const g of guide.places) {
      if (!g || typeof g !== 'object') continue;
      const id = str(g.id);
      if (!id || !TOKEN_RE.test(id) || seen.has(id) || contentIds.has(id)) continue;
      if (num(g.lat) == null || num(g.lng) == null) continue;
      if (g.dates && str(g.dates.to) && today && str(g.dates.to) < today) { out.ended += 1; continue; }
      if (str(g.hold)) { out.held += 1; continue; } // kept for later (e.g. dates not announced yet), not shown
      seen.add(id);
      out.places.push(g);
    }
    if (guide.overlays && typeof guide.overlays === 'object') out.overlays = guide.overlays;
    if (Array.isArray(guide.routes)) out.routes = guide.routes.filter((r) => r && str(r.id) && Array.isArray(r.stops));
    if (Array.isArray(guide.tips)) out.tips = guide.tips.filter((t) => t && str(t.title));
    out.updated = str(guide.updated);
    out.ok = true;
    return out;
  }
  function guideRaw(g) {
    return {
      id: g.id, name: g.name, category: g.category, latitude: g.lat, longitude: g.lng, address: g.address,
      description: g.summary, sourceUrl: g.sourceUrl, verifiedAt: dayStamp(g.verified), region: g.region,
      arrivalRadiusMeters: num(g.radius) || 60, openingInfo: '', city: 'LONDON', sourceVersion: 1, guide: true,
    };
  }
  /** Give guide places and content places with an overlay their planning record (p.g) and planner node (p.node). */
  function attachGuide(places, gd) {
    const byId = new Map(gd.places.map((g) => [g.id, g]));
    const P = window.TCAPlanner;
    for (const p of places) {
      const g = byId.get(p.id) || (p.city === 'LONDON' ? gd.overlays[p.id] : null);
      if (!g || typeof g !== 'object') continue;
      p.g = g;
      p.guide = byId.has(p.id);
      p.zh = str(g.zh);
      p.unverified = g.unverified === true;
      p.vary = g.hoursVary === true;
      p.calendarUrl = safeUrl(g.calendarUrl) ? str(g.calendarUrl) : '';
      if (P && p.hasCoords) {
        p.node = P.compilePlace({ id: p.id, name: p.name, category: p.category, lat: p.lat, lng: p.lng }, g);
        p.node.place = p;
      }
    }
  }
  /** Source records for guide places: the main page plus the extra pages each record lists. */
  function guideSources(list, places) {
    const known = new Set(places.map((p) => p.id));
    const out = [];
    for (const g of list) {
      if (!known.has(g.id)) continue;
      const at = dayStamp(g.verified);
      const until = g.dates && str(g.dates.to) ? dayStamp(g.dates.to) + 32 * 3600e3 : null;
      if (str(g.sourceUrl)) {
        out.push({ id: `guide-${g.id}`, url: str(g.sourceUrl), key: urlKey(g.sourceUrl), verifiedAt: at, validUntil: until, status: str(g.verifyNote), license: GUIDE_LICENSE, force: [g.id] });
      }
      (Array.isArray(g.sources) ? g.sources : []).forEach((u, i) => {
        if (!str(u) || urlKey(u) === urlKey(g.sourceUrl)) return;
        out.push({ id: `guide-${g.id}-${i + 1}`, url: str(u), key: urlKey(u), verifiedAt: at, validUntil: null, status: COORD_HOST_RE.test(hostOf(u)) ? '坐标参考' : '辅助参考：交叉核对或补充信息', license: GUIDE_LICENSE, force: [g.id] });
      });
    }
    return out;
  }

  function normalize(json, guide) {
    if (!json || typeof json !== 'object' || Array.isArray(json)) throw new Error('shape');
    const list = (k) => (Array.isArray(json[k]) ? json[k] : []);
    const gd = readGuide(guide, json);
    const hiddenPlaceIds = new Set();
    const hiddenPlaces = [];
    const places = [];
    const seen = new Set();
    for (const raw of list('places').concat(gd.places.map(guideRaw))) {
      if (raw && typeof raw === 'object' && (raw.hidden === true || raw.isPrivate === true)) {
        hiddenPlaceIds.add(str(raw.id));
        const lat = num(raw.latitude);
        const lng = num(raw.longitude);
        hiddenPlaces.push({ id: str(raw.id), name: str(raw.name), region: str(raw.region), address: str(raw.address), lat: lat != null && lng != null ? lat : null, lng });
        continue;
      }
      const p = normalizePlace(raw);
      if (p && !seen.has(p.id)) { seen.add(p.id); places.push(p); }
    }
    attachGuide(places, gd);
    const groups = assignGroups(places);
    for (const p of places) {
      const g = p.group;
      const x = p.g || {};
      p.search = fold([p.name, p.zh, p.address, p.region, p.postcode, g.plate.main, g.plate.sub, p.plate.main, p.plate.sub, p.description, p.openingInfo, p.guide ? '' : x.summary, p.cat.zh, p.cat.terms, p.category, CITIES[p.city].zh, CITIES[p.city].en].join(' '));
    }
    places.sort((a, b) => cmp(a.name, b.name) || cmp(a.id, b.id));
    const placeById = new Map(places.map((p) => [p.id, p]));

    const seriesById = new Map();
    for (const raw of list('series')) {
      if (!raw || typeof raw !== 'object') continue;
      const id = str(raw.id);
      if (!id || seriesById.has(id)) continue;
      if (hiddenPlaceIds.has(str(raw.placeId))) continue;
      seriesById.set(id, { id, placeId: str(raw.placeId), title: str(raw.title), organizer: str(raw.organizer), sourceUrl: str(raw.sourceUrl), events: [] });
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
      const status = statusRaw.toUpperCase();
      const series = seriesById.get(str(raw.seriesId)) || null;
      const city = place ? place.city : cityOfTz(tz);
      const e = {
        id,
        title: str(raw.title) || (series && series.title) || '未命名活动',
        start,
        end,
        tz,
        dayIdx: dayIndex(start, tz),
        status,
        statusRaw,
        cancelled: !!(STATUS[status] && STATUS[status].cancelled),
        deadline: num(raw.registrationDeadlineUtc),
        priceMinor: num(raw.priceMinor),
        currency: str(raw.currency).toUpperCase(),
        sourceUrl: str(raw.sourceUrl),
        verifiedAt: num(raw.verifiedAt),
        sourceVersion: num(raw.sourceVersion),
        placeId,
        place,
        series,
        city,
        search: '',
      };
      e.search = fold([e.title, place ? place.name : '', place ? place.region : '', series ? series.title : ''].join(' '));
      events.push(e);
      if (series) series.events.push(e);
    }
    events.sort((a, b) => a.start - b.start || cmp(a.title, b.title) || cmp(a.id, b.id));
    for (const s of seriesById.values()) s.events.sort((a, b) => a.start - b.start || cmp(a.id, b.id));

    // Event and series source URLs at hidden places mark the sources that must not be shown.
    const rawSources = [];
    for (const raw of list('sources')) {
      if (!raw || typeof raw !== 'object') continue;
      const url = str(raw.url);
      rawSources.push({
        id: str(raw.id),
        url,
        key: urlKey(url),
        verifiedAt: num(raw.verifiedAt),
        validUntil: num(raw.validUntil),
        status: str(raw.status),
        license: str(raw.license),
      });
    }
    rawSources.push(...guideSources(gd.places, places));
    const hiddenKeys = new Set();
    for (const raw of list('places')) if (raw && hiddenPlaceIds.has(str(raw.id)) && str(raw.sourceUrl)) hiddenKeys.add(urlKey(raw.sourceUrl));
    for (const raw of list('events').concat(list('series'))) if (raw && hiddenPlaceIds.has(str(raw.placeId)) && str(raw.sourceUrl)) hiddenKeys.add(urlKey(raw.sourceUrl));
    // guide places stay out of the URL/site heuristics, so content.json sources link exactly as before
    const linked = linkSources(rawSources, places.filter((p) => !p.guide), events, Array.from(seriesById.values()), hiddenPlaces, placeById);
    const sources = linked.filter((s) => !(hiddenKeys.has(s.key) && !s.placeIds.length && !s.refs.events.length && !s.refs.series.length));

    // licence texts → footnote numbers, most common first
    const licTally = new Map();
    for (const s of sources) if (s.license) licTally.set(s.license, (licTally.get(s.license) || 0) + 1);
    const licenses = Array.from(licTally.entries()).sort((a, b) => b[1] - a[1] || cmp(a[0], b[0])).map(([text, count], i) => ({ text, count, n: i + 1 }));
    const licNo = new Map(licenses.map((l) => [l.text, l.n]));

    const sourcesByPlace = new Map();
    for (const s of sources) {
      s.licNo = s.license ? licNo.get(s.license) : null;
      const cities = new Set();
      for (const id of s.placeIds) cities.add(placeById.get(id).city);
      for (const e of s.refs.events) if (e.city) cities.add(e.city);
      s.city = CITY_ORDER.find((c) => cities.has(c)) || null;
      s.tz = s.city ? CITIES[s.city].tz : VERIFY_TZ;
      s.domain = domainOf(s.url);
      s.path = pathOf(s.url);
      s.coordRef = COORD_HOST_RE.test(hostOf(s.url));
      s.search = fold([s.domain, s.path, s.status, s.placeIds.map((id) => placeById.get(id).name).join(' '), s.refs.events.map((e) => e.title).join(' '), s.refs.series.map((x) => x.title).join(' ')].join(' '));
      for (const id of s.placeIds) {
        if (!sourcesByPlace.has(id)) sourcesByPlace.set(id, []);
        sourcesByPlace.get(id).push(s);
      }
    }
    sources.sort((a, b) => cmp(a.domain, b.domain) || cmp(a.url, b.url) || cmp(a.id, b.id));
    for (const [id, list2] of sourcesByPlace) {
      const mainKey = urlKey(placeById.get(id).sourceUrl);
      list2.sort((a, b) => (b.key === mainKey) - (a.key === mainKey) || (b.verifiedAt || 0) - (a.verifiedAt || 0) || cmp(a.url, b.url));
    }

    const eventsByPlace = new Map();
    for (const e of events) {
      if (!e.placeId) continue;
      if (!eventsByPlace.has(e.placeId)) eventsByPlace.set(e.placeId, []);
      eventsByPlace.get(e.placeId).push(e);
    }

    return {
      meta: { format: str(json.format), version: str(json.version), kind: str(json.kind), coordinateSystem: str(json.coordinateSystem) },
      places, placeById, groups, events, eventsByPlace, seriesById, sources, sourcesByPlace, licenses,
      nodes: places.filter((p) => p.node).map((p) => p.node),
      guide: { ok: gd.ok, error: gd.error, count: places.filter((p) => p.guide).length, overlays: places.filter((p) => p.g && !p.guide).length, updated: gd.updated, routes: gd.routes, tips: gd.tips, ended: gd.ended, held: gd.held },
    };
  }

  /* ------------------------------------------------------------------ state */

  const state = {
    data: null,
    gen: 0,
    loadError: null,
    city: 'BOTH',
    tab: 'places',
    placeId: null,
    query: '',
    cats: new Set(),
    mapCity: 'LONDON',
    themePref: 'system',
    listScroll: 0,
    returnTab: 'places',
    returnScroll: 0,
    returnFocus: null,
    pushedPlace: null,
    notFound: null,
    mapsOff: false,
    mapMin: false,
    mapMinAuto: false,
    mapPinned: false,
    pastOpen: false,
    partition: '',
    evFilters: { free: false, weekend: false, cats: new Set() },
    evOpen: new Set(),
    evPlaceIds: null,
    srcQuery: '',
    srcMode: 'place',
    srcOpen: new Set(),
    filterSig: '*',
    filterIds: null,
    hotId: null,
    plan: null, // filled at boot (stored preferences)
    planDate: null,
    planRes: null,
    excluded: new Set(),
    startKind: 'preset',
    startPoint: null,
    geo: { status: 'idle' },
    picking: false,
    fitRoute: false,
  };

  const els = {
    atlas: $('.atlas'),
    panel: $('#panel'),
    scroll: $('[data-scroll]'),
    views: { places: $('#view-places'), guide: $('#view-guide'), events: $('#view-events'), sources: $('#view-sources') },
    tabs: $$('.tab'),
    tablist: $('.tabs'),
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

  /* ------------------------------------------------------------------ focus keys (survive re-renders) */

  function focusKey() {
    const a = doc.activeElement;
    if (!a || a === doc.body) return null;
    const k = a.closest && a.closest('[data-fk]');
    return k ? k.dataset.fk : null;
  }
  function refocus(key) {
    if (!key) return false;
    const el = doc.querySelector(`[data-fk="${CSS.escape(key)}"]`);
    if (el && el.getClientRects().length) { el.focus({ preventScroll: true }); return true; }
    return false;
  }
  /** Run fn (which may rebuild the view) and put keyboard focus back on the equivalent element. */
  function keepFocus(fn) {
    const k = focusKey();
    fn();
    if (k && (doc.activeElement === doc.body || !doc.activeElement || !doc.activeElement.isConnected)) refocus(k);
  }

  /* ------------------------------------------------------------------ routing (bare hash tokens) */

  function currentToken() {
    if (state.tab === 'places' && state.placeId) return state.placeId;
    if (state.tab === 'events') return 'events';
    if (state.tab === 'sources') return 'sources';
    if (state.tab === 'guide') return 'guide';
    return state.city === 'BOTH' ? 'both' : CITIES[state.city].token;
  }
  function writeHash(opts = {}) {
    const token = currentToken();
    if (!TOKEN_RE.test(token)) return;
    if (readHash() === token && !opts.push) return;
    const url = location.pathname + location.search + '#' + token;
    try {
      if (opts.push) history.pushState({ tca: 'place', id: token }, '', url);
      else history.replaceState(history.state && history.state.tca === 'place' && history.state.id === token ? history.state : null, '', url);
    } catch { /* sandboxed */ }
  }
  function readHash() {
    let t = location.hash.replace(/^#/, '');
    try { t = decodeURIComponent(t); } catch { return null; }
    return TOKEN_RE.test(t) ? t : null;
  }
  /** Apply a token from the address bar or an in-page link. Returns true when it was understood. */
  function route(token, opts = {}) {
    if (!token) return false;
    const low = token.toLowerCase();
    if (low === 'london' || low === 'fuzhou' || low === 'both') {
      state.placeId = null;
      selectOnMap(null);
      setCity(low.toUpperCase(), { render: false });
      setTab('places', { render: false });
      render();
      return true;
    }
    if (low === 'places') {
      if (state.placeId) { state.placeId = null; selectOnMap(null); }
      setTab('places', opts);
      return true;
    }
    if (low === 'events' || low === 'sources' || low === 'guide') {
      if (state.placeId) { state.placeId = null; selectOnMap(null); }
      setTab(low, opts);
      return true;
    }
    if (state.data && state.data.placeById.has(token)) {
      openPlace(token, opts);
      return true;
    }
    return false;
  }
  /** A link to a place that does not exist (renamed, removed, mistyped): say so and show the list. */
  function notFound(token) {
    if (!state.data) return;
    state.notFound = token;
    if (state.placeId) { state.placeId = null; selectOnMap(null); }
    setTab('places', { render: false });
    render({ force: true });
    announce('未找到该地点，已显示列表');
  }

  /* ------------------------------------------------------------------ city / tab / theme / map strip */

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
    if (changed) { state.cats.clear(); state.evFilters.cats.clear(); }
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
    if (changed && !mqDesktop.matches && !state.mapsOff) {
      // Phones: the map earns its space on 地点 and 攻略 (the route); 活动 and 来源 start with it folded to a strip.
      state.mapPinned = false;
      setMapMin(tab !== 'places' && tab !== 'guide' && !state.placeId, { auto: true });
    }
    if (tab === 'guide' && state.city === 'BOTH') setMapCity('LONDON');
    if (changed && tab !== 'guide' && state.picking) togglePicking();
    if (opts.render !== false) {
      render();
      if (changed) scrollPanelTop();
    }
  }

  /** Fold the sticky map to a strip (phones and tablets only; the desktop layout ignores it). */
  function setMapMin(min, opts = {}) {
    const was = state.mapMin;
    state.mapMin = !!min;
    state.mapMinAuto = !!(min && opts.auto);
    els.atlas.classList.toggle('is-mapmin', state.mapMin);
    for (const b of $$('[data-map-toggle]')) b.setAttribute('aria-expanded', String(!state.mapMin));
    if (was && !state.mapMin) refreshMaps();
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
    // Keep the browser chrome colour in step with a forced theme.
    const paper = getComputedStyle(root).getPropertyValue('--paper').trim();
    for (const meta of $$('meta[name="theme-color"]')) {
      if (!meta.dataset.original) meta.dataset.original = meta.getAttribute('content');
      meta.setAttribute('content', state.themePref === 'system' ? meta.dataset.original : paper);
    }
    updateTiles();
  }

  /* ------------------------------------------------------------------ maps */

  const maps = {};
  let PinIcon = null;
  let ClusterIcon = null;
  const clusterOfEl = new WeakMap();

  /** Load the cluster plugin only once Leaflet is there (it throws without it). Resolves true when usable. */
  function loadClusterScript() {
    const L = window.L;
    if (!L || typeof L.map !== 'function') return Promise.resolve(false);
    if (typeof L.markerClusterGroup === 'function') return Promise.resolve(true);
    return new Promise((resolve) => {
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        resolve(typeof window.L.markerClusterGroup === 'function');
      };
      const timer = window.setTimeout(done, 6000);
      const s = doc.createElement('script');
      s.src = CLUSTER_SRC;
      s.async = true;
      s.onload = done;
      s.onerror = done;
      doc.head.appendChild(s);
    });
  }

  function defineIcons() {
    const L = window.L;
    if (PinIcon) return;
    PinIcon = L.DivIcon.extend({
      createIcon(old) {
        const div = L.DivIcon.prototype.createIcon.call(this, old);
        const id = this.options.placeId;
        div.dataset.id = id;
        div.setAttribute('aria-label', this.options.label);
        paintPin(div, id);
        return div;
      },
    });
    ClusterIcon = L.DivIcon.extend({
      createIcon(old) {
        const div = L.DivIcon.prototype.createIcon.call(this, old);
        div.setAttribute('aria-label', this.options.label);
        div.dataset.cluster = '1';
        clusterOfEl.set(div, this.options.cluster);
        return div;
      },
    });
  }

  function initMaps() {
    const L = window.L;
    if (!L || typeof L.map !== 'function') { mapsOff(); return; }
    try {
      defineIcons();
      for (const key of CITY_ORDER) {
        const el = doc.getElementById(key === 'LONDON' ? 'map-london' : 'map-fuzhou');
        const frame = el.closest('.mapframe');
        const ref = CITIES[key].ref;
        const map = L.map(el, {
          zoomControl: false,
          minZoom: 3,
          maxZoom: 19,
          zoomSnap: 1, // whole zoom levels keep raster tiles crisp and seam-free
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
            b.addEventListener('click', () => fitCity(key, true, { all: true }));
            wrap.appendChild(b);
            L.DomEvent.disableClickPropagation(wrap);
            return wrap;
          },
        });
        new FitControl().addTo(map);
        // Phones and tablets: fold the sticky map to a strip (hidden on the desktop layout).
        const MinControl = L.Control.extend({
          options: { position: 'topright' },
          onAdd() {
            const wrap = L.DomUtil.create('div', 'leaflet-bar minctl');
            const b = h('button', { type: 'button', title: '收起地图', 'aria-label': '收起地图', 'aria-expanded': 'true', 'data-map-toggle': '' }, icon('up'));
            wrap.appendChild(b);
            L.DomEvent.disableClickPropagation(wrap);
            return wrap;
          },
        });
        new MinControl().addTo(map);
        // Zoom controls first in the DOM, so Tab reaches them before the markers (positioning is unaffected;
        // the attribution corner stays after the markers).
        const corner = el.querySelector('.leaflet-top.leaflet-right');
        if (corner) el.insertBefore(corner, el.firstChild);
        const m = {
          key, map, el, frame, chips: $('[data-edgechips]', frame),
          layer: null, solo: L.layerGroup().addTo(map), ghost: L.layerGroup().addTo(map),
          markers: new Map(), where: new Map(), muted: new Set(),
          ring: null, selected: null, fitted: false, pendingFocus: null,
          tiles: null, theme: effectiveTheme(), tileErr: 0, tileOk: 0, provider: startProvider(),
          hotCluster: null, roving: null, refocus: null, uiRaf: 0,
        };
        setTileLayer(m, m.provider);
        el.setAttribute('role', 'region');
        el.setAttribute('aria-roledescription', '地图');
        el.setAttribute('aria-label', `${CITIES[key].zh}地图：方向键平移，加减号缩放。点位：Tab 进入后用方向键在点位之间移动，Enter 打开`);
        const band = () => { m.el.dataset.zoomband = map.getZoom() < 13 ? 'far' : 'near'; };
        map.on('zoomend', band);
        map.on('moveend zoomend', () => scheduleMapUI(m));
        band();
        wireMapKeys(m);
        // Until the reader pans or zooms, a resized map is refitted rather than just re-centred.
        const touched = () => { m.userMoved = true; };
        el.addEventListener('pointerdown', touched);
        el.addEventListener('wheel', touched, { passive: true });
        el.addEventListener('keydown', (ev) => { if (ev.target === el) touched(); });
        maps[key] = m;
        if ('ResizeObserver' in window) {
          new ResizeObserver(() => onMapResize(m)).observe(el);
        }
      }
    } catch {
      mapsOff();
    }
  }

  function mapsOff() {
    state.mapsOff = true;
    root.classList.add('no-map');
    for (const k of Object.keys(maps)) delete maps[k];
  }

  /** The provider to start with: the remembered fallback (less than a day old), else the first. */
  function startProvider() {
    try {
      const v = JSON.parse(store.get(STORE_TILES) || 'null');
      const i = v ? TILE_PROVIDERS.findIndex((p) => p.key === v.key) : -1;
      if (i > 0 && Date.now() - v.at < DAY) return i;
    } catch { /* ignore */ }
    return 0;
  }
  function setTileLayer(m, i) {
    const L = window.L;
    const prov = TILE_PROVIDERS[i];
    if (m.tiles) m.map.removeLayer(m.tiles);
    m.provider = i;
    m.tileErr = 0;
    m.tileOk = 0;
    m.frame.dataset.tiles = prov.key;
    const layer = L.tileLayer(prov.url[m.theme], Object.assign({ className: 'tiles-' + prov.key }, prov.opts));
    m.tiles = layer;
    layer
      .on('tileerror', () => {
        if (m.tiles !== layer) return; // late events from a layer already replaced
        m.tileErr += 1;
        if (m.tileOk === 0 && m.tileErr >= TILE_FAIL && m.provider < TILE_PROVIDERS.length - 1) {
          setTileLayer(m, m.provider + 1);
          store.set(STORE_TILES, JSON.stringify({ key: TILE_PROVIDERS[m.provider].key, at: Date.now() }));
          return;
        }
        updateTileNotice(m);
      })
      .on('tileload', () => { if (m.tiles !== layer) return; m.tileOk += 1; updateTileNotice(m); })
      .addTo(m.map);
    layer.bringToBack();
  }

  function updateTileNotice(m) {
    const note = $('[data-tile-notice]', m.frame);
    // only once every provider has been tried
    const failing = m.provider === TILE_PROVIDERS.length - 1 && m.tileErr >= 2 && m.tileOk === 0;
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
      m.tiles.setUrl(TILE_PROVIDERS[m.provider].url[theme]);
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
    } else if (state.data && (!m.fitted || (m.autoFit && !m.userMoved && !m.selected))) {
      fitCity(m.key, false);
    }
    scheduleMapUI(m);
  }

  /** After a layout change: resize visible maps; optionally refit them. */
  function refreshMaps(opts = {}) {
    if (state.mapsOff) return;
    if (opts.refit) for (const m of Object.values(maps)) if (!m.selected) m.fitted = false;
    window.requestAnimationFrame(() => {
      for (const m of Object.values(maps)) if (mapVisible(m)) onMapResize(m);
    });
  }

  /** The places a map should frame: the current filter's matches (or all), trimmed to the central core. */
  function framePlaces(key, all) {
    const d = state.data;
    let list = d.places.filter((p) => p.city === key && p.hasCoords);
    if (state.filterIds) {
      const shown = list.filter((p) => state.filterIds.has(p.id));
      if (shown.length) list = shown;
    }
    if (all || list.length < 6) return list;
    const ref = CITIES[key].ref;
    const core = list.filter((p) => haversineKm(ref, p) <= CORE_KM);
    return core.length >= Math.max(4, list.length * 0.6) ? core : list;
  }
  function fitPadding(m) {
    const small = m.el.offsetHeight < 420;
    const narrow = m.el.offsetWidth < 520;
    return { paddingTopLeft: [narrow ? 14 : 28, small ? 58 : 86], paddingBottomRight: [narrow ? 46 : 56, small ? 26 : 30] };
  }
  function fitCity(key, animate, opts = {}) {
    const m = maps[key];
    if (!m || !state.data) return;
    if (!mapVisible(m)) { m.fitted = false; return; }
    const pts = framePlaces(key, opts.all).map((p) => [p.lat, p.lng]);
    const anim = animate && !mqReduce.matches;
    m.map.invalidateSize({ animate: false, pan: false });
    if (!pts.length) {
      m.map.setView([CITIES[key].ref.lat, CITIES[key].ref.lng], 12, { animate: anim });
    } else {
      const bounds = window.L.latLngBounds(pts);
      const pad = fitPadding(m);
      if (opts.gentle) {
        // Filter changes: leave the view alone when it already shows the matches at about the right scale.
        const z = m.map.getBoundsZoom(bounds, false, window.L.point(pad.paddingTopLeft[0] + pad.paddingBottomRight[0], pad.paddingTopLeft[1] + pad.paddingBottomRight[1]));
        const cur = m.map.getZoom();
        if (m.map.getBounds().contains(bounds) && cur >= Math.min(z, 15) - 1 && cur <= Math.min(z, 15)) { m.fitted = true; return; }
      }
      // Places that land under the caption plate or the zoom buttons join the bounds, and the fit is redone once.
      // (Only when that costs no zoom level: on a small map a hidden marker is better than a smaller map.)
      const fix = () => {
        const hidden = coveredPlaces(m);
        if (!hidden.length) return;
        const wider = window.L.latLngBounds(bounds.getSouthWest(), bounds.getNorthEast());
        for (const p of hidden) wider.extend([p.lat, p.lng]);
        const z = m.map.getZoom();
        if (m.map.getBoundsZoom(wider, false, window.L.point(pad.paddingTopLeft[0] + pad.paddingBottomRight[0], pad.paddingTopLeft[1] + pad.paddingBottomRight[1])) >= z) {
          m.map.fitBounds(wider, Object.assign({ maxZoom: z, animate: false }, pad));
          return;
        }
        // Otherwise slide the view a little, if the framed places all stay in sight.
        const size = m.map.getSize();
        const nw = m.map.latLngToContainerPoint(bounds.getNorthWest());
        const se = m.map.latLngToContainerPoint(bounds.getSouthEast());
        for (const [sx, sy] of [[-1, 0], [0, -1], [-1, -1]]) {
          const shift = window.L.point(sx * 40, sy * 40);
          const ok = nw.x - shift.x >= 8 && se.x - shift.x <= size.x - 8 && nw.y - shift.y >= 8 && se.y - shift.y <= size.y - 8;
          if (!ok) continue;
          m.map.panBy(shift, { animate: false });
          if (!coveredPlaces(m).length) return;
          m.map.panBy(shift.multiplyBy(-1), { animate: false });
        }
      };
      if (anim) m.map.once('moveend', fix);
      m.map.fitBounds(bounds, Object.assign({ maxZoom: 15, animate: anim }, pad));
      if (!anim) fix();
    }
    m.fitted = true;
    m.autoFit = true;
    m.userMoved = false;
  }
  /** Shown places whose marker sits under the map caption or the controls in the current view. */
  function coveredPlaces(m) {
    const box = m.el.getBoundingClientRect();
    const rects = [];
    for (const sel of ['.mapcap .plate', '.mapcap__time', '.leaflet-top.leaflet-right']) {
      const el = $(sel, m.frame);
      if (!el || !el.getClientRects().length) continue;
      const r = el.getBoundingClientRect();
      rects.push({ l: r.left - box.left - 14, t: r.top - box.top - 14, r: r.right - box.left + 14, b: r.bottom - box.top + 14 });
    }
    const out = [];
    for (const [id, mk] of m.markers) {
      if (m.muted.has(id)) continue;
      const pt = m.map.latLngToContainerPoint(mk.getLatLng());
      if (rects.some((q) => pt.x > q.l && pt.x < q.r && pt.y > q.t && pt.y < q.b)) out.push(state.data.placeById.get(id));
    }
    return out;
  }
  let refitTimer = 0;
  function scheduleRefit() {
    window.clearTimeout(refitTimer);
    refitTimer = window.setTimeout(() => {
      if (state.placeId) return;
      for (const m of Object.values(maps)) if (mapVisible(m)) fitCity(m.key, true, { gentle: true });
    }, 450);
  }

  function makeMarkerLayer(m) {
    const L = window.L;
    if (typeof L.markerClusterGroup !== 'function') return L.layerGroup();
    const g = L.markerClusterGroup({
      maxClusterRadius: 44,
      disableClusteringAtZoom: 16,
      spiderfyOnMaxZoom: true,
      showCoverageOnHover: false,
      zoomToBoundsOnClick: true,
      removeOutsideVisibleBounds: false,
      animate: !mqReduce.matches,
      spiderLegPolylineOptions: { className: 'spider-leg', weight: 1.5, opacity: 1 },
      iconCreateFunction: (cluster) => clusterIcon(cluster),
    });
    g.on('animationend spiderfied unspiderfied', () => scheduleMapUI(m));
    return g;
  }

  function clusterIcon(cluster) {
    const kids = cluster.getAllChildMarkers();
    const tally = new Map();
    const names = [];
    for (const k of kids) {
      const p = state.data && state.data.placeById.get(k.options.placeId);
      if (!p) continue;
      tally.set(p.category, (tally.get(p.category) || 0) + 1);
      names.push(p.name);
    }
    const n = kids.length;
    const cats = Array.from(tally.entries()).sort((a, b) => b[1] - a[1]);
    const html = h('span', { class: 'cluster', 'aria-hidden': 'true' },
      h('span', { class: 'cluster__n' }, String(n)),
      h('span', { class: 'cluster__cats' }, cats.map(([k, c]) => h('i', { 'data-cat': k, style: `flex-grow:${c}` }))));
    const label = `${n} 处地点：${names.slice(0, 3).join('、')}${n > 3 ? ' 等' : ''}。按 Enter 放大查看`;
    return new ClusterIcon({ html, className: 'cluster-wrap', iconSize: [n >= 10 ? 38 : 32, 30], iconAnchor: [n >= 10 ? 19 : 16, 15], label, cluster, names });
  }

  function buildMarkers() {
    if (state.mapsOff) return;
    const L = window.L;
    for (const m of Object.values(maps)) {
      if (m.layer) m.map.removeLayer(m.layer);
      m.solo.clearLayers();
      m.ghost.clearLayers();
      m.layer = makeMarkerLayer(m);
      m.markers.clear();
      m.where.clear();
      m.muted = new Set();
      m.selected = null;
      m.hotCluster = null;
      if (m.ring) { m.ring.remove(); m.ring = null; }
      m.fitted = false;
    }
    const batches = new Map();
    for (const p of state.data.places) {
      const m = maps[p.city];
      if (!m || !p.hasCoords) continue;
      const pin = h('span', { class: 'pin', 'data-cat': p.category, 'aria-hidden': 'true' }, p.cat.glyph);
      const marker = L.marker([p.lat, p.lng], {
        icon: new PinIcon({ className: 'pin-wrap', html: pin, iconSize: [26, 26], iconAnchor: [13, 13], placeId: p.id, label: `${p.name}（${p.cat.zh}）` }),
        keyboard: true,
        riseOnHover: true,
        placeId: p.id,
      });
      marker.bindTooltip(h('span', null, p.name), { direction: 'top', offset: [0, -15], className: 'atlas-tip', opacity: 1 });
      marker.on('click', () => openPlace(p.id, { from: 'map', focus: true }));
      marker.on('mouseover', () => setHot(p.id, true));
      marker.on('mouseout', () => setHot(p.id, false));
      m.markers.set(p.id, marker);
      m.where.set(p.id, 'cluster');
      if (!batches.has(m)) batches.set(m, []);
      batches.get(m).push(marker);
    }
    for (const [m, list] of batches) addToLayer(m.layer, list);
    for (const m of Object.values(maps)) m.layer.addTo(m.map);
    refreshMaps({ refit: true });
  }
  function addToLayer(layer, list) {
    if (typeof layer.addLayers === 'function') layer.addLayers(list); else for (const mk of list) layer.addLayer(mk);
  }
  function removeFromLayer(layer, list) {
    if (typeof layer.removeLayers === 'function') layer.removeLayers(list); else for (const mk of list) layer.removeLayer(mk);
  }

  /** Put each marker in its layer: the selected one stands alone (never clustered), muted ones are ghosts. */
  function placeMarkers(m) {
    if (!m.layer) return;
    const moves = [];
    for (const [id, mk] of m.markers) {
      const want = id === m.selected ? 'solo' : m.muted.has(id) ? 'ghost' : 'cluster';
      const cur = m.where.get(id);
      if (want !== cur) moves.push([id, mk, cur, want]);
    }
    if (!moves.length) return;
    const outOfCluster = moves.filter((x) => x[2] === 'cluster').map((x) => x[1]);
    if (outOfCluster.length) removeFromLayer(m.layer, outOfCluster);
    for (const [, mk, cur] of moves) { if (cur === 'solo') m.solo.removeLayer(mk); else if (cur === 'ghost') m.ghost.removeLayer(mk); }
    const intoCluster = [];
    for (const [id, mk, , want] of moves) {
      m.where.set(id, want);
      if (want === 'cluster') intoCluster.push(mk);
      else if (want === 'solo') m.solo.addLayer(mk);
      else m.ghost.addLayer(mk);
    }
    if (intoCluster.length) addToLayer(m.layer, intoCluster);
    for (const [id, mk] of moves) { const el = mk.getElement(); if (el) paintPin(el, id); }
    scheduleMapUI(m);
  }

  function paintPin(el, id) {
    const p = state.data && state.data.placeById.get(id);
    const m = p && maps[p.city];
    const where = m ? m.where.get(id) : 'cluster';
    el.classList.toggle('is-selected', !!(m && m.selected === id));
    el.classList.toggle('is-muted', where === 'ghost');
    el.classList.toggle('is-hot', state.hotId === id);
    if (where === 'ghost') el.setAttribute('aria-hidden', 'true'); else el.removeAttribute('aria-hidden');
  }

  function markerOf(id) {
    const p = state.data && state.data.placeById.get(id);
    const m = p && maps[p.city];
    const mk = m && m.markers.get(id);
    return mk ? { m, mk, p } : null;
  }
  /** What stands for a marker on screen right now: the marker, the cluster holding it, or null. */
  function visibleOf(m, mk) {
    if (m.where.get(mk.options.placeId) !== 'cluster' || typeof m.layer.getVisibleParent !== 'function') return mk.getElement() ? mk : null;
    const v = m.layer.getVisibleParent(mk);
    return v && v.getElement && v.getElement() ? v : null;
  }

  function clearHotCluster(m) {
    const c = m.hotCluster;
    if (!c) return;
    m.hotCluster = null;
    const el = c.getElement && c.getElement();
    if (el) el.classList.remove('is-hot');
    try { c.setZIndexOffset(0); c.unbindTooltip(); } catch { /* cluster already gone */ }
  }
  function paintHot(m, id) {
    const mk = m.markers.get(id);
    if (!mk) return;
    const vis = visibleOf(m, mk);
    if (!vis) return;
    if (vis === mk) {
      const el = mk.getElement();
      if (el) el.classList.add('is-hot');
      mk.setZIndexOffset(1500);
      return;
    }
    // Clustered: light up the cluster and name the place on it.
    const el = vis.getElement();
    if (!el) return;
    el.classList.add('is-hot');
    vis.setZIndexOffset(1500);
    m.hotCluster = vis;
    const p = state.data.placeById.get(id);
    vis.bindTooltip(h('span', null, p.name, h('small', null, ` · 在此 ${vis.getChildCount()} 处之中`)), { direction: 'top', offset: [0, -16], className: 'atlas-tip', opacity: 1 }).openTooltip();
  }
  function setHot(id, on) {
    if (on) state.hotId = id; else if (state.hotId === id) state.hotId = null;
    const row = els.panel.querySelector(`.row[data-id="${CSS.escape(id)}"]`);
    if (row) row.classList.toggle('is-hot', on);
    const hit = markerOf(id);
    if (!hit) return;
    const { m, mk } = hit;
    clearHotCluster(m);
    const el = mk.getElement();
    if (!on) {
      if (el) el.classList.remove('is-hot');
      mk.setZIndexOffset(m.selected === id ? 2000 : 0);
      return;
    }
    paintHot(m, id);
  }

  function selectOnMap(place, opts = {}) {
    for (const m of Object.values(maps)) {
      if (m.selected) {
        const old = m.markers.get(m.selected);
        m.selected = null;
        if (old) old.setZIndexOffset(0);
        placeMarkers(m);
      }
      if (m.ring) { m.ring.remove(); m.ring = null; }
    }
    if (!place || !place.hasCoords) return;
    const m = maps[place.city];
    if (!m) return;
    const mk = m.markers.get(place.id);
    if (mk) {
      m.selected = place.id;
      m.muted.delete(place.id);
      placeMarkers(m);
      const el = mk.getElement();
      if (el) paintPin(el, place.id);
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
    // The container may have just been revealed (city switch); Leaflet caches its size, so refresh it first.
    m.map.invalidateSize({ animate: false, pan: false });
    // Pick the whole zoom level at which the arrival ring's radius is about 22% of the map's shorter side
    // (Web Mercator: metres per pixel = 156543.03 · cos φ / 2^z for 256 px tiles).
    const size = m.map.getSize();
    const targetPx = 0.22 * Math.min(size.x, size.y);
    const radius = Math.max(place.radius || 80, 40);
    let z = Math.floor(Math.log2((targetPx * 156543.03 * Math.cos((place.lat * Math.PI) / 180)) / radius));
    z = Number.isFinite(z) ? Math.max(13, Math.min(18, z)) : 16;
    if (!animate || mqReduce.matches) m.map.setView(ll, z, { animate: false });
    else m.map.flyTo(ll, z, { duration: 0.75 });
    m.fitted = true;
    m.autoFit = false;
  }

  /** Mute (ghost) the markers outside matchIds; null shows all. opts.refit reframes the map to the matches. */
  function applyMarkerFilter(matchIds, opts = {}) {
    const sig = matchIds ? Array.from(matchIds).sort().join(',') : '*';
    const changed = sig !== state.filterSig;
    state.filterSig = sig;
    state.filterIds = matchIds;
    for (const m of Object.values(maps)) {
      const muted = new Set();
      if (matchIds) for (const id of m.markers.keys()) if (!matchIds.has(id) && id !== m.selected) muted.add(id);
      m.muted = muted;
      placeMarkers(m);
      scheduleMapUI(m);
    }
    if (changed && opts.refit) scheduleRefit();
  }

  /* map UI that depends on what is drawn: roving tab stop, edge chips, hover highlight */

  function scheduleMapUI(m) {
    if (m.uiRaf) return;
    m.uiRaf = window.requestAnimationFrame(() => {
      m.uiRaf = 0;
      if (!mapVisible(m)) {
        if (m.chips) m.chips.replaceChildren();
        for (const el of $$('.leaflet-marker-pane > .leaflet-marker-icon', m.el)) el.tabIndex = -1;
        return;
      }
      updateRoving(m);
      updateEdgeChips(m);
      if (state.hotId && m.markers.has(state.hotId) && !m.hotCluster) paintHot(m, state.hotId);
    });
  }

  function mapStops(m) {
    const box = m.el.getBoundingClientRect();
    return $$('.leaflet-marker-pane > .leaflet-marker-icon', m.el).filter((el) => {
      if (el.classList.contains('is-muted') || el.style.opacity === '0') return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.right > box.left && r.left < box.right && r.bottom > box.top && r.top < box.bottom;
    });
  }
  const centerOf = (el) => { const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; };
  /** One Tab stop per map: the selected marker, the last one used, or the one nearest the centre. */
  function updateRoving(m) {
    const all = $$('.leaflet-marker-pane > .leaflet-marker-icon', m.el);
    const stops = mapStops(m);
    const active = doc.activeElement;
    let cur = stops.find((el) => el === active)
      || stops.find((el) => m.roving && el.dataset.id === m.roving)
      || stops.find((el) => el.classList.contains('is-selected'));
    if (!cur && stops.length) {
      const box = m.el.getBoundingClientRect();
      const c = { x: box.left + box.width / 2, y: box.top + box.height / 2 };
      let best = Infinity;
      for (const el of stops) { const p = centerOf(el); const dd = (p.x - c.x) ** 2 + (p.y - c.y) ** 2; if (dd < best) { best = dd; cur = el; } }
    }
    for (const el of all) el.tabIndex = el === cur ? 0 : -1;
    // After Enter on a cluster zooms in, the cluster is gone: continue from the nearest stop to where it was.
    if (m.refocus && cur && (!m.el.contains(doc.activeElement) || doc.activeElement === m.el)) {
      const pt = m.map.latLngToContainerPoint(m.refocus);
      const box = m.el.getBoundingClientRect();
      let best = Infinity;
      let target = cur;
      for (const el of stops) { const p = centerOf(el); const dd = (p.x - box.left - pt.x) ** 2 + (p.y - box.top - pt.y) ** 2; if (dd < best) { best = dd; target = el; } }
      m.refocus = null;
      for (const el of all) el.tabIndex = el === target ? 0 : -1;
      target.focus({ preventScroll: true });
    }
  }
  function neighbour(m, from, key) {
    const dir = { ArrowRight: [1, 0], ArrowLeft: [-1, 0], ArrowDown: [0, 1], ArrowUp: [0, -1] }[key];
    const a = centerOf(from);
    let best = null;
    let bestScore = Infinity;
    for (const el of mapStops(m)) {
      if (el === from) continue;
      const b = centerOf(el);
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const along = dx * dir[0] + dy * dir[1];
      if (along <= 0) continue;
      const across = Math.abs(dx * dir[1] - dy * dir[0]);
      if (across > along * 2) continue;
      const score = along + across * 2;
      if (score < bestScore) { bestScore = score; best = el; }
    }
    return best;
  }
  function wireMapKeys(m) {
    m.el.addEventListener('keydown', (ev) => {
      const t = ev.target.closest && ev.target.closest('.leaflet-marker-icon');
      if (!t || !m.el.contains(t)) return;
      if (ev.key in { ArrowRight: 1, ArrowLeft: 1, ArrowUp: 1, ArrowDown: 1 }) {
        ev.preventDefault();
        ev.stopPropagation();
        const next = neighbour(m, t, ev.key);
        if (next) {
          t.tabIndex = -1;
          next.tabIndex = 0;
          m.roving = next.dataset.id || null;
          next.focus({ preventScroll: true });
        }
        return;
      }
      const cluster = clusterOfEl.get(t);
      if (cluster) {
        if (ev.key === 'Enter' || ev.key === ' ') {
          m.refocus = cluster.getLatLng();
          if (ev.key === ' ') { // Enter is handled by the cluster plugin (keypress)
            ev.preventDefault();
            if (m.map.getZoom() >= 15) cluster.spiderfy(); else cluster.zoomToBounds({ padding: [40, 40] });
          }
        }
        return;
      }
      if ((ev.key === 'Enter' || ev.key === ' ') && t.dataset.id) {
        ev.preventDefault();
        openPlace(t.dataset.id, { from: 'map', focus: true });
      }
    });
    m.el.addEventListener('focusin', (ev) => {
      const t = ev.target.closest && ev.target.closest('.leaflet-marker-icon');
      if (!t) return;
      if (t.dataset.id) {
        m.roving = t.dataset.id;
        setHot(t.dataset.id, true);
        const mk = m.markers.get(t.dataset.id);
        if (mk) mk.openTooltip();
      } else {
        const c = clusterOfEl.get(t);
        if (c) c.bindTooltip(h('span', null, `${c.getChildCount()} 处：${c.getAllChildMarkers().slice(0, 3).map((k) => state.data.placeById.get(k.options.placeId).name).join('、')}${c.getChildCount() > 3 ? ' 等' : ''}`), { direction: 'top', offset: [0, -16], className: 'atlas-tip', opacity: 1 }).openTooltip();
      }
    });
    m.el.addEventListener('focusout', (ev) => {
      const t = ev.target.closest && ev.target.closest('.leaflet-marker-icon');
      if (!t) return;
      if (t.dataset.id) {
        setHot(t.dataset.id, false);
        const mk = m.markers.get(t.dataset.id);
        if (mk) mk.closeTooltip();
      } else {
        const c = clusterOfEl.get(t);
        if (c && c !== m.hotCluster) { try { c.unbindTooltip(); } catch { /* gone */ } }
      }
    });
  }

  /* edge chips: places outside the current view, shown at the frame edge in their direction */

  const ARROWS = ['→', '↘', '↓', '↙', '←', '↖', '↑', '↗'];
  const DIRS = ['东', '东南', '南', '西南', '西', '西北', '北', '东北'];
  function updateEdgeChips(m) {
    const box = m.chips;
    if (!box) return;
    if (!state.data || state.placeId || !m.layer) { box.replaceChildren(); return; }
    const size = m.map.getSize();
    const cx = size.x / 2;
    const cy = size.y / 2;
    const center = m.map.getCenter();
    const sectors = new Map();
    let outside = 0;
    let inside = 0;
    for (const [id, mk] of m.markers) {
      if (m.muted.has(id)) continue;
      const pt = m.map.latLngToContainerPoint(mk.getLatLng());
      // (a marker cut in half by the frame edge counts as outside)
      if (pt.x >= 12 && pt.x <= size.x - 12 && pt.y >= 12 && pt.y <= size.y - 12) { inside += 1; continue; }
      outside += 1;
      const sec = ((Math.round(Math.atan2(pt.y - cy, pt.x - cx) / (Math.PI / 4)) % 8) + 8) % 8;
      if (!sectors.has(sec)) sectors.set(sec, []);
      const p = state.data.placeById.get(id);
      sectors.get(sec).push({ p, km: haversineKm({ lat: center.lat, lng: center.lng }, p) });
    }
    // Only for a few outliers around a populated view; when zoomed into one street everything is "outside".
    if (!outside || outside > 12 || !inside) { box.replaceChildren(); return; }
    const chips = [];
    const compactChips = size.x < 440 || size.y < 300; // small maps: arrow and count only
    for (const [sec, list] of Array.from(sectors.entries()).sort((a, b) => a[0] - b[0])) {
      list.sort((a, b) => a.km - b.km);
      const near = list[0].km;
      const far = list[list.length - 1].km;
      const kmText = list.length === 1 || Math.round(near) === Math.round(far) ? `${fmtKm(near)} km` : `${fmtKm(near)}–${fmtKm(far)} km`;
      const label = list.length === 1 ? (list[0].p.region || list[0].p.name) : `${list.length} 处`;
      const b = h('button', {
        type: 'button', class: 'edgechip', 'data-sec': sec,
        'aria-label': `视野外，${DIRS[sec]}方向约 ${kmText}：${list.map((x) => x.p.name).join('、')}。移动地图显示`,
        title: list.map((x) => x.p.name).join('\n'),
      }, h('span', { class: 'edgechip__arrow', 'aria-hidden': 'true' }, ARROWS[sec]),
      compactChips ? h('span', { class: 'edgechip__n', 'aria-hidden': 'true' }, String(list.length)) : [h('span', { class: 'edgechip__label' }, label), h('span', { class: 'edgechip__km' }, kmText)]);
      b.addEventListener('click', () => {
        const bounds = m.map.getBounds();
        for (const x of list) bounds.extend([x.p.lat, x.p.lng]);
        m.map.fitBounds(bounds, Object.assign({ animate: !mqReduce.matches, maxZoom: m.map.getZoom() }, fitPadding(m)));
      });
      chips.push({ b, sec });
    }
    box.replaceChildren(...chips.map((c) => c.b));
    // Place each chip where the ray from the centre in its direction meets the frame, clear of the controls.
    const frameBox = m.frame.getBoundingClientRect();
    const obstacles = [];
    for (const sel of ['.mapcap', '.leaflet-top.leaflet-right', '.leaflet-bottom.leaflet-right', '.mapnotice:not([hidden])']) {
      const el = $(sel, m.frame);
      if (el) { const r = el.getBoundingClientRect(); if (r.width) obstacles.push({ l: r.left - frameBox.left, t: r.top - frameBox.top, r: r.right - frameBox.left, b: r.bottom - frameBox.top }); }
    }
    // markers and clusters too: a chip should not sit on top of a place that is in view
    for (const el of mapStops(m)) { const r = el.getBoundingClientRect(); obstacles.push({ l: r.left - frameBox.left, t: r.top - frameBox.top, r: r.right - frameBox.left, b: r.bottom - frameBox.top }); }
    const inset = { l: 8, t: 8, r: size.x - 8, b: size.y - 22 };
    const placed = [];
    for (const { b, sec } of chips) {
      const w = b.offsetWidth;
      const hh = b.offsetHeight;
      const ang = sec * (Math.PI / 4);
      const dx = Math.cos(ang);
      const dy = Math.sin(ang);
      const tx = dx > 0 ? (inset.r - cx) / dx : dx < 0 ? (inset.l - cx) / dx : Infinity;
      const ty = dy > 0 ? (inset.b - cy) / dy : dy < 0 ? (inset.t - cy) / dy : Infinity;
      const t = Math.min(tx, ty);
      const x0 = Math.min(Math.max(cx + dx * t - w / 2, inset.l), inset.r - w);
      const y0 = Math.min(Math.max(cy + dy * t - hh / 2, inset.t), inset.b - hh);
      // Slide along the edge to the nearest spot clear of the controls and the chips already placed.
      const blockers = obstacles.concat(placed);
      const clear = (x, y) => x >= inset.l && x + w <= inset.r && y >= inset.t && y + hh <= inset.b
        && !blockers.some((o) => x < o.r + 4 && x + w > o.l - 4 && y < o.b + 4 && y + hh > o.t - 4);
      const cands = [[x0, y0]];
      for (const o of blockers) {
        if (Math.abs(dx) >= Math.abs(dy) - 0.01) cands.push([x0, o.b + 6], [x0, o.t - hh - 6]);
        if (Math.abs(dy) >= Math.abs(dx) - 0.01) cands.push([o.r + 6, y0], [o.l - w - 6, y0]);
      }
      let best = null;
      for (const [x, y] of cands) {
        if (!clear(x, y)) continue;
        const dist = Math.abs(x - x0) + Math.abs(y - y0);
        if (!best || dist < best[2]) best = [x, y, dist];
      }
      const [x, y] = best || [x0, y0];
      b.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
      placed.push({ l: x, t: y, r: x + w, b: y + hh });
    }
  }

  /* ------------------------------------------------------------------ shared render helpers */

  function glyph(cat, small) {
    return h('span', { class: small ? 'glyph glyph--sm' : 'glyph', 'data-cat': cat.key, 'aria-hidden': 'true' }, cat.glyph);
  }

  function plateEl(plate, size) {
    const sz = size === 'lg' ? ' plate--lg' : size === 'sm' ? ' plate--sm' : '';
    if (plate.kind === 'en') {
      return h('span', { class: 'plate plate--en' + sz },
        h('span', { class: 'plate__main', lang: 'en' }, plate.main, plate.code ? h('span', { class: 'plate__code' }, plate.code) : null),
        h('span', { class: 'plate__rule', 'aria-hidden': 'true' }),
        plate.sub ? h('span', { class: 'plate__sub', lang: hasCJK(plate.sub) ? null : 'en' }, plate.sub) : null);
    }
    if (plate.kind === 'zh') {
      return h('span', { class: 'plate plate--zh' + sz },
        h('span', { class: 'plate__main', lang: plate.latin ? 'en' : null }, plate.main),
        plate.sub ? h('span', { class: 'plate__sub', lang: 'en' }, plate.sub) : null);
    }
    return h('span', { class: 'plate plate--plain' }, h('span', { class: 'plate__main' }, plate.main));
  }
  function cityPlate(key, size) {
    return key === 'LONDON'
      ? plateEl({ kind: 'en', main: 'London', sub: '伦敦 · England' }, size)
      : plateEl({ kind: 'zh', main: '福州', sub: 'Fuzhou' }, size);
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
      el.classList.toggle('aging', !isStale(ts, t) && ageDays(ts, t) >= AGING_DAYS);
    } else if (kind === 'until') {
      const u = untilText(ts, Number(el.dataset.end), el.dataset.tz, t);
      el.textContent = u.text;
      el.classList.toggle('is-live', !!u.live);
    } else if (kind === 'open') {
      paintLive(el);
    } else if (kind === 'deadline') {
      const d = deadlineText(ts, el.dataset.tz, t);
      el.textContent = d.text;
      el.classList.toggle('deadline-past', !!d.past);
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
      } catch { fallback(); }
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
  function upcomingCount(city) {
    const t = now();
    return state.data.events.filter((e) => (city === 'BOTH' || e.city === city) && !e.cancelled && isUpcoming(e, t)).length;
  }
  function renderCounts() {
    const d = state.data;
    const set = (k, v) => { const el = $(`[data-count="${k}"]`); if (el) el.textContent = d ? String(v) : ''; };
    if (!d) return;
    const up = upcomingCount(state.city);
    set('places', countPlaces());
    set('events', up);
    set('sources', d.sources.length);
    $('#tab-places').setAttribute('aria-label', `地点 ${countPlaces()} 处`);
    $('#tab-events').setAttribute('aria-label', `活动 ${up} 场即将举行`);
    $('#tab-sources').setAttribute('aria-label', `来源 ${d.sources.length} 条`);
    const strip = $('[data-strip-count]');
    if (strip) strip.textContent = `${countPlaces()} 处`;
  }

  /* ------------------------------------------------------------------ scrolling */

  function scroller() { return mqDesktop.matches ? els.scroll : doc.scrollingElement; }
  /** Height covered at the top of the page by sticky things (phone layout: the map and the tab bar). */
  function stickyTop() {
    if (mqDesktop.matches) return 0;
    let off = 0;
    if (!state.mapsOff && getComputedStyle(els.mapzone).position === 'sticky') off += els.mapzone.offsetHeight;
    if (getComputedStyle(els.tablist).position === 'sticky') off += els.tablist.offsetHeight;
    return off;
  }
  /** Scroll the panel (desktop) or the page (phone) so `el` sits just below whatever is sticky. */
  function scrollToEl(el, opts = {}) {
    const extra = opts.extra || 0;
    if (mqDesktop.matches) {
      const sc = els.scroll;
      const top = el.getBoundingClientRect().top - sc.getBoundingClientRect().top + sc.scrollTop - extra - 8;
      sc.scrollTo({ top: Math.max(0, top), behavior: opts.behavior || smooth() });
    } else {
      const top = el.getBoundingClientRect().top + window.scrollY - stickyTop() - extra - 8;
      window.scrollTo({ top: Math.max(0, top), behavior: opts.behavior || smooth() });
    }
  }
  function inScrollView(el) {
    const r = el.getBoundingClientRect();
    if (mqDesktop.matches) { const b = els.scroll.getBoundingClientRect(); return r.top >= b.top && r.bottom <= b.bottom; }
    return r.top >= stickyTop() && r.bottom <= window.innerHeight;
  }
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
    const qs = terms(state.query);
    const cityPlaces = d.places.filter((p) => inCity(p.city));
    const byQuery = qs.length ? cityPlaces.filter((p) => qs.every((t) => p.search.includes(t))) : cityPlaces;
    const counts = new Map();
    for (const p of byQuery) counts.set(p.category, (counts.get(p.category) || 0) + 1);
    const shown = state.cats.size ? byQuery.filter((p) => state.cats.has(p.category)) : byQuery;
    return { cityPlaces, byQuery, shown, counts, qs, active: qs.length > 0 || state.cats.size > 0 };
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
      'aria-describedby': 'place-result', 'data-fk': 'place-search',
    });
    input.value = state.query;
    const clear = h('button', { type: 'button', class: 'search__clear', 'aria-label': '清除搜索' }, icon('x'));
    clear.hidden = !state.query;
    input.addEventListener('input', () => { state.query = input.value; clear.hidden = !state.query; updateResults(); });
    input.addEventListener('keydown', (e) => { if (e.key === 'Escape' && input.value) { e.preventDefault(); input.value = ''; state.query = ''; clear.hidden = true; updateResults(); } });
    clear.addEventListener('click', () => { input.value = ''; state.query = ''; clear.hidden = true; updateResults(); input.focus(); });

    const chipAll = h('button', { type: 'button', class: 'chip chip--all', 'aria-pressed': String(state.cats.size === 0), 'data-chip': '*', 'data-fk': 'chip:*' }, '全部', h('span', { class: 'num' }));
    chipAll.addEventListener('click', () => { state.cats.clear(); updateResults(); });
    const chips = [chipAll];
    for (const k of keys.concat(extra)) {
      const cat = catInfo(k);
      const b = h('button', { type: 'button', class: 'chip', 'aria-pressed': String(state.cats.has(k)), 'data-chip': k, 'data-fk': 'chip:' + k, title: CATEGORIES[k] ? `${cat.zh}（${k}）` : cat.zh },
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

    const notice = [];
    if (state.mapsOff) notice.push(h('p', { class: 'notice-inline' }, '地图组件未能加载。列表、活动和来源仍可正常使用；每个地点都附有在外部地图中打开的链接。'));
    if (state.notFound) {
      notice.push(h('p', { class: 'notice-inline', role: 'status' }, `链接中的地点“${state.notFound}”不存在，可能已改名或下线。下面是全部地点。`));
      state.notFound = null;
    }
    view.replaceChildren(...notice, toolbar, results);
    updateResults();
  }

  function updateResults() {
    const view = els.views.places;
    const results = $('[data-results]', view);
    if (!results) return;
    const f = placeFilter();

    for (const chip of $$('[data-chip]', view)) {
      const k = chip.dataset.chip;
      const all = k === '*';
      const n = all ? f.byQuery.length : f.counts.get(k) || 0;
      chip.querySelector('.num').textContent = String(n);
      chip.setAttribute('aria-pressed', String(all ? state.cats.size === 0 : state.cats.has(k)));
      chip.classList.toggle('is-zero', n === 0);
      chip.setAttribute('aria-label', `${all ? '全部类别' : catInfo(k).zh}，${n} 处`);
    }

    const line = $('[data-resultline]', view);
    const where = cityLabel(state.city);
    line.replaceChildren();
    if (f.active) {
      append(line, [`${where} · 共 ${f.cityPlaces.length} 处，`, h('b', null, `显示 ${f.shown.length} 处`)]);
      if (state.query.trim()) append(line, [`（搜索“${state.query.trim()}”）`]);
    } else {
      append(line, [`${where} · `, h('b', null, `${f.cityPlaces.length} 处地点`), state.city === 'FUZHOU' ? '，按区域' : '，按地区由近及远']);
    }
    const fresh = freshnessSummary(f.cityPlaces);
    if (fresh) append(line, [' · ', fresh]);

    results.replaceChildren();
    if (state.city !== 'BOTH') results.appendChild(h('h2', { class: 'vh' }, `${CITIES[state.city].zh}地点，按地区排列`));
    if (!f.shown.length) {
      const clearBtn = h('button', { type: 'button', class: 'btn' }, '清除搜索和筛选');
      clearBtn.addEventListener('click', () => {
        state.query = ''; state.cats.clear();
        const input = $('#place-search'); if (input) input.value = '';
        const c = $('.search__clear', view); if (c) c.hidden = true;
        updateResults();
        if (input) input.focus();
      });
      const other = state.city !== 'BOTH' && f.qs.length
        ? state.data.places.filter((p) => p.city !== state.city && f.qs.every((t) => p.search.includes(t))).length
        : 0;
      const actions = [clearBtn];
      if (other) {
        const otherCity = state.city === 'LONDON' ? 'FUZHOU' : 'LONDON';
        const b = h('button', { type: 'button', class: 'btn' }, `在${CITIES[otherCity].zh}有 ${other} 处匹配`);
        b.addEventListener('click', () => {
          setCity(otherCity);
          const input = $('#place-search');
          if (input) input.focus({ preventScroll: true });
        });
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
        for (const g of groupByArea(list)) {
          const head = h('h3', { class: 'group__head' }, plateEl(g.group.plate),
            h('span', { class: 'group__count' }, String(g.places.length), h('span', { class: 'vh' }, ' 处')));
          const ul = h('ul', { class: 'rows', role: 'list' }, g.places.map((p) => h('li', null, placeRow(p, f.qs))));
          section.appendChild(h('section', { class: 'group' + (g.group.outer ? ' group--outer' : '') }, head, ul));
        }
        results.appendChild(section);
      }
    }
    results.appendChild(provenance());
    applyMarkerFilter(f.active ? new Set(f.shown.map((p) => p.id)) : null, { refit: true });
  }

  /** One line under the result count: verification is only worth a label when it is getting old. */
  function freshnessSummary(list) {
    const ts = list.map((p) => p.verifiedAt).filter((x) => x != null);
    if (!ts.length) return null;
    const t = now();
    const stale = list.filter((p) => p.verifiedAt != null && isStale(p.verifiedAt, t)).length;
    const days = new Set(ts.map((x) => ymd(x, VERIFY_TZ)));
    if (stale) return h('span', { class: 'stale' }, `${stale} 处超过 ${STALE_DAYS} 天未核验`);
    const lo = Math.min(...ts);
    const hi = Math.max(...ts);
    if (days.size === 1) return h('span', { title: ymd(lo, VERIFY_TZ) }, `全部于 ${md(lo, VERIFY_TZ)}核验`);
    return h('span', { title: `${ymd(lo, VERIFY_TZ)} 至 ${ymd(hi, VERIFY_TZ)}` }, `${md(lo, VERIFY_TZ)}至${md(hi, VERIFY_TZ)}核验`);
  }

  /** One line under the list: where the data comes from and how fresh it is. */
  function provenance() {
    const d = state.data;
    const latest = d.places.map((p) => p.verifiedAt).filter((x) => x != null).reduce((m, x) => Math.max(m, x), 0);
    const toSources = h('a', { class: 'link', href: '#sources', 'data-route': 'sources' }, '查看全部来源');
    const unv = d.places.filter((p) => p.unverified).length;
    const vary = d.places.filter((p) => p.vary).length;
    const extra = [unv ? `${unv} 处标“待核实”` : '', vary ? `${vary} 处时间每天不同（附官网日历）` : '', d.guide.held ? `另有 ${d.guide.held} 处等官方公布后再显示` : ''].filter(Boolean);
    return h('p', { class: 'foot' },
      `资料来自公开数据文件 content.json（${d.meta.format || '格式未注明'} v${d.meta.version || '?'}，坐标 ${d.meta.coordinateSystem || '未注明'}）`,
      latest ? `，地点最近核验于 ${ymd(latest, VERIFY_TZ)}。` : '。',
      d.guide.count ? `伦敦另有攻略层 ${GUIDE_PATH} 的 ${d.guide.count} 处（仅网页版）${extra.length ? `；${extra.join('，')}` : ''}。` : '',
      '每条都附来源链接；出发前请以来源为准。', toSources);
  }

  function groupByArea(list) {
    const map = new Map();
    for (const p of list) {
      if (!map.has(p.group.key)) map.set(p.group.key, { group: p.group, places: [] });
      map.get(p.group.key).places.push(p);
    }
    const out = Array.from(map.values()).sort((a, b) => a.group.rank - b.group.rank || cmp(a.group.plate.main, b.group.plate.main));
    for (const g of out) g.places.sort((a, b) => a.rank - b.rank);
    return out;
  }

  function placeRow(p, qs) {
    const meta = [p.cat.zh, p.region || '未标注区域'];
    if (p.postcode) meta.push(p.postcode);
    if (p.group && p.group.outer && p.km != null) meta.push(`${fmtKm(p.km)} km`);
    let excerpt = p.excerpt || (p.g && p.g.summary) || '';
    let matched = false;
    if (qs && qs.length) {
      // Show why a row matched when the match is not in its visible name or meta line.
      const visible = fold(`${p.name} ${meta.join(' ')} ${p.cat.terms} ${p.category}`);
      if (!qs.every((t) => visible.includes(t))) {
        for (const field of [p.openingInfo, p.description, p.zh, p.g && p.g.summary, p.address, p.group.plate.sub]) {
          const snip = field && kwic(field, qs);
          if (snip) { excerpt = snip; matched = true; break; }
        }
      }
    }
    const fresh = p.verifiedAt != null && (isStale(p.verifiedAt) || ageDays(p.verifiedAt) >= AGING_DAYS) ? freshness(p.verifiedAt, 'row__fresh') : null;
    const live = p.node && p.node.plan && TP() ? liveEl(p, 'row__live') : null;
    const a = h('a', { class: 'row', href: '#' + p.id, 'data-id': p.id, 'data-city': p.city, 'data-route': p.id, 'data-fk': 'row:' + p.id },
      glyph(p.cat),
      h('span', { class: 'row__name' }, highlight(p.name, qs), p.zh ? h('span', { class: 'row__zh' }, highlight(p.zh, qs)) : null, unverifiedBadge(p)),
      fresh,
      h('span', { class: 'row__meta' }, live, live ? h('span', { class: 'sep', 'aria-hidden': 'true' }, ' · ') : null, highlight(meta.join(' · '), qs)),
      excerpt ? h('span', { class: 'row__excerpt' + (matched ? ' is-match' : '') }, highlight(excerpt, qs)) : null);
    a.addEventListener('pointerenter', () => setHot(p.id, true));
    a.addEventListener('pointerleave', () => setHot(p.id, false));
    a.addEventListener('focus', () => setHot(p.id, true));
    a.addEventListener('blur', () => setHot(p.id, false));
    return a;
  }

  /* ------------------------------------------------------------------ view: place detail */

  function returnFocusOf(el) {
    if (!el || !el.closest) return null;
    const ev = el.closest('[data-event]');
    const src = el.closest('[data-src]');
    return { fk: el.dataset.fk || (el.closest('[data-fk]') && el.closest('[data-fk]').dataset.fk) || null, event: ev ? ev.dataset.event : null, src: src ? src.dataset.src : null };
  }

  function openPlace(id, opts = {}) {
    const d = state.data;
    const p = d && d.placeById.get(id);
    if (!p) return;
    const wasDetail = state.tab === 'places' && !!state.placeId;
    if (state.tab === 'places' && !state.placeId) { state.listScroll = scroller().scrollTop; state.returnTab = 'places'; state.returnFocus = null; }
    else if (state.tab !== 'places') { state.returnTab = state.tab; state.returnScroll = scroller().scrollTop; state.returnFocus = returnFocusOf(opts.fromEl); }
    state.placeId = id;
    state.notFound = null;
    if (!inCity(p.city)) setCity(p.city, { render: false });
    if (state.city === 'BOTH') setMapCity(p.city);
    setTab('places', { render: false });
    if (!state.mapsOff) setMapMin(false);
    const push = !opts.fromHistory && !opts.initial && !wasDetail;
    render({ push });
    if (push) state.pushedPlace = id;
    selectOnMap(p);
    scrollPanelTop();
    if (opts.focus !== false) {
      const head = $('.detail__name', els.views.places);
      if (head) head.focus({ preventScroll: true });
    }
    if (opts.from === 'map') announce(`已打开 ${p.name}`);
  }

  function closePlace(opts = {}) {
    const id = state.placeId;
    // We added a history entry for this place: going back removes it, and popstate closes the page.
    if (!opts.fromHistory && state.pushedPlace === id && history.state && history.state.tca === 'place' && history.state.id === id) {
      state.pushedPlace = null;
      history.back();
      return;
    }
    state.pushedPlace = null;
    state.placeId = null;
    selectOnMap(null);
    if (state.returnTab !== 'places') {
      // Opened from 活动 or 来源: go back there, to the same scroll position and the element that opened it.
      const tab = state.returnTab;
      const rf = state.returnFocus;
      state.returnTab = 'places';
      setTab(tab, { render: false });
      render();
      scroller().scrollTop = state.returnScroll;
      const view = els.views[tab];
      let target = null;
      if (rf && rf.fk) target = view.querySelector(`[data-fk="${CSS.escape(rf.fk)}"]`);
      if (!target && rf && rf.event) target = view.querySelector(`[data-event="${CSS.escape(rf.event)}"] [data-route="${CSS.escape(id)}"]`);
      if (!target && rf && rf.src) target = view.querySelector(`[data-src="${CSS.escape(rf.src)}"] [data-route="${CSS.escape(id)}"]`);
      if (!target && id) target = view.querySelector(`[data-route="${CSS.escape(id)}"]`);
      if (target) {
        if (!inScrollView(target)) scrollToEl(target, { behavior: 'auto' });
        target.focus({ preventScroll: true });
      }
      return;
    }
    // Phones: a list left deep down had the map folded; fold it again so the old scroll position lines up.
    if (!mqDesktop.matches && !state.mapsOff && state.listScroll > window.innerHeight) setMapMin(true, { auto: true });
    render();
    scroller().scrollTop = state.listScroll;
    const row = id && els.views.places.querySelector(`.row[data-id="${CSS.escape(id)}"]`);
    if (row) {
      row.focus({ preventScroll: true });
      if (!inScrollView(row)) scrollToEl(row, { behavior: 'auto', extra: mqDesktop.matches ? 60 : 40 });
    }
  }

  /** Opening info as structured text: a provenance line, paragraphs, schedule lists and a 注意 block. */
  function openingBlocks(text, city) {
    if (!text) return [h('p', null, '数据中没有开放与安排信息，请查看来源。')];
    const { lead, body } = splitPreamble(text);
    const localLead = LOCAL_TIME_RE.test(lead);
    LOCAL_TIME_RE.lastIndex = 0;
    const out = [];
    if (lead) {
      const src = lead.replace(LOCAL_TIME_RE, '').replace(/[：:]$/, '').trim();
      out.push(h('p', { class: 'openinfo__src' }, `据${src.replace(/^据/, '')}${localLead ? ` · ${CITIES[city].zh}当地时间` : ''}`));
    }
    const sentences = splitTop(body, '。').map((x) => x.text.trim()).filter(Boolean);
    const warn = [];
    const tail = [];
    for (const s of sentences) {
      if (/^(注意|请注意|须|不得|售罄)/.test(s)) { warn.push(s); continue; }
      if (/^出发前/.test(s)) { tail.push(s); continue; }
      const items = scheduleItems(s);
      if (items) out.push(h('ul', { class: 'openinfo__list' }, items.map((it) => h('li', null, richText(it)))));
      else out.push(h('p', null, richText(s + '。')));
    }
    if (warn.length) {
      out.push(h('div', { class: 'openinfo__warn', role: 'note' }, h('span', { class: 'openinfo__warnlabel' }, icon('warn'), '注意'), warn.map((s) => h('p', null, richText(s + '。')))));
    }
    if (tail.length) out.push(h('p', { class: 'openinfo__tail' }, tail.map((s) => s + '。').join('')));
    return out;
  }

  function renderDetail(p) {
    const view = els.views.places;
    const d = state.data;
    const backTo = { places: '返回地点列表', guide: '返回攻略', events: '返回活动', sources: '返回来源' }[state.returnTab] || '返回地点列表';
    const back = h('button', { type: 'button', class: 'btn btn--quiet detail__back' }, icon('back'), backTo);
    back.addEventListener('click', () => closePlace());

    const addrText = h('p', null, p.address || '地址未注明');
    const head = h('header', { class: 'detail__head' },
      h('p', { class: 'detail__kicker' }, glyph(p.cat, true), h('span', null, p.cat.zh), h('span', { class: 'sep', 'aria-hidden': 'true' }, '/'), h('span', null, `${CITIES[p.city].zh} ${CITIES[p.city].en}`),
        p.group && p.group.area ? [h('span', { class: 'sep', 'aria-hidden': 'true' }, '/'), h('span', null, p.group.area.zh)] : null),
      h('h2', { class: 'detail__name', tabindex: '-1' }, p.name, p.zh ? h('span', { class: 'detail__zh' }, p.zh) : null),
      h('div', null, plateEl(p.plate)),
      h('div', { class: 'detail__address' }, addrText, p.address ? copyButton(() => p.address, '复制地址', addrText) : null));

    const parts = [back, head];
    if (p.description) parts.push(h('p', { class: 'detail__desc' }, richText(p.description)));
    if (!p.guide) {
      parts.push(h('section', { class: 'openinfo', 'data-city': p.city, 'aria-labelledby': 'open-label' },
        h('h3', { class: 'label', id: 'open-label' }, '开放与安排'),
        openingBlocks(p.openingInfo, p.city)));
    }
    if (p.g) parts.push(guideBlock(p));

    // events here (series collapsed into one row each)
    const evs = d.eventsByPlace.get(p.id) || [];
    const t = now();
    const up = evs.filter((e) => isUpcoming(e, t));
    const pastN = evs.length - up.length;
    if (evs.length) {
      const sec = h('section', { class: 'section', 'aria-labelledby': 'ev-here' }, h('h3', { class: 'label', id: 'ev-here' }, '这里的活动'));
      if (up.length) {
        sec.appendChild(h('ul', { class: 'minievents', role: 'list' }, buildItems(up).map((it) => miniEvent(it))));
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

    const srcs = d.sourcesByPlace.get(p.id) || [];
    const mainKey = p.sourceUrl ? urlKey(p.sourceUrl) : null;
    const mainRec = srcs.find((s) => s.key === mainKey) || null;
    const coordRefs = srcs.filter((s) => s !== mainRec && s.coordRef);
    const others = srcs.filter((s) => s !== mainRec && !s.coordRef);

    // survey: coordinates, radius, precision, and what the coordinates were checked against
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
        h('dt', null, '到达半径'), h('dd', null, p.radius ? `${nf0.format(p.radius)} m${state.mapsOff ? '' : '（地图上的虚线圈）'}` : '未注明'),
        p.km != null ? [h('dt', null, '距市中心'), h('dd', null, `${fmtKm(p.km)} km`, h('span', { class: 'muted' }, `（至 ${CITIES[p.city].ref.label} 的直线距离）`))] : null);
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
    if (coordRefs.length) {
      survey.appendChild(h('h4', { class: 'sublabel' }, '坐标依据'));
      survey.appendChild(h('div', { class: 'srcrows' }, coordRefs.map((s) => srcRow(s))));
    }
    parts.push(survey);

    // verification + every source record tied to this place
    const src = h('section', { class: 'section', 'aria-labelledby': 'src-label' }, h('h3', { class: 'label', id: 'src-label' }, '来源与核验', srcs.length ? h('span', { class: 'label__n' }, `${srcs.length} 条`) : null));
    src.appendChild(verifyLine(p.verifiedAt, p.sourceVersion));
    const rows = [];
    if (p.sourceUrl) rows.push(mainRec ? srcRow(mainRec, '主来源') : srcRow({ url: p.sourceUrl, domain: domainOf(p.sourceUrl), path: pathOf(p.sourceUrl), status: '', verifiedAt: null, placeIds: [p.id], how: 'url' }, '主来源'));
    else src.appendChild(h('p', { class: 'muted' }, '数据未提供主来源链接。'));
    const CAP = 4;
    const firstOthers = others.slice(0, Math.max(0, CAP - rows.length));
    const restOthers = others.slice(firstOthers.length);
    rows.push(...firstOthers.map((s) => srcRow(s)));
    const box = h('div', { class: 'srcrows' }, rows);
    src.appendChild(box);
    if (restOthers.length) {
      const more = h('button', { type: 'button', class: 'btn btn--quiet srcmore', 'aria-expanded': 'false' }, icon('down'), `另外 ${restOthers.length} 条来源`);
      more.addEventListener('click', () => {
        append(box, restOthers.map((s) => srcRow(s)));
        more.remove();
        const first = box.children[rows.length];
        if (first) { const a = first.querySelector('a'); if (a) a.focus(); }
      });
      src.appendChild(more);
    }
    if (srcs.some((s) => s.how && s.how !== 'url')) {
      src.appendChild(h('p', { class: 'note' }, '除主来源外，其余记录按网站、邮编、坐标或名称与本地点对应；全部记录见', h('a', { class: 'link', href: '#sources', 'data-route': 'sources' }, '来源页'), '。'));
    }
    parts.push(src);

    view.replaceChildren(h('article', { class: 'detail', 'data-city': p.city }, parts));
    applyMarkerFilter(null);
  }

  /** A compact source record: link, date, and the note clamped to two lines (tap to read all of it). */
  function srcRow(s, tag) {
    const status = s.status
      ? h('button', { type: 'button', class: 'srcrow__status', 'aria-expanded': 'false', title: '展开全文' }, h('span', { class: 'clamp' }, richText(s.status)))
      : null;
    if (status) status.addEventListener('click', () => { const open = status.getAttribute('aria-expanded') !== 'true'; status.setAttribute('aria-expanded', String(open)); });
    return h('div', { class: 'srcrow' + (tag ? ' is-main' : '') },
      h('p', { class: 'srcrow__head' },
        tag ? h('span', { class: 'srcrow__tag' }, tag) : null,
        extLink(s.url, s.domain + (s.path ? s.path : ''), 'link ext srcrow__url'),
        s.verifiedAt != null ? h('span', { class: 'srcrow__date' }, ymd(s.verifiedAt, VERIFY_TZ)) : null),
      status,
      s.validUntil != null ? h('p', { class: 'srcrow__meta' }, `有效至 ${ymd(s.validUntil, s.tz)} ${hm(s.validUntil, s.tz)}（${tzName(s.tz)}）`, s.validUntil < now() ? h('span', { class: 'badge' }, '已过期') : null) : null,
      s.how && s.how !== 'url' && !tag ? h('p', { class: 'srcrow__meta' }, HOW_ZH[s.how] || '') : null);
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

  /* ------------------------------------------------------------------ events: shared pieces */

  function timeRange(e, tz) {
    const a = hm(e.start, tz);
    if (e.end <= e.start) return a;
    return `${a}–${endText(e, tz)}`;
  }
  /** The end of a range as written after the dash: 21:00 / 次日 01:00 / 11月8日 19:00. */
  function endText(e, tz) {
    const dd = dayIndex(e.end, tz) - dayIndex(e.start, tz);
    return `${dd === 0 ? '' : dd === 1 ? '次日 ' : md(e.end, tz) + ' '}${hm(e.end, tz)}`;
  }
  function dayShort(e) {
    const l = dayLabel(e.dayIdx);
    return `${l.short} ${l.wd}`;
  }
  function relSpan(e) {
    const el = h('span', { class: 'countdown', 'data-rel': 'until', 'data-ts': e.start, 'data-end': e.end, 'data-tz': e.tz });
    paintRel(el);
    return el;
  }
  function priceText(e) {
    if (e.priceMinor === 0) return '免费';
    if (e.priceMinor == null) return '费用见来源';
    if (!e.currency) return `${(e.priceMinor / 100).toFixed(2)}（币种未注明，见来源）`;
    try {
      const f = new Intl.NumberFormat('zh-CN', { style: 'currency', currency: e.currency });
      const digits = f.resolvedOptions().maximumFractionDigits;
      return f.format(e.priceMinor / Math.pow(10, digits));
    } catch {
      return `${(e.priceMinor / 100).toFixed(2)} ${e.currency}`;
    }
  }
  /** Short price for the row chip: 免费 / £40 / 见来源. */
  function priceShort(list) {
    const ps = Array.from(new Set(list.map((e) => (e.currency || '') + ':' + e.priceMinor)));
    if (ps.length !== 1) return '见来源';
    const e = list[0];
    if (e.priceMinor === 0) return '免费';
    if (e.priceMinor == null || !e.currency) return '见来源';
    try {
      const f = new Intl.NumberFormat('zh-CN', { style: 'currency', currency: e.currency });
      const digits = f.resolvedOptions().maximumFractionDigits;
      const v = e.priceMinor / Math.pow(10, digits);
      return new Intl.NumberFormat('zh-CN', { style: 'currency', currency: e.currency, minimumFractionDigits: Number.isInteger(v) ? 0 : digits }).format(v);
    } catch { return '见来源'; }
  }
  function otherTz(e) {
    return cityOfTz(e.tz) === 'LONDON' ? CITIES.FUZHOU.tz : CITIES.LONDON.tz;
  }
  /** "City Lit 素描入门 VH401（周一晚班，全期3次…）" → main "City Lit 素描入门 VH401", note "周一晚班，全期3次…". */
  function seriesTitle(series) {
    const t = series.title || series.id;
    const m = t.match(/^(.*?)（(.*)）$/);
    return m && m[1].trim() ? { main: m[1].trim(), note: m[2].trim() } : { main: t, note: '' };
  }

  /** Rows: sessions of one series within SERIES_SPAN collapse to one item placed at the first session. */
  function buildItems(list) {
    const bySeries = new Map();
    for (const e of list) if (e.series) { if (!bySeries.has(e.series.id)) bySeries.set(e.series.id, []); bySeries.get(e.series.id).push(e); }
    const used = new Set();
    const items = [];
    for (const e of list) {
      if (used.has(e.id)) continue;
      const ses = e.series ? bySeries.get(e.series.id) : null;
      if (ses && ses.length >= 2 && Math.abs(ses[ses.length - 1].start - ses[0].start) <= SERIES_SPAN) {
        for (const x of ses) used.add(x.id);
        items.push({ kind: 'series', key: 's:' + e.series.id, first: e, events: ses, series: e.series });
      } else {
        used.add(e.id);
        items.push({ kind: 'event', key: 'e:' + e.id, first: e, events: [e], series: e.series });
      }
    }
    return items;
  }
  const liveOf = (events, t = now()) => events.filter((e) => !e.cancelled && isUpcoming(e, t));

  /** Session date chips for a series: every session in the data, past ones struck through. */
  function sessionChips(series, cityScope) {
    const t = now();
    const all = series.events.filter((e) => cityScope === 'BOTH' || !e.city || e.city === cityScope);
    const shown = all.slice(0, 8);
    return h('span', { class: 'sessions' },
      h('span', { class: 'vh' }, `共 ${all.length} 次：${all.map((e) => `${dayShort(e)}${!isUpcoming(e, t) ? '（已结束）' : e.cancelled ? '（已取消）' : ''}`).join('、')}`),
      h('span', { class: 'sessions__n', 'aria-hidden': 'true' }, `${all.length} 次`),
      shown.map((e) => h('span', { class: 'sess' + (!isUpcoming(e, t) ? ' is-past' : '') + (e.cancelled ? ' is-cancelled' : ''), 'aria-hidden': 'true' }, dayLabel(e.dayIdx).short)),
      all.length > shown.length ? h('span', { class: 'sess', 'aria-hidden': 'true' }, `+${all.length - shown.length}`) : null);
  }

  function miniEvent(item) {
    const e = item.first;
    const live = liveOf(item.events);
    const isSeries = item.kind === 'series';
    const title = isSeries ? seriesTitle(item.series).main : e.title;
    const when = isSeries
      ? `${md(e.start, e.tz)}起 · ${WEEKDAYS[dayLabel(e.dayIdx).dow]} ${timeRange(e, e.tz)}`
      : `${md(e.start, e.tz)} ${WEEKDAYS[dayLabel(e.dayIdx).dow]} ${timeRange(e, e.tz)}`;
    return h('li', { class: 'minievent' + (e.cancelled && !isSeries ? ' is-cancelled' : ''), 'data-event': e.id },
      h('p', { class: 'minievent__when' }, when, ' · ', e.cancelled && !isSeries ? h('span', { class: 'countdown' }, '已取消') : relSpan(live[0] || e)),
      h('p', { class: 'minievent__title' }, title),
      isSeries ? sessionChips(item.series, 'BOTH') : null,
      live.length ? icsButton(live, { compact: true, series: isSeries ? item.series : null }) : null);
  }

  /* ------------------------------------------------------------------ view: events */

  /** 本周末 = the coming Saturday and Sunday (today included on a Saturday); on a Sunday, 下周末. */
  function weekendDays(tz) {
    const today = dayIndex(now(), tz);
    const dow = dayLabel(today).dow;
    const days = dow === 6 ? [today, today + 1] : dow === 0 ? [today + 6, today + 7] : [today + (6 - dow), today + (7 - dow)];
    const set = new Set(days);
    set.label = dow === 0 ? '下周末' : '本周末';
    return set;
  }
  const refTz = () => (state.city === 'FUZHOU' ? CITIES.FUZHOU.tz : CITIES.LONDON.tz);
  function evFilterKey() {
    const f = state.evFilters;
    return `${f.free ? 'f' : ''}${f.weekend ? 'w' : ''}|${Array.from(f.cats).sort().join(',')}`;
  }
  function evMatches(e, wk) {
    const f = state.evFilters;
    if (f.free && e.priceMinor !== 0) return false;
    if (f.weekend && !wk.has(e.dayIdx)) return false;
    if (f.cats.size && !(e.place && f.cats.has(e.place.category))) return false;
    return true;
  }

  function renderEvents() {
    const view = els.views.events;
    const d = state.data;
    const t = now();
    const scope = d.events.filter((e) => state.city === 'BOTH' || e.city === state.city);
    const upAll = scope.filter((e) => isUpcoming(e, t));
    const past = scope.filter((e) => !isUpcoming(e, t));
    const wk = weekendDays(refTz());
    const up = upAll.filter((e) => evMatches(e, wk));
    const live = up.filter((e) => !e.cancelled);
    state.evPlaceIds = upAll.length ? new Set(live.map((e) => e.placeId).filter((id) => d.placeById.has(id))) : null;
    const parts = [h('h2', { class: 'vh' }, `${cityLabel(state.city)}活动`)];
    if (upAll.length) parts.push(evToolbar(upAll, wk));
    if (live.length) parts.push(weekStrip(live));
    if (up.length) {
      parts.push(evList(up));
    } else if (upAll.length) {
      const clearBtn = h('button', { type: 'button', class: 'btn', 'data-fk': 'ev:clear' }, '清除筛选');
      clearBtn.addEventListener('click', () => { state.evFilters.free = false; state.evFilters.weekend = false; state.evFilters.cats.clear(); keepFocus(() => render({ force: true })); refocus('evf:*'); });
      parts.push(h('div', { class: 'empty' }, h('p', { class: 'empty__title' }, '没有符合筛选的活动'), h('p', null, `${cityLabel(state.city)}共有 ${upAll.length} 场即将举行，去掉一些筛选试试。`), h('div', { class: 'empty__actions' }, clearBtn)));
    } else {
      parts.push(emptyEvents(past));
    }
    if (past.length) parts.push(pastBlock(past));
    view.replaceChildren(...parts);
    activateEvents();
  }
  function activateEvents() {
    applyMarkerFilter(state.evPlaceIds);
  }

  function emptyEvents(past) {
    const lastPast = past.slice().sort((a, b) => b.end - a.end)[0];
    const where = state.city === 'BOTH' ? '两座城市' : CITIES[state.city].zh;
    const actions = [];
    if (state.city !== 'BOTH') {
      const other = state.city === 'LONDON' ? 'FUZHOU' : 'LONDON';
      const n = upcomingCount(other);
      if (n) {
        const b = h('button', { type: 'button', class: 'btn', 'data-fk': 'ev:other' }, `去看${CITIES[other].zh}的 ${n} 场`);
        b.addEventListener('click', () => { setCity(other); const first = $('.evrow__toggle, .chip', els.views.events); if (first) first.focus({ preventScroll: true }); });
        actions.push(b);
      }
    }
    if (past.length) {
      const toPast = h('button', { type: 'button', class: 'btn' }, `查看已结束的 ${past.length} 场`);
      toPast.addEventListener('click', () => {
        const det = $('details.past', els.views.events);
        if (!det) return;
        det.open = true;
        state.pastOpen = true;
        fillPast(det);
        scrollToEl(det);
        det.querySelector('summary').focus({ preventScroll: true });
      });
      actions.push(toPast);
    }
    const toPlaces = h('button', { type: 'button', class: 'btn' }, '查看地点的常规安排');
    toPlaces.addEventListener('click', () => setTab('places'));
    actions.push(toPlaces);
    return h('div', { class: 'empty' },
      h('p', { class: 'empty__title' }, `${where}暂时没有即将举行的活动`),
      lastPast
        ? h('p', null, `最近一场“${lastPast.title}”已于 ${md(lastPast.end, lastPast.tz)}（${tzName(lastPast.tz)}）结束。新场次随 content.json 更新出现在这里，每一场都附来源链接和日历文件。`)
        : h('p', null, '新场次随 content.json 更新出现在这里，每一场都附来源链接和日历文件。'),
      h('p', null, '常规开放时间与每周安排记录在各地点的“开放与安排”里。'),
      h('div', { class: 'empty__actions' }, actions));
  }

  function evToolbar(upAll, wk) {
    const f = state.evFilters;
    const live = upAll.filter((e) => !e.cancelled);
    const chip = (key, label, n, pressed, onClick, extra) => {
      const b = h('button', { type: 'button', class: 'chip' + (key === '*' ? ' chip--all' : ''), 'aria-pressed': String(pressed), 'data-fk': 'evf:' + key, 'aria-label': `${typeof label === 'string' ? label : ''}${n != null ? `，${n} 场` : ''}` }, extra || null, h('span', null, label), n != null ? h('span', { class: 'num' }, String(n)) : null);
      if (n === 0) b.classList.add('is-zero');
      b.addEventListener('click', () => { onClick(); keepFocus(() => render({ force: true })); announce(`显示 ${$$('.evrow', els.views.events).length ? $('[data-evcount]', els.views.events).textContent : '0 场'}`); });
      return b;
    };
    const chips = [
      chip('*', '全部', live.length, !f.free && !f.weekend && !f.cats.size, () => { f.free = false; f.weekend = false; f.cats.clear(); }),
      chip('free', '免费', live.filter((e) => e.priceMinor === 0).length, f.free, () => { f.free = !f.free; }),
      chip('weekend', wk.label, live.filter((e) => wk.has(e.dayIdx)).length, f.weekend, () => { f.weekend = !f.weekend; }),
    ];
    const cats = CATEGORY_ORDER.filter((k) => live.some((e) => e.place && e.place.category === k));
    for (const k of cats) {
      const cat = catInfo(k);
      chips.push(chip('cat:' + k, cat.zh, live.filter((e) => e.place && e.place.category === k).length, f.cats.has(k), () => { if (f.cats.has(k)) f.cats.delete(k); else f.cats.add(k); }, glyph(cat, true)));
    }
    return h('div', { class: 'chips evchips', role: 'group', 'aria-label': '筛选活动' }, chips);
  }

  /** Week histogram: one column per week from this week (next week on a quiet Sunday), plus 之后. */
  function weekStrip(live) {
    const tz = refTz();
    const today = dayIndex(now(), tz);
    let start = mondayOf(today);
    let firstLabel = '本周';
    if (dayLabel(today).dow === 0 && !live.some((e) => e.dayIdx <= today)) { start = today + 1; firstLabel = '下周'; }
    const maxN = window.innerWidth < 400 ? 12 : 16;
    const last = live.reduce((m, e) => Math.max(m, e.dayIdx), today);
    const n = Math.max(8, Math.min(maxN, Math.ceil((last - start + 1) / 7)));
    const buckets = Array.from({ length: n }, () => []);
    const later = [];
    for (const e of live) {
      const w = Math.floor((mondayOf(e.dayIdx) - start) / 7);
      if (w < 0) buckets[0].push(e); else if (w < n) buckets[w].push(e); else later.push(e);
    }
    const mark = (e) => h('i', { 'data-cat': e.place ? e.place.category : null });
    const col = (list, label, title, cls, onClick) => {
      const marks = list.slice(0, 7).map(mark);
      if (list.length > 7) marks[6] = h('i', { class: 'more' });
      const b = h('button', { class: 'week' + (cls ? ' ' + cls : ''), type: 'button', 'aria-label': title, title });
      if (!list.length) b.disabled = true;
      append(b, [h('span', { class: 'week__bar', 'aria-hidden': 'true' }, marks), h('span', { class: 'week__label', 'aria-hidden': 'true' }, label)]);
      if (list.length) b.addEventListener('click', onClick);
      return b;
    };
    const cols = buckets.map((list, i) => {
      const ws = start + i * 7;
      const from = dayLabel(Math.max(ws, i === 0 ? start : ws));
      const to = dayLabel(mondayOf(ws) + 6);
      const monthStart = Array.from({ length: 7 }, (_, k) => dayLabel(ws + k)).find((x) => x.d === 1);
      const tag = i === 0 ? firstLabel : monthStart ? `${monthStart.mo}月` : '';
      const title = `${i === 0 ? firstLabel + '，' : ''}${from.md}–${to.md}：${list.length ? list.length + ' 场' : '没有活动'}`;
      return col(list, tag, title, i === 0 ? 'is-now' : '', () => gotoWeek(mondayOf(ws), new Set(list.map((e) => e.id))));
    });
    if (later.length) {
      const fromIdx = start + n * 7;
      cols.push(col(later, '之后', `${dayLabel(fromIdx).md}以后：${later.length} 场`, 'is-later', () => gotoWeek(mondayOf(fromIdx), new Set(later.map((e) => e.id)), true)));
    }
    const shown = live.length - later.length;
    return h('section', { class: 'weeks', 'aria-label': '按周分布' },
      h('p', { class: 'weeks__head' }, h('span', null, `${firstLabel}起 ${n} 周 · `, h('b', null, `${shown} 场`), later.length ? `，之后 ${later.length} 场` : ''), h('span', null, `按${CITIES[cityOfTz(tz)].zh}日期分周`)),
      h('div', { class: 'weeks__strip', style: `--cols:${cols.length}` }, cols));
  }
  /** Week column → the list: that week's section, or the series row that holds its sessions. */
  function gotoWeek(monday, ids, orLater) {
    const view = els.views.events;
    let target = view.querySelector(`#wk-${monday}`);
    if (!target && orLater) target = $$('.evweek', view).find((s) => Number(s.dataset.week) >= monday) || null;
    let row = null;
    if (!target) {
      row = $$('.evrow', view).find((r) => (r.dataset.events || '').split(' ').some((id) => ids.has(id))) || null;
      if (row) { setRowOpen(row, true); target = row; }
    }
    if (!target) return;
    scrollToEl(target, { extra: row && mqDesktop.matches ? 44 : 0 });
    const focusEl = row ? $('.evrow__toggle', row) : $('.evweek__head', target);
    if (focusEl) focusEl.focus({ preventScroll: true });
  }

  function evList(up) {
    const items = buildItems(up);
    const t = now();
    const tz = refTz();
    const thisMon = mondayOf(dayIndex(t, tz));
    const weeks = new Map();
    for (const it of items) {
      const mon = mondayOf(it.first.dayIdx);
      if (!weeks.has(mon)) weeks.set(mon, []);
      weeks.get(mon).push(it);
    }
    const sessionsInWeek = (mon) => up.filter((e) => !e.cancelled && mondayOf(e.dayIdx) === mon).length;
    const sections = Array.from(weeks.entries()).sort((a, b) => a[0] - b[0]).map(([mon, list]) => {
      const diff = Math.round((mon - thisMon) / 7);
      const rel = diff <= 0 ? '本周' : diff === 1 ? '下周' : `${diff} 周后`;
      const a = dayLabel(mon);
      const b = dayLabel(mon + 6);
      const n = sessionsInWeek(mon);
      return h('section', { class: 'evweek', id: `wk-${mon}`, 'data-week': mon, 'aria-labelledby': `wkh-${mon}` },
        h('h3', { class: 'evweek__head', id: `wkh-${mon}`, tabindex: '-1' },
          h('span', { class: 'evweek__rel' }, rel),
          h('span', { class: 'evweek__range' }, `${a.md}–${a.mo === b.mo ? b.d + '日' : b.md}`),
          h('span', { class: 'evweek__n' }, `${n} 场`)),
        h('div', { class: 'evrows' }, list.map((it) => evRow(it))));
    });
    return h('div', { class: 'evweeks' }, h('p', { class: 'vh', 'data-evcount': '' }, `${up.length} 场`), sections);
  }

  function evRow(item, opts = {}) {
    const e = item.first;
    const isSeries = item.kind === 'series';
    const t = now();
    const live = liveOf(item.events, t);
    const next = live[0] || e;
    const rowKey = item.key + (opts.past ? ':past' : '');
    const domId = 'ev-' + rowKey.replace(/[^A-Za-z0-9_-]+/g, '-');
    const cityKey = e.city || cityOfTz(e.tz);
    const open = state.evOpen.has(rowKey);
    const st = STATUS[e.status] || null;
    const title = isSeries ? seriesTitle(item.series) : { main: e.title, note: '' };
    const toggle = h('button', { type: 'button', class: 'evrow__toggle', 'aria-expanded': String(open), 'aria-controls': domId + '-more', 'data-fk': 'evt:' + rowKey },
      h('span', { class: 'evrow__title' }, title.main));
    const side = [];
    side.push(h('span', { class: 'price' + (priceShort(item.events) === '免费' ? ' is-free' : '') }, priceShort(item.events)));
    if (opts.past) side.push(h('span', { class: 'countdown' }, '已结束'));
    else if (!isSeries && e.cancelled) side.push(h('span', { class: 'countdown is-cancelled' }, '已取消'));
    else side.push(relSpan(next));
    const showStatus = !isSeries && st ? !st.quiet && !st.cancelled : !isSeries && e.statusRaw;
    const art = h('article', {
      class: 'evrow' + (isSeries ? ' evrow--series' : '') + (!isSeries && e.cancelled ? ' is-cancelled' : '') + (open ? ' is-open' : ''),
      id: domId, 'data-city': cityKey || null, 'data-event': e.id, 'data-events': item.events.map((x) => x.id).join(' '), 'data-row': rowKey,
    },
    h('div', { class: 'evrow__head' },
      h('div', { class: 'evrow__when' },
        h('span', { class: 'evrow__day' }, isSeries ? `${dayLabel(e.dayIdx).short} 起` : dayShort(e)),
        h('time', { class: 'evrow__time', datetime: new Date(e.start).toISOString() }, hm(e.start, e.tz)),
        e.end > e.start ? h('span', { class: 'evrow__end' }, `–${endText(e, e.tz)}`) : null),
      h('div', { class: 'evrow__main' },
        h('h4', { class: 'evrow__h' }, toggle),
        isSeries ? sessionChips(item.series, state.city) : null,
        showStatus ? h('span', { class: 'status' + (st && st.warn ? ' is-warn' : '') }, st ? st.zh : e.statusRaw) : null,
        e.place
          ? h('a', { class: 'placelink', href: '#' + e.place.id, 'data-route': e.place.id, 'data-fk': 'evp:' + rowKey }, glyph(e.place.cat, true), h('span', null, `${e.place.name}${e.place.region ? ' · ' + e.place.region : ''}`))
          : h('span', { class: 'placelink muted' }, '地点资料未公开或缺失')),
      h('div', { class: 'evrow__side' }, side)),
    h('div', { class: 'evrow__more', id: domId + '-more', hidden: !open }));
    if (open) fillMore(art, item, opts);
    toggle.addEventListener('click', () => setRowOpen(art, toggle.getAttribute('aria-expanded') !== 'true', item, opts));
    art._item = item;
    art._opts = opts;
    if (e.place) {
      art.addEventListener('pointerenter', () => setHot(e.place.id, true));
      art.addEventListener('pointerleave', () => setHot(e.place.id, false));
      art.addEventListener('focusin', () => setHot(e.place.id, true));
      art.addEventListener('focusout', () => setHot(e.place.id, false));
    }
    return art;
  }
  function setRowOpen(art, open, item, opts) {
    const it = item || art._item;
    const o = opts || art._opts || {};
    const key = art.dataset.row;
    const toggle = $('.evrow__toggle', art);
    const more = $('.evrow__more', art);
    if (open) state.evOpen.add(key); else state.evOpen.delete(key);
    toggle.setAttribute('aria-expanded', String(open));
    art.classList.toggle('is-open', open);
    if (open && !more.childNodes.length) fillMore(art, it, o);
    more.hidden = !open;
  }

  function fillMore(art, item, opts = {}) {
    const more = $('.evrow__more', art);
    const e = item.first;
    const isSeries = item.kind === 'series';
    const t = now();
    const ot = otherTz(e);
    const facts = [];
    const st = STATUS[e.status] || null;
    if (!isSeries) {
      facts.push(h('dt', null, '当地时间'), h('dd', null, richText(`${md(e.start, e.tz)} ${WEEKDAYS[dayLabel(e.dayIdx).dow]} ${timeRange(e, e.tz)}`), h('span', { class: 'muted' }, `（${tzName(e.tz)} ${zoneShort(e.start, e.tz)}）`)));
      facts.push(h('dt', null, tzName(ot)), h('dd', { class: 'other-time' }, richText(`${md(e.start, ot)} ${timeRange(e, ot)}`)));
    }
    facts.push(h('dt', null, '费用'), h('dd', null, isSeries && priceShort(item.events) === '见来源' ? '各场费用见来源' : priceText(e)));
    if (e.deadline != null) {
      const dl = h('span', { 'data-rel': 'deadline', 'data-ts': e.deadline, 'data-tz': e.tz });
      paintRel(dl);
      facts.push(h('dt', null, '报名'), h('dd', null, dl));
    }
    if (!isSeries && (e.statusRaw || st)) facts.push(h('dt', null, '状态'), h('dd', null, st ? st.zh : e.statusRaw));
    if (e.series) {
      const sTitle = seriesTitle(e.series);
      facts.push(h('dt', null, '系列'), h('dd', null, richText(e.series.title || e.series.id), e.series.organizer ? ` · 主办 ${e.series.organizer}` : '',
        e.series.sourceUrl && urlKey(e.series.sourceUrl) !== urlKey(e.sourceUrl) ? [' · ', extLink(e.series.sourceUrl, '系列页面')] : null));
      if (!isSeries && sTitle.main !== e.title && e.series.events.length > 1) {
        const others = e.series.events.filter((x) => x.id !== e.id && (state.city === 'BOTH' || x.city === state.city));
        if (others.length) facts.push(h('dt', null, '其他场次'), h('dd', null, others.map((x, i) => [i ? '、' : '', h('a', { class: 'link', href: '#events', 'data-goto-event': x.id }, `${dayShort(x)}${!isUpcoming(x, t) ? '（已结束）' : ''}`)])));
      }
    }
    const parts = [h('dl', { class: 'facts' }, facts)];
    if (isSeries) {
      parts.push(h('ol', { class: 'sesslist' }, item.series.events.filter((x) => state.city === 'BOTH' || !x.city || x.city === state.city).map((x) => {
        const past = !isUpcoming(x, t);
        return h('li', { class: 'sesslist__item' + (past ? ' is-past' : '') + (x.cancelled ? ' is-cancelled' : ''), 'data-session': x.id },
          h('span', { class: 'sesslist__when' }, richText(`${dayShort(x)} ${timeRange(x, x.tz)}`)),
          h('span', { class: 'sesslist__title' }, x.title),
          h('span', { class: 'sesslist__rel' }, past ? '已结束' : x.cancelled ? '已取消' : relSpan(x)),
          !past && !x.cancelled ? icsButton([x], { icon: true }) : null);
      })));
    }
    const live = liveOf(item.events, t);
    parts.push(h('div', { class: 'evrow__actions' },
      e.sourceUrl ? extLink(e.sourceUrl, `来源：${domainOf(e.sourceUrl)}`) : h('span', { class: 'muted' }, '无来源链接'),
      !opts.past && live.length ? icsButton(live, { series: isSeries ? item.series : null, fk: 'evi:' + art.dataset.row }) : null));
    more.replaceChildren(...parts);
  }

  function pastBlock(past) {
    const det = h('details', { class: 'past' }, h('summary', { 'data-fk': 'ev:past' }, icon('chev'), `已结束 (${past.length})`));
    det._past = past;
    det.open = state.pastOpen;
    if (det.open) fillPast(det);
    det.addEventListener('toggle', () => { state.pastOpen = det.open; if (det.open) fillPast(det); });
    return det;
  }
  function fillPast(det) {
    if (det.dataset.filled) return;
    det.dataset.filled = '1';
    const items = buildItems(det._past.slice().sort((a, b) => b.start - a.start));
    det.appendChild(h('div', { class: 'evrows' }, items.map((it) => evRow(it, { past: true }))));
  }

  /** From a link elsewhere (来源 › 用于…): show that event's row, opened and in view. */
  function gotoEvent(id) {
    const e = state.data && state.data.events.find((x) => x.id === id);
    if (!e) return;
    if (e.city && state.city !== 'BOTH' && e.city !== state.city) setCity('BOTH', { render: false });
    const f = state.evFilters;
    if (f.free || f.weekend || f.cats.size) { f.free = false; f.weekend = false; f.cats.clear(); els.views.events.dataset.key = ''; }
    if (state.placeId) { state.placeId = null; selectOnMap(null); }
    setTab('events');
    const view = els.views.events;
    if (!isUpcoming(e)) { const det = $('details.past', view); if (det) { det.open = true; state.pastOpen = true; fillPast(det); } }
    const row = view.querySelector(`.evrow[data-events~="${CSS.escape(id)}"]`);
    if (!row) return;
    setRowOpen(row, true);
    window.requestAnimationFrame(() => {
      scrollToEl(row, { extra: mqDesktop.matches ? 44 : 0, behavior: 'auto' });
      const ses = row.querySelector(`[data-session="${CSS.escape(id)}"]`);
      if (ses) ses.classList.add('is-target');
      const tg = $('.evrow__toggle', row);
      if (tg) tg.focus({ preventScroll: true });
    });
  }

  function partitionKey() {
    const d = state.data;
    if (!d) return '';
    const t = now();
    const up = d.events.filter((e) => isUpcoming(e, t)).length;
    const day = dayIndex(t, refTz());
    // Weekly is enough (week labels); with 本周末 on, the window moves daily.
    return `${up}:${state.evFilters.weekend ? day : mondayOf(day)}`;
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
  function vevent(e, stamp) {
    const lines = ['BEGIN:VEVENT'];
    lines.push(`UID:${icsEscape(e.id)}@twin-city-atlas`);
    lines.push(`SEQUENCE:${Math.max(0, Math.floor(e.sourceVersion || 0))}`);
    lines.push(`DTSTAMP:${stamp}`);
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
      e.note || null,
      e.deadline != null ? `报名截止：${md(e.deadline, e.tz)} ${hm(e.deadline, e.tz)}（${tzName(e.tz)}）` : null,
      e.series ? `系列：${e.series.title}${e.series.organizer ? '（主办 ' + e.series.organizer + '）' : ''}` : null,
      url ? `来源：${url.href}` : null,
      e.verifiedAt != null ? `资料核验于 ${ymd(e.verifiedAt, VERIFY_TZ)}，出发前请以来源为准。` : '出发前请以来源为准。',
    ].filter(Boolean).join('\n');
    lines.push(`DESCRIPTION:${icsEscape(desc)}`);
    const st = STATUS[e.status];
    if (st && st.cancelled) lines.push('STATUS:CANCELLED');
    else if (e.status === 'TENTATIVE') lines.push('STATUS:TENTATIVE');
    else if (e.status === 'SCHEDULED' || e.status === 'CONFIRMED' || e.status === 'OPEN') lines.push('STATUS:CONFIRMED');
    lines.push('END:VEVENT');
    return lines;
  }
  function buildICS(events) {
    const stamp = icsStamp(now());
    const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Twin City Atlas//双城图志//ZH', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH'];
    for (const e of events) lines.push(...vevent(e, stamp));
    lines.push('END:VCALENDAR');
    return lines.map(icsFold).join('\r\n') + '\r\n';
  }
  /** "加入日历" for one event, or "整期加入日历" for a series: one file with one VEVENT per session. */
  function icsButton(events, opts = {}) {
    const many = events.length > 1;
    const name = many && opts.series ? seriesTitle(opts.series).main : events[0].title;
    const text = many ? (opts.compact ? `加入日历（${events.length} 场）` : `整期加入日历（${events.length} 场）`) : '加入日历';
    const b = h('button', {
      type: 'button', class: opts.icon ? 'btn btn--quiet btn--icon' : opts.compact ? 'btn btn--quiet' : 'btn',
      'aria-label': many ? `把“${name}”的 ${events.length} 场一起加入日历（下载一个 .ics 文件）` : `把“${name}”加入日历（下载 .ics 文件）`,
      'data-fk': opts.fk || null,
      title: opts.icon ? '加入日历' : null,
    }, icon('cal'), opts.icon ? null : h('span', null, text));
    b.addEventListener('click', () => {
      const blob = new Blob([buildICS(events)], { type: 'text/calendar;charset=utf-8' });
      const href = URL.createObjectURL(blob);
      const base = many && opts.series ? opts.series.id : events[0].id;
      const a = h('a', { href, download: `${base.replace(/[^A-Za-z0-9._-]+/g, '-') || 'event'}.ics` });
      doc.body.appendChild(a);
      a.click();
      a.remove();
      window.setTimeout(() => URL.revokeObjectURL(href), 5000);
      announce(many ? `已生成包含 ${events.length} 场的日历文件` : '已生成日历文件');
    });
    return b;
  }

  /* ------------------------------------------------------------------ view: sources */

  const SUP = ['', '¹', '²', '³', '⁴', '⁵', '⁶', '⁷', '⁸', '⁹'];
  const sup = (n) => (n < 10 ? SUP[n] : `[${n}]`);

  function renderSources() {
    const view = els.views.sources;
    const d = state.data;
    const input = h('input', { type: 'search', id: 'src-search', value: state.srcQuery, placeholder: '搜索网站、网址、核验说明或地点…', autocomplete: 'off', spellcheck: 'false', 'aria-describedby': 'src-result', 'data-fk': 'src-search' });
    input.value = state.srcQuery;
    let timer = 0;
    input.addEventListener('input', () => { window.clearTimeout(timer); timer = window.setTimeout(() => { state.srcQuery = input.value; updateSources(); }, 140); });
    input.addEventListener('keydown', (e) => { if (e.key === 'Escape' && input.value) { e.preventDefault(); input.value = ''; state.srcQuery = ''; updateSources(); } });
    const mode = (key, label) => {
      const b = h('button', { type: 'button', class: 'seg__btn', 'aria-pressed': String(state.srcMode === key), 'data-fk': 'srcmode:' + key }, label);
      b.addEventListener('click', () => { state.srcMode = key; for (const x of $$('.seg__btn', view)) x.setAttribute('aria-pressed', String(x === b)); updateSources(); });
      return b;
    };
    const legend = h('details', { class: 'licenses' },
      h('summary', null, icon('chev'), `许可与版权说明 · ${d.licenses.length} 种（条目后的上标）`),
      h('ol', { class: 'licenses__list' }, d.licenses.map((l) => h('li', null, h('span', { class: 'licenses__n' }, sup(l.n)), h('span', null, l.text), h('span', { class: 'muted' }, ` · ${l.count} 条`)))));
    const linked = d.sources.filter((s) => s.placeIds.length).length;
    const toolbar = h('div', { class: 'toolbar srctoolbar' },
      h('div', { class: 'search', role: 'search' }, h('label', { class: 'vh', for: 'src-search' }, '搜索来源'), icon('search'), input),
      h('div', { class: 'seg', role: 'group', 'aria-label': '分组方式' }, mode('place', '按地点'), mode('site', '按网站')),
      h('p', { class: 'resultline', id: 'src-result', 'aria-live': 'polite', 'data-srcline': '' }),
      h('p', { class: 'privacy' }, `仅包含公开来源的公共资料，不含任何个人记录。${d.sources.length} 条来源中 ${linked} 条已对应到地点：除链接完全一致外，也按网站、邮编、坐标或名称对应。`));
    view.replaceChildren(h('h2', { class: 'vh' }, '来源'), toolbar, legend, h('div', { class: 'srcgroups', 'data-srclist': '' }), datafileBlock(),
      h('p', { class: 'foot' }, '底图 © OpenStreetMap contributors © CARTO。地图组件 Leaflet（BSD-2-Clause）与 Leaflet.markercluster（MIT）。字体 Barlow、IBM Plex Mono（SIL Open Font License）。'));
    updateSources();
    applyMarkerFilter(null);
  }

  function datafileBlock() {
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
        h('td', null, String(evs.filter((e) => !e.cancelled && isUpcoming(e, t)).length)),
        h('td', null, String(evs.length)));
    });
    return h('details', { class: 'datafile' },
      h('summary', null, icon('chev'), h('span', { class: 'datafile__title' }, '数据文件与应用内容地址'), h('span', { class: 'muted' }, latest ? ` · 最近核验 ${ymd(latest, VERIFY_TZ)}` : '')),
      h('div', { class: 'datafile__body' },
        h('div', null,
          h('span', { class: 'label' }, '应用内容地址（电脑版与安卓版从这里更新）'),
          h('div', { class: 'urlbox' }, urlInput, copyButton(() => PUBLIC_CONTENT_URL, '复制应用内容地址', urlInput))),
        h('p', null, h('a', { class: 'link ext', href: CONTENT_PATH, target: '_blank', rel: 'noopener noreferrer' }, h('span', null, '打开原始 content.json'), icon('ext'), h('span', { class: 'vh' }, '（在新窗口打开）'))),
        h('p', { class: 'note' }, `伦敦攻略层 ${GUIDE_PATH}：${d.guide.ok ? `${d.guide.count} 处新增地点、${d.guide.overlays} 处已有地点的游玩补充` : '未能读取'}。它只供网页版的攻略与规划使用，不在应用内容地址里，电脑版与安卓版的同步格式不受影响。`,
          ' ', h('a', { class: 'link ext', href: GUIDE_PATH, target: '_blank', rel: 'noopener noreferrer' }, h('span', null, '打开 london.json'), icon('ext'))),
        h('dl', { class: 'metagrid' }, meta.map(([k, v]) => h('div', null, h('dt', { lang: 'en' }, k), h('dd', null, v || '未注明')))),
        h('table', { class: 'counts' },
          h('caption', { class: 'vh' }, '各城市条目数'),
          h('thead', null, h('tr', null, h('th', { scope: 'col' }, '城市'), h('th', { scope: 'col' }, '地点'), h('th', { scope: 'col' }, '即将举行'), h('th', { scope: 'col' }, '活动总数'))),
          h('tbody', null, rows)),
        h('dl', { class: 'facts' },
          h('dt', null, '最近核验'), h('dd', null, latest ? [h('span', { class: 'mono' }, ymd(latest, VERIFY_TZ)), '（', h('span', { 'data-rel': 'ago', 'data-ts': latest }, agoText(latest)), '）'] : '未注明'),
          h('dt', null, '两城距离'), h('dd', null, h('span', { class: 'mono' }, `${nf0.format(km)} km`), `（大圆距离，${CITIES.LONDON.ref.label} 至福州${CITIES.FUZHOU.ref.label}）`),
          h('dt', null, '底图'), h('dd', null, '© OpenStreetMap contributors © CARTO'))));
  }

  /** Sources grouped by place (or by site), each group a collapsed <details> filled when opened. */
  function updateSources() {
    const view = els.views.sources;
    const box = $('[data-srclist]', view);
    if (!box) return;
    const d = state.data;
    const qs = terms(state.srcQuery);
    const shown = qs.length ? d.sources.filter((s) => qs.every((t) => s.search.includes(t))) : d.sources;
    const groups = [];
    if (state.srcMode === 'site') {
      const bySite = new Map();
      for (const s of shown) { if (!bySite.has(s.domain)) bySite.set(s.domain, []); bySite.get(s.domain).push(s); }
      for (const [dom, list] of Array.from(bySite.entries()).sort((a, b) => b[1].length - a[1].length || cmp(a[0], b[0]))) {
        groups.push({ key: 'site:' + dom, head: [h('span', { class: 'srcg__name mono' }, dom)], list, city: list[0].city });
      }
    } else {
      const order = state.city === 'FUZHOU' ? ['FUZHOU', 'LONDON'] : CITY_ORDER;
      const byPlace = new Map();
      const loose = [];
      for (const s of shown) {
        const pid = s.placeIds[0];
        if (!pid) { loose.push(s); continue; }
        if (!byPlace.has(pid)) byPlace.set(pid, []);
        byPlace.get(pid).push(s);
      }
      for (const c of order) {
        const places = d.places.filter((p) => p.city === c && byPlace.has(p.id))
          .sort((a, b) => a.group.rank - b.group.rank || a.rank - b.rank);
        if (!places.length) continue;
        groups.push({ cityHead: c, n: places.reduce((m, p) => m + byPlace.get(p.id).length, 0) });
        for (const p of places) {
          const list = byPlace.get(p.id);
          const mainKey = urlKey(p.sourceUrl);
          list.sort((a, b) => (b.key === mainKey) - (a.key === mainKey) || (b.verifiedAt || 0) - (a.verifiedAt || 0));
          groups.push({ key: 'place:' + p.id, head: [glyph(p.cat, true), h('span', { class: 'srcg__name' }, highlight(p.name, qs))], list, city: c, place: p });
        }
      }
      if (loose.length) groups.push({ key: 'loose', head: [h('span', { class: 'srcg__name' }, '未对应到具体地点')], list: loose, city: null, note: '这些来源未能按链接、网站、邮编、坐标或名称对应到某个地点，多为赛事总表或综合页面；其中的活动链接仍可点开。' });
    }
    const line = $('[data-srcline]', view);
    line.replaceChildren(qs.length ? h('b', null, `找到 ${shown.length} 条`) : h('b', null, `${d.sources.length} 条来源`), qs.length ? `（共 ${d.sources.length} 条）` : `，${state.srcMode === 'site' ? '按网站' : '按地点'}分组`);
    const out = [];
    for (const g of groups) {
      if (g.cityHead) { out.push(h('h3', { class: 'srccity', 'data-city': g.cityHead }, cityPlate(g.cityHead, 'sm'), h('span', { class: 'group__count' }, `${g.n} 条`))); continue; }
      const latest = g.list.reduce((m, s) => Math.max(m, s.verifiedAt || 0), 0);
      const det = h('details', { class: 'srcg', 'data-city': g.city || null, 'data-group': g.key },
        h('summary', { 'data-fk': 'srcg:' + g.key }, icon('chev'), g.head,
          h('span', { class: 'srcg__meta' }, `${g.list.length} 条${latest ? ' · ' + ymd(latest, VERIFY_TZ) : ''}`)));
      det._list = g.list;
      det._note = g.note;
      det._qs = qs;
      det.open = qs.length > 0 || state.srcOpen.has(g.key);
      if (det.open) fillSrcGroup(det);
      det.addEventListener('toggle', () => {
        if (det.open) { state.srcOpen.add(g.key); fillSrcGroup(det); } else state.srcOpen.delete(g.key);
      });
      out.push(det);
    }
    if (!out.length) out.push(h('div', { class: 'empty' }, h('p', { class: 'empty__title' }, '没有匹配的来源'), h('p', null, '搜索会查找网站、网址、核验说明和对应的地点、活动名称。')));
    box.replaceChildren(...out);
  }
  function fillSrcGroup(det) {
    if (det.dataset.filled) return;
    det.dataset.filled = '1';
    const t = now();
    append(det, [det._note ? h('p', { class: 'muted srcg__note' }, det._note) : null, h('ol', { class: 'srclist', role: 'list' }, det._list.map((s) => sourceItem(s, t, det._qs)))]);
  }

  function sourceItem(s, t, qs) {
    const d = state.data;
    const expired = s.validUntil != null && s.validUntil < t;
    const placeLinks = s.placeIds.map((id) => d.placeById.get(id)).map((p) => h('a', { href: '#' + p.id, 'data-route': p.id, class: 'link', 'data-fk': `srcp:${s.id}:${p.id}` }, p.name));
    const evs = s.refs.events;
    const sers = s.refs.series;
    const usedBits = [];
    if (evs.length) usedBits.push(`${evs.length} 场活动`);
    if (sers.length) usedBits.push(`${sers.length} 个系列`);
    let used = null;
    if (usedBits.length) {
      const list = h('ul', { class: 'src__used', hidden: true },
        evs.map((e) => h('li', null, h('a', { class: 'link', href: '#events', 'data-goto-event': e.id, 'data-fk': `srce:${s.id}:${e.id}` }, `${dayShort(e)} ${e.title}`))),
        sers.map((x) => h('li', null, `系列：${x.title || x.id}`)));
      const btn = h('button', { type: 'button', class: 'linkbtn', 'aria-expanded': 'false' }, `用于 ${usedBits.join('、')}`, icon('down'));
      btn.addEventListener('click', () => { const open = list.hidden; list.hidden = !open; btn.setAttribute('aria-expanded', String(open)); });
      used = [btn, list];
    }
    return h('li', { class: 'src', 'data-src': s.id },
      h('div', { class: 'src__head' },
        h('span', { class: 'src__domain' }, extLink(s.url, qs && qs.length ? highlight(s.domain, qs) : s.domain)),
        s.verifiedAt != null ? h('span', { class: 'src__date' }, `核验 ${ymd(s.verifiedAt, VERIFY_TZ)}`) : null),
      s.path ? h('p', { class: 'src__path' }, highlight(s.path, qs)) : null,
      s.status ? h('p', { class: 'src__status' }, qs && qs.length ? highlight(s.status, qs) : richText(s.status)) : null,
      h('p', { class: 'src__meta' },
        s.licNo ? h('span', { class: 'src__lic', title: s.license }, `许可${sup(s.licNo)}`) : null,
        s.validUntil != null ? h('span', null, `有效至 ${ymd(s.validUntil, s.tz)} ${hm(s.validUntil, s.tz)}（${tzName(s.tz)}）`, expired ? h('span', { class: 'badge' }, '已过期') : null) : null,
        placeLinks.length ? h('span', { class: 'src__refs' }, '地点：', placeLinks.map((a, i) => [i ? '、' : '', a]), s.how && s.how !== 'url' ? h('span', { class: 'muted' }, `（${HOW_ZH[s.how]}）`) : null) : null),
      used ? h('div', { class: 'src__usedbox' }, used) : null);
  }

  /* ------------------------------------------------------------------ guide: time, status, formatting */

  const TP = () => window.TCAPlanner || null;
  const sunCache = new Map();
  function sunFor(date) {
    let s = sunCache.get(date.key);
    if (!s) { s = TP().sunLocal(date); sunCache.set(date.key, s); }
    return s;
  }
  const londonNow = () => TP().londonParts(now());
  /** Minutes after a local midnight → "09:30"; 24:00 stays 24:00, later times wrap (25:00 → 01:00). */
  function clock(min) {
    const m = Math.round(min);
    if (m === 1440) return '24:00';
    return `${pad(Math.floor(m / 60) % 24)}:${pad(((m % 60) + 60) % 60)}`;
  }
  const clockNext = (min) => (Math.round(min) > 1440 ? '次日 ' : '') + clock(min);
  function durText(min) {
    const m = Math.max(0, Math.round(min));
    if (m < 60) return `${m} 分钟`;
    const hh = Math.floor(m / 60);
    const r = m % 60;
    return r ? `${hh} 小时 ${r} 分` : `${hh} 小时`;
  }
  function pence(p) {
    if (p == null) return '费用不定';
    if (p === 0) return '免费';
    return `£${p % 100 ? (p / 100).toFixed(2) : p / 100}`;
  }
  const INDOOR_ZH = { in: '室内', out: '户外', mixed: '室内外都有' };
  const BEST_ZH = { morning: '上午', midday: '中午', afternoon: '下午', sunset: '日落前后', evening: '傍晚', night: '夜里' };
  const DOW_ZH = ['一', '二', '三', '四', '五', '六', '日'];
  const PACE_ZH = { relaxed: '悠闲', normal: '适中', packed: '紧凑' };
  const dateZh = (dt) => `${dt.mo}月${dt.d}日 周${DOW_ZH[dt.dow]}`;
  function ivText(iv) {
    if (iv == null) return '时间未知';
    if (!iv.length) return '不开放';
    return iv.map(([o, c]) => (o === 0 && c >= 1440 ? '全天' : `${clock(o)}–${clockNext(c)}`)).join('，');
  }
  const placeLabel = (n) => (n.zh ? `${n.zh} ${n.name}` : n.name);

  /** Open / closed right now for a planner node → { text, cls }. */
  function liveStatus(node, t = now()) {
    const P = TP();
    const nowL = P.londonParts(t);
    if (node.dates && nowL.key < node.dates.from) {
      const f = P.parseDateKey(node.dates.from);
      return { text: `${f.mo}月${f.d}日开始`, cls: 'is-later' };
    }
    if (nowL.md === '12-25' && !P.xmasOk(node) && !node.closed.has('12-25')) return { text: '圣诞节多数关门 · 以官网为准', cls: 'is-closed' };
    const st = P.statusAt(node, nowL, sunFor(nowL), sunFor(P.addDays(nowL, -1)));
    if (node.vary) { // the hours are a cautious typical window: never claim more than that
      if (st.state === 'open') return { text: '一般这时开着 · 以官网日历为准', cls: 'is-open' };
      if (st.state === 'slots' && st.nextSlot != null) return { text: `今天一般 ${clock(st.nextSlot)} 开场 · 以官网为准`, cls: 'is-open' };
      if (st.state === 'closed' && st.opensAt != null) return { text: `一般 ${clock(st.opensAt)} 开门 · 以官网日历为准`, cls: 'is-closed' };
      return { text: '时间每天不同 · 查官网日历', cls: 'is-unknown' };
    }
    if (st.state === 'open') {
      if (st.always) return { text: '随时可去', cls: 'is-open' };
      const pastEntry = st.lastEntryAt != null && st.lastEntryAt <= nowL.min;
      if (pastEntry) return { text: `已停止入场 · ${clock(st.closesAt)} 关`, cls: 'is-closing' };
      return { text: `开放中 · 至 ${clock(st.closesAt)}`, cls: st.left <= 60 ? 'is-closing' : 'is-open' };
    }
    if (st.state === 'closed') return { text: st.opensAt != null ? `${clock(st.opensAt)} 开门` : st.closedToday ? '今天不开放' : '今天已关门', cls: 'is-closed' };
    if (st.state === 'slots') {
      if (st.nextSlot != null) return { text: `今天 ${clock(st.nextSlot)} 开场`, cls: 'is-open' };
      return P.slotsOn(node, nowL).length ? { text: '今天的场次已开始', cls: 'is-closed' } : { text: '今天没有场次', cls: 'is-closed' };
    }
    return { text: '开放时间未知', cls: 'is-unknown' };
  }
  function liveEl(p, extra) {
    const el = h('span', { class: 'live', 'data-rel': 'open', 'data-id': p.id, 'data-base': 'live' + (extra ? ' ' + extra : '') });
    paintRel(el);
    return el;
  }
  function paintLive(el) {
    const p = state.data && state.data.placeById.get(el.dataset.id);
    if (!p || !p.node || !TP()) { el.textContent = ''; return; }
    const s = liveStatus(p.node);
    el.textContent = s.text;
    el.className = `${el.dataset.base || 'live'} ${s.cls}`;
  }
  function unverifiedBadge(p) {
    if (!p) return null;
    if (p.unverified) return h('span', { class: 'badge badge--soft', title: '开放时间各来源说法不一或尚未确认（原因见地点页的核验说明）；出发前请查官网' }, '待核实');
    if (p.vary) return h('span', { class: 'badge badge--soft', title: '开放时间每天不同：规划按保守时段估算；出发前请在官网日历查当天时间' }, '时间每天不同');
    return null;
  }

  /* ------------------------------------------------------------------ guide: plan state */

  const START_PRESETS = [
    { key: 'charing-cross', zh: 'Charing Cross · 特拉法加广场', lat: 51.5080, lng: -0.1247 },
    { key: 'covent-garden', zh: 'Covent Garden 站', lat: 51.5129, lng: -0.1243 },
    { key: 'piccadilly', zh: 'Piccadilly Circus 站', lat: 51.5098, lng: -0.1342 },
    { key: 'oxford-circus', zh: 'Oxford Circus 站', lat: 51.5152, lng: -0.1415 },
    { key: 'westminster', zh: 'Westminster 站', lat: 51.5010, lng: -0.1248 },
    { key: 'victoria', zh: 'Victoria 站', lat: 51.4965, lng: -0.1441 },
    { key: 'waterloo', zh: 'Waterloo 站', lat: 51.5031, lng: -0.1132 },
    { key: 'london-bridge', zh: 'London Bridge 站', lat: 51.5049, lng: -0.0863 },
    { key: 'tower-hill', zh: 'Tower Hill 站', lat: 51.5098, lng: -0.0766 },
    { key: 'liverpool-street', zh: 'Liverpool Street 站', lat: 51.5178, lng: -0.0817 },
    { key: 'kings-cross', zh: 'King’s Cross St Pancras 站', lat: 51.5306, lng: -0.1239 },
    { key: 'russell-square', zh: 'Russell Square 站', lat: 51.5231, lng: -0.1244 },
    { key: 'paddington', zh: 'Paddington 站', lat: 51.5154, lng: -0.1755 },
    { key: 'south-kensington', zh: 'South Kensington 站', lat: 51.4941, lng: -0.1738 },
    { key: 'canary-wharf', zh: 'Canary Wharf 站', lat: 51.5035, lng: -0.0187 },
    { key: 'greenwich', zh: 'Cutty Sark（格林威治）DLR 站', lat: 51.4826, lng: -0.0096 },
  ];
  const PLAN_INTERESTS = ['LANDMARK', 'CULTURE', 'VIEW', 'NATURE', 'FOOD', 'NIGHT', 'SHOP', 'STROLL'];
  const TBAR_MIN = 360; // 06:00
  const TBAR_MAX = 1560; // 次日 02:00
  const TBAR_STEP = 15;
  const MIN_SPAN = 60;

  function defaultPlan() {
    return { window: [600, 1080], interests: [], pace: 'normal', freeOnly: false, rainy: false, kids: false, meals: true, events: true, back: false, pins: [], start: 'charing-cross' };
  }
  function loadPlan() {
    const p = defaultPlan();
    let v = null;
    try { v = JSON.parse(store.get(STORE_PLAN) || 'null'); } catch { v = null; }
    if (!v || typeof v !== 'object') return p;
    const w = v.window;
    if (Array.isArray(w) && w.length === 2 && w.every((x) => Number.isFinite(x)) && w[0] >= TBAR_MIN && w[1] <= TBAR_MAX && w[1] - w[0] >= MIN_SPAN) p.window = [w[0], w[1]];
    if (Array.isArray(v.interests)) p.interests = v.interests.filter((k) => PLAN_INTERESTS.includes(k));
    if (PACE_ZH[v.pace]) p.pace = v.pace;
    for (const k of ['freeOnly', 'rainy', 'kids', 'meals', 'events', 'back']) if (typeof v[k] === 'boolean') p[k] = v[k];
    if (Array.isArray(v.pins)) p.pins = v.pins.filter((x) => typeof x === 'string' && TOKEN_RE.test(x)).slice(0, 30);
    if (START_PRESETS.some((x) => x.key === v.start)) p.start = v.start;
    return p;
  }
  function savePlan() {
    const p = state.plan;
    store.set(STORE_PLAN, JSON.stringify({ window: p.window, interests: p.interests, pace: p.pace, freeOnly: p.freeOnly, rainy: p.rainy, kids: p.kids, meals: p.meals, events: p.events, back: p.back, pins: p.pins, start: p.start }));
  }

  function startPoint() {
    const k = state.startKind;
    if (k === 'geo' && state.geo.status === 'ok') return { lat: state.geo.lat, lng: state.geo.lng, label: '你的位置', kind: 'geo' };
    if ((k === 'pick' || k === 'place') && state.startPoint) return state.startPoint;
    const pr = START_PRESETS.find((x) => x.key === state.plan.start) || START_PRESETS[0];
    return { lat: pr.lat, lng: pr.lng, label: pr.zh, kind: 'preset' };
  }
  /** The day being planned: the one picked, else today — or tomorrow once today's window is (nearly) over. */
  function planDate() {
    const P = TP();
    const today = londonNow();
    if (state.planDate) {
      const dt = P.parseDateKey(state.planDate);
      if (dt && dt.key >= today.key) return dt;
      state.planDate = null;
    }
    const d0 = P.dateInfo(today.y, today.mo, today.d, 0);
    return state.plan.window[1] - Math.max(state.plan.window[0], today.min) < 60 ? Object.assign(P.addDays(d0, 1), { auto: true }) : d0;
  }
  function planWeights(withEvents = true) {
    const sel = new Set(state.plan.interests);
    const w = {};
    for (const k of CATEGORY_ORDER) w[k] = PLAN_INTERESTS.includes(k) ? (sel.size ? (sel.has(k) ? 1.6 : 0.35) : 1) : 0;
    if (state.plan.meals && w.FOOD < 1) w.FOOD = 1; // meals need restaurants even when food is not an interest
    w.EVENT = withEvents && state.plan.events ? 1.3 : 0;
    return w;
  }
  /** Dated events from content.json on that London date, as fixed-start planner stops. */
  function eventNodes(date) {
    const P = TP();
    const out = [];
    for (const e of state.data.events) {
      if (e.cancelled || e.city !== 'LONDON' || !e.place || !e.place.hasCoords) continue;
      // courses, chess and school sessions need registration for the whole series: not something to drop into
      if (['COURSE', 'CHESS', 'SCHOOL'].includes(e.place.category) || /须整期报名/.test(e.title)) continue;
      const st = P.londonParts(e.start);
      if (st.key !== date.key) continue;
      const dur = Math.max(30, Math.min(120, Math.round((e.end - e.start) / 60000) || 90));
      const n = P.compilePlace({ id: 'ev-' + e.id, name: e.title, category: e.place.category, lat: e.place.lat, lng: e.place.lng },
        { slots: `${P.DAY_CODES[date.dow]} ${clock(st.min)}`, visitMin: dur, score: 4, price: e.priceMinor, indoor: 'in', tags: [], best: [], dates: { from: date.key, to: date.key } });
      n.event = e;
      n.place = e.place;
      out.push(n);
    }
    return out;
  }

  function computePlan(fast) {
    const P = TP();
    const date = planDate();
    const sun = sunFor(date);
    let [a, b] = state.plan.window;
    const nowL = londonNow();
    let shifted = false;
    if (date.key === nowL.key && a < nowL.min + 5) { a = Math.ceil((nowL.min + 5) / 5) * 5; shifted = true; }
    const start = startPoint();
    const base = { date, sun, window: [a, b], asked: state.plan.window.slice(), shifted, start, stops: [], fast };
    if (b - a < 30) return Object.assign(base, { empty: b <= a ? 'past' : 'short' });
    const t0 = window.performance ? performance.now() : 0;
    const res = P.plan({
      nodes: state.data.nodes, extra: eventNodes(date), date, sun, window: [a, b], start, end: state.plan.back ? start : null,
      weights: planWeights(), pace: state.plan.pace, freeOnly: state.plan.freeOnly, rainy: state.plan.rainy, kids: state.plan.kids,
      meals: state.plan.meals, pinned: new Set(state.plan.pins), excluded: state.excluded,
      seed: P.hashStr(`${date.key}|${start.lat.toFixed(3)},${start.lng.toFixed(3)}`), iterations: fast ? 0 : 14, maxCandidates: fast ? 50 : 80,
    });
    res.ms = window.performance ? performance.now() - t0 : 0;
    return Object.assign(base, res);
  }
  let planRaf = 0;
  let planTimer = 0;
  /** Re-plan: fast (no local search) while a handle is being dragged, full once it is let go. */
  function schedulePlan(fast, opts = {}) {
    if (opts.fit) state.fitRoute = true;
    window.cancelAnimationFrame(planRaf);
    window.clearTimeout(planTimer);
    const run = () => {
      if (state.tab !== 'guide' || !state.data || !TP()) return;
      state.planRes = computePlan(fast);
      paintPlan();
    };
    if (fast) planRaf = window.requestAnimationFrame(run);
    else planTimer = window.setTimeout(run, 30);
  }

  function togglePin(id) {
    const pins = state.plan.pins;
    const i = pins.indexOf(id);
    if (i >= 0) pins.splice(i, 1); else { pins.push(id); state.excluded.delete(id); }
    savePlan();
    const p = state.data.placeById.get(id);
    announce(i >= 0 ? `已从必去中移除 ${p ? p.name : ''}` : `已加入必去：${p ? p.name : ''}`);
    for (const b of $$(`[data-pin="${CSS.escape(id)}"]`)) paintPinBtn(b);
    if (state.tab === 'guide') { paintPins(); schedulePlan(false, { fit: true }); }
  }
  function pinButton(p, opts = {}) {
    const b = h('button', { type: 'button', class: opts.small ? 'btn btn--quiet btn--icon pinbtn' : 'btn pinbtn', 'data-pin': p.id, 'data-fk': (opts.fk || 'pin:') + p.id });
    b.addEventListener('click', () => togglePin(p.id));
    paintPinBtn(b, opts.small);
    return b;
  }
  function paintPinBtn(b, small = b.classList.contains('btn--icon')) {
    const id = b.dataset.pin;
    const on = state.plan.pins.includes(id);
    const p = state.data && state.data.placeById.get(id);
    b.setAttribute('aria-pressed', String(on));
    b.setAttribute('aria-label', `${on ? '从必去中移除' : '加入必去'}：${p ? p.name : id}`);
    b.title = on ? '已在必去清单（点击移除）' : '加入必去清单，规划时一定排进去';
    b.replaceChildren(...[icon(on ? 'star-on' : 'star'), small ? null : h('span', null, on ? '已加入必去' : '加入必去')].filter(Boolean));
  }
  function planFrom(p) {
    state.startKind = 'place';
    state.startPoint = { lat: p.lat, lng: p.lng, label: p.zh || p.name, kind: 'place', placeId: p.id };
    state.placeId = null;
    selectOnMap(null);
    state.fitRoute = true;
    setTab('guide');
    scrollPanelTop();
  }

  /* ------------------------------------------------------------------ guide: location */

  function locate() {
    if (!('geolocation' in navigator)) {
      state.geo = { status: 'error', msg: '这个浏览器不支持定位。' };
      paintStart();
      return;
    }
    state.geo = { status: 'asking' };
    paintStart();
    navigator.geolocation.getCurrentPosition((pos) => {
      const lat = pos.coords.latitude;
      const lng = pos.coords.longitude;
      const km = haversineKm(CITIES.LONDON.ref, { lat, lng });
      if (km > 60) {
        state.geo = { status: 'far', lat, lng, acc: pos.coords.accuracy, km };
        if (state.startKind === 'geo') state.startKind = 'preset';
        announce(`你现在距伦敦市中心约 ${nf0.format(km)} km，已改用常用出发点`);
      } else {
        state.geo = { status: 'ok', lat, lng, acc: pos.coords.accuracy, km, at: now() };
        state.startKind = 'geo';
        announce(`已定位，精度约 ${nf0.format(pos.coords.accuracy)} 米`);
      }
      guideChanged({ fit: true });
    }, (err) => {
      state.geo = { status: err && err.code === 1 ? 'denied' : 'error', msg: err && err.code === 3 ? '定位超时。' : '' };
      if (state.startKind === 'geo') state.startKind = 'preset';
      paintStart();
      announce(state.geo.status === 'denied' ? '定位被拒绝' : '定位失败');
    }, { enableHighAccuracy: true, timeout: 15000, maximumAge: 60000 });
  }
  function onMapPick(e) {
    const m = maps.LONDON;
    state.picking = false;
    if (m) m.el.classList.remove('is-picking');
    state.startKind = 'pick';
    state.startPoint = { lat: e.latlng.lat, lng: e.latlng.lng, label: '地图选点', kind: 'pick' };
    announce('已把地图上选的点设为出发点');
    guideChanged({ fit: false });
  }
  function togglePicking() {
    const m = maps.LONDON;
    if (!m) return;
    state.picking = !state.picking;
    m.el.classList.toggle('is-picking', state.picking);
    m.map.off('click', onMapPick);
    if (state.picking) {
      m.map.once('click', onMapPick);
      if (!mqDesktop.matches) { setMapMin(false); window.scrollTo({ top: 0, behavior: smooth() }); }
      announce('在伦敦地图上点一下，设为出发点。按 Esc 取消');
    }
    paintStart();
  }
  /** Start point, date or preferences changed: refresh everything that depends on them. */
  function guideChanged(opts = {}) {
    if (state.tab !== 'guide') return;
    paintStart();
    paintNear();
    schedulePlan(false, opts);
  }

  /* ------------------------------------------------------------------ guide: view */

  function renderGuide() {
    const view = els.views.guide;
    const d = state.data;
    const parts = [h('h2', { class: 'vh' }, '伦敦攻略：附近推荐与行程规划')];
    if (!TP()) {
      parts.push(h('div', { class: 'empty' }, h('p', { class: 'empty__title' }, '规划组件未能加载'), h('p', null, 'assets/planner.js 没有加载成功，请刷新页面重试。地点、活动和来源仍可使用。')));
      view.replaceChildren(...parts);
      return;
    }
    if (state.city === 'FUZHOU') {
      const b = h('button', { type: 'button', class: 'btn', 'data-fk': 'guide:to-london' }, '切换到伦敦');
      b.addEventListener('click', () => { setCity('LONDON'); refocus('guide:locate'); });
      parts.push(h('div', { class: 'empty' }, h('p', { class: 'empty__title' }, '攻略目前只覆盖伦敦'), h('p', null, '附近推荐和时间条规划用的是伦敦地点的开放时间、游玩时长和交通估算。福州的地点仍可在“地点”里查看。'), h('div', { class: 'empty__actions' }, b)));
      view.replaceChildren(...parts);
      return;
    }
    if (!d.guide.ok) {
      parts.push(h('p', { class: 'notice-inline' }, `攻略资料 ${GUIDE_PATH} 未能读取（${d.guide.error ? d.guide.error.message : '无数据'}）。下面只能用 content.json 里的地点。`));
    }
    parts.push(guideHead(), startSection(), nearSection(), planSection());
    if (d.guide.routes.length) parts.push(routesSection());
    if (d.guide.tips.length) parts.push(tipsSection());
    parts.push(h('p', { class: 'foot' },
      `攻略层 ${GUIDE_PATH}：${d.guide.count} 处新增地点，另为 ${d.guide.overlays} 处已有地点补充了开放时间与游玩建议${d.guide.updated ? `，整理于 ${d.guide.updated}` : ''}。`,
      '路上时间按直线距离估算（步行约 4.6 km/h；较远时按地铁/公交门到门），只作安排参考；开放时间与票价以各地点来源页为准。定位只在本页内使用，不上传、不保存。'));
    view.replaceChildren(...parts);
    paintGuideClock();
    paintStart();
    paintNear();
    paintBar();
    paintPins();
    schedulePlan(false, { fit: true });
  }

  function guideHead() {
    return h('header', { class: 'ghead' },
      h('p', { class: 'ghead__kicker' }, cityPlate('LONDON', 'sm'), h('span', null, '伦敦攻略')),
      h('p', { class: 'ghead__line', 'data-guide-clock': '' }));
  }
  function paintGuideClock() {
    const el = $('[data-guide-clock]');
    if (!el || !TP()) return;
    const n = londonNow();
    const sun = sunFor(n);
    el.replaceChildren(
      h('span', null, '伦敦现在 ', h('b', { class: 'mono' }, clock(n.min)), ` · ${dateZh(n)}`),
      h('span', null, '日出 ', h('span', { class: 'mono' }, clock(sun.rise)), ' · 日落 ', h('span', { class: 'mono' }, clock(sun.set))),
      h('span', null, `${state.data.nodes.filter((x) => x.plan).length} 处可规划`));
  }

  /* start point */
  function startSection() {
    const locBtn = h('button', { type: 'button', class: 'btn', 'data-fk': 'guide:locate', 'data-locate': '' }, icon('locate'), h('span', null, '用我的位置'));
    locBtn.addEventListener('click', () => locate());
    const pickBtn = h('button', { type: 'button', class: 'btn', 'data-fk': 'guide:pick', 'data-pick': '', 'aria-pressed': 'false' }, icon('pin'), h('span', null, '在地图上点选'));
    pickBtn.addEventListener('click', () => togglePicking());
    if (state.mapsOff) pickBtn.hidden = true;
    const sel = h('select', { class: 'select', 'data-fk': 'guide:preset', 'aria-label': '常用出发点' },
      h('option', { value: '' }, '常用出发点…'),
      START_PRESETS.map((x) => h('option', { value: x.key }, x.zh)));
    sel.addEventListener('change', () => {
      if (!sel.value) return;
      state.plan.start = sel.value;
      state.startKind = 'preset';
      savePlan();
      guideChanged({ fit: true });
    });
    return h('section', { class: 'gsec', 'aria-labelledby': 'g-start' },
      h('h3', { class: 'gsec__title', id: 'g-start' }, '出发点'),
      h('div', { class: 'startrow' }, locBtn, pickBtn, sel),
      h('p', { class: 'startstatus', 'data-startstatus': '', role: 'status' }));
  }
  function paintStart() {
    const el = $('[data-startstatus]');
    if (!el) return;
    const g = state.geo;
    const st = startPoint();
    const parts = [];
    const pick = $('[data-pick]');
    if (pick) {
      pick.setAttribute('aria-pressed', String(!!state.picking));
      pick.querySelector('span').textContent = state.picking ? '取消点选' : '在地图上点选';
    }
    const loc = $('[data-locate]');
    if (loc) {
      loc.setAttribute('aria-pressed', String(st.kind === 'geo'));
      loc.querySelector('span').textContent = g.status === 'asking' ? '正在定位…' : st.kind === 'geo' ? '重新定位' : '用我的位置';
      loc.disabled = g.status === 'asking';
    }
    const sel = $('select[data-fk="guide:preset"]');
    if (sel) sel.value = st.kind === 'preset' ? state.plan.start : '';
    if (state.picking) parts.push(h('b', null, '在伦敦地图上点一下作为出发点。'));
    if (st.kind === 'geo') {
      parts.push(h('span', { class: 'startstatus__main' }, icon('locate'), `从你的位置出发（精度约 ±${nf0.format(g.acc)} m，距 Charing Cross ${fmtKm(g.km)} km）`));
    } else {
      parts.push(h('span', { class: 'startstatus__main' }, icon('pin'), st.kind === 'pick' ? `从地图选点出发（${fmtCoord(st.lat, st.lng, 4)}）` : `从 ${st.label} 出发`));
      if (g.status === 'denied') parts.push(h('span', { class: 'startstatus__warn' }, '定位权限被拒绝：可在浏览器的网站设置里允许定位，或继续用常用出发点、地图选点。'));
      else if (g.status === 'far') parts.push(h('span', { class: 'startstatus__warn' }, `你现在距伦敦市中心约 ${nf0.format(g.km)} km，不在伦敦，所以先用常用出发点；到了伦敦再点“用我的位置”。`));
      else if (g.status === 'error') parts.push(h('span', { class: 'startstatus__warn' }, `${g.msg || ''}暂时无法定位，可改用常用出发点或地图选点。`));
    }
    el.replaceChildren(...parts);
  }

  /* near me, now */
  function nearSection() {
    return h('section', { class: 'gsec', 'aria-labelledby': 'g-near' },
      h('h3', { class: 'gsec__title', id: 'g-near' }, '此刻 · 附近能去', h('span', { class: 'gsec__meta', 'data-near-meta': '' })),
      h('div', { 'data-near': '' }));
  }
  const REASON_ZH = { free: '免费', closing: '快关门了，抓紧', meal: '正是饭点', best: '这个时段最合适' };
  function paintNear() {
    const box = $('[data-near]');
    if (!box || !TP()) return;
    const P = TP();
    const nowL = londonNow();
    const sun = sunFor(nowL);
    const here = startPoint();
    const list = P.suggest({ nodes: state.data.nodes, now: nowL, here, sun, weights: planWeights(false), rainy: state.plan.rainy, excluded: state.excluded, maxMin: 40 });
    const meta = $('[data-near-meta]');
    if (meta) meta.textContent = `${clock(nowL.min)} · ${here.kind === 'geo' ? '你的位置' : here.label} · 40 分钟内`;
    if (!list.length) {
      box.replaceChildren(h('p', { class: 'muted nearempty' }, nowL.min >= 22 * 60 || nowL.min < 7 * 60
        ? '这个时间附近没有还开着的推荐地点。可以在下面拖动时间条，规划明天。'
        : '附近 40 分钟路程内，现在没有开放中的推荐地点。换个出发点，或在下面规划稍后的行程。'));
      return;
    }
    const top = list.slice(0, 3);
    const more = list.slice(3, 6);
    const rest = list.slice(6).filter((x) => x.travel.mode === 'walk' && x.travel.min <= 15).sort((a, b) => a.travel.min - b.travel.min).slice(0, 10);
    const wasOpen = !!$('details.nearmore[open]', box);
    const parts = [h('ol', { class: 'ncards' }, top.map((x) => h('li', null, nearCard(x, sun))))];
    if (more.length || rest.length) {
      parts.push(h('details', { class: 'nearmore', open: wasOpen },
        h('summary', { 'data-fk': 'guide:nearmore' }, icon('chev'), `再看 ${more.length + rest.length} 处${rest.length ? `（含步行 15 分钟内还开着的 ${rest.length} 处）` : ''}`),
        more.length ? h('ol', { class: 'ncards', start: '4' }, more.map((x) => h('li', null, nearCard(x, sun)))) : null,
        rest.length ? h('ul', { class: 'nearlist' }, rest.map((x) => h('li', null,
          h('a', { class: 'nearlist__name', href: '#' + x.node.id, 'data-route': x.node.id }, glyph(catInfo(x.node.category), true), h('span', null, placeLabel(x.node))),
          h('span', { class: 'nearlist__how mono' }, `${x.travel.min} 分`),
          liveEl(x.node.place, 'nearlist__live')))) : null));
    }
    box.replaceChildren(...parts);
  }
  function legText(lg) {
    return lg.mode === 'walk' ? `步行 ${lg.min} 分钟 · ${lg.km < 1 ? nf0.format(lg.km * 1000) + ' m' : lg.km.toFixed(1) + ' km'}` : `地铁/公交 约 ${lg.min} 分钟`;
  }
  function navUrl(a, b, mode) {
    return `https://www.google.com/maps/dir/?api=1&origin=${a.lat.toFixed(6)},${a.lng.toFixed(6)}&destination=${b.lat.toFixed(6)},${b.lng.toFixed(6)}&travelmode=${mode === 'walk' ? 'walking' : 'transit'}`;
  }
  function nearCard(x, sun) {
    const n = x.node;
    const p = n.place;
    const why = [];
    if (x.reasons.includes('sunset')) why.push(`日落 ${clock(sun.set)}，现在去正好`);
    if (x.kind === 'soon') why.push(`${clock(x.status.opensAt)} 开门`);
    if (x.kind === 'slot') why.push(`${clock(x.status.nextSlot)} 开场`);
    for (const r of x.reasons) if (REASON_ZH[r]) why.push(REASON_ZH[r]);
    if (n.score >= 5) why.unshift('必看');
    const g = p.g || {};
    const card = h('article', { class: 'ncard', 'data-id': p.id },
      h('a', { class: 'ncard__name', href: '#' + p.id, 'data-route': p.id, 'data-fk': 'near:' + p.id }, glyph(p.cat, true), h('span', null, p.zh || p.name), p.zh ? h('small', { lang: 'en' }, p.name) : null),
      h('p', { class: 'ncard__how' }, h('span', { class: 'ncard__leg' }, legText(x.travel)), liveEl(p, 'ncard__live'), unverifiedBadge(p)),
      why.length ? h('p', { class: 'ncard__why' }, why.map((w) => h('span', { class: 'why' }, w))) : null,
      g.summary ? h('p', { class: 'ncard__sum' }, g.summary) : null,
      h('p', { class: 'ncard__act' }, pinButton(p, { small: true, fk: 'npin:' }), extLink(navUrl(startPoint(), n, x.travel.mode), '导航', 'link ext ncard__nav')));
    card.addEventListener('pointerenter', () => setHot(p.id, true));
    card.addEventListener('pointerleave', () => setHot(p.id, false));
    return card;
  }

  /* planner: controls */
  function planSection() {
    return h('section', { class: 'gsec planner', 'aria-labelledby': 'g-plan' },
      h('h3', { class: 'gsec__title', id: 'g-plan' }, '拖动时间条 · 智能规划'),
      dayChips(), timeBar(), presetChips(), prefControls(),
      h('div', { class: 'pins', 'data-pins': '' }),
      h('div', { class: 'planout', 'data-planout': '', 'aria-live': 'polite' }));
  }
  function dayChips() {
    const P = TP();
    const today = londonNow();
    const cur = planDate();
    const chips = [];
    for (let i = 0; i < 7; i += 1) {
      const dt = P.addDays(P.dateInfo(today.y, today.mo, today.d, 0), i);
      const label = i === 0 ? '今天' : i === 1 ? '明天' : `周${DOW_ZH[dt.dow]}`;
      // (the pressed state follows planDate(), which may already have moved to tomorrow)
      const b = h('button', { type: 'button', class: 'chip daychip', 'aria-pressed': String(cur.key === dt.key), 'data-fk': 'day:' + i, 'data-day': dt.key, 'aria-label': `${label} ${dt.mo}月${dt.d}日` },
        h('span', null, label), h('span', { class: 'num' }, `${dt.mo}/${dt.d}`));
      b.addEventListener('click', () => setPlanDate(dt.key));
      chips.push(b);
    }
    const input = h('input', { type: 'date', class: 'dateinput', min: today.key, value: cur.key, 'aria-label': '选择其他日期', 'data-fk': 'day:input' });
    input.addEventListener('change', () => { if (TP().parseDateKey(input.value)) setPlanDate(input.value); });
    return h('div', { class: 'daychips', role: 'group', 'aria-label': '哪一天' }, chips, input);
  }
  function setPlanDate(key) {
    state.planDate = key;
    const cur = planDate();
    for (const b of $$('[data-day]')) b.setAttribute('aria-pressed', String(b.dataset.day === cur.key));
    const input = $('.dateinput');
    if (input) input.value = cur.key;
    paintBar();
    schedulePlan(false, { fit: true });
  }

  function timeBar() {
    const [a, b] = state.plan.window;
    const mk = (which, val) => h('input', { type: 'range', min: TBAR_MIN, max: TBAR_MAX, step: TBAR_STEP, value: val, class: 'tbar__input tbar__input--' + which, 'aria-label': which === 'a' ? '开始时间' : '结束时间', 'data-fk': 'tbar:' + which, 'data-tbar': which });
    const ia = mk('a', a);
    const ib = mk('b', b);
    const clamp = (which) => {
      let va = Number(ia.value);
      let vb = Number(ib.value);
      if (which === 'a' && va > vb - MIN_SPAN) { if (vb + (va - (vb - MIN_SPAN)) <= TBAR_MAX && va + MIN_SPAN <= TBAR_MAX) vb = va + MIN_SPAN; else va = vb - MIN_SPAN; }
      if (which === 'b' && vb < va + MIN_SPAN) { if (vb - MIN_SPAN >= TBAR_MIN) va = vb - MIN_SPAN; else vb = va + MIN_SPAN; }
      ia.value = va;
      ib.value = vb;
      state.plan.window = [Number(ia.value), Number(ib.value)];
    };
    for (const [el, which] of [[ia, 'a'], [ib, 'b']]) {
      el.addEventListener('input', () => { clamp(which); paintBar(); schedulePlan(true); });
      el.addEventListener('change', () => { clamp(which); paintBar(); savePlan(); schedulePlan(false, { fit: true }); });
    }
    const band = h('div', { class: 'tbar__band', 'data-band': '', title: '拖动整段时间', 'aria-hidden': 'true' });
    // The inner box is inset by half a handle, so 0–100% there matches where the native handles' centres can go.
    const track = h('div', { class: 'tbar__track', 'data-track': '' },
      h('div', { class: 'tbar__inner' },
        h('div', { class: 'tbar__night tbar__night--am', 'data-night': 'am', title: '日出前' }),
        h('div', { class: 'tbar__night tbar__night--pm', 'data-night': 'pm', title: '日落后' }),
        h('div', { class: 'tbar__now', 'data-tnow': '', hidden: true, title: '现在' }),
        band),
      ia, ib);
    // Drag the band between the handles to slide the whole window.
    band.addEventListener('pointerdown', (ev) => {
      ev.preventDefault();
      band.setPointerCapture(ev.pointerId);
      const x0 = ev.clientX;
      const w0 = state.plan.window.slice();
      const width = Math.max(1, (track.getBoundingClientRect().width || 1) - 22);
      band.classList.add('is-drag');
      const move = (e) => {
        let dm = Math.round((((e.clientX - x0) / width) * (TBAR_MAX - TBAR_MIN)) / TBAR_STEP) * TBAR_STEP;
        dm = Math.max(TBAR_MIN - w0[0], Math.min(TBAR_MAX - w0[1], dm));
        const next = [w0[0] + dm, w0[1] + dm];
        if (next[0] === state.plan.window[0]) return;
        state.plan.window = next;
        ia.value = next[0];
        ib.value = next[1];
        paintBar();
        schedulePlan(true);
      };
      const up = () => {
        band.classList.remove('is-drag');
        band.removeEventListener('pointermove', move);
        band.removeEventListener('pointerup', up);
        band.removeEventListener('pointercancel', up);
        savePlan();
        schedulePlan(false, { fit: true });
      };
      band.addEventListener('pointermove', move);
      band.addEventListener('pointerup', up);
      band.addEventListener('pointercancel', up);
    });
    const ticks = [];
    for (let m = TBAR_MIN; m <= TBAR_MAX; m += 120) ticks.push(h('span', { class: 'tbar__tick', style: `left:${((m - TBAR_MIN) / (TBAR_MAX - TBAR_MIN)) * 100}%` }, pad(Math.floor(m / 60) % 24)));
    return h('div', { class: 'tbar', 'data-tbarbox': '' },
      h('p', { class: 'tbar__readout', 'data-readout': '' }),
      track,
      h('div', { class: 'tbar__ticks', 'aria-hidden': 'true' }, ticks),
      h('div', { class: 'tbar__plan', 'data-tbar-plan': '', 'aria-hidden': 'true' }));
  }
  const tpos = (m) => `${(Math.max(0, Math.min(TBAR_MAX - TBAR_MIN, m - TBAR_MIN)) / (TBAR_MAX - TBAR_MIN)) * 100}%`;
  function paintBar() {
    const box = $('[data-tbarbox]');
    if (!box) return;
    const [a, b] = state.plan.window;
    const date = planDate();
    for (const el of $$('[data-day]')) el.setAttribute('aria-pressed', String(el.dataset.day === date.key));
    const di = $('.dateinput');
    if (di && di.value !== date.key && doc.activeElement !== di) di.value = date.key;
    const sun = sunFor(date);
    const track = $('[data-track]', box);
    track.style.setProperty('--a', tpos(a));
    track.style.setProperty('--b', tpos(b));
    $('[data-night="am"]', box).style.width = tpos(sun.rise);
    $('[data-night="pm"]', box).style.left = tpos(sun.set);
    const nowL = londonNow();
    const tn = $('[data-tnow]', box);
    tn.hidden = date.key !== nowL.key || nowL.min < TBAR_MIN;
    tn.style.left = tpos(nowL.min);
    for (const el of $$('[data-tbar]', box)) el.setAttribute('aria-valuetext', clockNext(Number(el.value)));
    const ro = $('[data-readout]', box);
    ro.replaceChildren(
      h('span', { class: 'tbar__day' }, `${date.key === nowL.key ? '今天 ' : ''}${dateZh(date)}`),
      h('span', { class: 'tbar__range' }, h('b', { class: 'mono' }, clock(a)), ' → ', h('b', { class: 'mono' }, clockNext(b))),
      h('span', { class: 'tbar__len' }, durText(b - a)),
      h('span', { class: 'tbar__sun' }, `日落 ${clock(sun.set)}`));
  }
  function presetChips() {
    const presets = [
      ['now3', '从现在起 3 小时'], ['am', '上午', [570, 780]], ['pm', '下午', [780, 1080]], ['day', '全天', [570, 1260]], ['eve', '晚上', [1050, 1410]],
    ];
    const chips = presets.map(([key, label, w]) => {
      const b = h('button', { type: 'button', class: 'chip', 'data-fk': 'tp:' + key }, label);
      b.addEventListener('click', () => {
        let win = w;
        if (key === 'now3') {
          const n = londonNow();
          state.planDate = n.key;
          const s = Math.min(TBAR_MAX - 180, Math.max(TBAR_MIN, Math.ceil((n.min + 5) / 15) * 15));
          win = [s, Math.min(TBAR_MAX, s + 180)];
        }
        state.plan.window = win.slice();
        for (const el of $$('[data-tbar]')) el.value = el.dataset.tbar === 'a' ? win[0] : win[1];
        savePlan();
        paintBar();
        schedulePlan(false, { fit: true });
      });
      return b;
    });
    return h('div', { class: 'chips tpresets', role: 'group', 'aria-label': '常用时段' }, chips);
  }
  function prefControls() {
    const p = state.plan;
    const interest = PLAN_INTERESTS.map((k) => {
      const cat = catInfo(k);
      const b = h('button', { type: 'button', class: 'chip', 'aria-pressed': String(p.interests.includes(k)), 'data-fk': 'int:' + k }, glyph(cat, true), h('span', null, cat.zh));
      b.addEventListener('click', () => {
        const i = p.interests.indexOf(k);
        if (i >= 0) p.interests.splice(i, 1); else p.interests.push(k);
        b.setAttribute('aria-pressed', String(i < 0));
        savePlan();
        paintNear();
        schedulePlan(false, { fit: true });
      });
      return b;
    });
    const seg = h('div', { class: 'seg', role: 'group', 'aria-label': '节奏' }, Object.entries(PACE_ZH).map(([k, label]) => {
      const b = h('button', { type: 'button', class: 'seg__btn', 'aria-pressed': String(p.pace === k), 'data-fk': 'pace:' + k }, label);
      b.addEventListener('click', () => {
        p.pace = k;
        for (const x of $$('[data-fk^="pace:"]')) x.setAttribute('aria-pressed', String(x === b));
        savePlan();
        schedulePlan(false, { fit: true });
      });
      return b;
    }));
    const toggles = [['meals', '安排午饭和晚饭'], ['events', '排入当天活动'], ['freeOnly', '只去免费的'], ['rainy', '下雨 · 室内优先'], ['kids', '带孩子'], ['back', '最后回到出发点']].map(([k, label]) => {
      const b = h('button', { type: 'button', class: 'chip chip--toggle', 'aria-pressed': String(!!p[k]), 'data-fk': 'opt:' + k }, label);
      b.addEventListener('click', () => {
        p[k] = !p[k];
        b.setAttribute('aria-pressed', String(p[k]));
        savePlan();
        if (k === 'rainy') paintNear();
        schedulePlan(false, { fit: true });
      });
      return b;
    });
    return h('div', { class: 'prefs' },
      h('div', { class: 'prefs__row' }, h('span', { class: 'prefs__label' }, '想看'), h('div', { class: 'chips', role: 'group', 'aria-label': '兴趣（可多选，不选为均衡）' }, interest)),
      h('div', { class: 'prefs__row' }, h('span', { class: 'prefs__label' }, '节奏'), seg),
      h('div', { class: 'prefs__row' }, h('span', { class: 'prefs__label' }, '选项'), h('div', { class: 'chips', role: 'group', 'aria-label': '规划选项' }, toggles)));
  }
  function paintPins() {
    const box = $('[data-pins]');
    if (!box) return;
    const d = state.data;
    const pins = state.plan.pins.map((id) => d.placeById.get(id)).filter(Boolean);
    const parts = [];
    if (pins.length) {
      const clear = h('button', { type: 'button', class: 'linkbtn', 'data-fk': 'pins:clear' }, '清空');
      clear.addEventListener('click', () => { state.plan.pins = []; savePlan(); for (const b of $$('[data-pin]')) paintPinBtn(b); paintPins(); schedulePlan(false, { fit: true }); });
      parts.push(h('p', { class: 'pins__line' }, h('span', { class: 'prefs__label' }, `必去 ${pins.length}`),
        pins.map((p) => {
          const x = h('button', { type: 'button', class: 'pinchip', 'aria-label': `从必去中移除 ${p.name}`, 'data-fk': 'pinx:' + p.id }, glyph(p.cat, true), h('span', null, p.zh || p.name), icon('x'));
          x.addEventListener('click', () => togglePin(p.id));
          return x;
        }), clear));
    }
    if (state.excluded.size) {
      const undo = h('button', { type: 'button', class: 'linkbtn', 'data-fk': 'ex:undo' }, '全部恢复');
      undo.addEventListener('click', () => { state.excluded.clear(); paintPins(); paintNear(); schedulePlan(false); });
      parts.push(h('p', { class: 'pins__line muted' }, `已排除 ${state.excluded.size} 处（“换一个”）`, undo));
    }
    if (!pins.length && !state.excluded.size) parts.push(h('p', { class: 'pins__hint muted' }, '在地点页点“加入必去”，规划时会优先排进去；不想去的可以在行程里点“换一个”。'));
    box.replaceChildren(...parts);
  }

  /* planner: result */
  function stopReasons(s, res) {
    const n = s.node;
    const out = [];
    if (s.pinned) out.push('必去');
    if (s.meal === 'lunch') out.push('午饭');
    if (s.meal === 'dinner') out.push('晚饭');
    if (n.event) out.push('当天活动');
    if (s.slot != null) out.push(`${clock(s.slot)} 开场`);
    const mid = (s.start + s.end) / 2;
    if (n.best.has('sunset') && mid >= res.sun.set - 60 && mid <= res.sun.set + 20) out.push('赶上日落');
    if (!s.pinned && n.score >= 5) out.push('必看');
    if (n.price === 0 && !n.spend && n.category !== 'SHOP') out.push('免费'); // shops are free to walk into anyway
    if (state.plan.rainy && n.indoor === 'in') out.push('室内');
    if (state.plan.kids && n.tags.has('kids')) out.push('适合孩子');
    if (s.slot != null) out.push(`提前 ${s.slot - s.start} 分钟到场`);
    else if (s.wait >= 5) out.push(`等 ${s.wait} 分钟开门`);
    return out;
  }
  function paintPlan() {
    const res = state.planRes;
    const out = $('[data-planout]');
    const strip = $('[data-tbar-plan]');
    if (!out || !res) return;
    paintBar();
    const span = TBAR_MAX - TBAR_MIN;
    const P = TP();
    // blocks on the time bar
    if (strip) {
      const blocks = [];
      let prevEnd = res.window[0];
      res.stops.forEach((s, i) => {
        const travelStart = s.arrive - s.leg.min;
        blocks.push(h('span', { class: 'tbar__leg', style: `left:${tpos(Math.max(prevEnd, travelStart))};width:${((s.arrive - Math.max(prevEnd, travelStart)) / span) * 100}%` }));
        blocks.push(h('span', { class: 'tbar__blk', 'data-cat': s.node.category, style: `left:${tpos(s.start)};width:${((s.end - s.start) / span) * 100}%`, title: `${clockNext(s.start)}–${clockNext(s.end)} ${placeLabel(s.node)}` }, String(i + 1)));
        prevEnd = s.end;
      });
      if (res.back) blocks.push(h('span', { class: 'tbar__leg', style: `left:${tpos(prevEnd)};width:${(res.back.min / span) * 100}%` }));
      strip.replaceChildren(...blocks);
    }
    const parts = [];
    if (res.empty) {
      parts.push(h('div', { class: 'empty' }, h('p', { class: 'empty__title' }, res.empty === 'past' ? '这个时段已经过去了' : '时间太短'),
        h('p', null, res.empty === 'past' ? '把时间条往后拖，或选明天。' : '可规划时间不足 30 分钟。把时间条拉长一些。')));
      out.replaceChildren(...parts);
      drawGuide();
      return;
    }
    const t = res.totals;
    const notes = [];
    if (res.shifted) notes.push(`今天已过 ${clock(res.asked[0])}，从现在（${clock(res.window[0])}）开始排。`);
    if (res.xmas) notes.push('圣诞节当天地铁和公交停运，绝大多数博物馆、商店和餐厅关门：这里只排全天开放的户外地点和皇家公园，全程步行，饭请提前订好。');
    if (res.date.auto) notes.push(`今天 ${clock(res.asked[0])}–${clockNext(res.asked[1])} 已经过去，先排的是明天（${dateZh(res.date)}）；想排今晚，把时间条往后拖，或点“从现在起 3 小时”。`);
    const pm = res.stops.find((s) => s.pinned && s.node.meal && !s.meal);
    if (res.needs.lunch && !res.hadLunch) {
      notes.push(pm ? `必去的“${pm.node.zh || pm.node.name}”排在 ${clockNext(pm.start)}，没赶上午饭时段（必去较多时先保证都排得进）；想中午吃，可减少必去或换一天。`
        : '没排进午饭：附近收录的餐厅在这个时段不开，或时间太紧；可在沿途的博物馆咖啡厅或小店简单吃点。');
    }
    if (res.needs.dinner && !res.hadDinner) {
      const show = res.stops.find((s) => s.slot != null && s.start < TP().DINNER[1] && s.end > TP().DINNER[0]);
      notes.push(show ? `晚饭时段在看“${show.node.zh || show.node.name}”：可以开场前就近简单吃点，或散场后再吃。`
        : '没排进晚饭：附近收录的餐厅这个时段不开，或时间太紧；可以把时间条往后拉一点，或就近吃。');
    }
    for (const u of res.unplaced) notes.push(`必去“${u.node.zh || u.node.name}”没排进去：${u.why}。`);
    const nm = (s) => `“${s.node.zh || s.node.name}”`;
    const vary = res.stops.filter((s) => s.node.vary).map(nm);
    const unv = res.stops.filter((s) => s.node.place && s.node.place.unverified).map(nm);
    if (vary.length) notes.push(`${vary.join('、')}的开放时间每天不同，这里按保守时段排；出发前在官网日历确认当天时间。`);
    if (unv.length) notes.push(`${unv.join('、')}的开放时间待核实，出发前请查官网。`);
    if (!res.stops.length) {
      parts.push(h('div', { class: 'empty' }, h('p', { class: 'empty__title' }, '这个时段排不出行程'),
        h('p', null, '所选时段里，从出发点能赶到、又开门的地点太少。试试拉长时间条、换一天，或去掉“只去免费的”等选项。')));
    } else {
      const visit = t.visitMin;
      const move = t.walkMin + t.transitMin;
      parts.push(h('p', { class: 'plansum' },
        h('b', null, `${res.stops.length} 站`), ` · 游览 ${durText(visit)} · 路上 ${durText(move)}`,
        t.walkKm >= 0.1 ? `（步行约 ${t.walkKm.toFixed(1)} km）` : '',
        ` · 门票约 ${t.cost ? pence(t.cost) + (t.costKnown ? '' : ' 起') : t.costKnown ? '£0' : '另计'}`,
        t.food || !t.foodKnown ? ` · 餐饮人均约 ${t.food ? pence(t.food) : '—'}${t.food && !t.foodKnown ? ' 起' : ''}` : '',
        h('span', { class: 'plansum__end' }, ` · ${clockNext(res.endT)} 结束`)));
    }
    if (notes.length) parts.push(h('ul', { class: 'plannotes' }, notes.map((x) => h('li', null, x))));
    if (res.stops.length) {
      const items = [h('li', { class: 'itin__mark' }, h('span', { class: 'itin__time mono' }, clock(res.window[0])), h('span', null, `出发 · ${res.start.label}`))];
      let prev = res.start;
      res.stops.forEach((s, i) => {
        items.push(h('li', { class: 'itin__leg' }, h('span', { class: 'itin__legtxt' }, icon(s.leg.mode === 'walk' ? 'walk' : 'tube'), legText(s.leg)), extLink(navUrl(prev, s.node, s.leg.mode), '路线', 'link ext itin__nav')));
        items.push(itinStop(s, i, res));
        prev = s.node;
      });
      if (res.back) items.push(h('li', { class: 'itin__leg' }, h('span', { class: 'itin__legtxt' }, icon(res.back.mode === 'walk' ? 'walk' : 'tube'), legText(res.back)), extLink(navUrl(prev, res.start, res.back.mode), '路线', 'link ext itin__nav')));
      items.push(h('li', { class: 'itin__mark' }, h('span', { class: 'itin__time mono' }, clockNext(res.endT)), h('span', null, res.back ? `回到 ${res.start.label}` : '结束')));
      parts.push(h('ol', { class: 'itin' }, items));
      parts.push(planActions(res));
    }
    if (!res.fast) parts.push(h('p', { class: 'note planalgo' }, `按开放时间、最后入场、游玩时长、路上时间、日落与饭点自动排序；拖动时间条会实时重排。（本次计算 ${Math.max(1, Math.round(res.ms))} ms）`));
    keepFocus(() => out.replaceChildren(...parts));
    drawGuide();
  }
  function itinStop(s, i, res) {
    const n = s.node;
    const p = n.place;
    const date = res.date;
    const why = stopReasons(s, res);
    const iv = n.slots ? null : TP().intervalsOn(n, date, res.sun);
    const facts = [];
    if (iv) facts.push(n.vary ? `按 ${ivText(iv)} 估算` : `当天 ${ivText(iv)}`);
    if (n.lastEntry != null && iv && iv.length) facts.push(`最后入场 ${clock(iv[iv.length - 1][1] - n.lastEntry)}`);
    facts.push(n.spend ? (n.price ? `人均约 ${pence(n.price)}` : '入场免费 · 餐饮另计') : pence(n.price));
    facts.push(INDOOR_ZH[n.indoor]);
    const swap = h('button', { type: 'button', class: 'btn btn--quiet btn--icon', title: '换一个：不去这里，重新规划', 'aria-label': `换掉 ${n.name}`, 'data-fk': 'swap:' + n.id }, icon('swap'), h('span', null, '换一个'));
    swap.addEventListener('click', () => {
      if (n.event) { state.plan.events = false; const t = $('[data-fk="opt:events"]'); if (t) t.setAttribute('aria-pressed', 'false'); savePlan(); }
      else { state.excluded.add(n.id); const k = state.plan.pins.indexOf(n.id); if (k >= 0) { state.plan.pins.splice(k, 1); savePlan(); } }
      paintPins();
      paintNear();
      schedulePlan(false);
      refocus('swap:' + n.id) || refocus('tbar:a');
    });
    const li = h('li', { class: 'itin__stop', 'data-id': p ? p.id : null },
      h('span', { class: 'itin__n', 'data-cat': n.category, 'aria-hidden': 'true' }, String(i + 1)),
      h('span', { class: 'itin__time mono' }, `${clockNext(s.start)}–${clockNext(s.end)}`),
      h('span', { class: 'itin__main' },
        p ? h('a', { class: 'itin__name', href: '#' + p.id, 'data-route': p.id, 'data-fk': 'itin:' + n.id }, glyph(p.cat, true), h('span', null, n.event ? n.name : placeLabel(n)))
          : h('span', { class: 'itin__name' }, n.name),
        n.event && p ? h('span', { class: 'itin__where' }, `地点：${p.zh || p.name}`) : null,
        why.length ? h('span', { class: 'itin__why' }, why.map((w) => h('span', { class: 'why' }, w))) : null,
        h('span', { class: 'itin__facts' }, facts.join(' · '), p && (p.unverified || p.vary) ? [' ', unverifiedBadge(p)] : null,
          p && p.calendarUrl ? [' ', extLink(p.calendarUrl, '官网当天时间', 'link ext')] : null),
        p && p.g && p.g.tips && p.g.tips.length ? h('span', { class: 'itin__tip' }, p.g.tips[0]) : null),
      h('span', { class: 'itin__act' }, p && !n.event ? pinButton(p, { small: true, fk: 'ipin:' }) : null, swap));
    if (p) {
      li.addEventListener('pointerenter', () => setHot(p.id, true));
      li.addEventListener('pointerleave', () => setHot(p.id, false));
    }
    return li;
  }
  function planActions(res) {
    const P = TP();
    const copy = copyButton(() => planText(res), '复制行程文字');
    copy.querySelector('span').textContent = '复制行程';
    const ics = h('button', { type: 'button', class: 'btn', 'data-fk': 'plan:ics' }, icon('cal'), h('span', null, '加入日历'));
    ics.addEventListener('click', () => {
      const evs = res.stops.map((s, i) => {
        const p = s.node.place;
        return {
          id: `plan-${res.date.key}-${i + 1}-${s.node.id}`, title: `${i + 1}. ${s.node.event ? s.node.name : placeLabel(s.node)}`,
          start: P.londonToUtc(res.date, s.start), end: P.londonToUtc(res.date, s.end), tz: CITIES.LONDON.tz, place: p || null,
          sourceUrl: s.node.event ? s.node.event.sourceUrl : (p && p.vary && p.calendarUrl) || (p ? p.sourceUrl : ''),
          note: p && p.vary ? `开放时间每天不同，出发前查官网日历：${p.calendarUrl || p.sourceUrl}` : p && p.unverified ? '开放时间待核实，出发前请查官网。' : null,
          verifiedAt: p ? p.verifiedAt : null, priceMinor: s.node.spend && !s.node.price ? null : s.node.price, currency: 'GBP', series: null, status: '', sourceVersion: 0, deadline: null,
        };
      });
      const blob = new Blob([buildICS(evs)], { type: 'text/calendar;charset=utf-8' });
      const href = URL.createObjectURL(blob);
      const a = h('a', { href, download: `london-plan-${res.date.key}.ics` });
      doc.body.appendChild(a);
      a.click();
      a.remove();
      window.setTimeout(() => URL.revokeObjectURL(href), 5000);
      announce(`已生成包含 ${evs.length} 站的日历文件`);
    });
    const pts = [res.start].concat(res.stops.map((s) => s.node));
    if (res.back) pts.push(res.start);
    const way = pts.slice(1, -1).slice(0, 8).map((x) => `${x.lat.toFixed(6)},${x.lng.toFixed(6)}`).join('|');
    const last = pts[pts.length - 1];
    const gmaps = `https://www.google.com/maps/dir/?api=1&origin=${pts[0].lat.toFixed(6)},${pts[0].lng.toFixed(6)}&destination=${last.lat.toFixed(6)},${last.lng.toFixed(6)}${way ? '&waypoints=' + encodeURIComponent(way) : ''}&travelmode=walking`;
    return h('div', { class: 'planact' }, copy, ics, extLink(gmaps, '整条路线（Google 地图）', 'btn'));
  }
  function planText(res) {
    const lines = [`伦敦行程 · ${dateZh(res.date)} ${clock(res.window[0])}–${clockNext(res.endT)}（从 ${res.start.label} 出发）`];
    res.stops.forEach((s, i) => {
      lines.push(`  ↓ ${legText(s.leg)}`);
      const cal = s.node.place && s.node.place.calendarUrl;
      lines.push(`${i + 1}. ${clockNext(s.start)}–${clockNext(s.end)}  ${s.node.event ? s.node.name : placeLabel(s.node)}${s.meal === 'lunch' ? '（午饭）' : s.meal === 'dinner' ? '（晚饭）' : ''}${s.node.vary ? '（时间每天不同，以官网日历为准）' : ''}`);
      if (cal && s.node.vary) lines.push(`   官网日历：${cal}`);
    });
    if (res.back) lines.push(`  ↓ ${legText(res.back)}，回到出发点`);
    lines.push('', '由 双城图志 生成。路上时间为估算，开放时间与票价以官网为准。');
    return lines.join('\n');
  }

  /* curated routes and practical tips */
  function routesSection() {
    const d = state.data;
    const cards = d.guide.routes.map((r) => {
      const stops = r.stops.map((id) => d.placeById.get(id)).filter(Boolean);
      const b = h('button', { type: 'button', class: 'btn', 'data-fk': 'route:' + r.id }, '套用这条');
      b.addEventListener('click', () => {
        state.plan.pins = stops.map((p) => p.id);
        if (Array.isArray(r.window) && r.window.length === 2) state.plan.window = [Math.max(TBAR_MIN, r.window[0]), Math.min(TBAR_MAX, r.window[1])];
        if (Array.isArray(r.interests)) state.plan.interests = r.interests.filter((k) => PLAN_INTERESTS.includes(k));
        for (const el of $$('[data-tbar]')) el.value = el.dataset.tbar === 'a' ? state.plan.window[0] : state.plan.window[1];
        for (const x of $$('[data-fk^="int:"]')) x.setAttribute('aria-pressed', String(state.plan.interests.includes(x.dataset.fk.slice(4))));
        if (r.start && START_PRESETS.some((x) => x.key === r.start)) { state.plan.start = r.start; if (state.startKind !== 'geo') state.startKind = 'preset'; }
        savePlan();
        for (const x of $$('[data-pin]')) paintPinBtn(x);
        paintStart();
        paintPins();
        paintBar();
        schedulePlan(false, { fit: true });
        const target = $('[data-planout]');
        if (target) scrollToEl($('#g-plan') || target);
        announce(`已套用“${r.title}”：${stops.length} 处必去，${clock(state.plan.window[0])} 到 ${clockNext(state.plan.window[1])}`);
      });
      return h('li', { class: 'rcard' },
        h('p', { class: 'rcard__title' }, r.title, Array.isArray(r.window) ? h('span', { class: 'rcard__win mono' }, `${clock(r.window[0])}–${clockNext(r.window[1])}`) : null),
        r.desc ? h('p', { class: 'rcard__desc' }, r.desc) : null,
        h('p', { class: 'rcard__stops' }, stops.map((p, i) => [i ? h('span', { class: 'sep', 'aria-hidden': 'true' }, '→') : null, h('a', { class: 'link', href: '#' + p.id, 'data-route': p.id }, p.zh || p.name)])),
        b);
    });
    return h('section', { class: 'gsec', 'aria-labelledby': 'g-routes' },
      h('h3', { class: 'gsec__title', id: 'g-routes' }, '现成路线', h('span', { class: 'gsec__meta' }, '一键设为必去，再按上面的时间条和日期排时间')),
      h('ul', { class: 'rcards' }, cards));
  }
  function tipsSection() {
    return h('section', { class: 'gsec', 'aria-labelledby': 'g-tips' },
      h('h3', { class: 'gsec__title', id: 'g-tips' }, '伦敦须知'),
      state.data.guide.tips.map((t, i) => h('details', { class: 'tip', open: i === 0 },
        h('summary', { 'data-fk': 'tip:' + i }, icon('chev'), t.title),
        h('ul', { class: 'tip__list' }, (t.items || []).map((x) => h('li', null, richText(x)))),
        t.source ? h('p', { class: 'tip__src' }, extLink(t.source, `来源：${domainOf(t.source)}`)) : null)));
  }

  /* map layer: start, my location, route */
  function guidePanes(m) {
    if (m.gRoute) return;
    const L = window.L;
    m.map.createPane('tcaRoute').style.zIndex = 450;
    m.map.createPane('tcaStops').style.zIndex = 640;
    m.gRoute = L.layerGroup().addTo(m.map);
    m.gStops = L.layerGroup().addTo(m.map);
  }
  function drawGuide() {
    const m = maps.LONDON;
    if (!m || state.mapsOff || !window.L) return;
    guidePanes(m);
    m.gRoute.clearLayers();
    m.gStops.clearLayers();
    const on = state.tab === 'guide' && !!state.data && state.city !== 'FUZHOU' && !!TP();
    m.el.classList.toggle('is-picking', on && state.picking);
    if (!on) return;
    const L = window.L;
    const g = state.geo;
    if (g.status === 'ok') {
      L.circle([g.lat, g.lng], { radius: Math.min(g.acc || 0, 2000), pane: 'tcaRoute', className: 'geo-acc', interactive: false }).addTo(m.gRoute);
      L.marker([g.lat, g.lng], { pane: 'tcaStops', interactive: false, keyboard: false, icon: L.divIcon({ className: 'geo-wrap', html: h('span', { class: 'geo-dot' }), iconSize: [18, 18], iconAnchor: [9, 9] }) }).addTo(m.gStops);
    }
    const start = startPoint();
    if (start.kind !== 'geo') {
      L.marker([start.lat, start.lng], { pane: 'tcaStops', interactive: false, keyboard: false, icon: L.divIcon({ className: 'startpin-wrap', html: h('span', { class: 'startpin' }, '起'), iconSize: [24, 24], iconAnchor: [12, 12] }) }).addTo(m.gStops);
    }
    const res = state.planRes;
    const ids = new Set();
    const pts = [[start.lat, start.lng]];
    if (res && res.stops && res.stops.length) {
      let prev = start;
      res.stops.forEach((s, i) => {
        const n = s.node;
        L.polyline([[prev.lat, prev.lng], [n.lat, n.lng]], { pane: 'tcaRoute', className: 'route-leg is-' + s.leg.mode, interactive: false }).addTo(m.gRoute);
        const mk = L.marker([n.lat, n.lng], {
          pane: 'tcaStops', keyboard: false, title: `${i + 1}. ${n.name}`,
          icon: L.divIcon({ className: 'stopnum-wrap', html: h('span', { class: 'stopnum', 'data-cat': n.category }, String(i + 1)), iconSize: [20, 20], iconAnchor: [-3, 25] }),
        });
        const pid = n.place && n.place.id;
        if (pid) mk.on('click', () => openPlace(pid, { from: 'map', focus: true }));
        mk.addTo(m.gStops);
        if (pid) ids.add(pid);
        pts.push([n.lat, n.lng]);
        prev = n;
      });
      if (res.back) L.polyline([[prev.lat, prev.lng], [start.lat, start.lng]], { pane: 'tcaRoute', className: 'route-leg is-back is-' + res.back.mode, interactive: false }).addTo(m.gRoute);
    }
    applyMarkerFilter(ids.size ? ids : null);
    if (state.fitRoute && res && !res.fast && mapVisible(m)) {
      state.fitRoute = false;
      if (g.status === 'ok') pts.push([g.lat, g.lng]);
      if (pts.length > 1) m.map.fitBounds(window.L.latLngBounds(pts), Object.assign({ maxZoom: 15, animate: !mqReduce.matches }, fitPadding(m)));
      else m.map.setView(pts[0], 14, { animate: !mqReduce.matches });
      m.fitted = true;
      m.autoFit = false;
    }
  }
  function activateGuide() {
    drawGuide();
  }

  /* place page: planning facts, weekly hours, tips */
  function guideBlock(p) {
    const g = p.g;
    const n = p.node;
    const P = TP();
    const sec = h('section', { class: 'guidebox', 'data-city': p.city, 'aria-labelledby': 'guide-label' },
      h('h3', { class: 'label', id: 'guide-label' }, '游玩建议', p.guide ? null : h('span', { class: 'label__n' }, '攻略补充')));
    if (n && P) sec.appendChild(h('p', { class: 'guidebox__now' }, liveEl(p, 'live--lg'), unverifiedBadge(p)));
    const facts = [];
    if (n) {
      facts.push(h('dt', null, '建议时长'), h('dd', null, n.slots && n.category === 'NIGHT' ? `约 ${durText(n.visitMin)}（含中场）` : `约 ${durText(n.visitMin)}`));
      facts.push(h('dt', null, '费用'), h('dd', null, pence(n.price), g.priceNote && g.priceNote !== pence(n.price) ? h('span', { class: 'muted' }, ` · ${g.priceNote}`) : null));
      facts.push(h('dt', null, '室内/户外'), h('dd', null, INDOOR_ZH[n.indoor]));
      if (n.best.size) facts.push(h('dt', null, '最佳时段'), h('dd', null, Array.from(n.best).map((b) => BEST_ZH[b] || b).join('、')));
      facts.push(h('dt', null, '推荐度'), h('dd', null, h('span', { class: 'stars', 'aria-label': `${n.score} 分（满分 5）` }, '★'.repeat(n.score), h('span', { class: 'stars__off' }, '★'.repeat(5 - n.score))), n.score >= 5 ? ' 初访必去' : n.score === 4 ? ' 很值得' : ''));
    }
    if (p.calendarUrl) {
      facts.push(h('dt', null, '开放时间'), h('dd', null, extLink(p.calendarUrl, p.vary ? '官网日历（每天不同）' : '官网开放时间'),
        h('span', { class: 'muted' }, p.vary ? (n && (n.hours || n.slots) ? ' · 下表是规划用的保守时段，出发前查当天时间' : ' · 按官网日历预约场次，不自动排进行程') : ' · 个别日子有调整，以官网为准')));
    }
    if (g.station) facts.push(h('dt', null, '交通'), h('dd', null, g.station));
    if (g.booking) facts.push(h('dt', null, '预约'), h('dd', null, g.booking));
    if (facts.length) sec.appendChild(h('dl', { class: 'facts' }, facts));
    if (Array.isArray(g.tips) && g.tips.length) sec.appendChild(h('ul', { class: 'tips' }, g.tips.map((t) => h('li', null, richText(t)))));
    if (n && P) sec.appendChild(weekBlock(p));
    if (g.verifyNote || g.overlayNote) sec.appendChild(h('p', { class: 'note guidebox__note' }, `核验说明：${g.verifyNote || g.overlayNote}`));
    if (n && n.plan) {
      const from = h('button', { type: 'button', class: 'btn', 'data-fk': 'from:' + p.id }, icon('route'), h('span', null, '从这里出发规划'));
      from.addEventListener('click', () => planFrom(p));
      sec.appendChild(h('div', { class: 'maplinks' }, n.hours || n.slots ? pinButton(p) : null, from));
    }
    return sec;
  }
  function weekBlock(p) {
    const P = TP();
    const n = p.node;
    const today = londonNow();
    const days = Array.from({ length: 7 }, (_, i) => { const d = P.addDays(today, i); return { date: d, slots: P.slotsOn(n, d) }; });
    const rows = days.map((x) => {
      const sun = sunFor(x.date);
      const iv = n.slots ? null : P.intervalsOn(n, x.date, sun);
      const text = n.slots ? (x.slots.length ? x.slots.map((m) => clock(m)).join('、') + ' 开场' : '无场次') : iv == null && n.vary ? '见官网日历' : ivText(iv);
      const isToday = x.date.key === today.key;
      return h('tr', { class: isToday ? 'is-today' : null },
        h('th', { scope: 'row' }, `周${DOW_ZH[x.date.dow]}`, h('span', { class: 'muted' }, ` ${x.date.mo}/${x.date.d}`)),
        h('td', { class: (iv && !iv.length) || (n.slots && !x.slots.length) ? 'is-off' : null }, text, isToday ? h('span', { class: 'vh' }, '（今天）') : null));
    });
    const notes = [];
    if (n.vary) {
      notes.push(n.slots ? '节目每天不同：表中是常规开场时间，当天有没有演出以官网节目单为准'
        : n.hours ? '时间每天不同：表中是规划用的保守时段（官网各日里最短的），当天实际时间以官网日历为准'
          : '时间每天不同，需按官网日历预约场次，所以不自动排进行程');
    }
    if (n.dates) notes.push(n.dates.to ? (n.dates.from <= today.key ? `开放至 ${n.dates.to}` : `只在 ${n.dates.from} 至 ${n.dates.to} 期间`) : `${n.dates.from} 起开放`);
    if (n.seasonal.length) notes.push(`季节性时间：${n.seasonal.map((s) => `${s.from.replace('-', '月')}日–${s.to.replace('-', '月')}日另有安排`).join('；')}（表中已按日期计算）`);
    if (n.closed.size) notes.push(`闭馆/休息日：${Array.from(n.closed).sort().map((x) => x.length === 5 ? x.replace('-', '月') + '日' : x).join('、')}`);
    if (n.lastEntry != null) notes.push(`最后入场为关门前 ${n.lastEntry} 分钟`);
    if (Array.from(n.hours ? n.hours.days : []).some((iv) => iv && iv.some((x) => x.dusk))) notes.push('“黄昏关门”按当天日落时间推算');
    return h('div', { class: 'week7' },
      h('table', { class: 'week7__table' }, h('caption', { class: 'vh' }, '未来 7 天开放时间（伦敦当地时间）'), h('tbody', null, rows)),
      notes.length ? h('p', { class: 'note' }, notes.join('。') + '。') : null);
  }

  /* ------------------------------------------------------------------ render dispatcher, states */

  function viewKey(tab) {
    if (tab === 'events') return `${state.gen}|${state.city}|${state.partition}|${evFilterKey()}`;
    if (tab === 'sources') return `${state.gen}`;
    if (tab === 'guide') return `${state.gen}|${state.city === 'FUZHOU' ? 'F' : 'L'}`;
    return `${state.gen}|${state.city}`;
  }
  function render(opts = {}) {
    if (!state.data) {
      if (state.loadError) showError(state.loadError); else showLoading();
      return;
    }
    renderCounts();
    const tab = state.tab;
    const view = els.views[tab];
    if (tab === 'places') {
      const p = state.placeId && state.data.placeById.get(state.placeId);
      if (p) { renderDetail(p); view.dataset.key = ''; }
      else {
        state.placeId = null;
        const key = viewKey('places');
        if (opts.force || state.notFound || view.dataset.key !== key || !$('[data-results]', view)) { renderPlaces(); view.dataset.key = key; }
        else applyMarkerFilter(state.query.trim() || state.cats.size ? new Set(placeFilter().shown.map((x) => x.id)) : null);
      }
    } else if (tab === 'guide') {
      const key = viewKey('guide');
      if (opts.force || view.dataset.key !== key) { renderGuide(); view.dataset.key = key; } else activateGuide();
    } else if (tab === 'events') {
      state.partition = partitionKey();
      const key = viewKey('events');
      if (opts.force || view.dataset.key !== key) { renderEvents(); view.dataset.key = key; } else activateEvents();
    } else {
      const key = viewKey('sources');
      if (opts.force || view.dataset.key !== key) { renderSources(); view.dataset.key = key; } else applyMarkerFilter(null);
    }
    updateMapSolo();
    if (tab !== 'guide') drawGuide();
    writeHash(opts);
  }

  /** 双城 on 活动 when one city has nothing coming up: give the whole map area to the other city. */
  function updateMapSolo() {
    let solo = '';
    if (state.data && state.city === 'BOTH' && state.tab === 'guide') solo = 'LONDON';
    else if (state.data && state.city === 'BOTH' && state.tab === 'events') {
      const l = upcomingCount('LONDON');
      const f = upcomingCount('FUZHOU');
      if (l && !f) solo = 'LONDON'; else if (f && !l) solo = 'FUZHOU';
    }
    if ((els.atlas.dataset.mapsolo || '') === solo) return;
    if (solo) { els.atlas.dataset.mapsolo = solo; setMapCity(solo); } else delete els.atlas.dataset.mapsolo;
    refreshMaps();
  }

  function showLoading() {
    for (const [k, v] of Object.entries(els.views)) if (k !== state.tab) { v.replaceChildren(); v.dataset.key = ''; }
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
    for (const [k, v] of Object.entries(els.views)) if (k !== state.tab) { v.replaceChildren(); v.dataset.key = ''; }
    els.views[state.tab].replaceChildren(h('div', { class: 'state state--error', role: 'alert' },
      h('p', { class: 'state__title' }, '无法读取 content.json'),
      h('p', { class: 'state__body' }, why, ' 地图和时钟仍可使用；稍后重试，或直接打开数据文件检查。'),
      h('div', { class: 'empty__actions' }, retry, h('a', { class: 'btn', href: CONTENT_PATH, target: '_blank', rel: 'noopener noreferrer' }, '打开 content.json', icon('ext')))));
    retry.focus({ preventScroll: true });
  }

  let clusterReady = Promise.resolve(false);
  async function load() {
    state.loadError = null;
    showLoading();
    // The guide layer is optional: if it fails, the atlas still loads and the 攻略 tab says why.
    const guideReq = fetch(GUIDE_PATH, { cache: 'no-cache' })
      .then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
      .catch((err) => (err instanceof Error ? err : new Error(String(err))));
    try {
      const res = await fetch(CONTENT_PATH, { cache: 'no-cache' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      state.data = normalize(json, await guideReq);
      state.gen += 1;
    } catch (err) {
      state.data = null;
      state.loadError = err;
      showError(err);
      return;
    }
    await clusterReady;
    buildMarkers();
    for (const v of Object.values(els.views)) v.dataset.key = '';
    const token = readHash();
    if (!route(token, { focus: false, initial: true })) {
      if (token && token.includes('-')) { state.notFound = token; announce('未找到该地点，已显示列表'); }
      render();
    }
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
    // Two unbreakable pieces; the comma ends the first so the line may wrap between them.
    const first = h('span', { class: 'nw' }, '时差 ', h('b', null, fmtH(diff)));
    const out = [first];
    if (dstCache.at != null) {
      const after = (offsetMin(dstCache.at + 60000, CITIES.FUZHOU.tz) - offsetMin(dstCache.at + 60000, CITIES.LONDON.tz)) / 60;
      first.append('，');
      out.push(h('span', { class: 'clocks__next' }, `${md(dstCache.at, CITIES.LONDON.tz)}起 ${fmtH(after)}`));
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
    if (state.data) {
      if (partitionKey() !== state.partition) {
        if (state.tab === 'events') {
          const y = scroller().scrollTop;
          keepFocus(() => render({ force: true }));
          scroller().scrollTop = y;
        } else {
          els.views.events.dataset.key = '';
        }
      }
      renderCounts();
      updateMapSolo();
      if (state.tab === 'guide' && TP() && els.views.guide.dataset.key) {
        paintGuideClock();
        paintNear();
        paintBar();
        const r = state.planRes;
        const nowL = londonNow();
        if (r && (r.shifted || r.empty || planDate().key !== r.date.key || (r.date.key === nowL.key && r.window[0] < nowL.min + 5))) schedulePlan(false);
      }
    }
  }
  function scheduleTick() {
    tick();
    window.setTimeout(scheduleTick, 60000 - (Date.now() % 60000) + 40);
  }

  /* ------------------------------------------------------------------ events wiring */

  let scrollRaf = 0;
  function onWindowScroll() {
    if (mqDesktop.matches) {
      // The desktop frame never scrolls the document; undo any programmatic scroll that slipped through.
      if (window.scrollY) window.scrollTo(0, 0);
      return;
    }
    if (scrollRaf) return;
    scrollRaf = window.requestAnimationFrame(() => {
      scrollRaf = 0;
      if (state.tab !== 'places' || state.placeId || state.mapsOff) return;
      const y = window.scrollY;
      if (y < 40) {
        state.mapPinned = false;
        if (state.mapMin && state.mapMinAuto) setMapMin(false);
      } else if (!state.mapMin && !state.mapPinned && y > window.innerHeight) {
        setMapMin(true, { auto: true });
      }
    });
  }

  function wire() {
    for (const b of $$('[data-set-city]')) b.addEventListener('click', () => setCity(b.dataset.setCity));
    for (const b of $$('[data-map-city]')) {
      b.addEventListener('click', () => { setMapCity(b.dataset.mapCity); refreshMaps(); });
    }
    for (const b of $$('[data-map-toggle]')) {
      b.addEventListener('click', () => {
        const min = !state.mapMin;
        state.mapPinned = !min && window.scrollY > 40;
        setMapMin(min);
        const other = $$('[data-map-toggle]').find((x) => x !== b && x.getClientRects().length);
        if (other) other.focus({ preventScroll: true });
      });
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
    window.addEventListener('scroll', onWindowScroll, { passive: true });

    $('[data-home]').addEventListener('click', (e) => {
      e.preventDefault();
      state.placeId = null;
      selectOnMap(null);
      setTab('places', { render: false });
      render();
      scrollPanelTop();
    });

    // Skip links move focus without touching the address bar (it carries the app's own tokens).
    for (const a of $$('a.skip')) {
      a.addEventListener('click', (e) => {
        e.preventDefault();
        if (a.hasAttribute('data-skip-map') && !state.mapsOff) {
          setMapMin(false);
          const m = maps[state.city === 'FUZHOU' ? 'FUZHOU' : state.mapCity] || Object.values(maps)[0];
          window.requestAnimationFrame(() => {
            const target = m && mapVisible(m) ? m.el : els.mapzone;
            if (!mqDesktop.matches) els.mapzone.scrollIntoView({ block: 'nearest' });
            target.focus({ preventScroll: true });
          });
        } else {
          els.panel.focus({ preventScroll: true });
          if (!mqDesktop.matches) scrollPanelTop();
        }
      });
    }

    // In-page links carry bare tokens; apply them. Opening a place adds a history entry (Back closes it).
    doc.addEventListener('click', (e) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const go = e.target.closest && e.target.closest('a[data-goto-event]');
      if (go) { e.preventDefault(); gotoEvent(go.dataset.gotoEvent); return; }
      const a = e.target.closest && e.target.closest('a[data-route]');
      if (!a) return;
      e.preventDefault();
      route(a.dataset.route, { focus: true, fromEl: a });
    });
    window.addEventListener('popstate', () => {
      const token = readHash();
      if (token && state.data && state.data.placeById.has(token)) {
        if (token !== state.placeId || state.tab !== 'places') openPlace(token, { focus: true, fromHistory: true });
        return;
      }
      if (state.placeId && state.tab === 'places') closePlace({ fromHistory: true });
      else if (state.placeId) { state.placeId = null; selectOnMap(null); }
      if (token && token !== currentToken()) route(token, { focus: false });
    });
    window.addEventListener('hashchange', () => {
      const token = readHash();
      if (!token || token === currentToken()) return;
      // The browser already made a history entry for this hash: do not push another.
      if (!route(token, { focus: false, fromHistory: true })) {
        if (token.includes('-')) notFound(token);
        else writeHash();
      }
    });
    doc.addEventListener('visibilitychange', () => { if (!doc.hidden) tick(); });
    doc.addEventListener('keydown', (e) => { if (e.key === 'Escape' && state.picking) { togglePicking(); announce('已取消地图选点'); } });
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
    state.plan = loadPlan();
    if (low === 'guide' && city === 'FUZHOU') { state.city = 'LONDON'; els.atlas.dataset.city = 'LONDON'; setMapCity('LONDON'); for (const b of $$('[data-set-city]')) b.setAttribute('aria-pressed', String(b.dataset.setCity === 'LONDON')); }
    if (low === 'events' || low === 'sources' || low === 'guide') {
      setTab(low, { render: false });
      if (!mqDesktop.matches && low !== 'guide') setMapMin(true, { auto: true });
    }

    clusterReady = loadClusterScript();
    initMaps();
    applyTheme();
    renderSurveyLine();
    wire();
    scheduleTick();
    load();
  }

  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', boot); else boot();
})();
