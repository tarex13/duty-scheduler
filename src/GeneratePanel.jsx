import { useMemo, useState } from 'react';
import { buildMonths, formatDay, parseISO } from './calendarLogic';

const WEEKDAYS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];

/**
 * Stage 4: stats + Generate.
 *   analysis       result of analyzeSession(...)
 *   startDate, endDate
 *   onGenerate()   your solver call (async is fine)
 *   generating     true while the solver runs
 */
export default function GeneratePanel({ analysis, startDate, endDate, onGenerate, generating }) {
  const [override, setOverride] = useState(false);
  const months = useMemo(() => buildMonths(startDate, endDate), [startDate, endDate]);
  const houses = Object.values(analysis.houses);
  const { counts } = analysis;
  const blocked = counts.error > 0 && !override;

  return (
    <div className="flex w-full flex-col gap-4">
      {/* Generate bar */}
      <section className="rounded-3xl border border-white/10 bg-white/[0.05] p-4 sm:p-5 backdrop-blur-xl
                          shadow-[0_8px_40px_rgba(0,0,0,0.45)] text-[#C5C6C7]">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 className="text-base sm:text-lg font-semibold text-white">Generate schedule</h2>
            <p className="text-xs sm:text-sm text-white/60">
              {counts.error > 0
                ? `${counts.error} must-fix issue${counts.error === 1 ? '' : 's'} in Stage 3. Generating now will leave gaps or missed minimums.`
                : counts.warning > 0
                  ? `No blockers. ${counts.warning} warning${counts.warning === 1 ? '' : 's'} worth a look in Stage 3.`
                  : 'All checks pass.'}
            </p>
            {counts.error > 0 && (
              <label className="mt-2 flex items-center gap-2 text-xs sm:text-sm text-white/75">
                <input type="checkbox" checked={override} onChange={(e) => setOverride(e.target.checked)}
                       className="h-4 w-4 accent-[#F87171]" />
                Generate anyway; I'll fix the gaps by hand
              </label>
            )}
          </div>
          <button type="button" onClick={onGenerate} disabled={blocked || generating}
                  className="shrink-0 rounded-2xl px-6 py-3 text-sm font-bold text-[#0B0C10] transition
                             shadow-[0_0_24px_rgba(102,252,241,0.35)] hover:brightness-110 active:scale-[0.98]
                             disabled:cursor-not-allowed disabled:opacity-40 disabled:shadow-none
                             focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70"
                  style={{ background: 'linear-gradient(135deg, #66FCF1, #45A29E)' }}>
            {generating ? 'Generating…' : 'Generate'}
          </button>
        </div>
      </section>

      {/* One card per house */}
      <div className="grid gap-4 lg:grid-cols-2">
        {houses.map((h) => (
          <HouseStats key={h.house} h={h} months={months} startDate={startDate} endDate={endDate}
                      weekendCount={analysis.weekendDays.length} />
        ))}
      </div>
    </div>
  );
}

function HouseStats({ h, months, startDate, endDate, weekendCount }) {
  const dayInfo = useMemo(() => new Map(h.perDay.map((d) => [d.date, d])), [h.perDay]);
  const maxRanks = Math.max(1, ...h.perDay.map((d) => d.ranks));

  const mostWanted = [...h.perDay].filter((d) => d.ranks > 0)
    .sort((a, b) => b.firsts - a.firsts || b.ranks - a.ranks).slice(0, 3);
  const mostNo = [...h.perDay].filter((d) => d.nos.length > 0)
    .sort((a, b) => b.nos.length - a.nos.length).slice(0, 3);

  return (
    <section className="rounded-3xl border border-white/10 bg-white/[0.05] p-4 sm:p-5 backdrop-blur-xl
                        shadow-[0_8px_40px_rgba(0,0,0,0.45)] text-[#C5C6C7]">
      <div className="flex items-center justify-between">
        <h3 className="text-base sm:text-lg font-semibold text-white">{h.house}</h3>
        <span className={`rounded-full px-2.5 py-1 text-xs font-semibold ring-1 ${
          h.feasible === false ? 'bg-[#F87171]/15 text-[#FECACA] ring-[#F87171]/40'
            : h.feasible ? 'bg-[#66FCF1]/10 text-[#D6FFFC] ring-[#66FCF1]/30'
              : 'bg-white/5 text-white/60 ring-white/15'}`}>
          {h.feasible === false ? 'No valid schedule yet' : h.feasible ? 'Schedule possible' : 'Fix data first'}
        </span>
      </div>

      <dl className="mt-4 grid grid-cols-2 sm:grid-cols-4 gap-2">
        <Stat label="Joined" value={`${h.claimed}/${h.donCount}`} />
        <Stat label="Submitted" value={`${h.submitted}/${h.donCount}`} />
        <Stat label="Extra shifts" value={h.extras} sub={`${h.volunteers} volunteer${h.volunteers === 1 ? '' : 's'}`} />
        <Stat label="Weekend need" value={`${h.sumMinWk}/${weekendCount}`} sub="min Fri/Sat" />
      </dl>

      {/* Demand heat map: how many dons ranked each day */}
      {months.map((m) => (
        <div key={m.key} className="mt-4">
          <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-white/50">Picks per day</p>
          <div className="grid grid-cols-7 gap-1 text-center text-[10px] font-semibold text-white/40">
            {WEEKDAYS.map((d, i) => <span key={i}>{d}</span>)}
          </div>
          <div className="mt-1 grid grid-cols-7 gap-1">
            {m.cells.map((iso, i) => {
              if (!iso) return <span key={`b${i}`} />;
              const info = dayInfo.get(iso);
              if (!info || iso < startDate || iso > endDate) {
                return (
                  <span key={iso} className="grid aspect-square place-items-center rounded-lg bg-white/[0.02] text-[10px] text-white/15">
                    {parseISO(iso).d}
                  </span>
                );
              }
              const heat = info.ranks / maxRanks;
              const risky = info.available.length <= 1;
              return (
                <span key={iso}
                      title={`${formatDay(iso)}: ${info.ranks} pick${info.ranks === 1 ? '' : 's'} (${info.firsts} first), ${info.nos.length} "no", ${info.available.length} available`}
                      className={`relative grid aspect-square place-items-center rounded-lg text-[11px] sm:text-xs font-semibold ring-1
                                  ${risky ? 'ring-[#F87171]/70' : 'ring-white/10'} ${heat > 0.5 ? 'text-[#0B0C10]' : 'text-white/80'}`}
                      style={{ background: info.ranks
                        ? `rgba(102, 252, 241, ${0.12 + heat * 0.75})`
                        : 'rgba(255,255,255,0.04)' }}>
                  {info.ranks || '·'}
                  {info.nos.length > 0 && (
                    <span className="absolute bottom-0.5 right-0.5 h-1.5 w-1.5 rounded-full bg-[#F87171]" />
                  )}
                </span>
              );
            })}
          </div>
          <p className="mt-1.5 text-[11px] text-white/45">
            Number = dons who ranked it. Red dot = someone said "no". Red ring = 1 or fewer dons available.
          </p>
        </div>
      ))}

      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <MiniList title="Most wanted"
                  items={mostWanted.map((d) => `${formatDay(d.date)}: ${d.firsts} first, ${d.ranks} total`)} />
        <MiniList title={'Most "no"'}
                  items={mostNo.map((d) => `${formatDay(d.date)}: ${d.nos.length} "no", ${d.available.length} left`)} />
      </div>
    </section>
  );
}

function Stat({ label, value, sub }) {
  return (
    <div className="rounded-2xl bg-white/[0.04] p-3 ring-1 ring-white/10">
      <dt className="text-[11px] uppercase tracking-wide text-white/50">{label}</dt>
      <dd className="mt-0.5 text-lg font-bold text-white">{value}</dd>
      {sub && <dd className="text-[11px] text-white/50">{sub}</dd>}
    </div>
  );
}

function MiniList({ title, items }) {
  return (
    <div className="rounded-2xl bg-white/[0.04] p-3 ring-1 ring-white/10">
      <p className="text-[11px] font-semibold uppercase tracking-wide text-white/50">{title}</p>
      {items.length === 0
        ? <p className="mt-1 text-xs text-white/40">Nothing yet</p>
        : <ul className="mt-1 space-y-0.5 text-xs sm:text-sm text-white/80">{items.map((t) => <li key={t}>{t}</li>)}</ul>}
    </div>
  );
}
