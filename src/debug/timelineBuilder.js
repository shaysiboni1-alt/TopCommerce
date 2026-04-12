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

  return {
    callSid: id || null,
    summary: record ? clone(record.summary || {}) : null,
    timeline_markers: record ? extractTimelineMarkers(record) : {},
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
