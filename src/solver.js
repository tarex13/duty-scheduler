// The scheduler: local search with restarts, exactly as in the spec.
// Pure JS (no React, no Supabase). Each house is solved on its own.
//
//   generateSchedule(...)  → assignments for both houses (Generate / Regenerate)
//   reviewSchedule(...)    → conflicts + stats for any schedule (Stage 5 panels)

import { isWeekend } from './calendarLogic';
import { DUTY_GROUPS, groupOf, listDays } from './preflightChecks';

// ---------- the policy knobs ----------

export const WEIGHTS = {
  unfilled: 100000,          // per empty day
  belowMin: 100000,          // per shift a don is short of min_total
  belowWeekendMin: 100000,   // per Fri/Sat shift short of min_weekend
  overMax: 100000,           // per shift over max (only possible through an admin pin)
  forbidden: 100000,         // don on a day they can't work (only possible through an admin pin)
  overSoftCap: 5000,         // per shift above 3 this month
  consecutive: 1000,         // per back-to-back pair
  spacing: 10,               // × (5 − gap)² for gaps of 2–4 days: 90, 40, 10
  nonVolunteerExtra: 40,     // per shift above min_total for a non-volunteer
  nonVolunteerWeekendExtra: 20, // per Fri/Sat above min_weekend for a non-volunteer
};
export const RANK_COST = { 1: 0, 2: 1, 3: 3, 4: 6 };
export const RANK_COST_BEYOND = 10; // admin-entered ranks 5+
export const UNRANKED_COST = 15;
export const SOFT_CAP = 3;

const rankCost = (r) => (r === 0 ? UNRANKED_COST : RANK_COST[r] ?? RANK_COST_BEYOND);

// Small seeded random generator, so a run can be reproduced from its seed.
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const randomSeed = () => Math.floor(Math.random() * 2 ** 31);

// ---------- model: one house, everything as arrays for speed ----------

function buildModel({ days, houseDons, preferences, submissions }) {
  const dayIndex = new Map(days.map((d, j) => [d, j]));
  const donIndex = new Map(houseDons.map((d, i) => [d.id, i]));
  const volunteer = new Set(submissions.filter((s) => s.volunteer_extra).map((s) => s.don_id));
  const N = days.length;

  const dons = houseDons.map((d) => ({
    id: d.id,
    name: d.name,
    minTotal: d.min_total,
    maxTotal: d.max_total,
    minWk: d.min_weekend,
    maxWk: d.max_weekend,
    volunteer: volunteer.has(d.id),
  }));
  const rank = dons.map(() => new Int32Array(N));     // 0 = unranked
  const no = dons.map(() => new Uint8Array(N));

  for (const p of preferences) {
    const i = donIndex.get(p.don_id);
    const j = dayIndex.get(p.date);
    if (i === undefined || j === undefined) continue;
    if (p.kind === 'rank') rank[i][j] = p.rank;
    if (p.kind === 'no') no[i][j] = 1;
  }

  const weekend = days.map(isWeekend);
  // Hard eligibility (ignoring how many shifts they already have)
  const can = dons.map((d, i) =>
    days.map((_, j) => d.maxTotal > 0 && !no[i][j] && !(weekend[j] && d.maxWk <= 0)),
  );

  return { days, dayIndex, donIndex, dons, rank, no, weekend, can };
}

// ---------- score (lower is better) ----------

function evaluate(model, assign) {
  const { dons, rank, can, weekend } = model;
  const D = dons.length;
  const total = new Int32Array(D);
  const wk = new Int32Array(D);
  const last = new Int32Array(D).fill(-100);
  let s = 0;

  for (let j = 0; j < assign.length; j++) {
    const d = assign[j];
    if (d < 0) { s += WEIGHTS.unfilled; continue; }
    total[d]++;
    if (weekend[j]) wk[d]++;
    s += rankCost(rank[d][j]);
    if (!can[d][j]) s += WEIGHTS.forbidden;
    const gap = j - last[d]; // days are consecutive dates, so index gap = day gap
    if (gap === 1) s += WEIGHTS.consecutive;
    else if (gap <= 4) s += (5 - gap) ** 2 * WEIGHTS.spacing;
    last[d] = j;
  }

  for (let d = 0; d < D; d++) {
    const don = dons[d];
    s += Math.max(0, don.minTotal - total[d]) * WEIGHTS.belowMin;
    s += Math.max(0, don.minWk - wk[d]) * WEIGHTS.belowWeekendMin;
    s += Math.max(0, total[d] - don.maxTotal) * WEIGHTS.overMax;
    s += Math.max(0, wk[d] - don.maxWk) * WEIGHTS.overMax;
    s += Math.max(0, total[d] - SOFT_CAP) * WEIGHTS.overSoftCap;
    if (!don.volunteer) {
      s += Math.max(0, total[d] - don.minTotal) * WEIGHTS.nonVolunteerExtra;
      s += Math.max(0, wk[d] - don.minWk) * WEIGHTS.nonVolunteerWeekendExtra;
    }
  }
  return s;
}

