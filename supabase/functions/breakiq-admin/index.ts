import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

class ApiError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function makePassword(length = 12) {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%";
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("");
}

function isGlobalAdmin(profile: any) {
  return profile?.role === "SUPER_ADMIN" ||
    (profile?.role === "ADMIN" && ["GENERAL", "ROOT", "ALL"].includes(String(profile.project_id || "").toUpperCase()));
}

function canManageProject(caller: any, target: any) {
  if (!caller || !target) return false;
  if (caller.role === "SUPER_ADMIN") return true;
  if (caller.role === "ADMIN" && ["GENERAL", "ROOT", "ALL"].includes(String(caller.project_id || "").toUpperCase())) return true;
  return ["ADMIN", "SUPERVISOR"].includes(caller.role) && caller.project_id === target.project_id;
}

async function getProfile(userId: string) {
  const { data, error } = await admin.from("profiles").select("*").eq("id", userId).maybeSingle();
  if (error) throw new ApiError("Could not read employee profile.", 500);
  if (!data) throw new ApiError("Employee profile not found.", 403);
  return data;
}

async function createUserAccount(caller: any, body: any) {
  const name = String(body.name || "").trim();
  const phone = String(body.phone || "").trim();
  const role = String(body.role || "");
  let projectId = String(body.project || "GENERAL").trim().toUpperCase();
  if (!name || !phone || !["AGENT", "SUPERVISOR", "ADMIN", "SUPER_ADMIN"].includes(role)) {
    throw new ApiError("Name, phone and a valid role are required.");
  }
  if (caller.role === "SUPERVISOR") {
    if (role !== "AGENT") throw new ApiError("Supervisors can only onboard agents.", 403);
    projectId = String(caller.project_id || "GENERAL").toUpperCase();
  } else if (!["ADMIN", "SUPER_ADMIN"].includes(caller.role)) {
    throw new ApiError("Management role required.", 403);
  } else if ((role === "ADMIN" || role === "SUPER_ADMIN") && !isGlobalAdmin(caller)) {
    throw new ApiError("Only a global administrator can create admin accounts.", 403);
  }
  if (role === "SUPER_ADMIN" && caller.role !== "SUPER_ADMIN") {
    throw new ApiError("Only a Super Admin can create another Super Admin.", 403);
  }
  if (!isGlobalAdmin(caller) && projectId !== caller.project_id) {
    throw new ApiError("You can only provision users in your own project.", 403);
  }
  const { data: project, error: projectError } = await admin.from("projects").select("id").eq("id", projectId).maybeSingle();
  if (projectError || !project) throw new ApiError("Selected project does not exist.", 400);

  const prefix = role === "AGENT" ? "AGT" : role === "SUPERVISOR" ? "SUP" : "ADM";
  const { data: sequence, error: seqError } = await admin.rpc("next_counter", {
    p_project_id: "GENERAL",
    p_counter_key: `employeeId:${prefix}`,
  });
  if (seqError) throw new ApiError("Could not allocate an employee ID.", 500);

  const employeeId = `${prefix}-${String(sequence).padStart(4, "0")}`;
  const email = `${employeeId.toLowerCase()}@breakapp.internal`;
  const password = makePassword();
  const { data: authResult, error: authError } = await admin.auth.admin.createUser({
    email, password, email_confirm: true,
    user_metadata: { name, employeeId },
    app_metadata: { role, project: projectId },
  });
  if (authError || !authResult.user) throw new ApiError(authError?.message || "Could not create auth user.", 400);

  const { error: profileError } = await admin.from("profiles").insert({
    id: authResult.user.id, employee_id: employeeId, name, role, project_id: projectId,
    phone, active: true, status: "OFFLINE", created_by: caller.id,
  });
  if (profileError) {
    await admin.auth.admin.deleteUser(authResult.user.id).catch(() => null);
    throw new ApiError("Auth account was rolled back because the employee profile could not be saved.", 500);
  }
  await admin.from("presence").upsert({
    user_id: authResult.user.id, project_id: projectId, role, name, status: "OFFLINE", work_mode: "WFO",
  });
  return { uid: authResult.user.id, employeeId, password, project: projectId };
}

