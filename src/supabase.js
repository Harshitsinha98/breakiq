import { createClient } from "@supabase/supabase-js";

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabasePublishableKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;

if (!supabaseUrl || !supabasePublishableKey) {
  console.warn(
    "Supabase configuration is missing. Set VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY before running the migrated app."
  );
}

export const supabase = createClient(
  supabaseUrl || "https://nrunqihyyijjyihqqlfw.supabase.co",
  supabasePublishableKey || "sb_publishable_odMf-IPvCBcV6tUNsjCH4A_KEPKHCiU",
  {
    auth: {
      autoRefreshToken: true,
      persistSession: true,
      detectSessionInUrl: true
    }
  }
);
