"use strict";

// In-memory call debug store
// Bounded retention with active-call preference.
// Design constraint: all operations are synchronous/lightweight and never block runtime.

const DEFAULT_MAX_EVENTS_PER_CALL = 500;
const DEFAULT_MAX_CHECKPOINTS_PER_CALL = 25;
const DEFAULT_MAX_COMPLETED_CALLS = 200;
const DEFAULT_MAX_ACTIVE_CALLS = 1000;

const state = {
  activeCalls: new Map(),
  completedCalls: new Map(),
  seq: 0,
};

function nowIso() {
  return new Date().toISOString();
}

function nextSeq() {
  state.seq += 1;
  return state.seq;
}

function safeStr(v) {
  return v === undefined || v === null ? "" : String(v).trim();
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function safeNumber(value, fallbackValue) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallbackValue;
}

function sortRecordsByUpdatedAsc(records) {
  return records.sort((a, b) => {
    const aTs = safeStr(a && (a.updated_at || a.created_at));
    const bTs = safeStr(b && (b.updated_at || b.created_at));
    if (aTs < bTs) return -1;
    if (aTs > bTs) return 1;
    return 0;
  });
}

function summarizeRecord(record) {
  if (!record) return null;
  return {
    callSid: safeStr(record.summary && record.summary.callSid) || safeStr(record.callSid) || null,
    streamSid: safeStr(record.summary && record.summary.streamSid) || null,
    started_at: safeStr(record.summary && record.summary.started_at) || null,
    ended_at: safeStr(record.summary && record.summary.ended_at) || null,
    twilio_call_status: safeStr(record.summary && record.summary.twilio_call_status) || null,
    final_status: safeStr(record.summary && record.summary.final_status) || null,
    final_reason: safeStr(record.summary && record.summary.final_reason) || null,
    event_count: Array.isArray(record.events) ? record.events.length : 0,
    checkpoint_count: Array.isArray(record.checkpoints) ? record.checkpoints.length : 0,
  };
}

function createRecord(callSid) {
  const id = safeStr(callSid);
  return {
    callSid: id,
    created_at: nowIso(),
    updated_at: nowIso(),
    finalized: false,
    summary: {
      callSid: id,
      streamSid: null,
      started_at: null,
      ended_at: null,
      twilio_call_status: null,
      final_status: null,
      final_reason: null,
      event_count: 0,
      checkpoint_count: 0,
    },
    events: [],
    checkpoints: [],
  };
}

function trimEvents(record, maxEvents) {
  const limit = safeNumber(maxEvents, DEFAULT_MAX_EVENTS_PER_CALL);
  if (!record || !Array.isArray(record.events) || record.events.length <= limit) return;
  record.events = record.events.slice(record.events.length - limit);
}

function trimCheckpoints(record, maxCheckpoints) {
  const limit = safeNumber(maxCheckpoints, DEFAULT_MAX_CHECKPOINTS_PER_CALL);
  if (!record || !Array.isArray(record.checkpoints) || record.checkpoints.length <= limit) return;
  record.checkpoints = record.checkpoints.slice(record.checkpoints.length - limit);
}

function trimCompleted(maxCompletedCalls) {
  const limit = safeNumber(maxCompletedCalls, DEFAULT_MAX_COMPLETED_CALLS);
  if (state.completedCalls.size <= limit) return;

  const sorted = sortRecordsByUpdatedAsc(Array.from(state.completedCalls.values()));
  const overflow = state.completedCalls.size - limit;

  for (let i = 0; i < overflow; i += 1) {
    const record = sorted[i];
    if (!record) continue;
    const id = safeStr(record.callSid);
    if (!id) continue;
    state.completedCalls.delete(id);
  }
}

function trimActive(maxActiveCalls) {
  const limit = safeNumber(maxActiveCalls, DEFAULT_MAX_ACTIVE_CALLS);
  if (state.activeCalls.size <= limit) return;

  // Preserve active calls preferentially by only trimming when the active map itself
  // exceeds a very high bound, and evict the stalest active records first.
  const sorted = sortRecordsByUpdatedAsc(Array.from(state.activeCalls.values()));
  const overflow = state.activeCalls.size - limit;

  for (let i = 0; i < overflow; i += 1) {
    const record = sorted[i];
    if (!record) continue;
    const id = safeStr(record.callSid);
    if (!id) continue;
    state.activeCalls.delete(id);
  }
}

function applyRecordBounds(record, options) {
  if (!record) return;
  const opts = options && typeof options === "object" ? options : {};
  trimEvents(record, opts.maxEventsPerCall);
  trimCheckpoints(record, opts.maxCheckpointsPerCall);
}

function applyGlobalBounds(options) {
  const opts = options && typeof options === "object" ? options : {};
  trimCompleted(opts.maxCompletedCalls);
  trimActive(opts.maxActiveCalls);
}

function getOrCreateRecord(callSid, options) {
  const id = safeStr(callSid);
  if (!id) return null;

  if (state.activeCalls.has(id)) {
    const existing = state.activeCalls.get(id);
    applyRecordBounds(existing, options);
    return existing;
  }

  if (state.completedCalls.has(id)) {
    const existing = state.completedCalls.get(id);
    applyRecordBounds(existing, options);
    return existing;
  }

  const record = createRecord(id);
  state.activeCalls.set(id, record);
  applyGlobalBounds(options);
  return record;
}

