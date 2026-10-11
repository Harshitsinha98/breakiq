import { supabase } from "../supabase";

const fieldAliases = {
  project_id: "project",
  employee_id: "employeeId",
  active_shift_id: "activeShiftId",
  active_break_id: "activeBreakId",
  work_mode: "workMode",
  created_at: "createdAt",
  updated_at: "updatedAt",
  created_by: "createdBy",
  last_heartbeat_at: "lastHeartbeatAt",
  shift_start: "shiftStart",
  shift_end: "shiftEnd",
  login_at: "loginAt",
  logout_at: "logoutAt",
  break_budget: "breakBudget",
  shift_id: "shiftId",
  break_category: "breakCategory",
  requested_duration_min: "requestedDurationMin",
  requested_at: "requestedAt",
  scheduled_for: "scheduledFor",
  break_started_at: "breakStartedAt",
  expected_end_at: "expectedEndAt",
  break_ended_at: "breakEndedAt",
  actual_minutes_used: "actualMinutesUsed",
  agent_name: "agentName",
  queue_seq: "queueSeq",
  suggested_time: "suggestedTime",
  notified_at: "notifiedAt",
  cancel_reason: "cancelReason",
  cancelled_at: "cancelledAt",
  warning_sent: "warningSent",
  exceeded_alert_sent: "exceededAlertSent",
  was_force_ended: "wasForceEnded",
  force_ended_by: "forceEndedBy",
  emergency_lockout: "emergencyLockout",
  emergency_reason: "emergencyReason",
  shift_duration_hours: "shiftDurationHours",
  meal_break_min: "mealBreakMin",
  short_break_min: "shortBreakMin",
  lockout_start_min: "lockoutStartMin",
  lockout_end_min: "lockoutEndMin",
  max_concurrent_breaks: "maxConcurrentBreaks",
  alert_mode: "alertMode",
  supervisor_broadcast_numbers: "supervisorBroadcastNumbers",
  report_type: "reportType"
};

const tableAliases = {
  users: "profiles",
  break_settings: "project_settings"
};

const timestampColumn = (key) =>
  /(^|_)(at|for|start|end)$/.test(key) ||
  ["shift_start", "shift_end", "created_at", "updated_at"].includes(key);

class DbTimestamp {
  constructor(value) {
    this.date = value instanceof Date ? value : new Date(value);
  }
  toMillis() { return this.date.getTime(); }
  toDate() { return new Date(this.date.getTime()); }
  get seconds() { return Math.floor(this.toMillis() / 1000); }
  get nanoseconds() { return (this.toMillis() % 1000) * 1_000_000; }
}

export const Timestamp = {
  fromDate: (date) => new DbTimestamp(date),
  fromMillis: (millis) => new DbTimestamp(new Date(millis))
};

export const serverTimestamp = () => new DbTimestamp(new Date());

export function collection(_db, name) {
  const collectionName = name === "break_settings" ? "project_settings" : name;
  return { kind: "collection", collectionName, table: tableAliases[name] || collectionName };
}

export function doc(_db, collectionName, id) {
  let realCollection = collectionName;
  let realId = id;
  if (collectionName === "break_settings") {
    realCollection = "project_settings";
    realId = "GENERAL";
  }
  return {
    kind: "document",
    collectionName: realCollection,
    table: tableAliases[realCollection] || realCollection,
    id: String(realId)
  };
}

export function where(field, op, value) {
  return { kind: "where", field, op, value };
}

export function orderBy(field, direction = "asc") {
  return { kind: "orderBy", field, direction };
}

export function limit(count) {
  return { kind: "limit", count };
}

export function query(ref, ...constraints) {
  return { ...ref, kind: "query", constraints };
}

function snakeToCamel(key) {
  return fieldAliases[key] || key.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
}

function camelToSnake(key) {
  const direct = Object.entries(fieldAliases).find(([, alias]) => alias === key);
  if (direct) return direct[0];
  return key.replace(/[A-Z]/g, (c) => "_" + c.toLowerCase());
}

function toDbValue(value) {
  if (value instanceof DbTimestamp) return value.toDate().toISOString();
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(toDbValue);
  if (value && typeof value === "object") {
    if (typeof value.toDate === "function") return value.toDate().toISOString();
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, toDbValue(v)]));
  }
  return value;
}

function mapNested(row) {
  if (Array.isArray(row)) return row.map(mapNested);
  if (!row || typeof row !== "object") return row;
  if (row instanceof Date || row instanceof DbTimestamp) return row;
  const output = {};
  for (const [key, value] of Object.entries(row)) {
    const normalizedKey = snakeToCamel(key);
    if (typeof value === "string" && timestampColumn(key) && !Number.isNaN(Date.parse(value))) {
      output[normalizedKey] = new DbTimestamp(value);
    } else if (value && typeof value === "object") {
      output[normalizedKey] = mapNested(value);
    } else {
      output[normalizedKey] = value;
    }
  }
  return output;
}