// ---------- search ----------

function counts(model, assign) {
  const total = new Int32Array(model.dons.length);
  const wk = new Int32Array(model.dons.length);
  assign.forEach((d, j) => {
    if (d < 0) return;
    total[d]++;
    if (model.weekend[j]) wk[d]++;
  });
  return { total, wk };
}

// Can don d take day j right now (hard rules + current counts)?
function roomFor(model, c, d, j) {
  const don = model.dons[d];
  return model.can[d][j] && c.total[d] < don.maxTotal && (!model.weekend[j] || c.wk[d] < don.maxWk);
}

// Step 1: fill hardest days first, preferring dons still below a minimum.
function buildStart(model, pinned, pinDon, rng) {
  const N = model.days.length;
  const D = model.dons.length;
  const assign = new Int32Array(N).fill(-1);
  for (let j = 0; j < N; j++) if (pinned[j]) assign[j] = pinDon[j];
  const c = counts(model, assign);

  const free = [];
  for (let j = 0; j < N; j++) if (!pinned[j]) free.push(j);
  const eligible = (j) => model.dons.reduce((n, _, d) => n + (model.can[d][j] ? 1 : 0), 0);
  const order = free
    .map((j) => ({ j, e: eligible(j), r: rng() }))
    .sort((a, b) => a.e - b.e || a.r - b.r)
    .map((x) => x.j);

  for (const j of order) {
    let best = -1;
    let bestCost = Infinity;
    for (let d = 0; d < D; d++) {
      if (!roomFor(model, c, d, j)) continue;
      const don = model.dons[d];
      let cost = rankCost(model.rank[d][j]) + rng() * 0.5;
      if (c.total[d] < don.minTotal) cost -= 1000;
      if (model.weekend[j] && c.wk[d] < don.minWk) cost -= 1000;
      if (assign[j - 1] === d || assign[j + 1] === d) cost += 500;
      if (cost < bestCost) { bestCost = cost; best = d; }
    }
    if (best >= 0) {
      assign[j] = best;
      c.total[best]++;
      if (model.weekend[j]) c.wk[best]++;
    }
  }
  return assign;
}

// Step 2: random valid moves, keep any that don't make the score worse.
function improve(model, assign, pinned, rng, iterations) {
  const N = model.days.length;
  const D = model.dons.length;
  const free = [];
  for (let j = 0; j < N; j++) if (!pinned[j]) free.push(j);
  if (free.length === 0 || D === 0) return evaluate(model, assign);

  const c = counts(model, assign);
  let current = evaluate(model, assign);
  const pick = (n) => Math.floor(rng() * n);

  for (let it = 0; it < iterations; it++) {
    if (rng() < 0.5 || free.length < 2) {
      // Reassign: give day j to a different don who has room
      const j = free[pick(free.length)];
      const from = assign[j];
      const to = pick(D);
      if (to === from || !roomFor(model, c, to, j)) continue;

      assign[j] = to;
      c.total[to]++; if (model.weekend[j]) c.wk[to]++;
      if (from >= 0) { c.total[from]--; if (model.weekend[j]) c.wk[from]--; }

      const next = evaluate(model, assign);
      if (next <= current) { current = next; continue; }

      assign[j] = from; // undo
      c.total[to]--; if (model.weekend[j]) c.wk[to]--;
      if (from >= 0) { c.total[from]++; if (model.weekend[j]) c.wk[from]++; }
    } else {
      // Swap: two dons trade days
      const j = free[pick(free.length)];
      const k = free[pick(free.length)];
      const a = assign[j];
      const b = assign[k];
      if (j === k || a < 0 || b < 0 || a === b) continue;
      if (!model.can[a][k] || !model.can[b][j]) continue;
      const wj = model.weekend[j];
      const wkk = model.weekend[k];
      if (wj !== wkk) {
        // whoever moves onto the Fri/Sat needs weekend room
        if (wkk && c.wk[a] >= model.dons[a].maxWk) continue;
        if (wj && c.wk[b] >= model.dons[b].maxWk) continue;
      }

      const shift = (d, delta) => { c.wk[d] += delta; };
      assign[j] = b; assign[k] = a;
      if (wj !== wkk) { if (wkk) { shift(a, 1); shift(b, -1); } else { shift(a, -1); shift(b, 1); } }

      const next = evaluate(model, assign);
      if (next <= current) { current = next; continue; }

      assign[j] = a; assign[k] = b; // undo
      if (wj !== wkk) { if (wkk) { shift(a, -1); shift(b, 1); } else { shift(a, 1); shift(b, -1); } }
    }
  }
  return current;
}

