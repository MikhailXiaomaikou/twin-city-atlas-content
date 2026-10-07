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
for (const r of guide.places) nodes.push(P.compilePlace({ id: r.id, name: r.name, category: r.category, lat: r.lat, lng: r.lng }, r));
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

test('Christmas Day: only open-air places, on foot', () => {
  const r = plan('2026-12-25', [600, 1080]);
  assert.ok(r.xmas);
  for (const s of r.stops) {
    assert.ok(s.node.hours && s.node.hours.always, s.node.id);
    assert.strictEqual(s.leg.mode, 'walk');
  }
});

test('near me suggests open places, nearest-and-best first', () => {
  const now = Object.assign({}, P.parseDateKey('2026-10-08'), { min: 11 * 60 });
  const list = P.suggest({ nodes, now, here: { lat: 51.5194, lng: -0.127 } });
  assert.ok(list.length >= 5);
  assert.ok(list.slice(0, 5).some((x) => x.node.id === 'london-british-museum'));
  for (const x of list) assert.ok(['open', 'soon', 'slot'].includes(x.kind));
});

console.log(`${n} checks passed`);