function normalizeRow(table, row) {
  if (!row) return null;
  const output = mapNested(row);
  if (table === "profiles") {
    output.uid = row.id;
    output.project = row.project_id;
    output.employeeId = row.employee_id;
  } else if (table === "presence") {
    output.id = row.user_id;
    output.uid = row.user_id;
    output.project = row.project_id;
  } else if (table === "shift_sessions") {
    output.uid = row.user_id || row.legacy_firebase_uid;
    output.project = row.project_id;
    output.employeeId = row.employee_id;
  } else if (table === "break_sessions") {
    output.uid = row.user_id || row.legacy_firebase_uid;
    output.project = row.project_id;
    output.employeeId = row.employee_id;
    output.agentName = row.agent_name;
  } else if (table === "project_settings") {
    output.id = row.project_id;
  } else if (table === "shift_reports") {
    output.uid = row.user_id;
    output.project = row.project_id;
  }
  if (table === "project_settings") {
    output.shiftDurationHours ??= 9;
    output.mealBreakMin ??= 40;
    output.shortBreakMin ??= 20;
    output.lockoutStartMin ??= 60;
    output.lockoutEndMin ??= 60;
    output.maxConcurrentBreaks ??= 2;
  }
  return output;
}

function snapshot(ref, rows) {
  if (ref.kind === "document") {
    const row = rows[0] || null;
    const data = row ? normalizeRow(ref.table, row) : null;
    return {
      id: ref.id,
      exists: () => Boolean(row),
      data: () => data
    };
  }
  const docs = rows.map((row) => {
    const data = normalizeRow(ref.table, row);
    const id = row.id ?? row.user_id ?? row.project_id;
    return { id: String(id), exists: () => true, data: () => data };
  });
  return { docs, size: docs.length, empty: docs.length === 0 };
}

function buildSelect(ref) {
  let q = supabase.from(ref.table).select("*");
  if (ref.kind === "document") {
    const idField = ref.table === "presence" ? "user_id" :
      ref.table === "project_settings" ? "project_id" : "id";
    q = q.eq(idField, ref.id);
  }
  for (const constraint of ref.constraints || []) {
    if (constraint.kind === "where") {
      const field = camelToSnake(constraint.field);
      const value = toDbValue(constraint.value);
      switch (constraint.op) {
        case "==": q = q.eq(field, value); break;
        case "!=": q = q.neq(field, value); break;
        case ">": q = q.gt(field, value); break;
        case ">=": q = q.gte(field, value); break;
        case "<": q = q.lt(field, value); break;
        case "<=": q = q.lte(field, value); break;
        case "in": q = q.in(field, constraint.value); break;
        default: throw new Error(`Unsupported query operator: ${constraint.op}`);
      }
    } else if (constraint.kind === "orderBy") {
      q = q.order(camelToSnake(constraint.field), { ascending: constraint.direction !== "desc" });
    } else if (constraint.kind === "limit") {
      q = q.limit(constraint.count);
    }
  }
  return q;
}

async function read(ref) {
  const { data, error } = await buildSelect(ref);
  if (error) throw error;
  return snapshot(ref, data || []);
}

export function onSnapshot(ref, next, errorCallback) {
  let closed = false;
  let channel = null;
  const refresh = async () => {
    if (closed) return;
    try {
      next(await read(ref));
    } catch (error) {
      if (errorCallback) errorCallback(error);
      else console.error("Supabase realtime read failed:", error.message);
    }
  };
  refresh();
  channel = supabase
    .channel(`compat-${ref.table}-${Math.random().toString(36).slice(2)}`)
    .on("postgres_changes", { event: "*", schema: "public", table: ref.table }, refresh)
    .subscribe();
  return () => {
    closed = true;
    if (channel) supabase.removeChannel(channel);
  };
}

export function getDocs(ref) {
  return read(ref);
}

export function getDoc(ref) {
  return read(ref);
}

export async function setDoc(ref, value, options = {}) {
  const data = toDbValue(value || {});
  if (ref.table === "presence") {
    const rpcName = data.status === "ONLINE" || data.status === "OFFLINE"
      ? "set_presence_status"
      : "touch_presence";
    const { error } = rpcName === "set_presence_status"
      ? await supabase.rpc(rpcName, { p_status: data.status })
      : await supabase.rpc(rpcName);
    if (error) throw error;
    return { id: ref.id };
  }
  if (ref.table === "projects") {
    const { data: result, error } = await supabase.rpc("create_project_tenant", {
      p_project_id: ref.id,
      p_name: data.name || ref.id
    });
    if (error) throw error;
    return result;
  }
  if (ref.table === "project_settings") {
    const { data: result, error } = await supabase.rpc("save_project_settings", {
      p_project_id: ref.id,
      p_settings: data
    });
    if (error) throw error;
    return result;
  }
  if (ref.table === "profiles" && options.merge && data.workMode) {
    const { data: result, error } = await supabase.rpc("set_work_mode", { p_mode: data.workMode });
    if (error) throw error;
    return result;
  }
  throw new Error("Direct table writes are disabled in the migration adapter. Use an authorized RPC or backend function.");
}

export async function deleteDoc(ref) {
  if (ref.table === "projects") {
    const { data, error } = await supabase.rpc("delete_project_tenant", { p_project_id: ref.id });
    if (error) throw error;
    return data;
  }
  throw new Error("Direct deletes are disabled in the migration adapter. Use an authorized backend operation.");
}