// Step 3: repeat from several starts, keep the best.
function solveHouse(model, pinsByDate, seed, { restarts = 20, iterations = 20000 } = {}) {
  const N = model.days.length;
  const pinned = new Uint8Array(N);
  const pinDon = new Int32Array(N).fill(-1);
  for (const [date, donId] of pinsByDate) {
    const j = model.dayIndex.get(date);
    if (j === undefined) continue;
    pinned[j] = 1;
    pinDon[j] = donId ? model.donIndex.get(donId) ?? -1 : -1;
  }

  let best = null;
  let bestScore = Infinity;
  for (let run = 0; run < restarts; run++) {
    const rng = mulberry32(seed + run * 7919);
    const assign = buildStart(model, pinned, pinDon, rng);
    const score = improve(model, assign, pinned, rng, iterations);
    if (score < bestScore) { bestScore = score; best = assign; }
  }
  return { assign: best, score: bestScore, pinned };
}

// ---------- public: generate ----------

/**
 * @param pins  array of { date, house, don_id } rows to keep fixed (don_id may be null)
 * @returns { assignments: [{ date, house, don_id, pinned }], score, breakdown }
 */
export function generateSchedule({ startDate, endDate, dons, preferences, submissions, pins = [], seed = randomSeed(), options }) {
  const days = listDays(startDate, endDate);
  const assignments = [];
  const breakdown = { seed };
  let score = 0;

  for (const house of DUTY_GROUPS) { // `house` = duty group, which is what assignments.house stores
    const houseDons = dons.filter((d) => groupOf(d.house) === house);
    if (houseDons.length === 0) continue;
    const model = buildModel({ days, houseDons, preferences, submissions });
    const pinsByDate = new Map(pins.filter((p) => p.house === house).map((p) => [p.date, p.don_id]));

    const result = solveHouse(model, pinsByDate, seed, options);
    score += result.score;
    breakdown[house] = result.score;

    days.forEach((date, j) => {
      const d = result.assign[j];
      assignments.push({
        date,
        house,
        don_id: d >= 0 ? model.dons[d].id : null,
        pinned: Boolean(result.pinned[j]),
      });
    });
  }
  return { assignments, score, breakdown, seed };
}

// ---------- public: review any schedule (generated or hand-edited) ----------

/**
 * @param assignments rows { date, house, don_id, pinned }
 * @returns {{ score, conflicts, slots, perDon, stats }}
 *   slots: Map `${date}|${house}` → { rank, forbidden, consecutive }
 */
