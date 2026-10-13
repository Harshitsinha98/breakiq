import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const WHATSAPP_TOKEN = Deno.env.get("WHATSAPP_TOKEN");
const WHATSAPP_GATEWAY_URL = Deno.env.get("WHATSAPP_GATEWAY_URL") || "https://api.breakiq.in/send-message";

const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-breakiq-cron-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function constantTimeEqual(a: string, b: string) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function normalizePhone(value: string) {
  let phone = String(value || "").trim().replace(/[+\s()-]/g, "");
  if (/^\d{10}$/.test(phone)) phone = "91" + phone;
  return phone;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed." }, 405);

  try {
    const suppliedSecret = req.headers.get("x-breakiq-cron-secret") || "";
    const { data: expectedSecret, error: secretError } = await admin.rpc("breakiq_cron_auth_secret");
    if (secretError || !expectedSecret || !constantTimeEqual(suppliedSecret, String(expectedSecret))) {
      return json({ error: "Unauthorized scheduler request." }, 401);
    }

    if (!WHATSAPP_TOKEN) {
      const { count } = await admin.from("notification_outbox").select("id", { count: "exact", head: true }).eq("status", "PENDING");
      return json({ ok: true, configured: false, pending: count || 0, message: "Set the rotated WHATSAPP_TOKEN secret before enabling WhatsApp delivery." });
    }

    const body = await req.json().catch(() => ({}));
    const batchSize = Math.max(1, Math.min(50, Number(body?.limit) || 20));
    const { data: rows, error: selectError } = await admin
      .from("notification_outbox")
      .select("id,project_id,recipient,message,kind,idempotency_key,attempts")
      .eq("status", "PENDING")
      .order("created_at", { ascending: true })
      .limit(batchSize);
    if (selectError) throw selectError;

    let sent = 0;
    let failed = 0;
    let skipped = 0;
    for (const row of rows || []) {
      const nextAttempt = Number(row.attempts || 0) + 1;
      const { data: claimed, error: claimError } = await admin
        .from("notification_outbox")
        .update({ status: "PROCESSING", attempts: nextAttempt, updated_at: new Date().toISOString(), last_error: null })
        .eq("id", row.id)
        .eq("status", "PENDING")
        .select("id")
        .maybeSingle();
      if (claimError) throw claimError;
      if (!claimed) {
        skipped += 1;
        continue;
      }

      try {
        const response = await fetch(WHATSAPP_GATEWAY_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            token: WHATSAPP_TOKEN,
            phone: normalizePhone(row.recipient),
            message: row.message,
          }),
          signal: AbortSignal.timeout(8000),
        });
        const responseText = await response.text().catch(() => "");
        if (response.status !== 200) {
          throw new Error(`WhatsApp gateway returned HTTP ${response.status}: ${responseText.slice(0, 300)}`);
        }
        const { error: sentUpdateError } = await admin.from("notification_outbox")
          .update({ status: "SENT", sent_at: new Date().toISOString(), updated_at: new Date().toISOString(), last_error: null })
          .eq("id", row.id);
        if (sentUpdateError) throw sentUpdateError;
        sent += 1;
      } catch (sendError) {
        const message = sendError instanceof Error ? sendError.message : "Unknown WhatsApp gateway error";
        const status = nextAttempt >= 5 ? "FAILED" : "PENDING";
        const { error: failUpdateError } = await admin.from("notification_outbox")
          .update({ status, updated_at: new Date().toISOString(), last_error: message.slice(0, 1000) })
          .eq("id", row.id);
        if (failUpdateError) throw failUpdateError;
        failed += 1;
      }
    }
    return json({ ok: true, configured: true, attempted: (rows || []).length, sent, failed, skipped });
  } catch (error) {
    console.error("breakiq-notifications error:", error);
    return json({ error: error instanceof Error ? error.message : "Unexpected notification error." }, 500);
  }
});
