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
const { pool } = require("../memory/pg");

function nowIso() {
  return new Date().toISOString();
}

function safeStr(v) {
  return v === undefined || v === null ? "" : String(v).trim();
}

async function saveLKGToDB({ botId, callSid, bundle, result }) {
  try {
    await pool.query(
      `
      insert into lkg_store (bot_id, call_sid, bundle, result, saved_at)
      values ($1, $2, $3, $4, now())
      on conflict (bot_id)
      do update set
        call_sid = excluded.call_sid,
        bundle = excluded.bundle,
        result = excluded.result,
        saved_at = now()
      `,
      [
        botId || "default_bot",
        callSid,
        JSON.stringify(bundle || {}),
        JSON.stringify(result || {}),
      ]
    );
  } catch (e) {
    logger.warn("LKG save failed", { error: e.message });
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
    recordFinalizationTimelineCheckpoint({
      callSid,
      entry: null,
      key: "finalization_completed_at",
      ts: nowIso(),
    });
    return { ok: false };
  }

  if (!tryAcquireFinalize(callSid)) {
    recordFinalizationTimelineCheckpoint({
      callSid,
      entry,
      key: "finalization_completed_at",
      ts: nowIso(),
    });
    return { ok: true };
  }

  if (!markFinalized(callSid, source || "finalization_coordinator")) {
    releaseFinalize(callSid);
    recordFinalizationTimelineCheckpoint({
      callSid,
      entry,
      key: "finalization_completed_at",
      ts: nowIso(),
    });
    return { ok: true };
  }

  try {
    entry.snapshot.call = {
      ...(entry.snapshot.call || {}),
      twilio_call_status: twilioStatus || entry.snapshot.call?.twilio_call_status || null,
      duration_seconds: Number(durationSeconds) || 0,
      ended_at: entry.snapshot.call?.ended_at || new Date().toISOString(),
      finalize_reason: source || null,
    };

    const out = await finalizePipeline({
      snapshot: entry.snapshot,
      ssot: getSSOT(),
    });

    // 🔥 כאן נשמר LKG רק אם COMPLETE
    if (out?.decision?.business_status === "COMPLETE") {
      await saveLKGToDB({
        botId: "default_bot",
        callSid,
        bundle: entry.snapshot?.compiled_prompt_bundle || null,
        result: out,
      });
    }

    recordFinalizationTimelineCheckpoint({
      callSid,
      entry,
      key: "finalization_completed_at",
      ts: nowIso(),
    });

    clearSession(callSid);

    return { ok: true, result: out };
  } catch (e) {
    releaseFinalize(callSid);

    recordFinalizationTimelineCheckpoint({
      callSid,
      entry,
      key: "finalization_completed_at",
      ts: nowIso(),
    });

    return { ok: false };
  }
}

module.exports = {
  finalizeThroughCoordinator,
};
