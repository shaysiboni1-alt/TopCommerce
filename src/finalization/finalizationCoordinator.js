"use strict";

const { getSSOT } = require("../ssot/ssotClient");
const { logger } = require("../utils/logger");
const { finalizePipeline } = require("../stage4/finalizePipeline");
const { getEntry, markFinalized, clearSession } = require("../runtime/callRegistry");
const { tryAcquireFinalize, releaseFinalize } = require("../runtime/finalizeOnce");
const { recordFinalizationEvent } = require("../debug/debugLogger");
const { DEBUG_EVENT_TYPES } = require("../debug/debugEventTypes");

function applySessionSnapshotUpdate(entry, { source, sessionFinalizeData, conversationLog }) {
  entry.snapshot = {
    ...(entry.snapshot || {}),
    call: {
      ...(entry.snapshot?.call || {}),
      ...(sessionFinalizeData || {}),
    },
    conversationLog: Array.isArray(conversationLog)
      ? conversationLog
      : Array.isArray(entry.snapshot?.conversationLog)
        ? entry.snapshot.conversationLog
        : [],
    lead: entry.snapshot?.lead || {},
  };

  if (
    !entry.snapshot.call.finalize_reason &&
    source
  ) {
    entry.snapshot.call.finalize_reason = source;
  }
}

async function finalizeThroughCoordinator({
  callSid,
  source,
  twilioStatus,
  durationSeconds,
  sessionFinalizeData,
  conversationLog,
}) {
  recordFinalizationEvent({
    callSid,
    source: "finalizationCoordinator",
    type: DEBUG_EVENT_TYPES.FINALIZATION_REQUESTED,
    level: "info",
    data: {
      trigger_source: source || null,
      twilio_call_status: twilioStatus || null,
      duration_seconds: Number.isFinite(Number(durationSeconds)) ? Number(durationSeconds) : null,
      has_session_finalize_data: !!sessionFinalizeData,
      conversation_log_length: Array.isArray(conversationLog) ? conversationLog.length : null,
    },
  });

  const entry = getEntry(callSid);
  entry?.session?.markTimeline?.("finalization_started_at");

  if (!entry) {
    logger.warn("finalizationCoordinator missing call", {
      callSid,
      source,
      twilioStatus,
    });

    recordFinalizationEvent({
      callSid,
      source: "finalizationCoordinator",
      type: DEBUG_EVENT_TYPES.FINALIZATION_FAILED,
      level: "warn",
      data: {
        trigger_source: source || null,
        reason: "missing_call",
      },
    });

    return { ok: false, reason: "missing_call" };
  }

  if (sessionFinalizeData) {
    try {
      applySessionSnapshotUpdate(entry, {
        source,
        sessionFinalizeData,
        conversationLog,
      });

      recordFinalizationEvent({
        callSid,
        source: "finalizationCoordinator",
        type: DEBUG_EVENT_TYPES.FINALIZATION_SNAPSHOT_ONLY_APPLIED,
        level: "debug",
        data: {
          trigger_source: source || null,
          twilio_call_status: entry.snapshot?.call?.twilio_call_status || null,
          ended_at: entry.snapshot?.call?.ended_at || null,
        },
      });

      entry?.session?.markTimeline?.("finalization_completed_at");
    } catch (e) {
      logger.warn("finalizationCoordinator snapshot-only update failed", {
        callSid,
        source,
        error: String(e?.message || e),
      });

      recordFinalizationEvent({
        callSid,
        source: "finalizationCoordinator",
        type: DEBUG_EVENT_TYPES.FINALIZATION_FAILED,
        level: "warn",
        data: {
          trigger_source: source || null,
          reason: "snapshot_only_update_failed",
          error: String(e?.message || e),
        },
      });
    } finally {
      clearSession(callSid);
    }

    return { ok: true, phase: "snapshot_only" };
  }

  if (!tryAcquireFinalize(callSid)) {
    recordFinalizationEvent({
      callSid,
      source: "finalizationCoordinator",
      type: DEBUG_EVENT_TYPES.FINALIZATION_DUPLICATE_IGNORED,
      level: "debug",
      data: {
        trigger_source: source || null,
        reason: "finalize_lock_already_acquired",
      },
    });

    return { ok: true, alreadyFinalized: true };
  }

  recordFinalizationEvent({
    callSid,
    source: "finalizationCoordinator",
    type: DEBUG_EVENT_TYPES.FINALIZATION_LOCK_ACQUIRED,
    level: "debug",
    data: {
      trigger_source: source || null,
    },
  });

  if (!markFinalized(callSid, source || "finalization_coordinator")) {
    releaseFinalize(callSid);

    recordFinalizationEvent({
      callSid,
      source: "finalizationCoordinator",
      type: DEBUG_EVENT_TYPES.FINALIZATION_DUPLICATE_IGNORED,
      level: "debug",
      data: {
        trigger_source: source || null,
        reason: "registry_already_finalized",
      },
    });

    return { ok: true, alreadyFinalized: true };
  }

  recordFinalizationEvent({
    callSid,
    source: "finalizationCoordinator",
    type: DEBUG_EVENT_TYPES.FINALIZATION_WINNER_SELECTED,
    level: "info",
    data: {
      winner_source: source || "finalization_coordinator",
      twilio_call_status: twilioStatus || entry.snapshot?.call?.twilio_call_status || null,
    },
  });

  try {
    entry.snapshot.call = {
      ...(entry.snapshot.call || {}),
      twilio_call_status: twilioStatus || entry.snapshot.call?.twilio_call_status || null,
      duration_seconds: Number.isFinite(Number(durationSeconds))
        ? Number(durationSeconds)
        : entry.snapshot.call?.duration_seconds || 0,
      ended_at: entry.snapshot.call?.ended_at || new Date().toISOString(),
      finalize_reason: source || entry.snapshot.call?.finalize_reason || null,
    };

    const out = await finalizePipeline({
      snapshot: entry.snapshot,
      ssot: getSSOT(),
    });

    entry?.session?.markTimeline?.("finalization_completed_at");
    clearSession(callSid);

    recordFinalizationEvent({
      callSid,
      source: "finalizationCoordinator",
      type: DEBUG_EVENT_TYPES.FINALIZATION_COMPLETED,
      level: "info",
      data: {
        winner_source: source || "finalization_coordinator",
        twilio_call_status: entry.snapshot?.call?.twilio_call_status || null,
        final_status: out?.decision?.business_status || null,
        final_reason: out?.decision?.reason || null,
      },
    });

    return { ok: true, via: "snapshot", result: out };
  } catch (e) {
    logger.warn("finalizationCoordinator failed", {
      callSid,
      source,
      error: String(e?.message || e),
    });
    entry.finalized = false;
    entry.finalizedSource = null;
    releaseFinalize(callSid);

    recordFinalizationEvent({
      callSid,
      source: "finalizationCoordinator",
      type: DEBUG_EVENT_TYPES.FINALIZATION_FAILED,
      level: "warn",
      data: {
        trigger_source: source || null,
        error: String(e?.message || e),
      },
    });

    return { ok: false, reason: String(e) };
  }
}

module.exports = {
  finalizeThroughCoordinator,
};
