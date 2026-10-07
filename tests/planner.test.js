/* Planner checks: `node tests/planner.test.js` from the repository root (no dependencies). */
'use strict';
const assert = require('assert');
const P = require('../assets/planner.js');
const guide = require('../guide/london.json');
const content = require('../content.json');

let n = 0;
const test = (name, fn) => { fn(); n += 1; console.log('ok', n, name); };
const hm = (m) => `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

test('opening-hours grammar', () => {
  const h = P.parseHours('Mo-Su 10:00-17:00; Fr 10:00-20:30; Su off');
  assert.deepStrictEqual(h.days[4], [{ s: 600, e: 1230, dusk: false }]);
  assert.deepStrictEqual(h.days[6], []);
  assert.strictEqual(P.parseHours('Fr,Sa 11:00-01:00').days[4][0].e, 1500); // past midnight
  assert.ok(P.parseHours('Mo-Su 07:00-dusk').days[0][0].dusk);
  assert.ok(P.parseHours('24/7').always);
  assert.ok(P.parseHours('Mo-Su 10:00-1700').error);
  assert.deepStrictEqual(P.parseSlots('Mo-Sa 19:30; Th,Sa 14:30').days[5], [870, 1170]); // matinées add up
});

test('London wall clock and sun', () => {
  const d = P.parseDateKey('2026-10-07');
  assert.strictEqual(d.dow, 2); // Wednesday
  assert.strictEqual(new Date(P.londonToUtc(d, 600)).toISOString(), '2026-10-07T09:00:00.000Z'); // BST
  assert.strictEqual(new Date(P.londonToUtc(P.parseDateKey('2026-10-25'), 600)).toISOString(), '2026-10-25T10:00:00.000Z'); // GMT
  const sun = P.sunLocal(d);
  assert.ok(Math.abs(sun.rise - (7 * 60 + 10)) <= 4 && Math.abs(sun.set - (18 * 60 + 26)) <= 4, `${hm(sun.rise)} ${hm(sun.set)}`);
  const dec = P.sunLocal(P.parseDateKey('2026-12-21'));
  assert.ok(Math.abs(dec.set - (15 * 60 + 53)) <= 4, hm(dec.set));
});

// planner nodes from the real guide data
const nodes = [];
for (const r of guide.places) if (!r.hold) nodes.push(P.compilePlace({ id: r.id, name: r.name, category: r.category, lat: r.lat, lng: r.lng }, r));
for (const [id, o] of Object.entries(guide.overlays)) {
  const p = content.places.find((x) => x.id === id);
  nodes.push(P.compilePlace({ id, name: p.name, category: p.category, lat: p.latitude, lng: p.longitude }, o));
}
const W = { LANDMARK: 1, CULTURE: 1, VIEW: 1, NATURE: 1, FOOD: 1, NIGHT: 1, SHOP: 1, STROLL: 1, COURSE: 0, CHESS: 0, SCHOOL: 0, EVENT: 0 };
const START = { lat: 51.508, lng: -0.1247 };
const plan = (date, win, extra = {}) => P.plan(Object.assign({ nodes, date: P.parseDateKey(date), window: win, start: START, end: null, weights: W, pace: 'normal', meals: true, seed: 1 }, extra));

test('every guide hours string parses', () => {
  const bad = nodes.filter((x) => x.errors.length).map((x) => `${x.id}: ${x.errors.join('; ')}`);
  assert.deepStrictEqual(bad, []);
});

test('a full day: feasible, inside opening hours, with lunch and dinner', () => {
  const date = P.parseDateKey('2026-10-08');
  const r = plan('2026-10-08', [570, 1260]);
  assert.ok(r.stops.length >= 4, `${r.stops.length} stops`);
  assert.ok(r.endT <= 1260);
  assert.ok(r.hadLunch && r.hadDinner);
  const sun = P.sunLocal(date);
  for (const s of r.stops) {
    if (s.node.slots) { assert.ok(P.slotsOn(s.node, date).includes(s.slot)); continue; }
    const iv = P.intervalsOn(s.node, date, sun);
    assert.ok(iv.some(([o, c]) => s.start >= o && s.end <= c), `${s.node.id} ${hm(s.start)}–${hm(s.end)} vs ${JSON.stringify(iv)}`);
  }
  for (let i = 1; i < r.stops.length; i += 1) assert.ok(r.stops[i].arrive >= r.stops[i - 1].end);
  // meals are counted as food spend, not tickets
  const sum = (f) => r.stops.filter((s) => f(s.node) && s.node.price != null).reduce((a, s) => a + s.node.price, 0);
  assert.ok(r.totals.food > 0);
  assert.strictEqual(r.totals.food, sum((x) => x.spend));
  assert.strictEqual(r.totals.cost, sum((x) => !x.spend));
});

test('pinned places come first; impossible ones are reported', () => {
  const pinned = new Set(['london-tower-of-london', 'london-show-harry-potter-cursed-child']);
  const r = plan('2026-10-08', [570, 1080], { pinned }); // the show only opens on 9 Oct
  assert.ok(r.stops.some((s) => s.node.id === 'london-tower-of-london'));
  assert.ok(r.unplaced.some((u) => u.node.id === 'london-show-harry-potter-cursed-child'));
});

test('dated closures are respected (Royal Observatory shut from 2 Nov 2026)', () => {
  const pinned = new Set(['london-royal-observatory-greenwich']);
  const before = plan('2026-10-20', [600, 1020], { pinned, start: { lat: 51.4826, lng: -0.0096 } });
  const after = plan('2026-11-12', [600, 1020], { pinned, start: { lat: 51.4826, lng: -0.0096 } });
  assert.ok(before.stops.some((s) => s.node.id === 'london-royal-observatory-greenwich'));
  assert.ok(after.unplaced.some((u) => u.node.id === 'london-royal-observatory-greenwich'));
});

test('open-ended dates: a new place counts from its opening day', () => {
  const n = P.compilePlace({ id: 'x', name: 'x', category: 'CULTURE', lat: 51.5, lng: -0.1 }, { hours: 'Mo-Su 10:00-17:00', dates: { from: '2026-11-28', to: null } });
  assert.deepStrictEqual(n.dates, { from: '2026-11-28', to: null });
  assert.strictEqual(P.runsOn(n, P.parseDateKey('2026-11-27')), false);
  assert.strictEqual(P.runsOn(n, P.parseDateKey('2027-06-01')), true);
});

test('day-varying places: planned inside their cautious window, or explained', () => {
  const pinned = new Set(['london-madame-tussauds', 'london-dennis-severs-house']);
  const r = plan('2026-10-08', [570, 1080], { pinned });
  const mt = r.stops.find((s) => s.node.id === 'london-madame-tussauds');
  assert.ok(mt && mt.node.vary && mt.start >= 600 && mt.end <= 900, mt && `${hm(mt.start)}–${hm(mt.end)}`);
  const ds = r.unplaced.find((u) => u.node.id === 'london-dennis-severs-house');
  assert.ok(ds && /官网日历/.test(ds.why), ds && ds.why);
  for (const g of guide.places) if (g.hoursVary) assert.ok(/^https:\/\//.test(g.calendarUrl), g.id);
});

test('held places are not planned', () => {
  const held = new Set(guide.places.filter((g) => g.hold).map((g) => g.id));
  assert.ok(held.size >= 1);
  assert.ok(nodes.every((x) => !held.has(x.id)));
  for (const r of guide.routes) for (const id of r.stops) assert.ok(!held.has(id), `${r.id} uses held ${id}`);
});

test('Christmas Day: only open-air places, on foot — in the plan and in near me', () => {
  const r = plan('2026-12-25', [600, 1080]);
  assert.ok(r.xmas);
  assert.ok(r.stops.length >= 3);
  for (const s of r.stops) {
    assert.ok(P.xmasOk(s.node), s.node.id);
    assert.strictEqual(s.leg.mode, 'walk');
    assert.ok(s.leg.min <= 45, `${s.node.id} ${s.leg.min} min`);
  }
  const now = Object.assign({}, P.parseDateKey('2026-12-25'), { min: 11 * 60 });
  const near = P.suggest({ nodes, now, here: START });
  assert.ok(near.length >= 3);
  for (const x of near) { assert.ok(P.xmasOk(x.node), x.node.id); assert.strictEqual(x.travel.mode, 'walk'); }
});

test('pins: a placed must-go is never also reported missing; a lone pin gets the true reason', () => {
  for (const r of guide.routes) {
    for (const day of ['2026-10-10', '2026-10-14', '2026-11-12', '2026-12-05']) {
      const res = plan(day, r.window, { pinned: new Set(r.stops), start: START });
      const placed = new Set(res.stops.map((s) => s.node.id));
      for (const u of res.unplaced) assert.ok(!placed.has(u.node.id), `${r.id} ${day}: ${u.node.id}`);
    }
  }
  const les = plan('2026-10-12', [600, 1260], { pinned: new Set(['london-show-les-miserables']) });
  const u = les.unplaced.find((x) => x.node.id === 'london-show-les-miserables');
  assert.ok(u && /看不完|放不下/.test(u.why), u && u.why);
});

test('the park is open all day (the pelican feeding is only a tip), and free only means free', () => {
  const sjp = nodes.find((x) => x.id === 'london-st-jamess-park');
  const st = P.statusAt(sjp, Object.assign({}, P.parseDateKey('2026-10-08'), { min: 16 * 60 }), P.sunLocal(P.parseDateKey('2026-10-08')));
  assert.strictEqual(st.state, 'open');
  const r = plan('2026-12-05', [1050, 1410], { freeOnly: true });
  for (const s of r.stops) if (!s.node.spend) assert.ok(s.node.price === 0 || (s.node.price == null && s.node.tags.has('free')), s.node.id);
});

test('sun times are wall-clock minutes on the clock-change day', () => {
  const sun = P.sunLocal(P.parseDateKey('2026-10-25'));
  assert.ok(Math.abs(sun.set - (16 * 60 + 47)) <= 4, hm(sun.set));
});

test('near me suggests open places, nearest-and-best first', () => {
  const now = Object.assign({}, P.parseDateKey('2026-10-08'), { min: 11 * 60 });
  const list = P.suggest({ nodes, now, here: { lat: 51.5194, lng: -0.127 } });
  assert.ok(list.length >= 5);
  assert.ok(list.slice(0, 5).some((x) => x.node.id === 'london-british-museum'));
  for (const x of list) assert.ok(['open', 'soon', 'slot'].includes(x.kind));
});

console.log(`${n} checks passed`);
