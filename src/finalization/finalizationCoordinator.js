"use strict";

const { getSSOT } = require("../ssot/ssotClient");
const { logger } = require("../utils/logger");
const { finalizePipeline } = require("../stage4/finalizePipeline");
const { getEntry, markFinalized, clearSession } = require("../runtime/callRegistry");
const { tryAcquireFinalize, releaseFinalize } = require("../runtime/finalizeOnce");
const {
  recordFinalizationEvent,
  recordSnapshotCheckpoint,
} = require("../debug/debugLogger");
const { DEBUG_EVENT_TYPES } = require("../debug/debugEventTypes");

function safeStr(v) {
  return v === undefined || v === null ? "" : String(v).trim();
}

function nowIso() {
  return new Date().toISOString();
}

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

function recordFinalizationTimelineCheckpoint({ callSid, entry, key, ts }) {
  const markerKey = safeStr(key);
  const markerTs = safeStr(ts) || nowIso();
  if (!callSid || !markerKey) return null;

  const marked = entry?.session?.markTimeline?.(markerKey, markerTs);
  if (marked) return marked;

  recordSnapshotCheckpoint({
    callSid,
    label: `timeline_${markerKey}`,
    ts: markerTs,
    snapshot: {
      timeline: {
        call_answered_at: entry?.session?.timeline?.call_answered_at || null,
        ws_connected_at: entry?.session?.timeline?.ws_connected_at || null,
        provider_session_ready_at: entry?.session?.timeline?.provider_session_ready_at || null,
        first_opening_sent_at: entry?.session?.timeline?.first_opening_sent_at || null,
        first_audio_out_at: entry?.session?.timeline?.first_audio_out_at || null,
        first_user_audio_at: entry?.session?.timeline?.first_user_audio_at || null,
        first_user_stable_utterance_at: entry?.session?.timeline?.first_user_stable_utterance_at || null,
        first_bot_response_at: entry?.session?.timeline?.first_bot_response_at || null,
        finalization_started_at:
          markerKey === "finalization_started_at"
            ? markerTs
            : entry?.session?.timeline?.finalization_started_at || null,
        finalization_completed_at:
          markerKey === "finalization_completed_at"
            ? markerTs
            : entry?.session?.timeline?.finalization_completed_at || null,
      },
    },
  });

  return markerTs;
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
  recordFinalizationTimelineCheckpoint({
    callSid,
    entry,
    key: "finalization_started_at",
    ts: nowIso(),
  });

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

    recordFinalizationTimelineCheckpoint({
      callSid,
      entry: null,
      key: "finalization_completed_at",
      ts: nowIso(),
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

      recordFinalizationTimelineCheckpoint({
        callSid,
        entry,
        key: "finalization_completed_at",
        ts: nowIso(),
      });
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

      recordFinalizationTimelineCheckpoint({
        callSid,
        entry,
        key: "finalization_completed_at",
        ts: nowIso(),
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

    recordFinalizationTimelineCheckpoint({
      callSid,
      entry,
      key: "finalization_completed_at",
      ts: nowIso(),
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

    recordFinalizationTimelineCheckpoint({
      callSid,
      entry,
      key: "finalization_completed_at",
      ts: nowIso(),
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

    recordFinalizationTimelineCheckpoint({
      callSid,
      entry,
      key: "finalization_completed_at",
      ts: nowIso(),
    });

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

    recordFinalizationTimelineCheckpoint({
      callSid,
      entry,
      key: "finalization_completed_at",
      ts: nowIso(),
    });

    return { ok: false, reason: String(e) };
  }
}

module.exports = {
  finalizeThroughCoordinator,
};
