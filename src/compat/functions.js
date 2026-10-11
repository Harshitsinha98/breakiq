import { supabase } from "../supabase";

function getCurrentUserId() {
  return supabase.auth.getUser().then(({ data, error }) => {
    if (error) throw error;
    return data.user?.id ?? null;
  });
}

async function invokeAdmin(action, payload = {}) {
  const { data, error } = await supabase.functions.invoke("breakiq-admin", {
    body: { action, ...payload }
  });
  if (error) throw error;
  if (data?.error) throw new Error(data.error);
  return data;
}

async function callBackend(name, payload = {}) {
  let rpcName;
  let args = {};

  switch (name) {
    case "startShift":
      rpcName = "start_shift";
      break;
    case "endShiftLogout":
      rpcName = "end_shift_logout";
      break;
    case "requestBreakNow": {
      const callerId = await getCurrentUserId();
      if (payload.targetUid && callerId && payload.targetUid !== callerId) {
        rpcName = "supervisor_request_break_now";
        args = {
          p_target_user_id: payload.targetUid,
          p_category: payload.category,
          p_minutes_now: payload.minutesNow ?? null
        };
      } else {
        rpcName = "request_break_now";
        args = {
          p_category: payload.category,
          p_minutes_now: payload.minutesNow ?? null
        };
      }
      break;
    }
    case "requestBreakLater":
      rpcName = "request_break_later";
      args = {
        p_category: payload.category,
        p_minutes_now: payload.minutesNow ?? null,
        p_scheduled_for_ms: payload.scheduledFor == null ? null : Number(payload.scheduledFor)
      };
      break;
    case "acceptBreakStart":
      rpcName = "accept_break_start";
      break;
    case "goingForBreak":
      rpcName = "going_for_break";
      break;
    case "endBreak":
      rpcName = "end_break";
      args = { p_target_user_id: null };
      break;
    case "cancelScheduledBreak":
      rpcName = "cancel_scheduled_break";
      args = { p_target_user_id: payload.targetUid ?? null };
      break;
    case "toggleEmergencyLockout":
      rpcName = "toggle_emergency_lockout";
      args = { p_locked: Boolean(payload.locked), p_reason: payload.reason ?? null };
      break;
    case "adminForceEndBreak":
      rpcName = "admin_force_end_break";
      args = { p_target_user_id: payload.targetUid };
      break;
    case "supervisorForceEndShift":
      rpcName = "supervisor_force_end_shift";
      args = { p_target_user_id: payload.targetUid };
      break;
    case "flushGhostQueue":
      rpcName = "flush_ghost_queue";
      args = { p_project_id: payload.project ?? "GENERAL" };
      break;
    case "createUserAccount":
    case "editUserAccount":
    case "deleteUserAccount":
    case "resetPassword":
    case "agentUpdateOwnPassword":
      return invokeAdmin(name, payload);
    default:
      throw new Error(`Unsupported backend operation: ${name}`);
  }

  const { data, error } = await supabase.rpc(rpcName, args);
  if (error) throw error;
  return data;
}

export function httpsCallable(_functions, name) {
  return async (payload = {}) => ({ data: await callBackend(name, payload) });
}
