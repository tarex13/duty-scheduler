// Pre-generation checks: everything that could stop the solver from producing
// a clean schedule, found before you click Generate.
// Pure JS (no React, no Supabase), so it's easy to test with plain Node.

import { formatDay, isWeekend, parseISO } from './calendarLogic';

// Real houses, as stored in dons.house
export const HOUSES = ['BH', 'EH', 'CMH'];
// Duty groups: every day needs one don from each group. BH and EH share one,
// so they're scheduled (and their stats counted) together.
export const DUTY_GROUPS = ['BH/EBY', 'CMH'];
export const GROUP_OF = { BH: 'BH/EBY', EH: 'BH/EBY', CMH: 'CMH' };
export const groupOf = (house) => GROUP_OF[house] ?? house;
// How many shifts above everyone's minimum each group should have (term rules:
// 3 BH/EBY dons do 10 instead of 9; 1 CMH don does 11 instead of 10).
export const EXPECTED_EXTRAS = { 'BH/EBY': 3, CMH: 1 };
export const SOFT_MONTHLY_CAP = 3;
const SEVERITY_ORDER = { error: 0, warning: 1, info: 2 };

// ---------- helpers ----------

export function listDays(startISO, endISO) {
  const { y, m, d } = parseISO(startISO);
  const end = parseISO(endISO);
  const endTime = Date.UTC(end.y, end.m - 1, end.d);
  const days = [];
  for (let t = Date.UTC(y, m - 1, d); t <= endTime; t += 86400000) {
    days.push(new Date(t).toISOString().slice(0, 10));
  }
  return days;
}

const plural = (n, word, many = `${word}s`) => `${n} ${n === 1 ? word : many}`;

// Edmonds–Karp max flow on a small graph (here: about 50 nodes).
function maxFlow(n, edges, source, sink) {
  const cap = Array.from({ length: n }, () => new Array(n).fill(0));
  for (const [u, v, c] of edges) cap[u][v] += c;

  let flow = 0;
  for (;;) {
    const parent = new Array(n).fill(-1);
    parent[source] = source;
    const queue = [source];
    while (queue.length && parent[sink] === -1) {
      const u = queue.shift();
      for (let v = 0; v < n; v++) {
        if (parent[v] === -1 && cap[u][v] > 0) {
          parent[v] = u;
          queue.push(v);
        }
      }
    }
    if (parent[sink] === -1) return flow;

    let push = Infinity;
    for (let v = sink; v !== source; v = parent[v]) push = Math.min(push, cap[parent[v]][v]);
    for (let v = sink; v !== source; v = parent[v]) {
      cap[parent[v]][v] -= push;
      cap[v][parent[v]] += push;
    }
    flow += push;
  }
}

// Is there ANY schedule for one house that fills every day with one don,
// never uses a "no" day, and gives every don between their min and max
// (total and weekend)? Spacing and preferences are ignored: this only asks
// "is it possible at all?".
//
// Network (each edge has a lower and upper bound):
//   S → don          [min_total,   max_total]
//   don → don's wknd [min_weekend, max_weekend]
//   don → weekday    [0, 1]   if the don can work that day
//   don's wknd → Fri/Sat [0, 1] if the don can work that day
//   day → T          [1, 1]   every day filled exactly once
//   T → S            [0, ∞]
// Lower bounds are handled with the standard trick: subtract them, then
// check that a max flow from a super-source saturates all the "owed" flow.
function scheduleExists(houseDons, days, canWork) {
  const D = houseDons.length;
  const S = 0, T = 1, SS = 2, TT = 3;
  const donNode = (i) => 4 + i;
  const wkNode = (i) => 4 + D + i;
  const dayNode = (j) => 4 + 2 * D + j;
  const n = 4 + 2 * D + days.length;

  const edges = [];
  const excess = new Array(n).fill(0);
  const add = (u, v, low, high) => {
    edges.push([u, v, high - low]);
    excess[v] += low;
    excess[u] -= low;
  };

  houseDons.forEach((don, i) => {
    add(S, donNode(i), don.min_total, don.max_total);
    add(donNode(i), wkNode(i), don.min_weekend, don.max_weekend);
    days.forEach((date, j) => {
      if (!canWork(don, date)) return;
      add(isWeekend(date) ? wkNode(i) : donNode(i), dayNode(j), 0, 1);
    });
  });
  days.forEach((_, j) => add(dayNode(j), T, 1, 1));
  add(T, S, 0, Infinity);

  let owed = 0;
  excess.forEach((e, v) => {
    if (e > 0) { edges.push([SS, v, e]); owed += e; }
    if (e < 0) edges.push([v, TT, -e]);
  });

  return maxFlow(n, edges, SS, TT) === owed;
}

