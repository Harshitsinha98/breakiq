// Compatibility exports kept while the migration branch replaces Firebase APIs.
import { supabase } from "./supabase";

export { supabase };
export const ORG_DOMAIN = "breakapp.internal";

// These markers allow the remaining UI to migrate gradually without a production cutover.
export const auth = {
  signOut: async () => {
    const { error } = await supabase.auth.signOut();
    if (error) throw error;
  }
};
export const db = {};
export const functions = {};