export function reviewSchedule({ startDate, endDate, dons, preferences, submissions, assignments }) {
  const days = listDays(startDate, endDate);
  const conflicts = [];
  const slots = new Map();
  const perDon = [];
  const stats = { slots: 0, filled: 0, firsts: 0, ranked: 0, unranked: 0 };
  let score = 0;

  const fmt = (iso) => new Date(`${iso}T12:00:00Z`).toLocaleDateString('en-US', {
    weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC',
  });

  for (const house of DUTY_GROUPS) { // `house` = duty group, which is what assignments.house stores
    const houseDons = dons.filter((d) => groupOf(d.house) === house);
    if (houseDons.length === 0) continue;
    const model = buildModel({ days, houseDons, preferences, submissions });

    const assign = new Int32Array(days.length).fill(-1);
    for (const a of assignments) {
      if (a.house !== house) continue;
      const j = model.dayIndex.get(a.date);
      const d = a.don_id ? model.donIndex.get(a.don_id) : undefined;
      if (j !== undefined && d !== undefined) assign[j] = d;
    }
    score += evaluate(model, assign);

    const shifts = model.dons.map(() => []);
    days.forEach((date, j) => {
      stats.slots++;
      const d = assign[j];
      if (d < 0) {
        conflicts.push({ severity: 'error', house, date, title: `${house}: ${fmt(date)} is empty` });
        slots.set(`${date}|${house}`, { empty: true });
        return;
      }
      stats.filled++;
      shifts[d].push(j);
      const r = model.rank[d][j];
      if (r === 1) stats.firsts++;
      if (r > 0) stats.ranked++; else stats.unranked++;
      const forbidden = !model.can[d][j];
      if (forbidden) {
        conflicts.push({ severity: 'warning', house, date, donId: model.dons[d].id,
          title: `${model.dons[d].name} is on ${fmt(date)}, a day they ${model.no[d][j] ? 'marked "no"' : "can't work"}` });
      }
      slots.set(`${date}|${house}`, { rank: r, forbidden, consecutive: false });
    });

    model.dons.forEach((don, d) => {
      const list = shifts[d];
      const total = list.length;
      const wk = list.filter((j) => model.weekend[j]).length;
      const hit = list.filter((j) => model.rank[d][j] > 0).length;

      for (let x = 1; x < list.length; x++) {
        const gap = list[x] - list[x - 1];
        if (gap === 1) {
          conflicts.push({ severity: 'warning', house, donId: don.id, date: days[list[x]],
            title: `${don.name} has back-to-back shifts: ${fmt(days[list[x - 1]])} and ${fmt(days[list[x]])}` });
          slots.get(`${days[list[x - 1]]}|${house}`).consecutive = true;
          slots.get(`${days[list[x]]}|${house}`).consecutive = true;
        } else if (gap === 2) {
          conflicts.push({ severity: 'info', house, donId: don.id,
            title: `${don.name} has shifts 2 days apart: ${fmt(days[list[x - 1]])} and ${fmt(days[list[x]])}` });
        }
      }
      if (total < don.minTotal) conflicts.push({ severity: 'error', house, donId: don.id,
        title: `${don.name} has ${total} shift${total === 1 ? '' : 's'}, needs at least ${don.minTotal}` });
      if (wk < don.minWk) conflicts.push({ severity: 'error', house, donId: don.id,
        title: `${don.name} has ${wk} Fri/Sat shift${wk === 1 ? '' : 's'}, needs at least ${don.minWk}` });
      if (total > don.maxTotal) conflicts.push({ severity: 'error', house, donId: don.id,
        title: `${don.name} has ${total} shifts, over their max of ${don.maxTotal}` });
      if (wk > don.maxWk) conflicts.push({ severity: 'error', house, donId: don.id,
        title: `${don.name} has ${wk} Fri/Sat shifts, over their max of ${don.maxWk}` });
      if (total > SOFT_CAP) conflicts.push({ severity: 'info', house, donId: don.id,
        title: `${don.name} has ${total} shifts (over the ${SOFT_CAP}-shift preference)` });
      if (!don.volunteer && total > don.minTotal) conflicts.push({ severity: 'info', house, donId: don.id,
        title: `${don.name} got an extra shift without volunteering` });
      if (total - hit > 0) conflicts.push({ severity: 'info', house, donId: don.id,
        title: `${don.name} got ${total - hit} day${total - hit === 1 ? '' : 's'} they didn't rank` });

      perDon.push({
        id: don.id, name: don.name, house, realHouse: houseDons[d].house, total, wk, hit,
        minTotal: don.minTotal, maxTotal: don.maxTotal, minWk: don.minWk, maxWk: don.maxWk,
        volunteer: don.volunteer,
        firsts: list.filter((j) => model.rank[d][j] === 1).length,
      });
    });
  }

  const order = { error: 0, warning: 1, info: 2 };
  conflicts.sort((a, b) => order[a.severity] - order[b.severity]);
  return { score, conflicts, slots, perDon, stats };
}