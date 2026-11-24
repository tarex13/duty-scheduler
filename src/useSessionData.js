import { useCallback, useEffect, useRef, useState } from 'react';
import { supabase } from './lib/supabase';

/**
 * Admin-only: loads every don, preference and submission for a session and
 * keeps them fresh. Dons' saves go through submit_preferences, which always
 * writes a submissions row, so a change on `submissions` is our cue to reload.
 */
export function useSessionData(sessionId) {
  const [data, setData] = useState({ dons: [], preferences: [], submissions: [] });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  // The session currently being shown. A load that finishes after the admin
  // switched sessions is ignored, so old data can't overwrite new data.
  const latestId = useRef(sessionId);
  latestId.current = sessionId;

  const refresh = useCallback(async () => {
    if (!sessionId) return;
    try {
      const donsRes = await supabase
        .from('dons')
        .select('*')
        .eq('session_id', sessionId)
        .order('house')
        .order('name');
      if (donsRes.error) throw donsRes.error;

      const ids = donsRes.data.map((d) => d.id);
      const [prefsRes, subsRes] = ids.length
        ? await Promise.all([
            supabase.from('preferences').select('don_id, date, kind, rank').in('don_id', ids),
            supabase.from('submissions').select('don_id, volunteer_extra, updated_at').in('don_id', ids),
          ])
        : [{ data: [] }, { data: [] }];
      if (prefsRes.error) throw prefsRes.error;
      if (subsRes.error) throw subsRes.error;

      if (latestId.current !== sessionId) return; // a different session was picked meanwhile
      setData({ dons: donsRes.data, preferences: prefsRes.data, submissions: subsRes.data });
      setError('');
    } catch (err) {
      if (latestId.current === sessionId) setError(err.message);
    } finally {
      if (latestId.current === sessionId) setLoading(false);
    }
  }, [sessionId]);

  useEffect(() => {
    // Clear the previous session's data straight away
    setData({ dons: [], preferences: [], submissions: [] });
    setLoading(Boolean(sessionId));
    if (!sessionId) return undefined;
    refresh();

    const channel = supabase
      .channel(`admin-session-${sessionId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'submissions' }, refresh)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'dons', filter: `session_id=eq.${sessionId}` }, refresh)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'preferences' }, refresh)
      .subscribe();

    return () => { supabase.removeChannel(channel); };
  }, [sessionId, refresh]);

  return { ...data, loading, error, refresh };
}
