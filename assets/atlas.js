/* 双城图志 · Twin City Atlas — front end.
 * Plain ES2020, no build step, no framework. Reads content.json (read-only, treated as untrusted text:
 * every data string reaches the DOM through textContent / attributes, never innerHTML).
 */
(function () {
  'use strict';

  /* ------------------------------------------------------------------ constants */

  const CONTENT_PATH = 'content.json';
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
    CULTURE: { glyph: '文', zh: '文化', terms: '文化 博物馆 美术馆 展览 历史 寺 culture museum gallery' },
    COURSE: { glyph: '课', zh: '课程', terms: '课程 培训 学习 讲座 course class' },
    FOOD: { glyph: '食', zh: '美食', terms: '美食 食物 小吃 市场 餐饮 food market' },
    NATURE: { glyph: '园', zh: '自然', terms: '自然 公园 园 山 湖 nature park' },
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
    { key: 'westend', en: 'West End', zh: '西区 · 考文特花园', regions: ['Trafalgar Square', 'Covent Garden', 'Strand', 'Aldwych', 'West End', 'Holborn', 'Fitzrovia', 'St James\'s', 'Soho', 'Westminster', 'Leicester Square', 'Mayfair', 'Chinatown'] },
    { key: 'bloomsbury', en: 'Bloomsbury', zh: '布鲁姆斯伯里 · 国王十字', regions: ['Bloomsbury', 'Euston', 'St Pancras', 'King\'s Cross', 'Russell Square'] },
    { key: 'southbank', en: 'South Bank', zh: '南岸 · 萨瑟克', regions: ['South Bank', 'Bankside', 'London Bridge', 'Waterloo', 'Bermondsey', 'Elephant & Castle', 'Southwark', 'Borough'] },
    { key: 'kensington', en: 'South Kensington', zh: '南肯辛顿 · 海德公园', regions: ['South Kensington', 'Kensington Gardens', 'Hyde Park', 'Bayswater', 'Knightsbridge', 'Kensington'] },
    { key: 'city', en: 'City & East', zh: '金融城 · 东区', regions: ['Aldgate', 'Spitalfields', 'Shoreditch', 'City of London', 'Clerkenwell', 'Barbican', 'Whitechapel'] },
    { key: 'regents', en: 'Regent\'s Park', zh: '摄政公园 · 卡姆登', regions: ['Regent\'s Park', 'Camden Town', 'Camden', 'Primrose Hill', 'Marylebone'] },
  ];
  const OUTER_AREA = { key: 'outer', en: 'Outer London', zh: '外伦敦', outer: true, regions: [] };
  const LONDON_AREA_INDEX = new Map();
  for (const a of LONDON_AREAS) for (const r of a.regions) LONDON_AREA_INDEX.set(regionKey(r), a);

  // Hosts that serve many unrelated pages: never used on their own to tie a source to a place.
  const SHARED_HOST_RE = /(^|\.)(wikipedia\.org|wikidata\.org|wikimedia\.org|doogal\.co\.uk|openstreetmap\.org|blogspot\.com|wordpress\.com|github\.io|jotform\.com|eventbrite\.[a-z.]+|google\.[a-z.]+|englishchess\.org\.uk|gov\.uk|gov\.cn)$/;
  // Reference works cited for a place's coordinates (listed under 位置 › 坐标依据).
  const COORD_HOST_RE = /(^|\.)(wikipedia\.org|wikidata\.org|doogal\.co\.uk|openstreetmap\.org)$/;
  const GENERIC_WORDS = new Set(['london', 'the', 'park', 'parks', 'gardens', 'garden', 'royal', 'museum', 'market', 'chess', 'club', 'library', 'college', 'centre', 'center', 'church', 'school', 'street', 'house', 'gallery', 'campus', 'university', 'south', 'north', 'east', 'west', 'hall']);
  const HOW_ZH = { postcode: '按邮编对应', coords: '按坐标对应', name: '按名称对应', region: '按区域名对应', site: '按网站对应' };

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
  function linkSources(sources, places, events, series, hidden) {
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

  function normalize(json) {
    if (!json || typeof json !== 'object' || Array.isArray(json)) throw new Error('shape');
    const list = (k) => (Array.isArray(json[k]) ? json[k] : []);
    const hiddenPlaceIds = new Set();
    const hiddenPlaces = [];
    const places = [];
    const seen = new Set();
    for (const raw of list('places')) {
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
    const groups = assignGroups(places);
    for (const p of places) {
      const g = p.group;
      p.search = fold([p.name, p.address, p.region, p.postcode, g.plate.main, g.plate.sub, p.plate.main, p.plate.sub, p.description, p.openingInfo, p.cat.zh, p.cat.terms, p.category, CITIES[p.city].zh, CITIES[p.city].en].join(' '));
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
    const hiddenKeys = new Set();
    for (const raw of list('places')) if (raw && hiddenPlaceIds.has(str(raw.id)) && str(raw.sourceUrl)) hiddenKeys.add(urlKey(raw.sourceUrl));
    for (const raw of list('events').concat(list('series'))) if (raw && hiddenPlaceIds.has(str(raw.placeId)) && str(raw.sourceUrl)) hiddenKeys.add(urlKey(raw.sourceUrl));
    const linked = linkSources(rawSources, places, events, Array.from(seriesById.values()), hiddenPlaces);
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
  };

  const els = {
    atlas: $('.atlas'),
    panel: $('#panel'),
    scroll: $('[data-scroll]'),
    views: { places: $('#view-places'), events: $('#view-events'), sources: $('#view-sources') },
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
    if (low === 'events' || low === 'sources') {
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
      // Phones: the map earns its space on 地点; 活动 and 来源 start with it folded to a strip.
      state.mapPinned = false;
      setMapMin(tab !== 'places' && !state.placeId, { auto: true });
    }
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
          tiles: null, theme: effectiveTheme(), tileErr: 0, tileOk: 0,
          hotCluster: null, roving: null, refocus: null, uiRaf: 0,
        };
        m.tiles = L.tileLayer(TILE_URL[m.theme], { subdomains: 'abcd', maxZoom: 20, attribution: TILE_ATTRIBUTION })
          .on('tileerror', () => { m.tileErr += 1; updateTileNotice(m); })
          .on('tileload', () => { m.tileOk += 1; updateTileNotice(m); })
          .addTo(map);
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
    return h('p', { class: 'foot' },
      `资料来自公开数据文件 content.json（${d.meta.format || '格式未注明'} v${d.meta.version || '?'}，坐标 ${d.meta.coordinateSystem || '未注明'}）`,
      latest ? `，地点最近核验于 ${ymd(latest, VERIFY_TZ)}。` : '。',
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
    let excerpt = p.excerpt;
    let matched = false;
    if (qs && qs.length) {
      // Show why a row matched when the match is not in its visible name or meta line.
      const visible = fold(`${p.name} ${meta.join(' ')} ${p.cat.terms} ${p.category}`);
      if (!qs.every((t) => visible.includes(t))) {
        for (const field of [p.openingInfo, p.description, p.address, p.group.plate.sub]) {
          const snip = field && kwic(field, qs);
          if (snip) { excerpt = snip; matched = true; break; }
        }
      }
    }
    const fresh = p.verifiedAt != null && (isStale(p.verifiedAt) || ageDays(p.verifiedAt) >= AGING_DAYS) ? freshness(p.verifiedAt, 'row__fresh') : null;
    const a = h('a', { class: 'row', href: '#' + p.id, 'data-id': p.id, 'data-city': p.city, 'data-route': p.id, 'data-fk': 'row:' + p.id },
      glyph(p.cat),
      h('span', { class: 'row__name' }, highlight(p.name, qs)),
      fresh,
      h('span', { class: 'row__meta' }, highlight(meta.join(' · '), qs)),
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
    const backTo = { places: '返回地点列表', events: '返回活动', sources: '返回来源' }[state.returnTab] || '返回地点列表';
    const back = h('button', { type: 'button', class: 'btn btn--quiet detail__back' }, icon('back'), backTo);
    back.addEventListener('click', () => closePlace());

    const addrText = h('p', null, p.address || '地址未注明');
    const head = h('header', { class: 'detail__head' },
      h('p', { class: 'detail__kicker' }, glyph(p.cat, true), h('span', null, p.cat.zh), h('span', { class: 'sep', 'aria-hidden': 'true' }, '/'), h('span', null, `${CITIES[p.city].zh} ${CITIES[p.city].en}`),
        p.group && p.group.area ? [h('span', { class: 'sep', 'aria-hidden': 'true' }, '/'), h('span', null, p.group.area.zh)] : null),
      h('h2', { class: 'detail__name', tabindex: '-1' }, p.name),
      h('div', null, plateEl(p.plate)),
      h('div', { class: 'detail__address' }, addrText, p.address ? copyButton(() => p.address, '复制地址', addrText) : null));

    const parts = [back, head];
    if (p.description) parts.push(h('p', { class: 'detail__desc' }, richText(p.description)));
    parts.push(h('section', { class: 'openinfo', 'data-city': p.city, 'aria-labelledby': 'open-label' },
      h('h3', { class: 'label', id: 'open-label' }, '开放与安排'),
      openingBlocks(p.openingInfo, p.city)));

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

  /* ------------------------------------------------------------------ render dispatcher, states */

  function viewKey(tab) {
    if (tab === 'events') return `${state.gen}|${state.city}|${state.partition}|${evFilterKey()}`;
    if (tab === 'sources') return `${state.gen}`;
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
    } else if (tab === 'events') {
      state.partition = partitionKey();
      const key = viewKey('events');
      if (opts.force || view.dataset.key !== key) { renderEvents(); view.dataset.key = key; } else activateEvents();
    } else {
      const key = viewKey('sources');
      if (opts.force || view.dataset.key !== key) { renderSources(); view.dataset.key = key; } else applyMarkerFilter(null);
    }
    updateMapSolo();
    writeHash(opts);
  }

  /** 双城 on 活动 when one city has nothing coming up: give the whole map area to the other city. */
  function updateMapSolo() {
    let solo = '';
    if (state.data && state.city === 'BOTH' && state.tab === 'events') {
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
    try {
      const res = await fetch(CONTENT_PATH, { cache: 'no-cache' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      state.data = normalize(json);
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
    if (low === 'events' || low === 'sources') {
      setTab(low, { render: false });
      if (!mqDesktop.matches) setMapMin(true, { auto: true });
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
