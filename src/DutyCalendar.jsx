import { useEffect, useMemo, useState } from 'react';
import {
  MAX_NOS,
  MAX_RANKS,
  buildMonths,
  formatDay,
  getDisabledReason,
  getLimits,
  isWeekend,
  normalizePrefs,
  parseISO,
  summarize,
  toggleDay,
} from './calendarLogic';
import { supabase } from './lib/supabase';

const WEEKDAYS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
const ordinal = (n) => {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
};

const TEAL = '#66FCF1';
const TEAL_DEEP = '#45A29E';
const ROSE = '#F87171';

/**
 * Pick ranked days and "can't work" days.
 *
 * Props
 *   startDate, endDate  'YYYY-MM-DD' (from the sessions row)
 *   don                 { max_total, max_weekend, min_weekend } (the claimed don's row)
 *   value               preferences array, same shape submit_preferences expects
 *   onChange(next)      called with the new preferences array
 */
export default function DutyCalendar({ startDate, endDate, don, value, onChange, prefSaving, handleSavePref, volunteer, setVolunteer, prefSaved=false, setPrefSaved=()=>{}, isAdmin = false }) {
  const [mode, setMode] = useState('rank'); // 'rank' | 'no'
  const [message, setMessage] = useState('');

  const ctx = useMemo(() => ({ startDate, endDate, don }), [startDate, endDate, don]);
  const months = useMemo(() => buildMonths(startDate, endDate), [startDate, endDate]);
  const prefs = useMemo(() => normalizePrefs(value, ctx, getLimits(isAdmin)), [value, ctx]);
  const summary = useMemo(() => summarize(prefs, ctx, isAdmin), [prefs, ctx, isAdmin]);
  const byDate = useMemo(() => new Map(prefs.map((p) => [p.date, p])), [prefs]);

  // Messages fade out on their own
  useEffect(() => {
    if (!message) return undefined;
    const t = setTimeout(() => setMessage(''), 3500);
    return () => clearTimeout(t);
  }, [message]);

  function handleTap(iso) {
    const result = toggleDay(prefs, iso, mode, ctx, isAdmin);
    setMessage(result.message ?? '');
    setPrefSaved(false);
    if (result.prefs !== prefs) onChange(result.prefs);
  }

  useEffect(() => {
    const fetchPref = async () => {
      const { data, error } = await supabase.from('preferences').select().eq('don_id', don.id);
      onChange(data);
    }
    fetchPref();
  }, [])

  function clearMode() {
    onChange(prefs.filter((p) => p.kind !== mode));
    setMessage(mode === 'rank' ? 'Cleared your picks.' : 'Cleared your "can\'t work" days.');
  }

  const modeCount = mode === 'rank' ? summary.ranked.length : summary.nos.length;
  const canSave = isAdmin ? !(prefSaving || prefSaved) : !(prefSaving || prefSaved || summary.ranksMissing > 0 || summary.weekendWarning);
  return (
    <div className="relative isolate w-full max-w-xl mx-auto h-full">
      {/* Soft color blobs behind the glass so the blur has something to show */}
      <div aria-hidden className="pointer-events-none absolute inset-0 -z-10 overflow-hidden rounded-[2rem]">
        <div className="absolute -top-16 -left-10 h-56 w-56 rounded-full blur-3xl opacity-5"
          style={{ background: TEAL_DEEP }} />
        <div className="absolute -bottom-20 -right-10 h-64 w-64 rounded-full blur-3xl opacity-15"
          style={{ background: '#0F3460' }} />
        <div className="absolute top-1/3 right-1/4 h-32 w-32 rounded-full blur-3xl opacity-5"
          style={{ background: ROSE }} />
      </div>

      <div className="rounded-[2rem] border border-white/10 bg-white/[0.05] p-3 sm:p-6 text-[#C5C6C7]
                      backdrop-blur-xl shadow-[0_8px_40px_rgba(0,0,0,0.45)]">

        {/* Mode switch */}
        <div role="tablist" aria-label="What are you marking?"
          className="grid grid-cols-2 gap-1 rounded-2xl bg-black/20 p-1 ring-1 ring-white/10">
          <ModeButton active={mode === 'rank'} onClick={() => setMode('rank')} color={TEAL}
            label="Days I'd like" count={`${summary.ranked.length}/${MAX_RANKS}`} />
          <ModeButton active={mode === 'no'} onClick={() => setMode('no')} color={ROSE}
            label="Can't work" count={`${summary.nos.length}/${MAX_NOS}`} />
        </div>

        <p className="mt-3 text-xs sm:text-sm text-white/60">
          {mode === 'rank'
            ? 'Tap days in order of preference. Tap a picked day to remove it; the rest move up.'
            : `Tap up to ${MAX_NOS} days you can't work. You won't be scheduled on these.`}
        </p>

        {months.map((month) => (
          <section key={month.key} className="mt-4">
            <h3 className="mb-2 text-base sm:text-lg font-semibold text-white">{month.label}</h3>

            <div className="grid grid-cols-7 gap-1.5 sm:gap-2.5 text-center text-[11px] sm:text-xs font-semibold uppercase tracking-wide">
              {WEEKDAYS.map((d, i) => (
                <span key={i} className={i === 5 || i === 6 ? 'text-[#66FCF1]/80' : 'text-white/40'}>
                  {d}
                </span>
              ))}
            </div>

            <div className="mt-1.5 grid grid-cols-7 gap-1.5 sm:gap-2.5">
              {month.cells.map((iso, i) =>
                iso ? (
                  <DayCell key={iso} iso={iso} pref={byDate.get(iso)}
                    reason={getDisabledReason(iso, ctx)} mode={mode}
                    onTap={() => handleTap(iso)} />
                ) : (
                  <span key={`blank-${i}`} aria-hidden />
                ),
              )}
            </div>
          </section>
        ))}

        {/* Feedback line (announced to screen readers) */}
        <div aria-live="polite" className="mt-3 min-h-[1.25rem] text-xs sm:text-sm text-white/80">
          {message}
        </div>

        {/* Nudges */}
        <div className="mt-1 flex flex-col gap-2">
          {summary.ranksMissing > 0 && (
            <Nudge tone="info">
              Rank at least {summary.requiredRanks} days ({summary.ranksMissing} more to go).
            </Nudge>
          )}
          {summary.weekendWarning && (
            <Nudge tone="warn">
              You need a weekend shift. Rank a Friday or Saturday, or you may get one you didn't pick.
            </Nudge>
          )}
        </div>

        {/* Your picks, in priority order */}
        {summary.ranked.length > 0 && (
          <div className="mt-4">
            <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-white/50">Your picks</h4>
            <ol className="flex flex-wrap gap-2">
              {summary.ranked.map((p) => (
                <li key={p.date}>
                  <button type="button"
                    onClick={() => { onChange(toggleDay(prefs, p.date, 'rank', ctx, isAdmin).prefs); }}
                    className="group flex items-center gap-2 rounded-full bg-white/[0.07] py-1 pl-1 pr-3 text-xs sm:text-sm
                                     ring-1 ring-white/10 transition hover:bg-white/[0.12] focus-visible:outline-none
                                     focus-visible:ring-2 focus-visible:ring-[#66FCF1]/70"
                    aria-label={`Remove ${formatDay(p.date)}, your ${ordinal(p.rank)} choice`}>
                    <span className="grid h-6 w-6 place-items-center rounded-full text-[11px] font-bold text-[#0B0C10]"
                      style={{ background: `linear-gradient(135deg, ${TEAL}, ${TEAL_DEEP})` }}>
                      {p.rank}
                    </span>
                    <span className="text-white/90">{formatDay(p.date)}</span>
                    <span aria-hidden className="text-white/30 group-hover:text-white/70">✕</span>
                  </button>
                </li>
              ))}
            </ol>
          </div>
        )}

        {/* Legend + clear */}
        <div className="mt-5 flex flex-wrap items-center justify-between gap-3 border-t border-white/10 pt-4">
          <ul className="flex flex-wrap gap-x-4 gap-y-2 text-[11px] sm:text-xs text-white/60">
            <Legend swatch={<span className="h-3 w-3 rounded" style={{ background: `linear-gradient(135deg, ${TEAL}, ${TEAL_DEEP})` }} />} label="Picked" />
            <Legend swatch={<span className="h-3 w-3 rounded ring-1 ring-[#F87171]/60 bg-[#F87171]/25" />} label="Can't work" />
            <Legend swatch={<span className="h-3 w-3 rounded ring-1 ring-white/10 bg-[#66FCF1]/10" />} label="Fri/Sat" />
            <Legend swatch={<span className="h-3 w-3 rounded ring-1 ring-white/5 bg-white/[0.02]" />} label="Unavailable" />
          </ul>
          <button type="button" onClick={clearMode} disabled={modeCount === 0}
            className="rounded-full px-3 py-1.5 text-xs font-medium text-white/70 ring-1 ring-white/15 transition
                             hover:bg-white/10 hover:text-white disabled:opacity-30 disabled:hover:bg-transparent
                             focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#66FCF1]/70">
            Clear {mode === 'rank' ? 'picks' : "can't work"}
          </button>

          <div className='flex justify-between w-full p-2 gap-3'>
            <div className='flex items-center gap-3'>
              <span>Are you willing to take an Extra Shift?</span>
              <input
                type="checkbox"
                checked={volunteer}
                onChange={(e)=>setVolunteer(e.target.checked)}
                className={`h-5 w-5 cursor-pointer rounded border-gray-300 accent-teal-300`}
              />

            </div>
            {
              <button disabled={!canSave} onClick={() => { if (canSave) { handleSavePref() } else { setMessage('Some Errors Need Fixing!!!') } }} className={` rounded font-semibold p-3 ${canSave ? 'bg-[#004D61]/50 cursor-pointer' : 'bg-[#66FCF1]/7 cursor-not-allowed'}`}>{prefSaving ? 'Saving' : prefSaved ? 'Saved' : 'Save'}</button>
            }</div>
        </div>
      </div>
    </div>
  );
}

function ModeButton({ active, onClick, color, label, count }) {
  return (
    <button type="button" role="tab" aria-selected={active} onClick={onClick}
      className={`flex items-center justify-center gap-2 rounded-xl px-3 py-2 text-sm font-semibold transition
                        focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/50
                        ${active ? 'bg-white/[0.12] text-white shadow-[0_2px_12px_rgba(0,0,0,0.3)] ring-1 ring-white/15'
          : 'text-white/50 hover:text-white/80'}`}>
      <span className="h-2 w-2 rounded-full" style={{ background: color, opacity: active ? 1 : 0.5 }} />
      {label}
      <span className={`rounded-full px-1.5 text-[11px] ${active ? 'bg-black/30' : 'bg-black/20'}`}>{count}</span>
    </button>
  );
}

function DayCell({ iso, pref, reason, mode, onTap }) {
  const dayNum = parseISO(iso).d;
  const weekend = isWeekend(iso);
  const disabled = Boolean(reason);
  const ranked = pref?.kind === 'rank';
  const blocked = pref?.kind === 'no';

  let look = 'bg-white/[0.06] ring-1 ring-white/10 text-white/85 hover:bg-white/[0.12] hover:ring-white/25 active:scale-95';
  if (weekend) look += ' bg-[#66FCF1]/[0.08]';
  if (mode === 'no' && !pref) look += ' hover:ring-[#F87171]/40';
  if (ranked) look = 'text-[#0B0C10] ring-1 ring-white/40 shadow-[0_0_18px_rgba(102,252,241,0.35)] active:scale-95';
  if (blocked) look = 'bg-[#F87171]/20 ring-1 ring-[#F87171]/60 text-[#FECACA] active:scale-95';
  if (disabled) look = 'bg-white/[0.02] ring-1 ring-white/5 text-white/20 cursor-not-allowed';

  const label = [
    formatDay(iso),
    ranked && `your ${ordinal(pref.rank)} choice`,
    blocked && "marked can't work",
    reason,
  ].filter(Boolean).join(', ');

  return (
    // aria-disabled (not disabled) so a tap still explains *why* on phones, where there's no hover
    <button type="button" onClick={onTap} aria-disabled={disabled} aria-pressed={ranked || blocked}
      aria-label={label} title={reason ?? undefined}
      style={ranked ? { background: `linear-gradient(135deg, ${TEAL}, ${TEAL_DEEP})` } : undefined}
      className={`relative flex aspect-square select-none flex-col items-center justify-center rounded-xl sm:rounded-2xl
                        text-sm sm:text-base font-semibold transition duration-150
                        focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#66FCF1]/70 ${look}`}>
      <span className={disabled && reason?.startsWith('No duty') ? 'line-through decoration-white/20' : ''}>
        {dayNum}
      </span>

      {ranked && (
        <span className="absolute right-0.5 top-0.5 sm:right-1 sm:top-1 grid h-4 w-4 sm:h-5 sm:w-5 place-items-center
                         rounded-full bg-[#0B0C10]/85 text-[10px] sm:text-[11px] font-bold text-[#66FCF1]">
          {pref.rank}
        </span>
      )}
      {ranked && <span className="hidden sm:block text-[10px] font-medium leading-none opacity-70">{ordinal(pref.rank)}</span>}
      {blocked && <span aria-hidden className="text-[10px] sm:text-xs leading-none">✕</span>}
      {weekend && !pref && !disabled && (
        <span aria-hidden className="absolute bottom-1 h-1 w-1 rounded-full bg-[#66FCF1]/70" />
      )}
    </button>
  );
}

function Nudge({ tone, children }) {
  const styles = tone === 'warn'
    ? 'bg-amber-400/10 ring-amber-300/30 text-amber-100'
    : 'bg-[#66FCF1]/10 ring-[#66FCF1]/25 text-[#D6FFFC]';
  return (
    <p className={`rounded-xl px-3 py-2 text-xs sm:text-sm ring-1 backdrop-blur-sm ${styles}`}>{children}</p>
  );
}

function Legend({ swatch, label }) {
  return (
    <li className="flex items-center gap-1.5">
      {swatch}
      {label}
    </li>
  );
}
