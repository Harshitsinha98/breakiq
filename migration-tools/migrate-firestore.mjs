import { applicationDefault, cert, getApps, initializeApp } from "firebase-admin/app";
import { FieldPath, getFirestore } from "firebase-admin/firestore";
import { createClient } from "@supabase/supabase-js";
import fs from "node:fs";

const APPLY = process.argv.includes("--apply");
const BATCH_SIZE = 300;
const FIREBASE_PROJECT_ID = process.env.FIREBASE_PROJECT_ID || "erp-break-system-fda79";
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in the local environment.");
  process.exit(1);
}
if (!process.env.GOOGLE_APPLICATION_CREDENTIALS) {
  console.error("Set GOOGLE_APPLICATION_CREDENTIALS to the local Firebase Admin service-account JSON file.");
  process.exit(1);
}
if (!fs.existsSync(process.env.GOOGLE_APPLICATION_CREDENTIALS)) {
  console.error("Firebase service-account file was not found at GOOGLE_APPLICATION_CREDENTIALS.");
  process.exit(1);
}

const app = getApps()[0] || initializeApp({
  credential: applicationDefault(),
  projectId: FIREBASE_PROJECT_ID,
});
const firestore = getFirestore(app);
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const nowIso = () => new Date().toISOString();
const projectIdOf = (value) => String(value || "GENERAL").trim().toUpperCase() || "GENERAL";

function plain(value) {
  if (value == null) return value;
  if (value instanceof Date) return value.toISOString();
  if (typeof value?.toDate === "function") return value.toDate().toISOString();
  if (typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(plain);
  if (Buffer.isBuffer(value)) return value.toString("base64");
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, plain(item)]));
}

function iso(value, fallback = null) {
  if (value == null) return fallback;
  if (typeof value === "string" && !Number.isNaN(Date.parse(value))) return new Date(value).toISOString();
  if (value instanceof Date) return value.toISOString();
  if (typeof value?.toDate === "function") return value.toDate().toISOString();
  return fallback;
}

function extras(source, known) {
  const result = { ...(source?.extra && typeof source.extra === "object" ? plain(source.extra) : {}) };
  for (const [key, value] of Object.entries(source || {})) {
    if (!known.has(key) && key !== "extra" && value !== undefined) result[key] = plain(value);
  }
  return result;
}

async function readCollection(name) {
  const docs = [];
  let cursor = null;
  while (true) {
    let query = firestore.collection(name).orderBy(FieldPath.documentId()).limit(BATCH_SIZE);
    if (cursor) query = query.startAfter(cursor);
    const snap = await query.get();
    if (snap.empty) break;
    docs.push(...snap.docs.map((doc) => ({ id: doc.id, data: plain(doc.data()) })));
    cursor = snap.docs[snap.docs.length - 1];
    if (snap.size < BATCH_SIZE) break;
  }
  return docs;
}

async function getSupabaseAuthUsers() {
  const byEmail = new Map();
  let page = 1;
  const perPage = 1000;
  while (true) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage });
    if (error) throw error;
    const users = data?.users || [];
    for (const user of users) {
      if (user.email) byEmail.set(user.email.toLowerCase(), user);
    }
    if (users.length < perPage) break;
    page += 1;
  }
  return byEmail;
}

async function upsertInBatches(table, rows, onConflict) {
  if (!rows.length) return;
  for (let offset = 0; offset < rows.length; offset += BATCH_SIZE) {
    const batch = rows.slice(offset, offset + BATCH_SIZE);
    const { error } = await supabase.from(table).upsert(batch, { onConflict });
    if (error) throw new Error(`Upsert failed for ${table} (batch starting ${offset}): ${error.message}`);
  }
}

const summary = {};
async function applyOrCount(table, rows, conflict) {
  summary[table] = rows.length;
  if (APPLY) await upsertInBatches(table, rows, conflict);
}

