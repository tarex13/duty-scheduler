// Pure calendar logic: no React, no Supabase. Easy to test with plain Node.
//
// A preference looks exactly like what submit_preferences expects:
//   { date: '2026-12-04', kind: 'rank', rank: 1 }
//   { date: '2026-12-10', kind: 'no',   rank: null }

export const MAX_RANKS = 4;
export const MAX_NOS = 3;

// ---------- Dates (all as 'YYYY-MM-DD' strings, so time zones can't shift them) ----------

export function getLimits(isAdmin = false) {
  return isAdmin
    ? { maxRanks: Infinity, maxNos: Infinity }
    : { maxRanks: MAX_RANKS, maxNos: MAX_NOS };
}


export function parseISO(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return { y, m, d };
  
}

export function toISO(y, m, d) {
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

// 0 = Sunday … 6 = Saturday
export function dayOfWeek(iso) {
  const { y, m, d } = parseISO(iso);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

export function isWeekend(iso) {
  const dow = dayOfWeek(iso);
  return dow === 5 || dow === 6; // Friday or Saturday
}

export function formatDay(iso) {
  const { y, m, d } = parseISO(iso);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-US', {
    weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC',
  });
}

// Every full month the session touches, as grid cells (null = empty leading cell).
// Showing the whole month means Dec 23–31 appear too, but disabled.
export function buildMonths(startISO, endISO) {
  const start = parseISO(startISO);
  const end = parseISO(endISO);
  const months = [];

  let y = start.y;
  let m = start.m;
  while (y < end.y || (y === end.y && m <= end.m)) {
    const firstDow = new Date(Date.UTC(y, m - 1, 1)).getUTCDay();
    const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const cells = Array(firstDow).fill(null);
    for (let d = 1; d <= daysInMonth; d++) cells.push(toISO(y, m, d));

    months.push({
      key: `${y}-${m}`,
      label: new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString('en-US', {
        month: 'long', year: 'numeric', timeZone: 'UTC',
      }),
      cells,
    });

    m += 1;
    if (m > 12) { m = 1; y += 1; }
  }
  return months;
}

// ---------- Rules ----------

// Why a day can't be picked (for either mode), or null if it can.
// ctx = { startDate, endDate, don: { max_total, max_weekend } }
export function getDisabledReason(iso, { startDate, endDate, don }) {
  if (iso < startDate || iso > endDate) return 'No duty shift on this day';
  if ((don?.max_total ?? 1) <= 0) return "You've already reached your shift total";
  if (isWeekend(iso) && (don?.max_weekend ?? 1) <= 0) {
    return "You've already done all your weekend shifts";
  }
  return null;
}

// Ranks become 1, 2, 3… in their current order; "no" days keep rank null.
// Output is sorted by date so it's stable.
function renumber(list) {
  const ranked = list
    .filter((p) => p.kind === 'rank')
    .sort((a, b) => a.rank - b.rank)
    .map((p, i) => ({ date: p.date, kind: 'rank', rank: i + 1 }));
  const nos = list
    .filter((p) => p.kind === 'no')
    .map((p) => ({ date: p.date, kind: 'no', rank: null }));
  return [...ranked, ...nos].sort((a, b) => (a.date < b.date ? -1 : 1));
}

// Cleans anything that came in (e.g. loaded from the database): drops bad kinds,
// duplicate dates, disabled days, and anything over the limits; fixes rank gaps.
export function normalizePrefs(prefs, ctx, limits = getLimits()) {
  const seen = new Set();
  const valid = [];
  //console.log(prefs)
  const sorted = [...(prefs ?? [])].sort((a, b) => {
    // ranks first by rank, so if we must drop extras we keep the top choices
    if (a.kind === 'rank' && b.kind === 'rank') return (a.rank ?? 99) - (b.rank ?? 99);
    return a.kind === 'rank' ? -1 : 1;
  });

  let ranks = 0;
  let nos = 0;
  for (const p of sorted) {
    if (!p || typeof p.date !== 'string' || seen.has(p.date)) continue;
    if (getDisabledReason(p.date, ctx)) continue;
    if (p.kind === 'rank' && ranks < limits.maxRanks) {
      valid.push({ date: p.date, kind: 'rank', rank: p.rank ?? 99 });
      ranks += 1;
      seen.add(p.date);
    } else if (p.kind === 'no' && nos < limits.maxNos) {
      valid.push({ date: p.date, kind: 'no', rank: null });
      nos += 1;
      seen.add(p.date);
    }
  }
  return renumber(valid);
}

// What happens when a day is tapped. Returns { prefs, message }.
// message is a short note for the user (limit reached, moved between lists, etc.).
export function toggleDay(prefs, iso, mode, ctx, isAdmin = false) {
  const reason = getDisabledReason(iso, ctx);
  const limits = getLimits(isAdmin);
  let list = normalizePrefs(prefs, ctx, limits);
  if (reason) return { prefs: list, message: reason };
  const existing = list.find((p) => p.date === iso);
  const rankCount = list.filter((p) => p.kind === 'rank').length;
  const noCount = list.filter((p) => p.kind === 'no').length;

  if (mode === 'rank') {
    // Tap a ranked day → remove it; everyone ranked after it moves up one.
    if (existing?.kind === 'rank') {
      return { prefs: renumber(list.filter((p) => p.date !== iso)), message: null };
    }
    if (rankCount >= limits.maxRanks) {
      return {
        prefs: list,
        message: `You can rank up to ${MAX_RANKS} days. Tap a ranked day to remove it first.`,
      };
    }
    // New pick (or a "can't work" day switched to a pick) goes to the end.
    list = list.filter((p) => p.date !== iso);
    list.push({ date: iso, kind: 'rank', rank: rankCount + 1 });
  console.log("tap2");
    return {
      prefs: renumber(list),
      message: existing?.kind === 'no' ? `Moved ${formatDay(iso)} from "can't work" to your picks.` : null,
    };
  }

  // mode === 'no'
  if (existing?.kind === 'no') {
    return { prefs: renumber(list.filter((p) => p.date !== iso)), message: null };
  }
  if (noCount >= limits.maxNos) {
    return {
      prefs: list,
      message: `You can mark up to ${MAX_NOS} days you can't work. Tap one to remove it first.`,
    };
  }
  list = list.filter((p) => p.date !== iso);
  list.push({ date: iso, kind: 'no', rank: null });
  return {
    prefs: renumber(list),
    message: existing?.kind === 'rank'
      ? `Removed ${formatDay(iso)} from your picks; the ones after it moved up.`
      : null,
  };
}

// Counters and nudges for the status bar.
export function summarize(prefs, ctx, isAdmin) {
  const list = normalizePrefs(prefs, ctx, getLimits(isAdmin));
  const ranked = list.filter((p) => p.kind === 'rank').sort((a, b) => a.rank - b.rank);
  const nos = list.filter((p) => p.kind === 'no');
  const maxTotal = ctx.don?.max_total ?? MAX_RANKS;
  const requiredRanks = Math.min(MAX_RANKS, Math.max(0, maxTotal));
  const needsWeekend = (ctx.don?.min_weekend ?? 0) > 0;
  const hasWeekendPick = ranked.some((p) => isWeekend(p.date));

  return {
    ranked,
    nos,
    requiredRanks,
    ranksMissing: Math.max(0, requiredRanks - ranked.length),
    weekendWarning: needsWeekend && !hasWeekendPick,
    isValid: ranked.length >= requiredRanks,
  };
}
