import { useEffect, useMemo, useState } from 'react'
import heroImg from './assets/hero.png'
import reactLogo from './assets/react.svg'
import viteLogo from './assets/vite.svg'
import './App.css'
import { supabase } from './lib/supabase' // the admin signs in with email, not anonymously
import DutyCalendar from './DutyCalendar'
import { STAGES } from './App'
import { useSessionData } from './useSessionData'
import { analyzeSession } from './preflightChecks'
import { generateSchedule } from './solver'
import PreflightPanel from './PreflightPanel'
import GeneratePanel from './GeneratePanel'
import ScheduleEditor from './ScheduleEditor'

const STAGE_COUNT = 5; // 1 claims, 2 info, 3 preferences + checks, 4 stats + generate, 5 schedule

const Admin = () => {
    // who is looking at this page? 'checking' | 'signedOut' | 'notAdmin' | 'admin'
    const [authState, setAuthState] = useState('checking');
    const [selectedUserStage3, setSelectedUserStage3] = useState(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState('');
    const [totalSessions, setTotalSessions] = useState(null);
    const [sessionDB, setSessionDB] = useState(null);
    const [prefs, setPrefs] = useState([]);
    const [volunteer, setVolunteer] = useState(false);
    const [prefSaving, setPrefSaving] = useState(false);
    const [generating, setGenerating] = useState(false);

    // all dons, preferences and submissions for the selected session, kept live via Realtime
    const { dons, preferences, submissions, refresh } = useSessionData(authState === 'admin' ? sessionDB?.id : null);

    // pre-generation checks (Stage 3 + 4)
    const analysis = useMemo(() => {
        if (!sessionDB) return null;
        return analyzeSession({
            startDate: sessionDB.start_date,
            endDate: sessionDB.end_date,
            dons, preferences, submissions,
        });
    }, [sessionDB, dons, preferences, submissions]);

    // worst issue per don, for the dots in the Stage 3 list
    const worstIssue = useMemo(() => {
        const rank = { error: 0, warning: 1, info: 2 };
        const map = new Map();
        for (const issue of analysis?.issues ?? []) {
            for (const id of issue.donIds) {
                if (!map.has(id) || rank[issue.severity] < rank[map.get(id)]) map.set(id, issue.severity);
            }
        }
        return map;
    }, [analysis]);

    useEffect(() => {
        if (error == '') return;
        alert(error);
        setError('');
    }, [error])

    // only a signed-in admin (not an anonymous don) gets the panel
    useEffect(() => {
        async function check(session) {
            if (!session || session.user.is_anonymous) { setAuthState('signedOut'); return; }
            const { data, error } = await supabase.rpc('is_admin');
            setAuthState(!error && data ? 'admin' : 'notAdmin');
        }
        supabase.auth.getSession().then(({ data }) => check(data.session));
        const { data: sub } = supabase.auth.onAuthStateChange((_event, session) => {
            setTimeout(() => check(session), 0); // don't call Supabase inside this callback directly
        });
        return () => sub.subscription.unsubscribe();
    }, []);

    useEffect(() => {
        if (authState !== 'admin') return;
        let cancelled = false; // ignore results if the component unmounts mid-load

        async function init() {
            try {
                const sesData = await supabase
                    .from('sessions')
                    .select('*')
                    .order('created_at', { ascending: false });

                if (sesData.error) throw sesData.error;
                if (cancelled) return;
                setTotalSessions(sesData.data);
                setSessionDB(sesData.data[0] ?? null); // CHANGED: ?? null so an empty table doesn't leave undefined
            } catch (err) {
                if (!cancelled) setError(err.message);
            } finally {
                if (!cancelled) setLoading(false);
            }
        }

        init();
        return () => { cancelled = true; };
    }, [authState]);

    // CHANGED: removed the useEffect that called refresh() on every sessionDB change.
    // useSessionData already reloads when the session id changes; the extra call also
    // fired on every stage/status click and could let old data overwrite new data.

    useEffect(() => {
        const userId = selectedUserStage3?.id;
        if (!userId) return;

        let cancelled = false;

        async function fetchPref() {
            const { data, error } = await supabase
                .from('preferences')
                .select('date, kind, rank')
                .eq('don_id', userId);

            if (cancelled) return;
            if (error) {
                console.error(error);
                return;
            }
            setPrefs(data ?? []);
        }

        fetchPref();

        return () => { cancelled = true; };
    }, [selectedUserStage3?.id]);

    // NEW: keep the selected session and the dropdown list in sync
    const mergeSession = (fields) => {
        setSessionDB((s) => (s ? { ...s, ...fields } : s));
        setTotalSessions((list) => list?.map((s) => (s.id === sessionDB?.id ? { ...s, ...fields } : s)));
    };

    // NEW: switch session and clear anything that belonged to the old one
    const switchSession = (id) => {
        const next = totalSessions?.find((s) => s.id === id);
        if (!next) return;
        setSessionDB(next);
        setSelectedUserStage3(null);
        setPrefs([]);
        setVolunteer(false);
    };

    const selectDonStage3 = async (id) => {
        const { data, error } = await supabase.from('dons').select('*').eq('id', id).single();
        if (error) { setError(error.message); return; }
        setSelectedUserStage3(data);
        // load the don's real volunteer choice, otherwise saving would overwrite it with false
        setVolunteer(submissions.find((s) => s.don_id === id)?.volunteer_extra ?? false);
    }

    const unclaim = async (id) => {
        if (!id) return;
        const { error } = await supabase.from('dons').update({ claimed_by: null, claimed_at: null }).eq('id', id);
        if (error) { setError(error.message); return; }
        refresh();
    }

    const setSessionData = async (key, value) => {
        if (!sessionDB) return; // CHANGED: nothing to update yet
        const { error } = await supabase.from('sessions').update({ [key]: value }).eq('id', sessionDB.id);
        if (error) { setError(error.message); return; }
        mergeSession({ [key]: value }); // CHANGED: also updates the dropdown list
    }

    const handleSavePref = async () => {
        if (!selectedUserStage3?.id || prefSaving) return; // ignore double taps while saving

        setPrefSaving(true);
        try {
            const { error } = await supabase.rpc('submit_preferences', {
                p_don_id: selectedUserStage3.id,
                p_prefs: prefs,          // [{ date, kind, rank }], straight from DutyCalendar
                p_volunteer: volunteer,  // the "willing to take an extra shift" checkbox
            });
            if (error) throw error;
            refresh(); // update the checks right away
        } catch (err) {
            alert(`Could not save preferences: ${err.message}`,);
        } finally {
            setPrefSaving(false);
        }
    };

    // Stage 4 → run the solver, save as a new version, jump to Stage 5
    const handleGenerate = async () => {
        if (generating || !sessionDB) return;
        setGenerating(true);
        try {
            await new Promise((r) => setTimeout(r, 30)); // let "Generating…" render before the solver runs
            const result = generateSchedule({
                startDate: sessionDB.start_date,
                endDate: sessionDB.end_date,
                dons, preferences, submissions,
            });
            const { error } = await supabase.rpc('save_schedule', {
                p_session_id: sessionDB.id,
                p_seed: result.seed,
                p_score: result.score,
                p_breakdown: result.breakdown,
                p_assignments: result.assignments,
            });
            if (error) throw error;
            await setSessionData('stage', 5);
        } catch (err) {
            setError(err.message);
        } finally {
            setGenerating(false);
        }
    };

    // login / not-admin screens
    if (authState === 'checking') return <div className='h-screen grid place-items-center text-white/60'>Loading…</div>;
    if (authState !== 'admin') return <AdminLogin notAdmin={authState === 'notAdmin'} />;
    // NEW: loading / no sessions yet
    if (loading) return <div className='h-screen grid place-items-center text-white/60'>Loading…</div>;
    if (!sessionDB) return <div className='h-screen grid place-items-center text-white/60'>No sessions yet. Create one in Supabase first.</div>;

    return (
        <div className='h-screen overflow-hidden flex items-center'>
            <section className='text-left items-center max-h-[80%] flex flex-col overflow-y-auto w-full rounded border-[#2e303a] border-2 rounded bg-[#E0E0E0]/5'>
                <div className='flex justify-center flex-col items-center p-2'>
                    <div><span className='text-[#F7F7F7] text-2xl font-semibold'>Duty Scheduling</span></div>
                </div>
                {/* CHANGED: onChange goes on <select> (it never fires on <option>), and the select is controlled */}
                <div className='pb-3'>
                    <select value={sessionDB.id} onChange={(e) => switchSession(e.target.value)}
                        className='rounded-xl bg-black/30 px-3 py-2 text-white ring-1 ring-white/15 outline-none focus:ring-[#66FCF1]/60'>
                        {totalSessions?.map((val) => (
                            <option key={val.id} value={val.id} className='bg-[#1F2833]'>{val.name}</option>
                        ))}
                    </select>
                </div>
                <div className='gap-3 flex flex-col justify-center items-center'>
                    <div className='flex flex-wrap justify-center items-center gap-4'>
                        <span className='text-lg'>Stage: </span>
                        {STAGES.map((val, ind) => {
                            return (
                                <button key={ind} onClick={() => { setSessionData('status', val) }} className={

                                    `cursor-pointer p-2 relative flex select-none flex-row items-center justify-center
                        text-sm sm:text-base font-semibold transition duration-150
                        focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#66FCF1]/70 ${sessionDB?.status == val ? 'bg-[#E4E4E4]/[0.08]  shadow-[0_0_7px_rgba(102,252,241,0.35)]' : ' hover:bg-white/[0.12] hover:ring-white/25'} ring-1 ring-white/10 text-white/85 active:scale-95`}>{val}</button>
                            )
                        })}
                    </div>
                    <div className='flex gap-4'>
                        {[...Array(STAGE_COUNT)].map((val, ind) => {
                            return (
                                <button key={ind} onClick={() => { setSessionData('stage', ind + 1) }} className={

                                    `cursor-pointer w-10 h-10 relative flex aspect-square select-none flex-row items-center justify-center rounded-xl sm:rounded-2xl
                        text-sm sm:text-base font-semibold transition duration-150
                        focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#66FCF1]/70 ${sessionDB?.stage == (ind + 1) ? 'bg-[#66FCF1]/[0.08] shadow-[0_0_18px_rgba(102,252,241,0.35)] ' : ' hover:bg-white/[0.12] hover:ring-white/25'} ring-1 ring-white/10 text-white/85 active:scale-95`}>{ind + 1}</button>
                            )
                        })}
                    </div>
                </div>
                {sessionDB?.stage == 1 && <>
                    <div className='overflow-y-scroll w-full '>
                        <div><span className='text-[#F7F7F7] text-xl font-semibold'>Claimed</span></div>
                        {dons.filter((val) => val.claimed_by != null).map((val, index) => {

                            return (
                                <div key={val?.id} className={`bg-[#E4E4E4]/20 rounded-lg p-2 m-2 flex justify-between shadow-lg hover:bg-[#ffeb3b]/20 items-center`}>
                                    <span className={``}>{val.name}</span>
                                    <div className='flex items-center gap-3'>
                                        <div className=' p-1 rounded'><span>{val.house}</span></div>
                                        <button onClick={() => { unclaim(val.id) }} className='p-2 bg-red-700/60 rounded-lg cursor-pointer'>Unclaim</button>
                                    </div>
                                </div>
                            )
                        })}
                        <div><span className='text-[#F7F7F7] text-xl font-semibold'>Unclaimed</span></div>
                        {dons.filter((val) => val.claimed_by == null).map((val, index) => {

                            return (
                                <div key={val?.id} className={`bg-[#E4E4E4]/20 rounded-lg p-2 m-2 flex justify-between shadow-lg hover:bg-[#ffeb3b]/20`}>
                                    <span className={``}>{val.name}</span>
                                    <div className=' p-1 rounded'><span>{val.house}</span></div>
                                </div>
                            )
                        })}
                    </div>

                </>}

                {/* CHANGED: Stage 2 shows who has joined (dons submit in Stage 3 in your flow) */}
                {sessionDB?.stage == 2 && <div className='overflow-y-auto w-full'>
                    {[['Joined', true], ["Hasn't joined yet", false]].map(([label, joined]) => (
                        <div key={label}>
                            <div><span className='text-[#F7F7F7] text-xl font-semibold'>{label}</span></div>
                            {dons.filter((val) => (val.claimed_by != null) === joined).map((val) => (
                                <div key={val.id} className='bg-[#E4E4E4]/20 rounded-lg p-2 m-2 flex justify-between shadow-lg items-center'>
                                    <span>{val.name}</span>
                                    <div className='p-1 rounded'><span>{val.house}</span></div>
                                </div>
                            ))}
                        </div>
                    ))}
                </div>}

                {sessionDB?.stage == 3 && analysis && <div className='flex w-full flex-col gap-4 pt-4 px-2'>
                    <PreflightPanel analysis={analysis} onSelectDon={selectDonStage3} selectedDonId={selectedUserStage3?.id} />

                    <div className='flex w-full flex-col gap-4 md:flex-row md:items-start'>
                        <div className='overflow-y-auto w-full md:w-72 md:shrink-0 max-h-[60vh]'>
                            {dons.map((val, index) => {
                                const sev = worstIssue.get(val.id);
                                const hasSubmitted = submissions.some((s) => s.don_id === val.id); // NEW
                                return (
                                    <div key={val?.id} onClick={() => { selectDonStage3(val?.id) }} className={`${selectedUserStage3?.id == val.id ? 'bg-[#ffeb3b]/20' : 'bg-[#E4E4E4]/20 '} rounded-lg p-2 cursor-pointer m-2 flex justify-between items-center shadow-lg hover:bg-[#ffeb3b]/20`}>
                                        <span className={`flex items-center gap-2 ${selectedUserStage3?.id == val?.id ? 'font-bold text-white/90' : ''}`}>
                                            {sev && <span className={`h-2 w-2 rounded-full ${sev === 'error' ? 'bg-[#F87171]' : sev === 'warning' ? 'bg-amber-300' : 'bg-[#66FCF1]'}`} />}
                                            {val.name}
                                            {hasSubmitted && <span className='text-xs text-[#66FCF1]'>✓</span>}
                                        </span>
                                        <div className=' p-1 rounded'><span>{val?.house}</span></div>
                                    </div>
                                )
                            })}
                        </div>
                        {selectedUserStage3 && <DutyCalendar
                            key={selectedUserStage3.id} // NEW: fresh calendar state per don
                            startDate={sessionDB?.start_date}
                            endDate={sessionDB?.end_date}
                            don={selectedUserStage3}
                            value={prefs}
                            onChange={setPrefs}
                            handleSavePref={handleSavePref}
                            prefSaving={prefSaving}
                            isAdmin={true}
                            volunteer={volunteer}
                            setVolunteer={setVolunteer}
                        />}
                    </div>
                </div>}

                {sessionDB?.stage == 4 && analysis && <div className='w-full p-3'>
                    <GeneratePanel analysis={analysis}
                        startDate={sessionDB.start_date} endDate={sessionDB.end_date}
                        onGenerate={handleGenerate} generating={generating} />
                </div>}

                {sessionDB?.stage == 5 && <ScheduleEditor
                    key={sessionDB.id} // NEW: fresh editor state per session
                    session={sessionDB}
                    dons={dons} preferences={preferences} submissions={submissions}
                    onSessionChange={mergeSession} />} {/* CHANGED: keeps the dropdown list in sync too */}

            </section>

        </div>
    )
}

// email/password login for the admin account (created in Supabase → Authentication → Users)
function AdminLogin({ notAdmin }) {
    const [email, setEmail] = useState('');
    const [password, setPassword] = useState('');
    const [busy, setBusy] = useState(false);
    const [message, setMessage] = useState('');

    async function submit(e) {
        e.preventDefault();
        setBusy(true);
        setMessage('');
        const { error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) setMessage(error.message);
        setBusy(false);
    }

    return (
        <div className='h-screen grid place-items-center p-4'>
            <form onSubmit={submit} className='w-full max-w-sm rounded-3xl border border-white/10 bg-white/[0.05] p-6 backdrop-blur-xl shadow-[0_8px_40px_rgba(0,0,0,0.45)] flex flex-col gap-3'>
                <h1 className='text-xl font-semibold text-white'>Admin sign in</h1>
                {notAdmin && (
                    <p className='text-sm text-amber-200'>
                        This account isn't an admin.{' '}
                        <button type='button' className='underline' onClick={() => supabase.auth.signOut()}>Sign out</button>
                    </p>
                )}
                <input type='email' required value={email} onChange={(e) => setEmail(e.target.value)} placeholder='Email'
                    className='rounded-xl bg-black/20 px-3 py-2 text-white ring-1 ring-white/10 outline-none focus:ring-[#66FCF1]/60' />
                <input type='password' required value={password} onChange={(e) => setPassword(e.target.value)} placeholder='Password'
                    className='rounded-xl bg-black/20 px-3 py-2 text-white ring-1 ring-white/10 outline-none focus:ring-[#66FCF1]/60' />
                {message && <p className='text-sm text-[#FCA5A5]'>{message}</p>}
                <button type='submit' disabled={busy}
                    className='rounded-xl py-2 font-semibold text-[#0B0C10] disabled:opacity-50'
                    style={{ background: 'linear-gradient(135deg, #66FCF1, #45A29E)' }}>
                    {busy ? 'Signing in…' : 'Sign in'}
                </button>
            </form>
        </div>
    );
}

export default Admin
