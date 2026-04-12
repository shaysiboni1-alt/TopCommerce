"use strict";

// Read-only timeline builder for call debug data
// No runtime wiring. No async logic.

const { getCallRecord, getCallEvents, getCallCheckpoints } = require("./callDebugStore");

function safeStr(v) {
  return v === undefined || v === null ? "" : String(v).trim();
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function normalizeBoolean(v, fallbackValue) {
  if (typeof v === "boolean") return v;
  if (v === "true") return true;
  if (v === "false") return false;
  return !!fallbackValue;
}

function safeArray(v) {
  return Array.isArray(v) ? v : [];
}

function safeTs(v) {
  const s = safeStr(v);
  return s || null;
}

function safeDiffMs(fromTs, toTs) {
  const from = safeTs(fromTs);
  const to = safeTs(toTs);
  if (!from || !to) return null;

  const fromMs = Date.parse(from);
  const toMs = Date.parse(to);

  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs)) return null;

  const diff = toMs - fromMs;
  return diff >= 0 ? diff : null;
}

function buildDerivedMetrics(markers) {
  const timeline = markers && typeof markers === "object" ? markers : {};

  const call_answered_at = safeTs(timeline.call_answered_at);
  const ws_connected_at = safeTs(timeline.ws_connected_at);
  const provider_session_ready_at = safeTs(timeline.provider_session_ready_at);
  const first_opening_sent_at = safeTs(timeline.first_opening_sent_at);
  const first_audio_out_at = safeTs(timeline.first_audio_out_at);
  const first_user_audio_at = safeTs(timeline.first_user_audio_at);
  const first_user_stable_utterance_at = safeTs(timeline.first_user_stable_utterance_at);
  const first_bot_response_at = safeTs(timeline.first_bot_response_at);
  const finalization_started_at = safeTs(timeline.finalization_started_at);
  const finalization_completed_at = safeTs(timeline.finalization_completed_at);

  return {
    answer_to_ws_connected_ms: safeDiffMs(call_answered_at, ws_connected_at),
    ws_to_provider_ready_ms: safeDiffMs(ws_connected_at, provider_session_ready_at),
    provider_ready_to_opening_sent_ms: safeDiffMs(provider_session_ready_at, first_opening_sent_at),
    opening_sent_to_first_audio_out_ms: safeDiffMs(first_opening_sent_at, first_audio_out_at),

    answer_to_first_audio_out_ms: safeDiffMs(call_answered_at, first_audio_out_at),
    first_audio_out_to_first_user_audio_ms: safeDiffMs(first_audio_out_at, first_user_audio_at),
    first_user_audio_to_stable_utterance_ms: safeDiffMs(first_user_audio_at, first_user_stable_utterance_at),
    stable_utterance_to_first_bot_response_ms: safeDiffMs(first_user_stable_utterance_at, first_bot_response_at),
    user_end_to_bot_start_ms: safeDiffMs(first_user_stable_utterance_at, first_bot_response_at),

    finalization_duration_ms: safeDiffMs(finalization_started_at, finalization_completed_at),

    has_user_audio: !!first_user_audio_at,
    has_stable_utterance: !!first_user_stable_utterance_at,
    has_bot_response: !!first_bot_response_at,
    has_finalization_window: !!(finalization_started_at && finalization_completed_at),
  };
}

function buildTimelineEntryFromEvent(event) {
  const item = event && typeof event === "object" ? event : {};
  return {
    kind: "event",
    seq: Number.isFinite(Number(item.seq)) ? Number(item.seq) : 0,
    ts: safeStr(item.ts) || null,
    callSid: safeStr(item.callSid) || null,
    streamSid: safeStr(item.streamSid) || null,
    category: safeStr(item.category) || "unknown",
    type: safeStr(item.type) || "UNKNOWN_EVENT",
    source: safeStr(item.source) || "unknown",
    level: safeStr(item.level) || "info",
    message: safeStr(item.message) || "",
    data: clone(item.data || {}),
  };
}

function buildTimelineEntryFromCheckpoint(checkpoint) {
  const item = checkpoint && typeof checkpoint === "object" ? checkpoint : {};
  return {
    kind: "checkpoint",
    seq: Number.isFinite(Number(item.seq)) ? Number(item.seq) : 0,
    ts: safeStr(item.ts) || null,
    callSid: safeStr(item.callSid) || null,
    streamSid: null,
    category: "snapshot",
    type: "SNAPSHOT_CHECKPOINT_CREATED",
    source: "callDebugStore",
    level: "debug",
    message: "",
    data: {
      checkpoint_id: safeStr(item.checkpoint_id) || null,
      label: safeStr(item.label) || "unnamed_checkpoint",
      snapshot: clone(item.snapshot || {}),
    },
  };
}

