import { useMemo, useState } from 'react';
import { formatDay } from './calendarLogic';

const TONE = {
  error:   { label: 'Must fix', dot: 'bg-[#F87171]', bar: 'bg-[#F87171]', chip: 'bg-[#F87171]/15 text-[#FECACA] ring-[#F87171]/40' },
  warning: { label: 'Check',    dot: 'bg-amber-300', bar: 'bg-amber-300', chip: 'bg-amber-300/10 text-amber-100 ring-amber-300/30' },
  info:    { label: 'FYI',      dot: 'bg-[#66FCF1]', bar: 'bg-[#66FCF1]/70', chip: 'bg-[#66FCF1]/10 text-[#D6FFFC] ring-[#66FCF1]/25' },
};

/**
 * Stage 3 warnings list.
 *   analysis       result of analyzeSession(...)
 *   onSelectDon    (donId) => void   opens that don in your list + calendar
 *   selectedDonId  highlights that don's chips
 */
export default function PreflightPanel({ analysis, onSelectDon, selectedDonId }) {
  const [severity, setSeverity] = useState('all'); // all | error | warning | info
  const [house, setHouse] = useState('all');
  const [open, setOpen] = useState(true);
  //console.log(analysis);
  const houses = Object.keys(analysis.houses);
  const visible = useMemo(
    () => analysis.issues.filter(
      (i) => (severity === 'all' || i.severity === severity) && (house === 'all' || i.house === house),
    ),
    [analysis.issues, severity, house],
  );
  const { counts } = analysis;
  const clean = counts.error === 0 && counts.warning === 0;

  return (
    <section className="w-full rounded-3xl border border-white/10 bg-white/[0.05] p-3 sm:p-5 text-[#C5C6C7]
                        backdrop-blur-xl shadow-[0_8px_40px_rgba(0,0,0,0.45)]">
      <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open}
              className="flex w-full items-center justify-between gap-3 text-left focus-visible:outline-none">
        <div>
          <h2 className="text-base sm:text-lg font-semibold text-white">Pre-generation checks</h2>
          <p className="text-xs sm:text-sm text-white/60">
            {clean ? 'Nothing blocking. You can move on to Generate.' : 'Fix these, or ask dons to, before generating.'}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1.5 text-xs font-semibold">
          {['error', 'warning', 'info'].map((s) => (
            <span key={s} className={`rounded-full px-2 py-0.5 ring-1 ${TONE[s].chip}`}>{counts[s]}</span>
          ))}
          <span aria-hidden className={`ml-1 text-white/40 transition ${open ? 'rotate-180' : ''}`}>▾</span>
        </div>
      </button>

      {open && (
        <>
          <div className="mt-4 flex flex-wrap gap-2">
            {['all', 'error', 'warning', 'info'].map((s) => (
              <FilterChip key={s} active={severity === s} onClick={() => setSeverity(s)}>
                {s === 'all' ? 'All' : TONE[s].label}  {s !== 'all' && <span className="opacity-60">- {counts[s]}</span>}
              </FilterChip>
            ))}
            <span className="mx-1 hidden sm:block w-px bg-white/10" />
            {['all', ...houses].map((h) => (
              <FilterChip key={h} active={house === h} onClick={() => setHouse(h)}>
                {h === 'all' ? 'Both houses' : h}
              </FilterChip>
            ))}
          </div>

          <ul className="mt-4 gap-2.5">
            {visible.length === 0 && (
              <li className="rounded-2xl bg-white/[0.04] p-4 text-sm text-white/60 ring-1 ring-white/10">
                Nothing here. 🎉
              </li>
            )}
            {visible.map((issue) => (
              <IssueCard key={issue.id} issue={issue} nameOf={analysis.nameOf}
                         onSelectDon={onSelectDon} selectedDonId={selectedDonId} />
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

function IssueCard({ issue, nameOf, onSelectDon, selectedDonId }) {
  const tone = TONE[issue.severity];
  const [showAll, setShowAll] = useState(false);
  const lines = showAll ? issue.lines : issue.lines.slice(0, 4);

  return (
    <li className="relative overflow-hidden rounded-2xl bg-white/[0.04] p-3 pl-4 sm:p-4 sm:pl-5 ring-1 ring-white/10">
      <span aria-hidden className={`absolute inset-y-0 left-0 w-1 ${tone.bar}`} />
      <div className="flex items-start gap-2">
        <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${tone.dot}`} aria-hidden />
        <div className="min-w-0 flex-1">
          <p className="text-sm sm:text-[15px] font-semibold text-white">
            <span className="sr-only">{tone.label}: </span>{issue.title}
          </p>
          {issue.detail && <p className="mt-0.5 text-xs sm:text-sm text-white/60">{issue.detail}</p>}

          {issue.lines.length > 0 && (
            <ul className="mt-2 space-y-0.5 text-xs sm:text-sm text-white/75">
              {lines.map((l) => <li key={l}>{l}</li>)}
              {issue.lines.length > 4 && (
                <li>
                  <button type="button" onClick={() => setShowAll((s) => !s)}
                          className="text-[#66FCF1] hover:underline">
                    {showAll ? 'Show less' : `+${issue.lines.length - 4} more`}
                  </button>
                </li>
              )}
            </ul>
          )}

          {(issue.donIds.length > 0 || issue.dates.length > 0) && (
            <div className="mt-2.5 flex flex-wrap gap-1.5">
              {issue.donIds.map((id) => (
                <button key={id} type="button" onClick={() => onSelectDon?.(id)}
                        className={`rounded-full px-2.5 py-1 text-xs font-medium ring-1 transition
                                    focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#66FCF1]/70
                                    ${selectedDonId === id
                                      ? 'bg-[#66FCF1]/25 text-white ring-[#66FCF1]/60'
                                      : 'bg-white/[0.07] text-white/85 ring-white/15 hover:bg-white/[0.14]'}`}>
                  {nameOf.get(id) ?? 'Unknown'}
                </button>
              ))}
              {issue.dates.length > 0 && issue.lines.length === 0 && issue.dates.map((d) => (
                <span key={d} className={`rounded-full px-2.5 py-1 text-xs ring-1 ${tone.chip}`}>{formatDay(d)}</span>
              ))}
            </div>
          )}
        </div>
      </div>
    </li>
  );
}

function FilterChip({ active, onClick, children }) {
  return (
    <button type="button" onClick={onClick} aria-pressed={active}
            className={`rounded-full px-3 py-1.5 text-xs font-medium ring-1 transition
                        focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#66FCF1]/70
                        ${active ? 'bg-white/[0.14] text-white ring-white/25' : 'text-white/60 ring-white/10 hover:text-white'}`}>
      {children}
    </button>
  );
}
