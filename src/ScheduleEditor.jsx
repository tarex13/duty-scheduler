import { useCallback, useEffect, useMemo, useState } from 'react';
import { supabase } from './lib/supabase';
import { formatDay, isWeekend } from './calendarLogic';
import { DUTY_GROUPS, groupOf, listDays } from './preflightChecks';
import { generateSchedule, reviewSchedule } from './solver';

const glass = 'rounded-3xl border border-white/10 bg-white/[0.05] backdrop-blur-xl shadow-[0_8px_40px_rgba(0,0,0,0.45)]';
const TONE = {
  error: 'bg-[#F87171]',
  warning: 'bg-amber-300',
  info: 'bg-[#66FCF1]',
};
const slotKey = (date, house) => `${date}|${house}`;

/**
 * Stage 5: view, fix, pin, regenerate and publish schedule versions.
 *   session          the sessions row
 *   dons, preferences, submissions   from useSessionData
 *   onSessionChange(fields)          merge changed session fields into Admin's state
 */
export default function ScheduleEditor({ session, dons, preferences, submissions, onSessionChange }) {
  const [versions, setVersions] = useState([]);
  const [activeId, setActiveId] = useState(null);
  const [rows, setRows] = useState([]);              // assignments of the active version
  const [publishedRows, setPublishedRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState('');              // label of the running action
  const [error, setError] = useState('');
  const [picker, setPicker] = useState(null);        // { date, house }
  const [highlight, setHighlight] = useState(null);  // don id

  const active = versions.find((v) => v.id === activeId);
  const readOnly = Boolean(active?.published_at);    // published versions are frozen (DB trigger)
  const isLive = active && active.id === session.published_schedule_id;
  const days = useMemo(() => listDays(session.start_date, session.end_date), [session.start_date, session.end_date]);
  const donById = useMemo(() => new Map(dons.map((d) => [d.id, d])), [dons]);

  // ---------- loading ----------

  const loadVersions = useCallback(async (selectId) => {
    const { data, error: err } = await supabase
      .from('schedules')
      .select('id, version, seed, score, created_at, published_at')
      .eq('session_id', session.id)
      .order('version', { ascending: false });
    if (err) { setError(err.message); return; }
    setVersions(data);
    setActiveId((cur) => selectId ?? (data.some((v) => v.id === cur) ? cur : data[0]?.id ?? null));
    setLoading(false);
  }, [session.id]);

  useEffect(() => { loadVersions(); }, [loadVersions]);

  useEffect(() => {
    if (!activeId) { setRows([]); return undefined; }
    let cancelled = false;
    (async () => {
      const { data, error: err } = await supabase
        .from('assignments')
        .select('date, house, don_id, pinned')
        .eq('schedule_id', activeId);
      if (cancelled) return;
      if (err) setError(err.message); else setRows(data);
    })();
    return () => { cancelled = true; };
  }, [activeId]);

  useEffect(() => {
    const liveId = session.published_schedule_id;
    if (!liveId || liveId === activeId) { setPublishedRows([]); return undefined; }
    let cancelled = false;
    (async () => {
      const { data } = await supabase.from('assignments').select('date, house, don_id').eq('schedule_id', liveId);
      if (!cancelled) setPublishedRows(data ?? []);
    })();
    return () => { cancelled = true; };
  }, [session.published_schedule_id, activeId]);

  // ---------- derived ----------

  const rowByKey = useMemo(() => new Map(rows.map((r) => [slotKey(r.date, r.house), r])), [rows]);
  const liveByKey = useMemo(() => new Map(publishedRows.map((r) => [slotKey(r.date, r.house), r.don_id])), [publishedRows]);
  const review = useMemo(
    () => reviewSchedule({
      startDate: session.start_date, endDate: session.end_date,
      dons, preferences, submissions, assignments: rows,
    }),
    [session.start_date, session.end_date, dons, preferences, submissions, rows],
  );
  const changedCount = publishedRows.length
    ? rows.filter((r) => liveByKey.get(slotKey(r.date, r.house)) !== r.don_id).length
    : 0;
  const counts = review.conflicts.reduce((c, x) => ({ ...c, [x.severity]: (c[x.severity] ?? 0) + 1 }), {});

  // ---------- actions ----------

  async function run(label, fn) {
    if (busy) return;
    setBusy(label);
    setError('');
    try { await fn(); } catch (err) { setError(err.message ?? String(err)); } finally { setBusy(''); }
  }

  // Save rows as a brand-new version and switch to it
  async function saveAsNewVersion(newRows, seed, score) {
    const { data: id, error: err } = await supabase.rpc('save_schedule', {
      p_session_id: session.id,
      p_seed: seed,
      p_score: score,
      p_breakdown: null,
      p_assignments: newRows,
    });
    if (err) throw err;
    await loadVersions(id);
  }

  const regenerate = () => run('Regenerating…', async () => {
    await new Promise((r) => setTimeout(r, 30)); // let the button show "Regenerating…" first
    const result = generateSchedule({
      startDate: session.start_date, endDate: session.end_date,
      dons, preferences, submissions,
      pins: rows.filter((r) => r.pinned),
    });
    await saveAsNewVersion(result.assignments, result.seed, result.score);
  });

  // Published versions can't change, so copy one into a new draft with everything pinned
  const editAsNewVersion = () => run('Copying…', async () => {
    await saveAsNewVersion(rows.map((r) => ({ ...r, pinned: true })), active?.seed ?? 0, review.score);
  });

  const publish = () => run('Publishing…', async () => {
    if (counts.error && !window.confirm(`This version has ${counts.error} must-fix issue(s). Publish anyway?`)) return;
    const { error: err } = await supabase.rpc('publish_schedule', { p_schedule_id: activeId });
    if (err) throw err;
    onSessionChange({ published_schedule_id: activeId, status: 'published' });
    await loadVersions(activeId);
  });

  async function updateSlot(date, house, patch) {
    if (readOnly) return;
    const before = rows;
    setRows((rs) => rs.map((r) => (r.date === date && r.house === house ? { ...r, ...patch } : r)));
    const { error: err } = await supabase
      .from('assignments')
      .update(patch)
      .eq('schedule_id', activeId).eq('date', date).eq('house', house);
    if (err) { setRows(before); setError(err.message); }
  }

  const unpinAll = () => run('Unpinning…', async () => {
    const { error: err } = await supabase.from('assignments').update({ pinned: false }).eq('schedule_id', activeId);
    if (err) throw err;
    setRows((rs) => rs.map((r) => ({ ...r, pinned: false })));
  });

  // ---------- render ----------

  if (loading) return <p className="p-6 text-white/60">Loading schedules…</p>;
  if (!versions.length) {
    return (
      <div className={`${glass} m-3 p-6 text-center text-white/70`}>
        No schedule yet. Generate one in Stage 4.
      </div>
    );
  }

  return (
    <div className="flex w-full flex-col gap-4 p-3 text-[#C5C6C7]">
      {/* Toolbar */}
      <section className={`${glass} p-4 sm:p-5`}>
        <div className="flex flex-wrap items-center gap-2">
          {versions.map((v) => (
            <button key={v.id} type="button" onClick={() => setActiveId(v.id)}
                    className={`rounded-full px-3 py-1.5 text-xs font-semibold ring-1 transition ${
                      v.id === activeId ? 'bg-white/[0.14] text-white ring-white/30' : 'text-white/60 ring-white/10 hover:text-white'}`}>
              v{v.version}
              {v.id === session.published_schedule_id && <span className="ml-1.5 text-[#66FCF1]">● live</span>}
              {v.published_at && v.id !== session.published_schedule_id && <span className="ml-1.5 text-white/40">old</span>}
            </button>
          ))}
        </div>

        <div className="mt-4 flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <p className="text-sm text-white/70">
            {isLive ? 'This version is live for everyone. ' : readOnly ? 'An older published version (read-only). ' : 'Draft. Only you can see it. '}
            {readOnly ? 'Make a copy to change it.' : 'Tap a slot to change who is on it; changed slots get pinned.'}
            {changedCount > 0 && <span className="text-amber-200"> {changedCount} slot{changedCount === 1 ? '' : 's'} differ from the live version.</span>}
          </p>
          <div className="flex flex-wrap gap-2">
            {readOnly ? (
              <ActionButton onClick={editAsNewVersion} busy={busy}>Edit as new version</ActionButton>
            ) : (
              <>
                <ActionButton onClick={unpinAll} busy={busy} disabled={!rows.some((r) => r.pinned)}>Unpin all</ActionButton>
                <ActionButton onClick={regenerate} busy={busy}>Regenerate (keeps pins)</ActionButton>
              </>
            )}
            {!isLive && <ActionButton primary onClick={publish} busy={busy}>Publish v{active?.version}</ActionButton>}
          </div>
        </div>
        {busy && <p className="mt-2 text-xs text-[#66FCF1]">{busy}</p>}
        {error && <p className="mt-2 text-xs text-[#FCA5A5]">{error}</p>}

        <dl className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-5">
          <Stat label="Filled" value={`${review.stats.filled}/${review.stats.slots}`} />
          <Stat label="On a #1 pick" value={pct(review.stats.firsts, review.stats.filled)} />
          <Stat label="On any pick" value={pct(review.stats.ranked, review.stats.filled)} />
          <Stat label="Unranked" value={review.stats.unranked} />
          <Stat label="Issues" value={`${counts.error ?? 0} / ${counts.warning ?? 0}`} sub="must fix / check" />
        </dl>
      </section>

      <div className="grid gap-4 xl:grid-cols-[1fr_360px]">
        {/* Day list */}
        <section className={`${glass} p-3 sm:p-4`}>
          <div className="mb-2 hidden grid-cols-[90px_1fr_1fr] gap-2 px-1 text-[11px] font-semibold uppercase tracking-wide text-white/40 sm:grid">
            <span>Day</span>{DUTY_GROUPS.map((h) => <span key={h}>{h}</span>)}
          </div>
          <ul className="flex flex-col gap-1.5">
            {days.map((date) => (
              <li key={date}
                  className={`grid grid-cols-2 gap-1.5 rounded-2xl p-1.5 sm:grid-cols-[90px_1fr_1fr] sm:gap-2 ${
                    isWeekend(date) ? 'bg-[#66FCF1]/[0.06]' : ''}`}>
                <div className="col-span-2 px-1 text-xs font-semibold text-white/80 sm:col-span-1 sm:self-center sm:text-sm">
                  {formatDay(date)}
                  {isWeekend(date) && <span className="ml-1 text-[10px] text-[#66FCF1]/80">Fri/Sat</span>}
                </div>
                {DUTY_GROUPS.map((house) => {
                  const key = slotKey(date, house);
                  const row = rowByKey.get(key);
                  const flag = review.slots.get(key) ?? {};
                  return (
                    <Slot key={house} house={house} row={row} flag={flag}
                          name={row?.don_id ? donById.get(row.don_id)?.name : null}
                          changed={publishedRows.length > 0 && liveByKey.get(key) !== (row?.don_id ?? null)}
                          highlighted={highlight && row?.don_id === highlight}
                          readOnly={readOnly}
                          onOpen={() => !readOnly && setPicker({ date, house })}
                          onTogglePin={() => updateSlot(date, house, { pinned: !row?.pinned })} />
                  );
                })}
              </li>
            ))}
          </ul>
        </section>

        {/* Side panels */}
        <div className="flex flex-col gap-4">
          <section className={`${glass} p-4`}>
            <h3 className="text-sm font-semibold text-white">Conflicts</h3>
            {review.conflicts.length === 0 && <p className="mt-2 text-sm text-white/60">None. 🎉</p>}
            <ul className="mt-2 flex max-h-80 flex-col gap-1.5 overflow-y-auto pr-1">
              {review.conflicts.map((c, i) => (
                <li key={i}>
                  <button type="button" onClick={() => setHighlight(c.donId ?? null)}
                          className="flex w-full items-start gap-2 rounded-xl px-2 py-1.5 text-left text-xs sm:text-sm hover:bg-white/[0.06]">
                    <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${TONE[c.severity]}`} />
                    <span className="text-white/85">{c.title}</span>
                  </button>
                </li>
              ))}
            </ul>
          </section>

          <section className={`${glass} p-4`}>
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold text-white">Dons</h3>
              {highlight && <button type="button" onClick={() => setHighlight(null)} className="text-xs text-[#66FCF1]">Clear highlight</button>}
            </div>
            <div className="mt-2 max-h-96 overflow-y-auto">
              <table className="w-full text-left text-xs">
                <thead className="text-white/40">
                  <tr><th className="py-1 font-medium">Name</th><th className="font-medium">Shifts</th><th className="font-medium">Fri/Sat</th><th className="font-medium">Picks</th></tr>
                </thead>
                <tbody>
                  {review.perDon.map((d) => {
                    const short = d.total < d.minTotal || d.wk < d.minWk;
                    const over = d.total > d.maxTotal || d.wk > d.maxWk;
                    return (
                      <tr key={d.id} onClick={() => setHighlight(d.id === highlight ? null : d.id)}
                          className={`cursor-pointer border-t border-white/5 ${d.id === highlight ? 'bg-[#66FCF1]/10' : 'hover:bg-white/[0.04]'}`}>
                        <td className="py-1.5 pr-2 text-white/90">{d.name}<span className="ml-1 text-[10px] text-white/40">{d.realHouse}</span></td>
                        <td className={short || over ? 'text-[#FCA5A5]' : ''}>{d.total} <span className="text-white/40">({d.minTotal}–{d.maxTotal})</span></td>
                        <td className={d.wk < d.minWk || d.wk > d.maxWk ? 'text-[#FCA5A5]' : ''}>{d.wk} <span className="text-white/40">({d.minWk}–{d.maxWk})</span></td>
                        <td>{d.hit}/{d.total}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>
        </div>
      </div>

      {picker && (
        <DonPicker picker={picker} dons={dons.filter((d) => groupOf(d.house) === picker.house)}
                   preferences={preferences} review={review} rows={rows}
                   current={rowByKey.get(slotKey(picker.date, picker.house))?.don_id ?? null}
                   onClose={() => setPicker(null)}
                   onPick={(donId) => {
                     updateSlot(picker.date, picker.house, { don_id: donId, pinned: true });
                     setPicker(null);
                   }} />
      )}
    </div>
  );
}

// ---------- pieces ----------

function Slot({ house, row, flag, name, changed, highlighted, readOnly, onOpen, onTogglePin }) {
  const bad = flag.empty || flag.forbidden;
  return (
    <div className={`relative flex items-center gap-1 rounded-xl ring-1 transition ${
      highlighted ? 'bg-[#66FCF1]/20 ring-[#66FCF1]/60'
        : bad ? 'bg-[#F87171]/10 ring-[#F87171]/50'
          : flag.consecutive ? 'bg-amber-300/10 ring-amber-300/40'
            : 'bg-white/[0.05] ring-white/10'}`}>
      <button type="button" onClick={onOpen} disabled={readOnly}
              className="flex min-w-0 flex-1 items-center gap-2 px-2.5 py-2 text-left disabled:cursor-default">
        <span className="text-[10px] font-semibold text-white/40 sm:hidden">{house}</span>
        <span className={`truncate text-sm ${name ? 'text-white/90' : 'italic text-[#FCA5A5]'}`}>{name ?? 'Empty'}</span>
        {flag.rank > 0 && <span className="shrink-0 rounded-full bg-[#66FCF1]/15 px-1.5 text-[10px] font-bold text-[#66FCF1]">#{flag.rank}</span>}
        {name && flag.rank === 0 && <span className="shrink-0 text-[10px] text-white/40">unranked</span>}
        {changed && <span className="shrink-0 h-1.5 w-1.5 rounded-full bg-amber-300" title="Different from the live version" />}
      </button>
      {!readOnly && (
        <button type="button" onClick={onTogglePin} aria-pressed={row?.pinned} title={row?.pinned ? 'Pinned: regenerate keeps it' : 'Pin this slot'}
                className={`mr-1 grid h-7 w-7 shrink-0 place-items-center rounded-lg text-sm transition ${
                  row?.pinned ? 'bg-[#66FCF1]/20 text-[#66FCF1]' : 'text-white/25 hover:text-white/70'}`}>
          {row?.pinned ? '📌' : '📍'}
        </button>
      )}
    </div>
  );
}

function DonPicker({ picker, dons, preferences, review, rows, current, onClose, onPick }) {
  const { date, house } = picker;
  const options = dons.map((d) => {
    const pref = preferences.find((p) => p.don_id === d.id && p.date === date);
    const stats = review.perDon.find((x) => x.id === d.id);
    const total = stats?.total ?? 0;
    const wk = stats?.wk ?? 0;
    const weekend = isWeekend(date);
    const onThisDay = current === d.id;
    const atMax = !onThisDay && (total >= d.max_total || (weekend && wk >= d.max_weekend));
    const neighbour = rows.some((r) => r.house === house && r.don_id === d.id &&
      Math.abs(Date.parse(r.date) - Date.parse(date)) === 86400000);
    const no = pref?.kind === 'no';
    const rank = pref?.kind === 'rank' ? pref.rank : 0;
    const warn = [no && 'said "no"', atMax && 'at max', neighbour && 'back-to-back', weekend && d.max_weekend <= 0 && 'no weekend room']
      .filter(Boolean);
    const sort = (no || atMax ? 100 : 0) + (rank ? rank : 10) + (neighbour ? 5 : 0);
    return { d, rank, warn, total, wk, sort, onThisDay };
  }).sort((a, b) => a.sort - b.sort);

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 p-0 backdrop-blur-sm sm:items-center sm:p-4"
         onClick={onClose} role="dialog" aria-modal="true">
      <div className={`${glass} max-h-[85vh] w-full max-w-md overflow-hidden rounded-b-none sm:rounded-3xl`}
           onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-white/10 p-4">
          <div>
            <p className="text-xs uppercase tracking-wide text-white/50">{house}</p>
            <h3 className="text-base font-semibold text-white">{formatDay(date)}</h3>
          </div>
          <button type="button" onClick={onClose} className="rounded-full px-3 py-1 text-sm text-white/60 ring-1 ring-white/15 hover:text-white">Close</button>
        </div>
        <ul className="max-h-[60vh] overflow-y-auto p-2">
          {options.map(({ d, rank, warn, total, wk, onThisDay }) => (
            <li key={d.id}>
              <button type="button" onClick={() => onPick(d.id)}
                      className={`flex w-full items-center justify-between gap-3 rounded-2xl px-3 py-2.5 text-left transition hover:bg-white/[0.08] ${
                        onThisDay ? 'bg-[#66FCF1]/10 ring-1 ring-[#66FCF1]/40' : ''}`}>
                <div className="min-w-0">
                  <p className={`truncate text-sm font-medium ${warn.length ? 'text-white/60' : 'text-white'}`}>{d.name}</p>
                  <p className="text-[11px] text-white/45">
                    {total} shift{total === 1 ? '' : 's'} ({d.min_total}–{d.max_total}) · Fri/Sat {wk} ({d.min_weekend}–{d.max_weekend})
                  </p>
                </div>
                <div className="flex shrink-0 flex-wrap justify-end gap-1">
                  {rank > 0 && <span className="rounded-full bg-[#66FCF1]/15 px-2 py-0.5 text-[11px] font-bold text-[#66FCF1]">#{rank}</span>}
                  {warn.map((w) => <span key={w} className="rounded-full bg-[#F87171]/15 px-2 py-0.5 text-[11px] text-[#FECACA]">{w}</span>)}
                </div>
              </button>
            </li>
          ))}
          <li>
            <button type="button" onClick={() => onPick(null)}
                    className="mt-1 w-full rounded-2xl px-3 py-2.5 text-left text-sm italic text-[#FCA5A5] hover:bg-white/[0.06]">
              Leave empty
            </button>
          </li>
        </ul>
      </div>
    </div>
  );
}

function ActionButton({ onClick, busy, disabled, primary, children }) {
  return (
    <button type="button" onClick={onClick} disabled={Boolean(busy) || disabled}
            className={`rounded-2xl px-4 py-2 text-sm font-semibold transition active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-40 ${
              primary ? 'text-[#0B0C10] shadow-[0_0_20px_rgba(102,252,241,0.3)] hover:brightness-110'
                : 'text-white/85 ring-1 ring-white/15 hover:bg-white/10'}`}
            style={primary ? { background: 'linear-gradient(135deg, #66FCF1, #45A29E)' } : undefined}>
      {children}
    </button>
  );
}

function Stat({ label, value, sub }) {
  return (
    <div className="rounded-2xl bg-white/[0.04] p-3 ring-1 ring-white/10">
      <dt className="text-[11px] uppercase tracking-wide text-white/50">{label}</dt>
      <dd className="mt-0.5 text-lg font-bold text-white">{value}</dd>
      {sub && <dd className="text-[11px] text-white/45">{sub}</dd>}
    </div>
  );
}

const pct = (n, d) => (d ? `${Math.round((n / d) * 100)}%` : '–');