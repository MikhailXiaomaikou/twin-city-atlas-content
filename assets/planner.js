/* 双城图志 · Twin City Atlas — London guide planner.
 * Pure functions, no DOM: opening-hours grammar, sun times, London wall-clock time, a travel-time model,
 * "what to do near me now" suggestions and a time-window itinerary planner (orienteering with time windows,
 * greedy insertion + a small deterministic iterated local search). Loaded before atlas.js; also runs in Node
 * (module.exports) so it can be tested without a browser.
 */
(function (root) {
  'use strict';

  const TZ = 'Europe/London';
  const DAY_MIN = 1440;
  const DAY_CODES = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'];
  const EARTH_KM = 6371.0088;

  /* ------------------------------------------------------------------ opening-hours grammar */

  const DAY_RE = /^(Mo|Tu|We|Th|Fr|Sa|Su)(?:-(Mo|Tu|We|Th|Fr|Sa|Su))?$/;
  const TIME_RE = /^(\d{1,2}):(\d{2})$/;

  /** "Mo-Fr,Su" → [0,1,2,3,4,6] (0 = Monday). null when not a day list. */
  function parseDays(spec) {
    const out = new Set();
    for (const part of spec.split(',')) {
      const m = part.trim().match(DAY_RE);
      if (!m) return null;
      const a = DAY_CODES.indexOf(m[1]);
      const b = m[2] ? DAY_CODES.indexOf(m[2]) : a;
      for (let i = a; ; i = (i + 1) % 7) { out.add(i); if (i === b) break; }
    }
    return Array.from(out).sort((x, y) => x - y);
  }
  function parseClock(s) {
    const m = String(s).trim().match(TIME_RE);
    if (!m) return null;
    const h = Number(m[1]);
    const mi = Number(m[2]);
    if (h > 48 || mi > 59) return null;
    return h * 60 + mi;
  }
  /** Split "Mo-Fr 10:00-17:00" into its day part and its time part; a rule without days means every day. */
  function splitRule(rule) {
    const r = rule.trim();
    const sp = r.indexOf(' ');
    const head = sp === -1 ? r : r.slice(0, sp);
    const days = parseDays(head);
    if (days) return { days, rest: sp === -1 ? '' : r.slice(sp + 1).trim() };
    return { days: [0, 1, 2, 3, 4, 5, 6], rest: r };
  }

  /**
   * Opening hours → { always, days: [7 × intervals|null] } with intervals [{s, e, dusk}] in minutes after the
   * day's midnight (e may pass 1440 for places open past midnight). Later rules replace earlier ones for the
   * days they name (OpenStreetMap semantics). Returns { error } when the string cannot be read.
   */
  function parseHours(str) {
    if (str == null) return null;
    const text = String(str).trim();
    if (!text) return null;
    if (/^24\/7$/i.test(text)) return { always: true, days: Array.from({ length: 7 }, () => [{ s: 0, e: DAY_MIN, dusk: false }]) };
    const days = Array.from({ length: 7 }, () => null);
    for (const rule of text.split(';')) {
      if (!rule.trim()) continue;
      if (/^PH\b/.test(rule.trim())) continue; // public-holiday rules: closures are listed as dates instead
      const { days: ds, rest } = splitRule(rule);
      let iv;
      if (/^(off|closed)$/i.test(rest)) iv = [];
      else if (/^24\/7$/i.test(rest)) iv = [{ s: 0, e: DAY_MIN, dusk: false }];
      else {
        iv = [];
        for (const range of rest.split(',')) {
          const [a, b] = range.split('-').map((x) => x.trim());
          const s = parseClock(a);
          if (s == null || b == null) return { error: `无法读取时间段“${range.trim()}”` };
          if (/^(dusk|sunset)$/i.test(b)) { iv.push({ s, e: null, dusk: true }); continue; }
          let e = parseClock(b);
          if (e == null) return { error: `无法读取时间段“${range.trim()}”` };
          if (e <= s) e += DAY_MIN;
          iv.push({ s, e, dusk: false });
        }
      }
      for (const d of ds) days[d] = iv;
    }
    return { always: false, days };
  }

  /** Fixed start times ("Mo-Sa 19:30; We,Sa 14:30") → [7 × sorted minutes]. Rules add up (matinées join evenings). */
  function parseSlots(str) {
    if (str == null || !String(str).trim()) return null;
    const days = Array.from({ length: 7 }, () => []);
    for (const rule of String(str).split(';')) {
      if (!rule.trim()) continue;
      const { days: ds, rest } = splitRule(rule);
      if (/^(off|closed)$/i.test(rest)) { for (const d of ds) days[d] = []; continue; }
      for (const t of rest.split(',')) {
        const m = parseClock(t);
        if (m == null) return { error: `无法读取开始时间“${t.trim()}”` };
        for (const d of ds) if (!days[d].includes(m)) days[d].push(m);
      }
    }
    for (const d of days) d.sort((a, b) => a - b);
    return { days };
  }

  /* ------------------------------------------------------------------ London wall-clock time */

  let partsFmt = null;
  function fmt() {
    if (!partsFmt) {
      partsFmt = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', hourCycle: 'h23' });
    }
    return partsFmt;
  }
  /** UTC ms → London { y, mo, d, min (minutes after midnight), dow (0 = Monday), key 'YYYY-MM-DD' }. */
  function londonParts(ts) {
    const p = {};
    for (const x of fmt().formatToParts(ts)) p[x.type] = x.value;
    const y = Number(p.year);
    const mo = Number(p.month);
    const d = Number(p.day);
    return dateInfo(y, mo, d, (Number(p.hour) % 24) * 60 + Number(p.minute));
  }
  function dateInfo(y, mo, d, min) {
    const dow = (new Date(Date.UTC(y, mo - 1, d)).getUTCDay() + 6) % 7;
    const key = `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    return { y, mo, d, min: min || 0, dow, key, md: key.slice(5) };
  }
  /** 'YYYY-MM-DD' → date info (min 0), or null. */
  function parseDateKey(key) {
    const m = String(key || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!m) return null;
    const dt = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
    if (dt.getUTCMonth() !== Number(m[2]) - 1) return null;
    return dateInfo(Number(m[1]), Number(m[2]), Number(m[3]), 0);
  }
  function addDays(date, n) {
    const dt = new Date(Date.UTC(date.y, date.mo - 1, date.d + n));
    return dateInfo(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate(), 0);
  }
  /** London local date + minutes after its midnight (may exceed 1440) → UTC ms. */
  function londonToUtc(date, min) {
    const wall = Date.UTC(date.y, date.mo - 1, date.d) + min * 60000;
    let guess = wall;
    for (let i = 0; i < 3; i += 1) {
      const p = londonParts(guess);
      const seen = Date.UTC(p.y, p.mo - 1, p.d) + p.min * 60000;
      const off = seen - (guess - (guess % 60000));
      const next = wall - off;
      if (next === guess) break;
      guess = next;
    }
    return guess;
  }

  /* ------------------------------------------------------------------ sun */

  /** Sunrise / sunset (UTC ms) for a date at lat/lng — the NOAA sunrise equation, about ±2 minutes. */
  function sunTimes(date, lat, lng) {
    const rad = Math.PI / 180;
    const jd = Date.UTC(date.y, date.mo - 1, date.d) / 86400000 + 2440587.5; // 00:00 UTC, so the ceil below lands on this date's noon
    const n = Math.ceil(jd - 2451545.0 + 0.0008);
    const jStar = n - lng / 360;
    const M = (357.5291 + 0.98560028 * jStar) % 360;
    const C = 1.9148 * Math.sin(M * rad) + 0.02 * Math.sin(2 * M * rad) + 0.0003 * Math.sin(3 * M * rad);
    const lambda = (M + C + 180 + 102.9372) % 360;
    const jTransit = 2451545.0 + jStar + 0.0053 * Math.sin(M * rad) - 0.0069 * Math.sin(2 * lambda * rad);
    const sinDec = Math.sin(lambda * rad) * Math.sin(23.4397 * rad);
    const cosDec = Math.cos(Math.asin(sinDec));
    const cosW = (Math.sin(-0.833 * rad) - Math.sin(lat * rad) * sinDec) / (Math.cos(lat * rad) * cosDec);
    if (cosW < -1 || cosW > 1) return null;
    const w = Math.acos(cosW) / rad;
    const toMs = (j) => Math.round((j - 2440587.5) * 86400000);
    return { rise: toMs(jTransit - w / 360), set: toMs(jTransit + w / 360) };
  }
  /** Sun for a London date as local minutes: { rise, set, dusk } (dusk ≈ when parks that "close at dusk" shut). */
  function sunLocal(date, lat = 51.5074, lng = -0.1278) {
    const s = sunTimes(date, lat, lng);
    if (!s) return { rise: 420, set: 1080, dusk: 1100 };
    const loc = (ms) => { const p = londonParts(ms); return p.min + (p.key > date.key ? 1440 : p.key < date.key ? -1440 : 0); };
    const rise = loc(s.rise);
    const set = loc(s.set);
    return { rise, set, dusk: set + 15 };
  }

  /* ------------------------------------------------------------------ places */

  const BEST_RANGES = {
    morning: [8 * 60, 12 * 60],
    midday: [11 * 60 + 30, 14 * 60 + 30],
    afternoon: [13 * 60, 17 * 60 + 30],
    evening: [17 * 60 + 30, 22 * 60],
    night: [21 * 60, 26 * 60],
  };
  const SCORE_VALUE = [0, 0.8, 2, 4.5, 8, 14]; // convex: one must-see outweighs several nice-to-haves

  function mdKey(s) { return /^\d{2}-\d{2}$/.test(s) ? s : null; }
  function inMdWindow(md, from, to) {
    if (!from || !to) return false;
    return from <= to ? md >= from && md <= to : md >= from || md <= to;
  }

  /**
   * Guide record (guide/london.json place or overlay) → planner node. `base` carries id/name/category/lat/lng.
   * Problems with the hours strings are collected in node.errors and the bad field is ignored.
   */
  function compilePlace(base, g) {
    const errors = [];
    const hours = parseHours(g.hours);
    if (hours && hours.error) errors.push(`hours: ${hours.error}`);
    const seasonal = [];
    for (const s of Array.isArray(g.seasonal) ? g.seasonal : []) {
      // a window overrides the hours, the show times, or both
      const hs = s && s.hours != null ? parseHours(s.hours) : null;
      const ss = s && s.slots != null ? parseSlots(s.slots) : null;
      if (!s || !mdKey(s.from) || !mdKey(s.to) || (!hs && !ss) || (hs && hs.error) || (ss && ss.error)) { errors.push(`seasonal: ${JSON.stringify(s)}`); continue; }
      seasonal.push({ from: s.from, to: s.to, hours: hs, slots: ss });
    }
    const slots = parseSlots(g.slots);
    if (slots && slots.error) errors.push(`slots: ${slots.error}`);
    const closed = new Set((Array.isArray(g.closed) ? g.closed : []).filter((x) => /^(\d{4}-)?\d{2}-\d{2}$/.test(x)));
    // dates: { from, to } for things that exist only for a while; `to` may be null for a new place opening on `from`
    const dates = g.dates && parseDateKey(g.dates.from) && (g.dates.to == null || parseDateKey(g.dates.to)) ? { from: g.dates.from, to: g.dates.to || null } : null;
    const visit = Number(g.visitMin);
    return {
      id: base.id,
      name: base.name,
      zh: g.zh || '',
      category: base.category,
      lat: base.lat,
      lng: base.lng,
      hours: hours && !hours.error ? hours : null,
      seasonal,
      slots: slots && !slots.error ? slots : null,
      closed,
      dates,
      lastEntry: Number.isFinite(Number(g.lastEntry)) && g.lastEntry != null ? Number(g.lastEntry) : null,
      visitMin: Number.isFinite(visit) && visit > 0 ? visit : 60,
      price: Number.isFinite(g.price) ? g.price : null,
      indoor: g.indoor === 'in' || g.indoor === 'out' ? g.indoor : 'mixed',
      best: new Set(Array.isArray(g.best) ? g.best : []),
      score: Math.max(1, Math.min(5, Math.round(Number(g.score) || 3))),
      tags: new Set(Array.isArray(g.tags) ? g.tags : []),
      plan: g.plan !== false,
      meal: base.category === 'FOOD' && g.meal !== false, // false for coffee bars and tea rooms
      spend: base.category === 'FOOD' || /人均/.test(g.priceNote || ''), // price is food & drink per head, not a ticket
      vary: g.hoursVary === true, // hours/slots change day to day: what is here is a cautious typical window
      xmas: g.xmasOpen === true, // open on Christmas Day, when almost everything else is shut
      errors,
    };
  }

  /** Open on Christmas Day: places open round the clock, and those the data marks as open that day (the Royal Parks). */
  const xmasOk = (node) => !!(node.hours && node.hours.always) || node.xmas === true;
  /** Is the node running on this date at all (date range, closure dates, Christmas Day)? */
  function runsOn(node, date) {
    if (node.dates && (date.key < node.dates.from || (node.dates.to && date.key > node.dates.to))) return false;
    if (node.closed.has(date.md) || node.closed.has(date.key)) return false;
    if (date.md === '12-25' && !xmasOk(node)) return false;
    return true;
  }
  /** Hours in force on a date (seasonal overrides win; the last matching window wins). */
  function hoursFor(node, date) {
    let h = node.hours;
    for (const s of node.seasonal) if (s.hours && inMdWindow(date.md, s.from, s.to)) h = s.hours;
    return h;
  }
  /**
   * Opening intervals on a date as [[open, close], …] in local minutes (close may exceed 1440).
   * [] = closed that day, null = hours unknown.
   */
  function intervalsOn(node, date, sun) {
    if (!runsOn(node, date)) return [];
    const h = hoursFor(node, date);
    if (!h) return node.slots ? [] : null;
    const iv = h.days[date.dow];
    if (!iv) return [];
    const dusk = sun ? sun.dusk : 17 * 60;
    return iv.map((x) => [x.s, x.dusk ? Math.max(x.s + 30, dusk) : x.e]).filter((x) => x[1] > x[0]).sort((a, b) => a[0] - b[0]);
  }
  function slotsOn(node, date) {
    if (!node.slots || !runsOn(node, date)) return [];
    let sl = node.slots;
    for (const s of node.seasonal) if (s.slots && inMdWindow(date.md, s.from, s.to)) sl = s.slots;
    return sl.days[date.dow].slice();
  }
  /** Weekly table: 7 × [[open, close]] / null (unknown), using the hours in force on `date`. */
  function weekTable(node, date, sun) {
    const out = [];
    const monday = addDays(date, -date.dow);
    for (let i = 0; i < 7; i += 1) {
      const d = addDays(monday, i);
      out.push({ date: d, iv: intervalsOn(node, d, sun), slots: slotsOn(node, d) });
    }
    return out;
  }

  /**
   * Open / closed now. `now` = London date info with .min. Looks at today and at yesterday's late intervals.
   * → { state: 'open'|'closed'|'unknown'|'slots', closesAt, opensAt (minutes, today's clock), left (min), nextSlot }
   */
  function statusAt(node, now, sunToday, sunYesterday) {
    if (node.slots) {
      const today = slotsOn(node, now).filter((s) => s >= now.min - 5);
      return { state: 'slots', nextSlot: today.length ? today[0] : null, later: today.slice(1) };
    }
    const today = intervalsOn(node, now, sunToday);
    const yday = intervalsOn(node, addDays(now, -1), sunYesterday || sunToday);
    if (today == null && yday == null) return { state: 'unknown' };
    for (const [o, c] of yday || []) if (c > DAY_MIN && now.min + DAY_MIN >= o && now.min + DAY_MIN < c) return { state: 'open', closesAt: c - DAY_MIN, left: c - DAY_MIN - now.min, lastEntryAt: node.lastEntry != null ? c - DAY_MIN - node.lastEntry : null };
    for (const [o, c] of today || []) {
      if (now.min >= o && now.min < c) return { state: 'open', closesAt: c, left: c - now.min, lastEntryAt: node.lastEntry != null ? c - node.lastEntry : null, always: o === 0 && c >= DAY_MIN };
    }
    const next = (today || []).find(([o]) => o > now.min);
    if (today == null) return { state: 'unknown' };
    return { state: 'closed', opensAt: next ? next[0] : null, closedToday: !(today || []).length };
  }

  /* ------------------------------------------------------------------ distance & travel */

  function haversineKm(a, b) {
    const rad = (x) => (x * Math.PI) / 180;
    const dLat = rad(b.lat - a.lat);
    const dLng = rad(b.lng - a.lng);
    const s = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
    return 2 * EARTH_KM * Math.asin(Math.sqrt(s));
  }
  /**
   * Door-to-door estimate. Walking: straight line × 1.25 for street detours at the pace's speed. Public transport:
   * ~10 min to reach a platform and wait, then the line distance × 1.3 at a speed that grows with distance
   * (Tube in zone 1 ≈ 19 km/h door to door, rail for day trips faster). Walk when it is ≤ walkMax minutes or barely slower.
   */
  function travel(a, b, opt = {}) {
    const km = haversineKm(a, b);
    const walkKmh = opt.walkKmh || 4.6;
    const walkMax = opt.walkMax || 20;
    const walkKm = km * 1.25;
    const walk = (walkKm / walkKmh) * 60;
    const speed = km < 6 ? 19 : km < 15 ? 26 : 40;
    const transit = 10 + ((km * 1.3) / speed) * 60;
    if (walk <= walkMax || walk <= transit + 4) return { min: Math.max(1, Math.round(walk)), mode: 'walk', km: walkKm };
    return { min: Math.round(transit), mode: 'transit', km: km * 1.3 };
  }

  /* ------------------------------------------------------------------ deterministic randomness */

  function hashStr(s) {
    let h = 2166136261 >>> 0;
    for (let i = 0; i < s.length; i += 1) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    return h >>> 0;
  }
  function rng(seed) {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /* ------------------------------------------------------------------ planner */

  const PACE = {
    relaxed: { visit: 1.25, walkKmh: 4.0, walkMax: 16, gap: 10 },
    normal: { visit: 1, walkKmh: 4.6, walkMax: 20, gap: 5 },
    packed: { visit: 0.75, walkKmh: 5.0, walkMax: 24, gap: 0 },
  };
  const LUNCH = [11 * 60 + 15, 14 * 60];
  const DINNER = [17 * 60 + 30, 20 * 60 + 30];
  const TEA = [14 * 60 + 30, 17 * 60 + 30];
  const MEAL_BONUS = 14;
  const TRAVEL_COST = 0.12; // value lost per minute on the move: a 25-min Tube ride must buy clearly more

  function inRange(m, r) { return m >= r[0] && m <= r[1]; }
  /** Sunset light: from an hour before sunset to twenty minutes after. */
  const nearSunset = (mid, sun) => mid >= sun.set - 60 && mid <= sun.set + 20;

  /**
   * Plan a route for one London date and time window.
   * opts: {
   *   nodes: planner nodes (compilePlace), date: date info, window: [startMin, endMin] (local, end may pass 1440),
   *   start: {lat, lng}, end: {lat, lng} | null (finish anywhere), sun: sunLocal(date),
   *   weights: { CATEGORY: weight }, pace: 'relaxed'|'normal'|'packed',
   *   freeOnly, rainy, kids, meals, pinned: Set(id), excluded: Set(id), extra: [event nodes], seed, iterations
   * }
   * → { stops: [{ node, arrive, start, end, wait, leg, meal }], back, endT, value, totals, unplaced: [{node, why}], needs }
   */
  function plan(opts) {
    const RATIO_POW = opts.ratioPow || 1; // value per added minute (squared favoured long stops too much on this data)
    const pace = PACE[opts.pace] || PACE.normal;
    const date = opts.date;
    const sun = opts.sun || sunLocal(date);
    const [t0, t1] = opts.window;
    const pinned = opts.pinned || new Set();
    const excluded = opts.excluded || new Set();
    const weights = opts.weights || {};
    // Christmas Day: no Tube or buses, and almost everything with a door is shut. Walk, and only open-air places.
    const xmas = date.md === '12-25';
    const legOpt = { walkKmh: pace.walkKmh, walkMax: xmas ? 1e9 : pace.walkMax };
    const meals = !!opts.meals && !xmas;
    const span = t1 - t0;

    // candidate pool: runnable today, inside the window, reachable and back
    const pool = [];
    const unplaced = [];
    const all = (opts.nodes || []).concat(opts.extra || []);
    for (const n of all) {
      if (n.lat == null || n.lng == null) continue;
      const isPinned = pinned.has(n.id);
      if (excluded.has(n.id) && !isPinned) continue;
      if (!n.plan && !isPinned && !n.event) continue;
      const w = n.event ? (weights.EVENT || 0) : weights[n.category] == null ? 1 : weights[n.category];
      if (w <= 0 && !isPinned) continue;
      // free only: known free (or tagged free with no fixed price); meals are allowed
      if (opts.freeOnly && n.price !== 0 && !(n.price == null && n.tags.has('free')) && n.category !== 'FOOD' && !isPinned) continue;
      if (n.tags.has('daytrip') && span < 300 && !isPinned) continue;
      const iv = n.slots ? null : intervalsOn(n, date, sun);
      const slots = n.slots ? slotsOn(n, date) : null;
      const dur = Math.max(15, Math.round(n.visitMin * (n.slots || n.event ? 1 : pace.visit)));
      const node = { n, w, iv, slots, dur, pinned: isPinned, idx: pool.length };
      let why = '';
      const pre = n.event ? 10 : 15;
      const fitsIv = ([o, c]) => {
        const s = Math.max(o, t0);
        return s <= (n.lastEntry != null ? c - n.lastEntry : c) && Math.min(c, t1) - s >= Math.max(15, dur * 0.7);
      };
      if (xmas && !xmasOk(n)) why = '圣诞节当天关闭';
      else if (slots && !slots.some((s) => s - pre >= t0 && s + dur <= t1)) {
        why = !slots.length ? '这一天没有场次' : slots.some((s) => s - pre >= t0 && s < t1) ? `所选时段结束前看不完（约 ${dur} 分钟），把时间条往后拉` : '所选时段内没有场次';
      } else if (!slots && iv == null) why = n.vary ? '开放时间每天不同，先在官网日历查好当天时间' : '开放时间未知';
      else if (!slots && !iv.some(fitsIv)) {
        why = !iv.length ? '这一天不开放' : iv.some(([o, c]) => Math.min(c, t1) > Math.max(o, t0)) ? '所选时段内来不及游览（开放时间或最后入场不够）' : '所选时段内不开放';
      }
      if (!why) {
        const out = travel(opts.start, n, legOpt).min;
        const back = opts.end ? travel(n, opts.end, legOpt).min : 0;
        if (out + Math.min(dur, 45) + back > span) why = '离起点太远，时间不够往返';
      }
      if (why) { if (isPinned) unplaced.push({ node: n, why }); continue; }
      pool.push(node);
    }
    // keep the search small: pinned + the most promising others
    const potential = (x) => (x.pinned ? 1e9 : SCORE_VALUE[x.n.score] * x.w / (1 + travel(opts.start, x.n, legOpt).min / 25));
    pool.sort((a, b) => potential(b) - potential(a));
    const cands = pool.slice(0, opts.maxCandidates || 110);
    cands.forEach((c, i) => { c.idx = i; });

    // leg cache (index -1 = start, -2 = end)
    const legCache = new Map();
    const pt = (i) => (i === -1 ? opts.start : i === -2 ? opts.end : cands[i].n);
    function leg(i, j) {
      const k = i * 1000 + j;
      let v = legCache.get(k);
      if (!v) { v = travel(pt(i), pt(j), legOpt); legCache.set(k, v); }
      return v;
    }

    function fitWindow(c, arrive) {
      if (c.slots) {
        for (const s of c.slots) {
          const pre = c.n.event ? 10 : 15;
          if (s - pre < arrive) continue;
          if (s - pre - arrive > 75 && !c.pinned) return null; // too long a wait for the next performance
          return { start: s - pre, end: s + c.dur, slot: s };
        }
        return null;
      }
      for (const [o, cl] of c.iv) {
        const s = Math.max(arrive, o);
        const latest = c.n.lastEntry != null ? cl - c.n.lastEntry : cl - Math.min(30, c.dur * 0.5);
        if (s > latest) continue;
        const e = Math.min(s + c.dur, cl);
        if (e - s < Math.max(15, Math.min(c.dur, c.dur * 0.7))) continue;
        if (s - arrive > 50 && !c.pinned) return null; // don't stand outside for an hour
        return { start: s, end: e };
      }
      return null;
    }

    function timeFit(c, s, e) {
      const n = c.n;
      const mid = (s + e) / 2;
      let f = 1;
      if (n.best.size) {
        let hit = false;
        for (const b of n.best) {
          if (b === 'sunset') { if (nearSunset(mid, sun)) hit = true; continue; }
          const r = BEST_RANGES[b];
          if (r && mid >= r[0] && mid <= r[1]) hit = true;
        }
        f *= hit ? 1.25 : 0.9;
        if (n.best.has('sunset') && nearSunset(mid, sun)) f *= 1.3;
      }
      if (n.category === 'NIGHT' && !c.slots && s < 16 * 60) f *= 0.55;
      // a ticketed matinée eats an afternoon: only when nightlife was asked for
      if (n.category === 'NIGHT' && c.slots && s < 17 * 60 && !(c.w > 1)) f *= 0.5;
      const dark = Math.max(0, e - Math.max(s, sun.set + 30)) >= 0.5 * Math.max(1, e - s) && !n.best.has('night') && !n.best.has('evening');
      if (dark && n.category === 'NATURE') f *= 0.12; // a park in the dark is not worth the trip
      else if (dark && (n.indoor === 'out' || n.category === 'STROLL')) f *= 0.6;
      if (n.tags.has('tea') && inRange(s, TEA)) f *= 1.3;
      return f;
    }

    const isShow = (x) => !!x.slots && x.n.category === 'NIGHT' && !x.n.event;
    /** Walk the route: times, feasibility, value. null when infeasible. */
    function evaluate(route) {
      let t = t0;
      let at = -1;
      let value = 0;
      let lunch = false;
      let dinner = false;
      let mealEnd = -1e9;
      let snack = null; // the last food stop that was not a meal, in case a meal follows straight after
      const cat = new Map();
      const stops = [];
      // at most one ticketed show unless more are must-go
      let shows = route.some((i) => cands[i].pinned && isShow(cands[i])) ? 1 : 0;
      for (let k = 0; k < route.length; k += 1) {
        const c = cands[route[k]];
        const lg = leg(at, c.idx);
        if (xmas && lg.min > 45) return null; // on foot all day: no hour-long walks
        const arrive = t + lg.min + (k ? pace.gap : 0);
        const win = fitWindow(c, arrive);
        if (!win) return null;
        // A three-hour museum is worth more than a twenty-minute photo stop of the same rating (but not nine times more).
        const stay = Math.max(1, win.end - win.start);
        let v = SCORE_VALUE[c.n.score] * c.w * timeFit(c, win.start, win.end) * Math.min(2.2, Math.max(0.45, Math.pow(stay / 60, 0.75)));
        if (opts.rainy) v *= c.n.indoor === 'in' ? 1.35 : c.n.indoor === 'mixed' ? 0.9 : 0.4;
        if (opts.kids && c.n.tags.has('kids')) v *= 1.4;
        if (opts.kids && (c.n.tags.has('pub') || c.n.tags.has('bar'))) v *= 0.2;
        if (isShow(c) && !c.pinned) { if (shows) v *= 0.1; shows += 1; }
        if (c.n.event) v *= 1.6; // a one-off today beats a museum that is there every day
        let meal = null;
        if (c.n.category === 'FOOD') {
          const light = !c.n.meal;
          if (meals && !light && !lunch && inRange(win.start, LUNCH)) { lunch = true; meal = 'lunch'; v += MEAL_BONUS; }
          else if (meals && !light && !dinner && inRange(win.start, DINNER)) { dinner = true; meal = 'dinner'; v += MEAL_BONUS; }
          else {
            if (!light && !c.n.tags.has('market')) v *= 0.3;
            if (light && c.n.tags.has('tea') && !inRange(win.start, TEA)) v *= 0.35;
            if (win.start - mealEnd < 150) v *= 0.3; // just ate
          }
          if (meal) {
            v -= 0.6 * Math.max(0, lg.min - 10); // eat near the route, not across town
            mealEnd = win.end;
            if (snack && win.start - snack.end < 150) value -= snack.v * 0.7; // a food stop right before a meal
            snack = null;
          }
        }
        const seen = cat.get(c.n.category) || 0;
        if (!meal) v *= Math.pow(0.8, seen);
        cat.set(c.n.category, seen + 1);
        if (c.pinned) v += 1000;
        if (c.n.category === 'FOOD' && !meal && !c.pinned) snack = { v, end: win.end };
        value += v - TRAVEL_COST * lg.min;
        stops.push({ c, arrive, start: win.start, end: win.end, slot: win.slot, wait: win.start - arrive, leg: lg, meal, value: v });
        t = win.end;
        at = c.idx;
      }
      const back = opts.end ? leg(at, -2) : null;
      const endT = t + (back ? back.min : 0);
      if (endT > t1) return null;
      if (back) value -= TRAVEL_COST * back.min;
      return { route, stops, value, endT, back };
    }

    // greedy insertion, best value²/added-time ratio
    function improve(cur, allowed) {
      const used = new Set(cur.route);
      for (;;) {
        let best = null;
        let bestRatio = 0;
        for (const c of cands) {
          if (used.has(c.idx) || (allowed && !allowed(c))) continue;
          for (let pos = 0; pos <= cur.route.length; pos += 1) {
            const r = cur.route.slice(0, pos).concat(c.idx, cur.route.slice(pos));
            const ev = evaluate(r);
            if (!ev) continue;
            const gain = ev.value - cur.value;
            if (gain <= 0.01) continue;
            const extra = Math.max(5, ev.endT - cur.endT);
            const ratio = Math.pow(gain, RATIO_POW) / extra;
            if (ratio > bestRatio) { bestRatio = ratio; best = ev; }
          }
        }
        if (!best) return cur;
        cur = best;
        for (const i of cur.route) used.add(i);
      }
    }
    /** Reverse segments, or move one stop elsewhere, while that adds value or shortens the day without losing value. */
    function twoOpt(cur) {
      const gain = (ev) => ev && (ev.value > cur.value + 1e-6 || (ev.value >= cur.value - 1e-6 && ev.endT < cur.endT - 0.5));
      let changed = true;
      while (changed) {
        changed = false;
        for (let i = 0; i < cur.route.length - 1; i += 1) {
          for (let j = i + 1; j < cur.route.length; j += 1) {
            const ev = evaluate(cur.route.slice(0, i).concat(cur.route.slice(i, j + 1).reverse(), cur.route.slice(j + 1)));
            if (gain(ev)) { cur = ev; changed = true; }
          }
        }
        // relocate: e.g. the palace next to the guard change instead of a walk back later
        for (let i = 0; i < cur.route.length; i += 1) {
          for (let j = 0; j < cur.route.length; j += 1) {
            if (i === j) continue;
            const r = cur.route.slice();
            r.splice(j, 0, r.splice(i, 1)[0]);
            const ev = evaluate(r);
            if (gain(ev)) { cur = ev; changed = true; }
          }
        }
      }
      return cur;
    }
    const better = (a, b) => a.value > b.value + 1e-6 || (Math.abs(a.value - b.value) <= 1e-6 && a.endT < b.endT);

    const empty = { route: [], stops: [], value: 0, endT: t0 + (opts.end ? leg(-1, -2).min : 0), back: opts.end ? leg(-1, -2) : null };
    if (empty.endT > t1) return finish(empty, unplaced.concat(cands.filter((c) => c.pinned).map((c) => ({ node: c.n, why: '时间太短' }))));
    // Must-go places first, most important first, each where it adds the least time.
    let cur = empty;
    const pins = cands.filter((c) => c.pinned).sort((a, b) => b.n.score - a.n.score || b.dur - a.dur);
    for (const c of pins) {
      const mealPin = meals && c.n.meal;
      let best = null;
      for (let pos = 0; pos <= cur.route.length; pos += 1) {
        const ev = evaluate(cur.route.slice(0, pos).concat(c.idx, cur.route.slice(pos)));
        if (ev && (!best || (mealPin ? better(ev, best) : ev.endT < best.endT))) best = ev;
      }
      if (best) cur = best;
    }
    cur = twoOpt(improve(cur));
    let best = cur;
    const rand = rng(opts.seed != null ? opts.seed : 7);
    const iters = opts.iterations != null ? opts.iterations : 24;
    for (let it = 0; it < iters && best.route.length; it += 1) {
      // shake: drop a short run of unpinned stops, rebuild, polish
      const r = best.route.slice();
      const len = 1 + Math.floor(rand() * Math.min(3, r.length));
      const at = Math.floor(rand() * r.length);
      const kept = r.filter((idx, k) => k < at || k >= at + len || cands[idx].pinned);
      const base = evaluate(kept);
      if (!base) continue;
      const cand = twoOpt(improve(base));
      if (better(cand, best)) best = cand;
    }
    const placed = new Set(best.route);
    for (const c of pins) {
      if (placed.has(c.idx)) continue;
      unplaced.push({ node: c.n, why: evaluate([c.idx]) ? '与其他必去地点的时间冲突，排不进去' : '所选时段内放不下（开放时间、演出结束时间或路程不够）' });
    }
    return finish(best, unplaced);

    function finish(res, miss) {
      let walkKm = 0;
      let walkMin = 0;
      let transitMin = 0;
      let visitMin = 0;
      let waitMin = 0;
      let cost = 0;
      let costKnown = true;
      let food = 0;
      let foodKnown = true;
      const legs = res.stops.map((s) => s.leg).concat(res.back ? [res.back] : []);
      for (const lg of legs) { if (lg.mode === 'walk') { walkKm += lg.km; walkMin += lg.min; } else transitMin += lg.min; }
      for (const s of res.stops) {
        visitMin += s.end - s.start;
        waitMin += s.wait;
        const n = s.c.n;
        if (n.spend) { if (!n.price) foodKnown = false; else food += n.price; } else if (n.price == null) costKnown = false; else cost += n.price;
      }
      const needs = {
        lunch: !!opts.meals && t0 <= LUNCH[0] && t1 >= LUNCH[1] + 45,
        dinner: !!opts.meals && t0 <= DINNER[0] && t1 >= DINNER[0] + 120,
      };
      return {
        stops: res.stops.map((s) => ({ node: s.c.n, arrive: s.arrive, start: s.start, end: s.end, slot: s.slot, wait: s.wait, leg: s.leg, meal: s.meal, pinned: s.c.pinned })),
        back: res.back,
        endT: res.endT,
        value: res.value,
        totals: { walkKm, walkMin, transitMin, visitMin, waitMin, cost, costKnown, food, foodKnown },
        unplaced: miss,
        needs: xmas ? { lunch: false, dinner: false } : needs,
        xmas,
        hadLunch: res.stops.some((s) => s.meal === 'lunch'),
        hadDinner: res.stops.some((s) => s.meal === 'dinner'),
        sun,
      };
    }
  }

  /* ------------------------------------------------------------------ near me, now */

  /**
   * What to do from `here` at London time `now` (date info with .min).
   * → [{ node, travel, status, score, reasons: [text], kind: 'open'|'soon'|'slot' }] best first.
   */
  function suggest(opts) {
    const now = opts.now;
    const sun = opts.sun || sunLocal(now);
    const sunY = sunLocal(addDays(now, -1));
    const out = [];
    for (const n of opts.nodes || []) {
      if (!n.plan || n.lat == null) continue;
      if (opts.excluded && opts.excluded.has(n.id)) continue;
      const tr = travel(opts.here, n, now.md === '12-25' ? { walkMax: 1e9 } : undefined); // no Tube on Christmas Day
      if (tr.min > (opts.maxMin || 45)) continue;
      const st = statusAt(n, now, sun, sunY);
      const arrive = now.min + tr.min;
      let kind = null;
      let room = 0;
      if (st.state === 'open') {
        const until = st.lastEntryAt != null ? st.lastEntryAt : now.min + st.left - Math.min(30, n.visitMin * 0.5);
        room = now.min + st.left - arrive;
        if (arrive <= until && room >= Math.min(45, n.visitMin * 0.6)) kind = 'open';
      } else if (st.state === 'closed' && st.opensAt != null && st.opensAt - now.min <= 75 && st.opensAt >= arrive - 10) kind = 'soon';
      else if (st.state === 'slots' && st.nextSlot != null && st.nextSlot - arrive >= 10 && st.nextSlot - now.min <= 240) kind = 'slot';
      if (!kind) continue;
      let v = SCORE_VALUE[n.score] * (opts.weights && opts.weights[n.category] != null ? opts.weights[n.category] : 1);
      if (v <= 0) continue;
      const reasons = [];
      const mid = arrive + Math.min(n.visitMin, 90) / 2;
      if (n.best.has('sunset') && nearSunset(mid, sun) && now.min < sun.set) { v *= 1.6; reasons.push('sunset'); }
      else {
        for (const b of n.best) { const r = BEST_RANGES[b]; if (r && mid >= r[0] && mid <= r[1]) { v *= 1.2; reasons.push('best'); break; } }
      }
      if (n.category === 'NIGHT' && kind === 'open' && now.min < 16 * 60) v *= 0.5;
      if (n.category === 'FOOD' && (inRange(now.min + tr.min, LUNCH) || inRange(now.min + tr.min, DINNER))) { v *= 1.5; reasons.push('meal'); }
      if (n.indoor === 'out' && now.min > sun.set + 20 && !n.best.has('night') && !n.best.has('evening')) v *= 0.4;
      if (opts.rainy) v *= n.indoor === 'in' ? 1.4 : n.indoor === 'out' ? 0.35 : 0.9;
      if (kind === 'soon') v *= 0.7;
      if (kind === 'open' && room < 75 && st.left < DAY_MIN) reasons.push('closing');
      if (n.price === 0 && !n.spend) reasons.push('free');
      const score = v / (1 + tr.min / 12);
      out.push({ node: n, travel: tr, status: st, kind, score, reasons, room });
    }
    out.sort((a, b) => b.score - a.score);
    return out;
  }

  const api = {
    TZ, DAY_CODES, BEST_RANGES, SCORE_VALUE, PACE, LUNCH, DINNER,
    parseHours, parseSlots, compilePlace, intervalsOn, slotsOn, weekTable, statusAt, runsOn, xmasOk,
    londonParts, londonToUtc, parseDateKey, addDays, dateInfo, sunTimes, sunLocal,
    haversineKm, travel, plan, suggest, hashStr,
  };
  root.TCAPlanner = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