async function editUserAccount(caller: any, body: any) {
  const targetUid = String(body.targetUid || "");
  if (!targetUid) throw new ApiError("Target user is required.");
  if (!["ADMIN", "SUPER_ADMIN"].includes(caller.role)) throw new ApiError("Only administrators can edit accounts.", 403);
  const target = await getProfile(targetUid);
  if (!canManageProject(caller, target)) throw new ApiError("Not authorized for this employee.", 403);
  const name = body.name == null ? target.name : String(body.name).trim();
  const phone = body.phone == null ? target.phone : String(body.phone).trim();
  const role = body.role == null ? target.role : String(body.role);
  const projectId = body.project == null ? target.project_id : String(body.project).trim().toUpperCase();
  if (!name || !["AGENT", "SUPERVISOR", "ADMIN", "SUPER_ADMIN"].includes(role)) throw new ApiError("Name or role is invalid.");
  if (!isGlobalAdmin(caller) && projectId !== caller.project_id) throw new ApiError("Only global administrators can move employees between projects.", 403);
  if (role === "SUPER_ADMIN" && caller.role !== "SUPER_ADMIN") throw new ApiError("Only a Super Admin can assign the Super Admin role.", 403);
  if (!isGlobalAdmin(caller) && ["ADMIN", "SUPER_ADMIN"].includes(role)) throw new ApiError("Only global administrators can assign admin roles.", 403);
  const { data: project, error: projectError } = await admin.from("projects").select("id").eq("id", projectId).maybeSingle();
  if (projectError || !project) throw new ApiError("Selected project does not exist.", 400);
  const { error: updateError } = await admin.from("profiles").update({
    name, phone, role, project_id: projectId, updated_at: new Date().toISOString(),
    extra: { ...(target.extra || {}), updatedBy: caller.id },
  }).eq("id", targetUid);
  if (updateError) throw new ApiError("Could not update employee profile.", 500);
  await admin.auth.admin.updateUserById(targetUid, {
    user_metadata: { name, employeeId: target.employee_id },
    app_metadata: { role, project: projectId },
  });
  await admin.from("presence").upsert({ user_id: targetUid, project_id: projectId, role, name });
  return { ok: true, updatedId: targetUid };
}

async function deleteUserAccount(caller: any, body: any) {
  const targetUid = String(body.targetUid || "");
  if (!targetUid) throw new ApiError("Target user is required.");
  if (!["ADMIN", "SUPER_ADMIN", "SUPERVISOR"].includes(caller.role)) throw new ApiError("Management role required.", 403);
  const target = await getProfile(targetUid);
  if (!canManageProject(caller, target)) throw new ApiError("Not authorized for this employee.", 403);
  if (target.role === "SUPER_ADMIN" || (target.role === "ADMIN" && caller.role !== "SUPER_ADMIN")) {
    throw new ApiError("Administrator account cannot be deleted by this role.", 403);
  }
  if (caller.role === "SUPERVISOR" && target.role !== "AGENT") throw new ApiError("Supervisors can only remove agents.", 403);
  const { error } = await admin.auth.admin.deleteUser(targetUid);
  if (error) throw new ApiError("Could not delete the authentication account.", 500);
  return { ok: true, removedId: target.employee_id };
}

async function resetPassword(caller: any, body: any) {
  const targetUid = String(body.targetUid || "");
  if (!targetUid) throw new ApiError("Target user is required.");
  if (!["ADMIN", "SUPER_ADMIN", "SUPERVISOR"].includes(caller.role)) throw new ApiError("Management role required.", 403);
  const target = await getProfile(targetUid);
  if (!canManageProject(caller, target)) throw new ApiError("Not authorized for this employee.", 403);
  if (caller.role === "SUPERVISOR" && target.role !== "AGENT") throw new ApiError("Supervisors can only reset agent passwords.", 403);
  if (target.role === "SUPER_ADMIN" && caller.role !== "SUPER_ADMIN") throw new ApiError("Only a Super Admin can reset this account.", 403);
  const password = makePassword();
  const { error } = await admin.auth.admin.updateUserById(targetUid, { password });
  if (error) throw new ApiError("Could not reset the password.", 500);
  return { password };
}

async function updateOwnPassword(caller: any, body: any) {
  const newPass = String(body.newPass || "");
  if (newPass.length < 8) throw new ApiError("Password must be at least 8 characters.");
  const { error } = await admin.auth.admin.updateUserById(caller.id, { password: newPass });
  if (error) throw new ApiError("Could not update password.", 400);
  return { ok: true };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed." }, 405);
  try {
    const authorization = req.headers.get("Authorization");
    if (!authorization?.startsWith("Bearer ")) throw new ApiError("Authentication required.", 401);
    const token = authorization.slice("Bearer ".length);
    const callerClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
    const { data: authData, error: authError } = await callerClient.auth.getUser(token);
    if (authError || !authData.user) throw new ApiError("Invalid or expired session.", 401);
    const caller = await getProfile(authData.user.id);
    const body = await req.json();
    let result: unknown;
    switch (String(body.action || "")) {
      case "createUserAccount": result = await createUserAccount(caller, body); break;
      case "editUserAccount": result = await editUserAccount(caller, body); break;
      case "deleteUserAccount": result = await deleteUserAccount(caller, body); break;
      case "resetPassword": result = await resetPassword(caller, body); break;
      case "agentUpdateOwnPassword": result = await updateOwnPassword(caller, body); break;
      default: throw new ApiError("Unsupported administrative operation.", 400);
    }
    return json(result, 200);
  } catch (error) {
    const status = error instanceof ApiError ? error.status : 500;
    const message = error instanceof Error ? error.message : "Unexpected server error.";
    if (status >= 500) console.error("breakiq-admin error:", error);
    return json({ error: message }, status);
  }
});
