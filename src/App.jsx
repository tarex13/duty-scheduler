import { useEffect, useState } from 'react'
import './App.css'
import { ensureSession, supabase } from './lib/supabase'
import DutyCalendar from './DutyCalendar'
import Admin from './Admin'
import PublishedSchedule from './PublishedSchedule' // NEW

export const STAGES = ['setup', 'open', 'closed', 'published'];

// NEW: /admin shows the admin panel, everything else shows the don screens.
// They're separate components so the don code (which signs in anonymously on claim)
// never runs on the admin page.
function App() {
  const isAdminPage = window.location.pathname.startsWith('/admin');
  return isAdminPage ? <Admin /> : <DonApp />;
}

// CHANGED: this was App; the body is the same except where marked
function DonApp() {
  const [session, setSession] = useState(null);
  const [dons, setDons] = useState([]);
  const [selectedUser, setSelectedUser] = useState('');
  const [myDon, setMyDon] = useState(null);   // the don this device claimed, if any
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [sessionDBRealtime, setSessionDBRealtime] = useState(undefined); // CHANGED: undefined = still loading, null = no round open
  const [claiming, setClaiming] = useState(false);
  const [prefs, setPrefs] = useState([]);
  const [volunteer, setVolunteer] = useState(false);
  const [prefSaving, setPrefSaving] = useState(false);
  const [prefSaved, setPrefSaved] = useState(false);

  async function handleClaim(donId) {
    setClaiming(true);
    setError('');
    try {
      await ensureSession(); // reuses an existing session or signs in anonymously

      const { error: claimError } = await supabase.rpc('claim_don', { p_don_id: donId });
      if (claimError) throw claimError; // e.g. "That name is already taken"

      // RLS now lets them read their own row (claimed_by = auth.uid())
      const { data, error: ownError } = await supabase
        .from('dons')
        .select('*')
        .eq('id', donId)
        .single();
      if (ownError) throw ownError;

      setMyDon(data);
      // CHANGED: removed `stage: s.stage + 1`. The stage belongs to the admin and is
      // shared by everyone; which screen a don sees now depends on the stage AND on
      // whether they've claimed a name (see `screen` below).
    } catch (err) {
      setError(err.message);
      // Refresh the list so a name someone else just took shows as taken
      const { data } = await supabase.from('don_directory').select('*')
        .eq('session_id', sessionDBRealtime.id).order('name'); // CHANGED: this session only
      if (data) setDons(data);
    } finally {
      setClaiming(false);
    }
  }

  const handleSavePref = async () => {
    if (!myDon?.id || prefSaving) return; // ignore double taps while saving
    if(sessionDBRealtime?.stage == 4) {alert("Submissions Paused"); return}
    setPrefSaving(true);
    try {
      const { error } = await supabase.rpc('submit_preferences', {
        p_don_id: myDon.id,
        p_prefs: prefs,          // [{ date, kind, rank }], straight from DutyCalendar
        p_volunteer: volunteer,  // the "willing to take an extra shift" checkbox
      });
      setPrefSaved(true);
      if (error) throw error;
    } catch (err) {
      setPrefSaved(false);
      alert(`Could not save preferences: ${err.message}`);
      // The function's messages are written for users, e.g. "Please rank at least 3 days"
    } finally {
      setPrefSaving(false);
    }
  };

  useEffect(() => {
    let channel = null;
    let cancelled = false;

    async function fetchRound(id) {
      const query = supabase.from('sessions').select('*');
      const { data, error } = id
        ? await query.eq('id', id).single()
        : // CHANGED: newest session past 'setup', so a session you're still preparing stays hidden
          await query.neq('status', 'setup').order('created_at', { ascending: false }).limit(1).maybeSingle();
      if (error) throw error;
      return data;
    }

    async function init() {
      try {
        const data = await fetchRound();
        if (cancelled || !data) {
          setSessionDBRealtime(data);
          return;
        }
        setSessionDBRealtime(data);

        channel = supabase
          .channel(`session-${data.id}`)
          .on(
            'postgres_changes',
            {
              event: 'UPDATE',
              schema: 'public',
              table: 'sessions',
              filter: `id=eq.${data.id}`, // only this round's row
            },
            (payload) => setSessionDBRealtime(payload.new) // the full updated row, including stage
          )
          .subscribe(async (status) => {
            // Refetch once connected (and after reconnects) to catch any
            // change made between the first fetch and the subscription
            if (status === 'SUBSCRIBED') {
              try {
                const fresh = await fetchRound(data.id);
                if (!cancelled) setSessionDBRealtime(fresh);
              } catch (err) {
                if (!cancelled) setError(err.message);
              }
            }
          });
      } catch (err) {
        if (!cancelled) setError(err.message);
      }
    }

    init();

    // Unsubscribe on unmount (also stops StrictMode from leaving a duplicate listener)
    return () => {
      cancelled = true;
      if (channel) supabase.removeChannel(channel);
    };
  }, []);

  useEffect(() => {
    if (error == '') return;
    alert(error);
    setError('');
  }, [error])

  useEffect(() => {
    const sessionId = sessionDBRealtime?.id; // CHANGED: wait until we know which session
    if (!sessionId) return;
    let cancelled = false; // ignore results if the component unmounts mid-load

    async function init() {
      try {
        // CHANGED: only *check* for an existing session here. Signing in anonymously
        // now happens on claim (handleClaim → ensureSession), as you planned, so
        // people who just open the link don't each create an anonymous user.
        const { data: { session } } = await supabase.auth.getSession();
        if (cancelled) return;
        setSession(session);

        const [dirRes, ownRes] = await Promise.all([
          supabase.from('don_directory').select('*').eq('session_id', sessionId).order('name'), // CHANGED: this session only
          // CHANGED: no session = nothing claimed yet (before, this ran .eq with undefined)
          session
            ? supabase.from('dons').select('*').eq('session_id', sessionId).eq('claimed_by', session.user.id).maybeSingle() // CHANGED: this session only
            : Promise.resolve({ data: null, error: null }),
        ]);

        if (dirRes.error) throw dirRes.error; // CHANGED: check errors before using the data
        if (ownRes.error) throw ownRes.error;
        if (cancelled) return;

        const find = dirRes.data.find((val) => val.is_mine == true);
        if (find) {
          setSelectedUser(find.id);
          setDons([find, ...dirRes.data.filter((val) => val.id != find.id)]);
        } else {
          setDons(dirRes.data);
        }
        setMyDon(ownRes.data);
      } catch (err) {
        if (!cancelled) setError(err.message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    init();
    return () => { cancelled = true; };
  }, [sessionDBRealtime?.id]); // CHANGED: was [], now reloads for the session

  useEffect(() => {
    const userId = myDon?.id;
    if (!userId) return;

    let cancelled = false;

    async function fetchPref() {
      const { data, error } = await supabase
        .from('preferences')
        .select('date, kind, rank')
        .eq('don_id', userId);

      // CHANGED: the error key is `error` (it was `errorData`, which is always undefined),
      // and filters go before .maybeSingle()
      const { data: volunteerData, error: volunteerError } = await supabase
        .from('submissions')
        .select('volunteer_extra')
        .eq('don_id', userId)
        .maybeSingle();

      if (cancelled) return;
      if (error) {
        console.error(error);
        return;
      }
      if (volunteerError) {
        console.error(volunteerError);
        return;
      }
      setPrefs(data ?? []);
      // CHANGED: volunteerData is null until they've submitted once; this used to crash
      setVolunteer(volunteerData?.volunteer_extra ?? false);
    }

    fetchPref();

    return () => { cancelled = true; };
  }, [myDon?.id]);

  // NEW: which screen to show. Stage is the admin's; claiming is per person.
  //   no name claimed (stages 1–4) → name picker (claim_don itself checks status = 'open')
  //   stages 1–2 → your info, waiting
  //   stages 3–4 → your info + calendar (same for dons in both, as you wanted)
  //   stage 5    → published schedule
  const stage = Number(sessionDBRealtime?.stage);
  const screen =
    stage >= 5 ? 'published'
      : !myDon ? 'pick'
        : stage >= 3 ? 'calendar'
          : 'info';

  // CHANGED: separate "loading" from "no round open"
  if (sessionDBRealtime === undefined || (sessionDBRealtime && loading)) {
    return <div className='h-screen grid place-items-center text-white/60'>Loading…</div>;
  }
  if (sessionDBRealtime === null) {
    return <div className='h-screen grid place-items-center text-white/60'>No scheduling round is open yet.</div>;
  }

  return (
    // CHANGED: un-commented; this is your don UI, with the stage checks swapped for `screen`
    <div className='h-screen overflow-hidden flex items-center'>
      <section className='text-left items-center max-h-[80%] flex flex-col overflow-y-auto w-full rounded border-[#2e303a] border-2 rounded bg-[#E0E0E0]/5'>
        <div className='flex justify-center flex-col items-center p-2'>
          <div><span className='text-[#F7F7F7] text-2xl font-semibold'>Duty Scheduling</span></div>
          {screen == 'pick' && <span className='text-lg font-mono'>Select your Name</span>}
          {(screen == 'info' || screen == 'calendar') && <span className='text-lg font-mono'>Your Info</span>}
        </div>
        {screen == 'pick' && <>
          <div className='overflow-y-scroll w-full'>
            {dons.map((val, index) => {
              // CHANGED: removed console.log(val), which ran on every render
              return (
                // CHANGED: taken names can't be selected (claim_don would refuse anyway)
                <div key={val.id} onClick={() => { if (!val.is_claimed || val.is_mine) setSelectedUser(val?.id) }} className={`${selectedUser == val.id ? 'bg-[#ffeb3b]/20' : 'bg-[#E4E4E4]/20 '} ${val.is_claimed && !val.is_mine ? 'opacity-40 cursor-not-allowed' : 'cursor-pointer hover:bg-[#ffeb3b]/20'} rounded-lg p-2 m-2 flex justify-between shadow-lg`}>
                  <span className={`${selectedUser == val?.id && 'font-bold text-white/90'}`}>{val.name}{val.is_claimed && !val.is_mine && <span className='ml-2 text-xs'>(taken)</span>}</span>
                  <div className=' p-1 rounded'><span>{val?.house}</span></div>
                </div>
              )
            })}
          </div>
          <div className='flex justify-end w-full p-2'>
            <button disabled={claiming} onClick={() => {
              if (selectedUser == '') return;
              // NEW: a mis-tap claims someone else's name, and only the admin can undo it
              const name = dons.find((d) => d.id === selectedUser)?.name;
              if (!window.confirm(`Claim "${name}"? Only pick your own name.`)) return;
              handleClaim(selectedUser);
            }} className={` rounded cursor-pointer font-semibold p-3 ${!claiming ? 'bg-[#004D61]/40' : 'bg-[#E4E4E4]/20 '}`}>{!claiming ? 'Confirm' : 'Claiming'}</button>
          </div>
        </>}
        {(screen == 'info' || screen == 'calendar') &&
          // CHANGED: stacks on phones (flex-col md:flex-row), w-[50%] only from md up
          <div className='w-full p-3 flex flex-col gap-3 md:flex-row'>
            <div className='w-full md:w-[50%] flex justify-center items-center flex-col'>
              <span className='font-bold text-white text-2xl'>{myDon?.name} - {myDon?.house}</span>
              <span className='text-lg font-mono'>Your Stats: </span>
              <span className='text-sm'>(Session {screen == 'info' && 'Not'} Started) </span>
            </div>
            <div className='border-2 border-[#0F3460]/20 bg-[#1F2833] shadow-2xl w-full h-full p-3 rounded'>
              <div className='font-semibold'>Current Shifts: <span className='font-semibold '>{myDon?.current_total}</span></div>
              <div><span className='font-semibold'>Current Weekend Shifts:</span>  <span>{myDon?.current_weekend}</span></div>
              <div className='text-[#45A29E]'><span className='font-bold'>Min Weekend Shift(s): </span> <span className='font-semibold'>{myDon?.min_weekend}</span></div>
              <div className=' text-[#45A29E]'><span className='font-bold'>Min Total Shift(s):</span> <span className='font-semibold'>{myDon?.min_total}</span></div>
              <div className=''><span className='font-semibold'>Max Weekend Shift(s):</span>  <span>{myDon?.max_weekend}</span></div>
              <div><span className='font-semibold'>Max Total Shift(s):</span> <span>{myDon?.max_total}</span></div>
            </div>
          </div>
        }

        {screen == 'calendar' && myDon && (
          <div className="w-full p-3 flex flex-col">
            <DutyCalendar
              startDate={sessionDBRealtime?.start_date}
              endDate={sessionDBRealtime?.end_date}
              don={myDon}
              value={prefs}
              onChange={setPrefs}
              prefSaving={prefSaving}
              handleSavePref={handleSavePref}
              volunteer={volunteer}
              prefSaved={prefSaved}
              setPrefSaved = {setPrefSaved}
              setVolunteer={setVolunteer}
              
            />
          </div>
        )}

        {/* NEW: stage 5 */}
        {screen == 'published' && <PublishedSchedule session={sessionDBRealtime} myDon={myDon} />}
      </section>

    </div>
  )
}

export default App