async function main() {
  console.log(`BreakIQ Firestore migration: ${APPLY ? "APPLY MODE" : "DRY RUN (no writes)"}`);
  console.log(`Expected Firebase project: ${FIREBASE_PROJECT_ID}`);
  console.log(`Supabase target: ${SUPABASE_URL}`);

  const [fireUserDocs, projectDocs, projectSettingsDocs, presenceDocs, shiftDocs, breakDocs, reportDocs, counterDocs] =
    await Promise.all([
      readCollection("users"),
      readCollection("projects"),
      readCollection("project_settings"),
      readCollection("presence"),
      readCollection("shift_sessions"),
      readCollection("break_sessions"),
      readCollection("shift_reports"),
      readCollection("counters"),
    ]);
  const breakSettingsSnap = await firestore.doc("break_settings/config").get();
  const legacySettings = breakSettingsSnap.exists ? plain(breakSettingsSnap.data()) : null;

  const authUsersByEmail = await getSupabaseAuthUsers();
  const authByLegacyUid = new Map();
  const missingUsers = [];

  for (const doc of fireUserDocs) {
    const employeeId = String(doc.data.employeeId || "").trim().toLowerCase();
    const email = employeeId ? `${employeeId}@breakapp.internal` : "";
    const authUser = email ? authUsersByEmail.get(email) : null;
    if (!authUser) missingUsers.push({ firebaseUid: doc.id, employeeId: doc.data.employeeId || null, email: email || null });
    else authByLegacyUid.set(doc.id, authUser.id);
  }

  if (missingUsers.length) {
    console.error(`Cannot import data: ${missingUsers.length} Firestore user(s) do not yet exist in Supabase Auth.`);
    console.error("Import Firebase Auth users first using the official Supabase Firebase Auth migration guide, then rerun this script.");
    console.error("Missing user mapping (first 25):", missingUsers.slice(0, 25));
    process.exit(2);
  }

  const projectById = new Map();
  for (const row of [
    { id: "GENERAL", name: "General", active: true },
    { id: "BENTLEY", name: "BENTLEY", active: true },
    { id: "FOOTLOCKER", name: "FOOTLOCKER", active: true },
  ]) projectById.set(row.id, row);

  for (const d of projectDocs) {
    projectById.set(projectIdOf(d.id), {
      id: projectIdOf(d.id),
      name: String(d.data.name || d.data.displayName || d.id),
      active: d.data.active !== false,
      created_at: iso(d.data.createdAt, nowIso()),
    });
  }
  for (const d of fireUserDocs) {
    const p = projectIdOf(d.data.project);
    if (!projectById.has(p)) projectById.set(p, { id: p, name: p, active: true });
  }
  for (const d of projectSettingsDocs) {
    const p = projectIdOf(d.id);
    if (!projectById.has(p)) projectById.set(p, { id: p, name: p, active: true });
  }
  for (const d of shiftDocs.concat(breakDocs, reportDocs)) {
    const p = projectIdOf(d.data.project);
    if (!projectById.has(p)) projectById.set(p, { id: p, name: p, active: true });
  }
  const projects = [...projectById.values()];

  const profileKnown = new Set([
    "employeeId","name","role","project","phone","active","status","workMode",
    "activeShiftId","activeBreakId","createdBy","createdAt","updatedAt","uid"
  ]);
  const profiles = fireUserDocs.map(({ id, data }) => {
    const supaId = authByLegacyUid.get(id);
    const role = String(data.role || "AGENT").toUpperCase();
    if (!["AGENT","SUPERVISOR","ADMIN","SUPER_ADMIN"].includes(role)) {
      throw new Error(`Unknown role ${role} for employee ${data.employeeId || id}`);
    }
    return {
      id: supaId,
      legacy_firebase_uid: id,
      employee_id: String(data.employeeId || "").trim().toUpperCase(),
      name: String(data.name || "Employee"),
      role,
      project_id: projectIdOf(data.project),
      phone: data.phone ? String(data.phone) : null,
      active: data.active !== false,
      status: String(data.status || "OFFLINE"),
      work_mode: data.workMode === "WFH" ? "WFH" : "WFO",
      active_shift_id: data.activeShiftId || null,
      active_break_id: data.activeBreakId || null,
      created_by: data.createdBy ? authByLegacyUid.get(data.createdBy) || null : null,
      created_at: iso(data.createdAt, nowIso()),
      updated_at: iso(data.updatedAt, nowIso()),
      extra: extras(data, profileKnown),
    };
  });

  const settingsKnown = new Set([
    "shiftDurationHours","mealBreakMin","shortBreakMin","lockoutStartMin","lockoutEndMin",
    "maxConcurrentBreaks","alertMode","supervisorBroadcastNumbers","emergencyLockout",
    "emergencyReason","updatedAt","createdAt","id"
  ]);
  const projectSettings = projectSettingsDocs.map(({ id, data }) => ({
    project_id: projectIdOf(id),
    shift_duration_hours: Number(data.shiftDurationHours ?? 9),
    meal_break_min: Number(data.mealBreakMin ?? 40),
    short_break_min: Number(data.shortBreakMin ?? 20),
    lockout_start_min: Number(data.lockoutStartMin ?? 60),
    lockout_end_min: Number(data.lockoutEndMin ?? 60),
    max_concurrent_breaks: Number(data.maxConcurrentBreaks ?? 2),
    alert_mode: String(data.alertMode || "INDIVIDUAL"),
    supervisor_broadcast_numbers: plain(data.supervisorBroadcastNumbers || []),
    emergency_lockout: data.emergencyLockout === true,
    emergency_reason: data.emergencyReason || null,
    updated_at: iso(data.updatedAt, nowIso()),
    extra: { ...extras(data, settingsKnown), hasSettingsOverride: true },
  }));

  // The legacy break_settings/config doc is a global fallback in the Firebase code.
  // Copy it to GENERAL only if the explicit project_settings/GENERAL doc is absent.
  if (legacySettings && !projectSettings.some((item) => item.project_id === "GENERAL")) {
    projectSettings.push({
      project_id: "GENERAL",
      shift_duration_hours: Number(legacySettings.shiftDurationHours ?? 9),
      meal_break_min: Number(legacySettings.mealBreakMin ?? 40),
      short_break_min: Number(legacySettings.shortBreakMin ?? 20),
      lockout_start_min: Number(legacySettings.lockoutStartMin ?? 60),
      lockout_end_min: Number(legacySettings.lockoutEndMin ?? 60),
      max_concurrent_breaks: Number(legacySettings.maxConcurrentBreaks ?? 2),
      alert_mode: String(legacySettings.alertMode || "INDIVIDUAL"),
      supervisor_broadcast_numbers: plain(legacySettings.supervisorBroadcastNumbers || []),
      emergency_lockout: legacySettings.emergencyLockout === true,
      emergency_reason: legacySettings.emergencyReason || null,
      updated_at: iso(legacySettings.updatedAt, nowIso()),
      extra: { hasSettingsOverride: true, migratedFromLegacyBreakSettings: true },
    });
  }

  const appSettings = legacySettings ? [{
    id: "break_settings/config",
    settings: legacySettings,
    updated_at: iso(legacySettings.updatedAt, nowIso()),
  }] : [];

  const shiftKnown = new Set([
    "uid","employeeId","name","project","shiftStart","shiftEnd","loginAt","logoutAt",
    "status","breakBudget","createdAt","createdBy"
  ]);
  const shifts = shiftDocs.map(({ id, data }) => {
    const legacyUid = data.uid || id.match(/^(.*)_\d{13}$/)?.[1] || null;
    const start = iso(data.shiftStart, nowIso());
    const end = iso(data.shiftEnd, new Date(new Date(start).getTime() + 9 * 3600000).toISOString());
    return {
      id,
      legacy_firebase_uid: legacyUid,
      user_id: legacyUid ? authByLegacyUid.get(legacyUid) || null : null,
      employee_id: data.employeeId || null,
      name: data.name || null,
      project_id: projectIdOf(data.project),
      shift_start: start,
      shift_end: end,
      login_at: iso(data.loginAt, start),
      logout_at: iso(data.logoutAt),
      status: String(data.status || "ON_SHIFT"),
      break_budget: plain(data.breakBudget || {}),
      created_at: iso(data.createdAt, nowIso()),
      extra: extras(data, shiftKnown),
    };
  });

  const breakKnown = new Set([
    "uid","employeeId","agentName","name","project","shiftId","breakCategory","requestedDurationMin",
    "mode","status","requestedAt","scheduledFor","breakStartedAt","expectedEndAt","breakEndedAt",
    "actualMinutesUsed","exceeded","wasForceEnded","forceEndedBy","forceEndedReason","notifiedReady",
    "readyToStart","queueSeq","suggestedTime","notifiedAt","warningSent","exceededAlertSent",
    "cancelReason","cancelledAt","createdAt","updatedAt"
  ]);
  const breaks = breakDocs.map(({ id, data }) => {
    const legacyUid = data.uid || null;
    const category = String(data.breakCategory || "").toUpperCase();
    if (!["MEAL","SHORT"].includes(category)) {
      throw new Error(`Break ${id} has invalid category ${category || "(missing)"}; inspect it before importing.`);
    }
    const mappedUserId = legacyUid ? authByLegacyUid.get(legacyUid) || null : null;
    return {
      id,
      legacy_firebase_uid: legacyUid,
      user_id: mappedUserId,
      employee_id: data.employeeId || null,
      agent_name: data.agentName || data.name || null,
      project_id: projectIdOf(data.project),
      shift_id: data.shiftId || null,
      break_category: category,
      requested_duration_min: Math.max(1, Number(data.requestedDurationMin || (category === "MEAL" ? 40 : 20))),
      mode: data.mode || "NOW",
      status: String(data.status || "CANCELLED"),
      requested_at: iso(data.requestedAt, nowIso()),
      scheduled_for: iso(data.scheduledFor),
      break_started_at: iso(data.breakStartedAt),
      expected_end_at: iso(data.expectedEndAt),
      break_ended_at: iso(data.breakEndedAt),
      actual_minutes_used: data.actualMinutesUsed == null ? null : Number(data.actualMinutesUsed),
      exceeded: data.exceeded === true,
      was_force_ended: data.wasForceEnded === true,
      force_ended_by: data.forceEndedBy ? authByLegacyUid.get(data.forceEndedBy) || null : null,
      force_ended_reason: data.forceEndedReason || null,
      notified_ready: data.notifiedReady === true,
      ready_to_start: data.readyToStart === true,
      queue_seq: data.queueSeq == null ? null : Number(data.queueSeq),
      suggested_time: iso(data.suggestedTime),
      notified_at: iso(data.notifiedAt),
      warning_sent: data.warningSent === true,
      exceeded_alert_sent: data.exceededAlertSent === true,
      cancel_reason: data.cancelReason || null,
      cancelled_at: iso(data.cancelledAt),
      extra: extras(data, breakKnown),
    };
  });

  const presenceKnown = new Set(["uid","role","name","project","status","workMode","lastHeartbeatAt","updatedAt"]);
  const presence = presenceDocs.map(({ id, data }) => {
    const legacyUid = data.uid || id;
    const userId = authByLegacyUid.get(legacyUid);
    if (!userId) return null;
    return {
      user_id: userId,
      project_id: projectIdOf(data.project),
      role: String(data.role || "AGENT").toUpperCase(),
      name: data.name || null,
      status: String(data.status || "OFFLINE"),
      work_mode: data.workMode === "WFH" ? "WFH" : "WFO",
      last_heartbeat_at: iso(data.lastHeartbeatAt),
      updated_at: iso(data.updatedAt, nowIso()),
      extra: extras(data, presenceKnown),
    };
  }).filter(Boolean);

  const reports = reportDocs.map(({ id, data }) => {
    const legacyUid = data.uid || null;
    return {
      id,
      user_id: legacyUid ? authByLegacyUid.get(legacyUid) || null : null,
      employee_id: data.employeeId || null,
      project_id: projectIdOf(data.project),
      report_type: data.reportType || data.type || "SHIFT_REPORT",
      payload: plain(data.payload || data),
      created_at: iso(data.createdAt, nowIso()),
    };
  });

  const queueIndex = breaks
    .filter((b) => ["AWAITING_SLOT","IN_QUEUE"].includes(b.status))
    .map((b) => ({
      project_id: b.project_id,
      id: b.id,
      queue_seq: b.queue_seq,
      break_session_id: b.id,
      payload: { userId: b.user_id, source: "FIREBASE_IMPORT" },
      updated_at: nowIso(),
    }));

  const aggregateByProject = new Map();
  for (const project of projects) {
    aggregateByProject.set(project.id, { project_id: project.id, id: "live", active_count: 0, queue_length: 0, updated_at: nowIso(), extra: {} });
  }
  for (const b of breaks) {
    const a = aggregateByProject.get(b.project_id) || { project_id: b.project_id, id: "live", active_count: 0, queue_length: 0, updated_at: nowIso(), extra: {} };
    if (["ON_BREAK","NOTIFIED_TO_START"].includes(b.status)) a.active_count += 1;
    if (["AWAITING_SLOT","IN_QUEUE"].includes(b.status)) a.queue_length += 1;
    aggregateByProject.set(b.project_id, a);
  }
  const aggregates = [...aggregateByProject.values()];

  const counterRows = [];
  const maxEmployeeSeq = { AGT: 0, SUP: 0, ADM: 0 };
  let legacyQueueSeq = 0;
  for (const p of profiles) {
    const match = /^(AGT|SUP|ADM)-(\d+)$/.exec(p.employee_id || "");
    if (match) maxEmployeeSeq[match[1]] = Math.max(maxEmployeeSeq[match[1]], Number(match[2]));
  }
  for (const d of counterDocs) {
    if (d.id === "employeeId") {
      for (const prefix of ["AGT","SUP","ADM"]) {
        const value = Number(d.data[prefix] || 0);
        if (Number.isFinite(value)) maxEmployeeSeq[prefix] = Math.max(maxEmployeeSeq[prefix], value);
      }
    } else if (d.id === "queueSeq") {
      legacyQueueSeq = Math.max(legacyQueueSeq, Number(d.data.value || 0));
    }
  }
  for (const [prefix,value] of Object.entries(maxEmployeeSeq)) {
    counterRows.push({ project_id: "GENERAL", counter_key: `employeeId:${prefix}`, values: { value }, updated_at: nowIso() });
  }
  for (const project of projects) {
    const maxQueue = breaks.filter((b) => b.project_id === project.id).reduce((max,b)=>Math.max(max,Number(b.queue_seq||0)),0);
    counterRows.push({ project_id: project.id, counter_key: "queueSeq", values: { value: Math.max(maxQueue, legacyQueueSeq) }, updated_at: nowIso() });
  }

  const plan = [
    ["projects", projects, "id"],
    ["profiles", profiles, "id"],
    ["project_settings", projectSettings, "project_id"],
    ["app_settings", appSettings, "id"],
    ["shift_sessions", shifts, "id"],
    ["break_sessions", breaks, "id"],
    ["presence", presence, "user_id"],
    ["break_queue_index", queueIndex, "project_id,id"],
    ["break_aggregates", aggregates, "project_id,id"],
    ["shift_reports", reports, "id"],
    ["counters", counterRows, "project_id,counter_key"],
  ];

  console.log("\nImport plan:");
  for (const [table, rows] of plan) {
    summary[table] = rows.length;
    console.log(`  ${table}: ${rows.length}`);
  }
  console.log(`  users requiring Supabase Auth mapping: ${fireUserDocs.length}`);

  if (!APPLY) {
    console.log("\nDRY RUN ONLY. No database writes were made.");
    console.log("After reviewing row counts, rerun with --apply to import. This script never deletes existing data.");
    return;
  }

  for (const [table, rows, conflict] of plan) {
    await applyOrCount(table, rows, conflict);
    console.log(`✓ Imported/upserted ${rows.length} rows into ${table}`);
  }

  console.log("\nMigration import complete. Validate counts and foreign-key mappings before switching production traffic.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
