import { createClient } from '@supabase/supabase-js'

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY
// add this temporarily right in your supabase.js
//console.log('localStorage available:', typeof window !== 'undefined' && typeof localStorage !== 'undefined');
//console.log('existing session:', localStorage.getItem('sb-' + import.meta.env.VITE_SUPABASE_URL.split('//')[1].split('.')[0] + '-auth-token'));
export const supabase = createClient(supabaseUrl, supabaseAnonKey)

// Reuse the saved session if there is one; otherwise sign in anonymously.
// The shared promise means calling this twice at once (e.g. StrictMode)
// still creates only one anonymous user.
let sessionPromise = null;

export function ensureSession() {
  if (!sessionPromise) {
    sessionPromise = (async () => {
      const { data: { session } } = await supabase.auth.getSession();
      if (session) return session; // already signed in on this device

      const { data, error } = await supabase.auth.signInAnonymously();
      if (error) throw error;
      return data.session;
    })();

    // If it failed, allow a retry next time instead of caching the failure
    sessionPromise.catch(() => { sessionPromise = null; });
  }
  return sessionPromise;
}

// const supabaseAdmin = createClient(
//     supabaseUrl,
//     process.env.SUPABASE_SERVICE_ROLE_KEY  // different key — never expose this to frontend
// )