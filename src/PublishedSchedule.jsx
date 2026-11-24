import { useEffect, useMemo, useState } from 'react';
import { supabase } from './lib/supabase';
import { formatDay, isWeekend } from './calendarLogic';
import { DUTY_GROUPS, listDays } from './preflightChecks';

const glass = 'rounded-3xl border border-white/10 bg-white/[0.05] backdrop-blur-xl shadow-[0_8px_40px_rgba(0,0,0,0.45)]';

/**
 * Don-side stage 5: "My shifts" + the full schedule.
 * Reloads by itself when the admin publishes or republishes, because the
 * session row (with published_schedule_id) already arrives through App's listener.
 */
export default function PublishedSchedule({ session, myDon }) {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const liveId = session?.published_schedule_id;

  useEffect(() => {
    if (!liveId) { setRows([]); setLoading(false); return undefined; }
    let cancelled = false;
    (async () => {
      setLoading(true);
      const { data, error: err } = await supabase
        .from('published_schedule')
        .select('date, house, don_id, don_name, updated')
        .eq('session_id', session.id)
        .order('date');
      if (cancelled) return;
      if (err) setError(err.message); else setRows(data);
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [liveId, session?.id]);

  const days = useMemo(() => listDays(session.start_date, session.end_date), [session.start_date, session.end_date]);
  const byKey = useMemo(() => new Map(rows.map((r) => [`${r.date}|${r.house}`, r])), [rows]);
  const mine = rows.filter((r) => myDon && r.don_id === myDon.id);

  if (loading) return <p className="p-6 text-white/60">Loading schedule…</p>;
  if (error) return <p className="p-6 text-[#FCA5A5]">Couldn't load the schedule: {error}</p>;
  if (!liveId || rows.length === 0) {
    return (
      <div className={`${glass} m-3 p-6 text-center text-white/70`}>
        The schedule isn't out yet. This page will update on its own.
      </div>
    );
  }

  return (
    <div className="flex w-full flex-col gap-4 p-3 text-[#C5C6C7]">
      {myDon && (
        <section className={`${glass} p-4 sm:p-5`}>
          <h2 className="text-base sm:text-lg font-semibold text-white">My shifts</h2>
          {mine.length === 0 ? (
            <p className="mt-2 text-sm text-white/60">You have no shifts this round.</p>
          ) : (
            <ul className="mt-3 grid gap-2 sm:grid-cols-2">
              {mine.map((r) => (
                <li key={r.date}
                    className="flex items-center justify-between rounded-2xl px-4 py-3 ring-1 ring-[#66FCF1]/40"
                    style={{ background: 'linear-gradient(135deg, rgba(102,252,241,0.18), rgba(69,162,158,0.10))' }}>
                  <span className="font-semibold text-white">{formatDay(r.date)}</span>
                  <span className="flex items-center gap-2 text-xs">
                    {isWeekend(r.date) && <span className="rounded-full bg-[#66FCF1]/15 px-2 py-0.5 text-[#66FCF1]">Fri/Sat</span>}
                    {r.updated && <span className="rounded-full bg-amber-300/15 px-2 py-0.5 text-amber-200">Updated</span>}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      <section className={`${glass} p-3 sm:p-4`}>
        <h2 className="px-1 pb-2 text-base sm:text-lg font-semibold text-white">Full schedule</h2>
        <div className="mb-1 hidden grid-cols-[110px_1fr_1fr] gap-2 px-2 text-[11px] font-semibold uppercase tracking-wide text-white/40 sm:grid">
          <span>Day</span>{DUTY_GROUPS.map((g) => <span key={g}>{g}</span>)}
        </div>
        <ul className="flex flex-col gap-1.5">
          {days.map((date) => (
            <li key={date}
                className={`grid grid-cols-2 gap-1.5 rounded-2xl p-1.5 sm:grid-cols-[110px_1fr_1fr] sm:gap-2 ${isWeekend(date) ? 'bg-[#66FCF1]/[0.06]' : ''}`}>
              <span className="col-span-2 px-1 text-xs font-semibold text-white/80 sm:col-span-1 sm:self-center sm:text-sm">
                {formatDay(date)}
              </span>
              {DUTY_GROUPS.map((g) => {
                const r = byKey.get(`${date}|${g}`);
                const isMe = myDon && r?.don_id === myDon.id;
                return (
                  <span key={g}
                        className={`flex items-center gap-2 rounded-xl px-3 py-2 text-sm ring-1 ${
                          isMe ? 'bg-[#66FCF1]/20 text-white ring-[#66FCF1]/60 font-semibold' : 'bg-white/[0.05] text-white/85 ring-white/10'}`}>
                    <span className="text-[10px] font-semibold text-white/40 sm:hidden">{g}</span>
                    <span className="truncate">{r?.don_name ?? '—'}</span>
                    {r?.updated && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-amber-300" title="Changed since the last version" />}
                  </span>
                );
              })}
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
