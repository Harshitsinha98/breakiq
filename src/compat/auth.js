import { supabase } from "../supabase";

export function signInWithEmailAndPassword(_auth, email, password) {
  return supabase.auth.signInWithPassword({ email, password }).then(({ data, error }) => {
    if (error) throw error;
    return { user: data.user, session: data.session };
  });
}

export function signOut(_auth) {
  return supabase.auth.signOut().then(({ error }) => {
    if (error) throw error;
    return { error: null };
  });
}

export function onAuthStateChanged(_auth, callback) {
  const { data } = supabase.auth.onAuthStateChange((_event, session) => {
    callback(session?.user ?? null);
  });
  return () => data.subscription.unsubscribe();
}