// ---------- main ----------

/**
 * @param {object} input
 *   startDate, endDate  'YYYY-MM-DD'
 *   dons         rows from the dons table (with min/max columns)
 *   preferences  rows: { don_id, date, kind, rank }
 *   submissions  rows: { don_id, volunteer_extra }
 * @returns {{ days, weekendDays, issues, houses, counts }}
 */
export function analyzeSession({ startDate, endDate, dons = [], preferences = [], submissions = [] }) {
  const days = listDays(startDate, endDate);
  const daySet = new Set(days);
  const weekendDays = days.filter(isWeekend);

  const nameOf = new Map(dons.map((d) => [d.id, d.name]));
  const submitted = new Set(submissions.map((s) => s.don_id));
  const volunteers = new Set(submissions.filter((s) => s.volunteer_extra).map((s) => s.don_id));

  const prefsByDon = new Map(dons.map((d) => [d.id, []]));
  for (const p of preferences) prefsByDon.get(p.don_id)?.push(p);
  const noDaysOf = (don) => new Set(prefsByDon.get(don.id).filter((p) => p.kind === 'no').map((p) => p.date));
  const ranksOf = (don) => prefsByDon.get(don.id).filter((p) => p.kind === 'rank');

  // Could the solver ever put this don on this day? (hard rules only)
  const noCache = new Map(dons.map((d) => [d.id, noDaysOf(d)]));
  const canWork = (don, date) =>
    daySet.has(date) &&
    don.max_total > 0 &&
    !noCache.get(don.id).has(date) &&
    !(isWeekend(date) && don.max_weekend <= 0);

  const issues = [];
  const add = (issue) =>
    issues.push({
      donIds: [],
      dates: [],
      lines: [],
      ...issue,
      id: `${issue.code}|${issue.house ?? ''}|${(issue.donIds ?? []).join(',')}|${(issue.dates ?? []).join(',')}`,
    });

  const houses = {};

  for (const house of DUTY_GROUPS) { // `house` here = duty group ('BH/EBY' or 'CMH')
    const hd = dons.filter((d) => groupOf(d.house) === house);
    if (hd.length === 0) continue;

    // ----- house totals -----
    const sum = (key) => hd.reduce((s, d) => s + (d[key] ?? 0), 0);
    const sumMin = sum('min_total');
    const sumMax = sum('max_total');
    const sumMinWk = sum('min_weekend');
    const sumMaxWk = sum('max_weekend');
    console.log(days.length, sumMin);
    const extras = days.length - sumMin;
    const volunteersWithRoom = hd.filter((d) => volunteers.has(d.id) && d.max_total > d.min_total);
    let dataProblem = false;

    if (sumMin > days.length) {
      dataProblem = true;
      add({ code: 'mins-too-high', severity: 'error', house,
        title: `${house}: minimums add up to ${sumMin} shifts, but there are only ${days.length} days`,
        detail: 'A current_total in the dons table is probably too low.' });
    }
    if (sumMax < days.length) {
      dataProblem = true;
      add({ code: 'max-too-low', severity: 'error', house,
        title: `${house}: dons can cover at most ${sumMax} of ${days.length} days`,
        detail: 'A current_total in the dons table is probably too high, or a don is missing.' });
    }
    if (sumMinWk > weekendDays.length) {
      dataProblem = true;
      add({ code: 'wk-mins-too-high', severity: 'error', house,
        title: `${house}: dons need ${sumMinWk} weekend shifts, but there are only ${weekendDays.length} Fri/Sat days`,
        detail: 'A current_weekend in the dons table is probably too low.' });
    }
    if (sumMaxWk < weekendDays.length) {
      dataProblem = true;
      add({ code: 'wk-max-too-low', severity: 'error', house,
        title: `${house}: dons can cover at most ${sumMaxWk} of ${weekendDays.length} Fri/Sat days`,
        detail: 'A current_weekend in the dons table is probably too high.' });
    }
    if (!dataProblem && EXPECTED_EXTRAS[house] !== undefined && extras !== EXPECTED_EXTRAS[house]) {
      add({ code: 'extras-mismatch', severity: 'warning', house,
        title: `${house}: expected ${plural(EXPECTED_EXTRAS[house], 'extra shift')}, the data gives ${extras}`,
        detail: 'The term totals may not add up. Double-check current_total for each don.' });
    }
    if (extras > 0 && volunteersWithRoom.length < extras) {
      add({ code: 'extras-volunteers', severity: 'info', house,
        donIds: volunteersWithRoom.map((d) => d.id),
        title: `${house}: ${plural(extras, 'extra shift')} to give out, ${plural(volunteersWithRoom.length, 'volunteer')}`,
        detail: 'Non-volunteers will get the rest. You could ask for more volunteers.' });
    }

    // ----- per don -----
    const unclaimed = [];
    const notSubmitted = [];
    const fewRanks = [];

    for (const don of hd) {
      if (don.min_total > don.max_total || don.min_weekend > don.max_weekend || don.min_weekend > don.max_total) {
        dataProblem = true;
        add({ code: 'don-data', severity: 'error', house, donIds: [don.id],
          title: `${don.name}: limits don't add up`,
          detail: `Total ${don.min_total}–${don.max_total}, weekend ${don.min_weekend}–${don.max_weekend}. Check their current_total and current_weekend.` });
        continue;
      }

      if (!don.claimed_by) unclaimed.push(don.id);
      else if (!submitted.has(don.id)) notSubmitted.push(don.id);

      const workable = days.filter((date) => canWork(don, date));
      const workableWk = workable.filter(isWeekend);
      const maxPossible = workable.length - workableWk.length + Math.min(workableWk.length, don.max_weekend);

      if (maxPossible < don.min_total) {
        add({ code: 'don-too-few-days', severity: 'error', house, donIds: [don.id],
          title: `${don.name} can work only ${plural(maxPossible, 'day')} but must do ${don.min_total}`,
          detail: 'Their "no" days and weekend limit leave too few days. Remove a "no" day.' });
      }
      if (workableWk.length < don.min_weekend) {
        add({ code: 'don-weekend-unavailable', severity: 'error', house, donIds: [don.id],
          dates: weekendDays.filter((d) => noCache.get(don.id).has(d)),
          title: `${don.name} needs ${plural(don.min_weekend, 'weekend shift')} but can work only ${plural(workableWk.length, 'Fri/Sat')}`,
          detail: 'They marked too many Fri/Sat days as "no".' });
      }
      if (don.min_total > SOFT_MONTHLY_CAP) {
        add({ code: 'don-over-cap', severity: 'info', house, donIds: [don.id],
          title: `${don.name} must do ${don.min_total} shifts (over the ${SOFT_MONTHLY_CAP}-shift preference)`,
          detail: 'Their term requirement forces it; just a heads-up.' });
      }

      const ranks = ranksOf(don);
      const ignored = prefsByDon.get(don.id).filter((p) => !canWork(don, p.date) && p.kind === 'rank');
      if (ignored.length) {
        add({ code: 'don-ignored-prefs', severity: 'warning', house, donIds: [don.id],
          dates: ignored.map((p) => p.date),
          title: `${don.name} ranked ${plural(ignored.length, 'day')} they can't be given`,
          detail: 'These picks fall outside the dates or on a weekend they have no room for. The solver will ignore them.' });
      }

      if (submitted.has(don.id)) {
        if (don.min_weekend > 0 && !ranks.some((p) => isWeekend(p.date))) {
          add({ code: 'don-no-weekend-pick', severity: 'warning', house, donIds: [don.id],
            title: `${don.name} needs a weekend shift but didn't rank a Fri/Sat`,
            detail: "They'll probably get a weekend day they didn't pick. You could ask them to add one." });
        }
        const required = Math.min(4, don.max_total);
        if (ranks.length < required) fewRanks.push({ don, have: ranks.length, required });
      }
    }

    if (fewRanks.length) {
      add({ code: 'don-few-ranks', severity: 'info', house,
        donIds: fewRanks.map((x) => x.don.id),
        lines: fewRanks.map((x) => `${x.don.name}: ranked ${x.have} of ${x.required}`),
        title: `${house}: ${plural(fewRanks.length, 'don', 'dons')} ranked fewer days than required`,
        detail: 'Possible only through an admin edit. Fewer picks means more unranked days for them.' });
    }
    if (unclaimed.length) {
      add({ code: 'don-unclaimed', severity: 'warning', house, donIds: unclaimed,
        title: `${house}: ${plural(unclaimed.length, "don hasn't", "dons haven't")} joined yet`,
        detail: 'If they never join, the solver treats them as free every day with no preferences.' });
    }
    if (notSubmitted.length) {
      add({ code: 'don-not-submitted', severity: 'warning', house, donIds: notSubmitted,
        title: `${house}: ${plural(notSubmitted.length, 'don has', 'dons have')} joined but not submitted`,
        detail: 'Without a submission they count as free every day with no preferences.' });
    }

    // ----- per day -----
    const perDay = days.map((date) => {
      const available = hd.filter((d) => !(d.min_total > d.max_total) && canWork(d, date));
      const prefsToday = hd.flatMap((d) => prefsByDon.get(d.id).filter((p) => p.date === date));
      return {
        date,
        weekend: isWeekend(date),
        available: available.map((d) => d.id),
        ranks: prefsToday.filter((p) => p.kind === 'rank').length,
        firsts: prefsToday.filter((p) => p.kind === 'rank' && p.rank === 1).length,
        nos: prefsToday.filter((p) => p.kind === 'no').map((p) => p.don_id),
      };
    });

    for (const day of perDay.filter((x) => x.available.length === 0)) {
      add({ code: 'day-nobody', severity: 'error', house, dates: [day.date], donIds: day.nos,
        title: `${house}: nobody can work ${formatDay(day.date)}`,
        detail: day.nos.length
          ? 'Everyone left either marked it "no" or has no room. Ask one of these dons to free it up.'
          : 'Every don has hit their total or weekend limit.' });
    }

    const forced = perDay.filter((x) => x.available.length === 1);
    if (forced.length) {
      add({ code: 'day-one', severity: 'warning', house,
        dates: forced.map((x) => x.date),
        donIds: [...new Set(forced.map((x) => x.available[0]))],
        lines: forced.map((x) => `${formatDay(x.date)} → ${nameOf.get(x.available[0])}`),
        title: `${house}: only one don can work ${plural(forced.length, 'day')}`,
        detail: "They'll be forced onto it, which also limits how well the rest can be spread out." });
    }

    const unranked = perDay.filter((x) => x.ranks === 0 && x.available.length > 0);
    if (unranked.length) {
      add({ code: 'day-unranked', severity: 'info', house, dates: unranked.map((x) => x.date),
        title: `${house}: nobody ranked ${plural(unranked.length, 'day')}`,
        detail: 'Someone will get each of these as an unranked day.' });
    }

    // ----- the final gate: does a valid schedule exist at all? -----
    let feasible = null; // null = not checked (fix data errors first)
    if (!dataProblem) {
      feasible = scheduleExists(hd, days, canWork);
      if (!feasible) {
        add({ code: 'infeasible', severity: 'error', house,
          title: `${house}: no schedule can meet every rule with the current "no" days`,
          detail: 'Even ignoring preferences, the days, "no" days and min/max limits can\'t all fit. The solver will still run, but some days will be unfilled or some dons will miss a minimum. Fix the errors above, or ask a don to free up a day.' });
      }
    }

    houses[house] = {
      house,
      donCount: hd.length,
      claimed: hd.filter((d) => d.claimed_by).length,
      submitted: hd.filter((d) => submitted.has(d.id)).length,
      volunteers: volunteersWithRoom.length,
      sumMin, sumMax, sumMinWk, sumMaxWk, extras,
      feasible,
      perDay,
    };
  }

  issues.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
  const counts = { error: 0, warning: 0, info: 0 };
  for (const i of issues) counts[i.severity] += 1;

  return { days, weekendDays, issues, houses, counts, nameOf };
}