function compareTimelineItems(a, b) {
  const aSeq = Number.isFinite(Number(a && a.seq)) ? Number(a.seq) : 0;
  const bSeq = Number.isFinite(Number(b && b.seq)) ? Number(b.seq) : 0;

  if (aSeq !== bSeq) return aSeq - bSeq;

  const aTs = safeStr(a && a.ts);
  const bTs = safeStr(b && b.ts);

  if (aTs < bTs) return -1;
  if (aTs > bTs) return 1;
  return 0;
}

function compactItem(item) {
  const value = item && typeof item === "object" ? item : {};
  const compact = {
    kind: value.kind || "event",
    seq: Number.isFinite(Number(value.seq)) ? Number(value.seq) : 0,
    ts: safeStr(value.ts) || null,
    category: safeStr(value.category) || "unknown",
    type: safeStr(value.type) || "UNKNOWN_EVENT",
    source: safeStr(value.source) || "unknown",
  };

  if (value.kind === "checkpoint") {
    compact.label = safeStr(value?.data?.label) || "unnamed_checkpoint";
    return compact;
  }

  if (safeStr(value.message)) {
    compact.message = safeStr(value.message);
  }

  return compact;
}

function filterTimelineItems(items, options) {
  const opts = options && typeof options === "object" ? options : {};
  const category = safeStr(opts.category).toLowerCase();
  const type = safeStr(opts.type).toLowerCase();

  return safeArray(items).filter((item) => {
    const itemCategory = safeStr(item && item.category).toLowerCase();
    const itemType = safeStr(item && item.type).toLowerCase();

    if (category && itemCategory !== category) return false;
    if (type && itemType !== type) return false;

    return true;
  });
}

function buildTimeline(callSid, options) {
  const id = safeStr(callSid);
  const opts = options && typeof options === "object" ? options : {};
  const includeCheckpoints =
    opts.includeCheckpoints === undefined ? true : normalizeBoolean(opts.includeCheckpoints, true);
  const compact = normalizeBoolean(opts.compact, false);

  const events = getCallEvents(id).map(buildTimelineEntryFromEvent);
  const checkpoints = includeCheckpoints
    ? getCallCheckpoints(id).map(buildTimelineEntryFromCheckpoint)
    : [];

  const merged = events.concat(checkpoints).sort(compareTimelineItems);
  const filtered = filterTimelineItems(merged, opts);

  return compact ? filtered.map(compactItem) : filtered;
}

function extractTimelineMarkers(record) {
  const checkpoints = safeArray(record && record.checkpoints);
  const markers = {};

  checkpoints.forEach((checkpoint) => {
    const label = safeStr(checkpoint && checkpoint.label);
    if (!label || !label.startsWith("timeline_")) return;
    const key = label.slice("timeline_".length);
    if (!key) return;

    const snapshot = checkpoint && checkpoint.snapshot && typeof checkpoint.snapshot === "object"
      ? checkpoint.snapshot
      : {};
    const timeline = snapshot.timeline && typeof snapshot.timeline === "object"
      ? snapshot.timeline
      : {};
    markers[key] = safeStr(timeline[key]) || safeStr(checkpoint && checkpoint.ts) || null;
  });

  return markers;
}

function buildCallDebugView(callSid, options) {
  const id = safeStr(callSid);
  const record = getCallRecord(id);
  const timeline = buildTimeline(id, options);
  const timeline_markers = record ? extractTimelineMarkers(record) : {};
  const derived_metrics = buildDerivedMetrics(timeline_markers);

  return {
    callSid: id || null,
    summary: record ? clone(record.summary || {}) : null,
    timeline_markers,
    derived_metrics,
    timeline,
  };
}

function buildRecentCallsTimelineIndex(options) {
  const opts = options && typeof options === "object" ? options : {};
  const status = safeStr(opts.status || "all");
  const limit = Number.isFinite(Number(opts.limit)) ? Number(opts.limit) : 50;

  const items = require("./callDebugStore").listCalls({
    status,
    limit,
  });

  return safeArray(items).map((item) => ({
    callSid: safeStr(item.callSid) || null,
    streamSid: safeStr(item.streamSid) || null,
    started_at: safeStr(item.started_at) || null,
    ended_at: safeStr(item.ended_at) || null,
    finalized: !!item.final_status,
    final_status: safeStr(item.final_status) || null,
    final_reason: safeStr(item.final_reason) || null,
    event_count: Number.isFinite(Number(item.event_count)) ? Number(item.event_count) : 0,
    checkpoint_count: Number.isFinite(Number(item.checkpoint_count)) ? Number(item.checkpoint_count) : 0,
  }));
}

module.exports = {
  buildTimeline,
  buildCallDebugView,
  buildRecentCallsTimelineIndex,
};