function updateSummaryFromEvent(record, event) {
  if (!record || !event) return;

  record.updated_at = event.ts || nowIso();
  record.summary.event_count = Array.isArray(record.events) ? record.events.length : 0;
  record.summary.checkpoint_count = Array.isArray(record.checkpoints) ? record.checkpoints.length : 0;

  if (event.streamSid && !record.summary.streamSid) {
    record.summary.streamSid = event.streamSid;
  }

  const data = event.data && typeof event.data === "object" ? event.data : {};

  if (data.streamSid && !record.summary.streamSid) {
    record.summary.streamSid = data.streamSid;
  }

  if (data.started_at && !record.summary.started_at) {
    record.summary.started_at = data.started_at;
  }

  if (data.ended_at) {
    record.summary.ended_at = data.ended_at;
  }

  if (data.twilio_call_status) {
    record.summary.twilio_call_status = data.twilio_call_status;
  }

  if (data.final_status) {
    record.summary.final_status = data.final_status;
  }

  if (data.final_reason) {
    record.summary.final_reason = data.final_reason;
  }

  if (event.type === "FINALIZATION_COMPLETED" && data.final_status) {
    record.finalized = true;
    record.summary.final_status = data.final_status;
    record.summary.final_reason = data.final_reason || record.summary.final_reason || null;
  }
}

function putEvent(event, options) {
  const callSid = safeStr(event && event.callSid);
  if (!callSid) return null;

  const record = getOrCreateRecord(callSid, options);
  if (!record) return null;

  const normalized = {
    event_id: safeStr(event.event_id) || `evt_${nextSeq()}`,
    seq: typeof event.seq === "number" ? event.seq : nextSeq(),
    ts: safeStr(event.ts) || nowIso(),
    callSid,
    streamSid: safeStr(event.streamSid) || null,
    category: safeStr(event.category) || "unknown",
    type: safeStr(event.type) || "UNKNOWN_EVENT",
    source: safeStr(event.source) || "unknown",
    level: safeStr(event.level) || "info",
    message: safeStr(event.message) || "",
    data: event.data && typeof event.data === "object" ? clone(event.data) : {},
  };

  record.events.push(normalized);
  applyRecordBounds(record, options);
  updateSummaryFromEvent(record, normalized);

  return clone(normalized);
}

function putCheckpoint(checkpoint, options) {
  const callSid = safeStr(checkpoint && checkpoint.callSid);
  if (!callSid) return null;

  const record = getOrCreateRecord(callSid, options);
  if (!record) return null;

  const normalized = {
    checkpoint_id: safeStr(checkpoint.checkpoint_id) || `cp_${nextSeq()}`,
    seq: typeof checkpoint.seq === "number" ? checkpoint.seq : nextSeq(),
    ts: safeStr(checkpoint.ts) || nowIso(),
    callSid,
    label: safeStr(checkpoint.label) || "unnamed_checkpoint",
    snapshot: checkpoint.snapshot && typeof checkpoint.snapshot === "object"
      ? clone(checkpoint.snapshot)
      : {},
  };

  record.checkpoints.push(normalized);
  applyRecordBounds(record, options);

  record.updated_at = normalized.ts;
  record.summary.checkpoint_count = Array.isArray(record.checkpoints) ? record.checkpoints.length : 0;

  return clone(normalized);
}

function markCallCompleted(callSid, summaryPatch, options) {
  const id = safeStr(callSid);
  if (!id) return false;

  const record = state.activeCalls.get(id) || state.completedCalls.get(id) || getOrCreateRecord(id, options);
  if (!record) return false;

  const patch = summaryPatch && typeof summaryPatch === "object" ? summaryPatch : {};
  record.finalized = true;
  record.summary = {
    ...(record.summary || {}),
    ...clone(patch),
    callSid: id,
  };
  record.updated_at = nowIso();
  record.summary.event_count = Array.isArray(record.events) ? record.events.length : 0;
  record.summary.checkpoint_count = Array.isArray(record.checkpoints) ? record.checkpoints.length : 0;

  if (state.activeCalls.has(id)) {
    state.activeCalls.delete(id);
  }
  state.completedCalls.set(id, record);

  applyRecordBounds(record, options);
  applyGlobalBounds(options);

  return true;
}

function getCallRecord(callSid) {
  const id = safeStr(callSid);
  if (!id) return null;

  const record = state.activeCalls.get(id) || state.completedCalls.get(id) || null;
  return record ? clone(record) : null;
}

function getCallEvents(callSid) {
  const record = getCallRecord(callSid);
  return record ? record.events || [] : [];
}

function getCallCheckpoints(callSid) {
  const record = getCallRecord(callSid);
  return record ? record.checkpoints || [] : [];
}

function listCalls(input) {
  const opts = input && typeof input === "object" ? input : {};
  const status = safeStr(opts.status || "all").toLowerCase();
  const limit = safeNumber(opts.limit, 50) || 50;

  let items = [];

  if (status === "active" || status === "all") {
    items = items.concat(Array.from(state.activeCalls.values()));
  }

  if (status === "completed" || status === "all") {
    items = items.concat(Array.from(state.completedCalls.values()));
  }

  items.sort((a, b) => {
    const aTs = safeStr(a.updated_at || a.created_at);
    const bTs = safeStr(b.updated_at || b.created_at);
    if (aTs < bTs) return 1;
    if (aTs > bTs) return -1;
    return 0;
  });

  return items.slice(0, Math.max(1, limit)).map((record) => clone(summarizeRecord(record)));
}

function clearAll() {
  state.activeCalls.clear();
  state.completedCalls.clear();
  state.seq = 0;
}

module.exports = {
  putEvent,
  putCheckpoint,
  markCallCompleted,
  getCallRecord,
  getCallEvents,
  getCallCheckpoints,
  listCalls,
  clearAll,
};
