"use strict";

// Debug logger facade
// Design constraint: all operations here are synchronous/lightweight and must never block runtime.
// No awaits, no async I/O, no runtime wiring.

const {
  putEvent,
  putCheckpoint,
  markCallCompleted,
  getCallRecord,
  getCallEvents,
  getCallCheckpoints,
  listCalls,
} = require("./callDebugStore");

const {
  DEBUG_EVENT_CATEGORIES,
  DEBUG_EVENT_TYPES,
} = require("./debugEventTypes");

const {
  serializeSnapshot,
  serializeEventData,
  serializeWebhookAttempt,
  toPlainError,
} = require("./debugSerializers");

function nowIso() {
  return new Date().toISOString();
}

function safeStr(v) {
  return v === undefined || v === null ? "" : String(v).trim();
}

function normalizeLevel(level) {
  const value = safeStr(level).toLowerCase();
  if (value === "debug" || value === "warn" || value === "error" || value === "info") {
    return value;
  }
  return "info";
}

function baseEvent(input) {
  const value = input && typeof input === "object" ? input : {};
  return {
    callSid: safeStr(value.callSid) || null,
    streamSid: safeStr(value.streamSid) || null,
    category: safeStr(value.category) || "unknown",
    type: safeStr(value.type) || "UNKNOWN_EVENT",
    source: safeStr(value.source) || "unknown",
    level: normalizeLevel(value.level),
    message: safeStr(value.message) || "",
    ts: safeStr(value.ts) || nowIso(),
    data: serializeEventData(value.data || {}),
  };
}

function recordCallEvent(input) {
  try {
    const event = baseEvent(input);
    if (!event.callSid) return null;
    return putEvent(event);
  } catch {
    return null;
  }
}

function recordSnapshotCheckpoint(input) {
  try {
    const value = input && typeof input === "object" ? input : {};
    const callSid = safeStr(value.callSid) || null;
    if (!callSid) return null;

    return putCheckpoint({
      callSid,
      label: safeStr(value.label) || "unnamed_checkpoint",
      ts: safeStr(value.ts) || nowIso(),
      snapshot: serializeSnapshot(value.snapshot || {}),
    });
  } catch {
    return null;
  }
}

function recordStateTransition(input) {
  try {
    const value = input && typeof input === "object" ? input : {};
    return recordCallEvent({
      callSid: value.callSid,
      streamSid: value.streamSid,
      category: DEBUG_EVENT_CATEGORIES.SESSION,
      type: DEBUG_EVENT_TYPES.CALL_SESSION_STATE_CHANGED,
      source: safeStr(value.source) || "callSession",
      level: value.level || "info",
      message: value.message || "",
      ts: value.ts,
      data: {
        from: safeStr(value.from) || null,
        to: safeStr(value.to) || null,
      },
    });
  } catch {
    return null;
  }
}

function recordFinalizationEvent(input) {
  try {
    const value = input && typeof input === "object" ? input : {};
    return recordCallEvent({
      callSid: value.callSid,
      streamSid: value.streamSid,
      category: DEBUG_EVENT_CATEGORIES.FINALIZATION,
      type: value.type || DEBUG_EVENT_TYPES.FINALIZATION_REQUESTED,
      source: safeStr(value.source) || "finalizationCoordinator",
      level: value.level || "info",
      message: value.message || "",
      ts: value.ts,
      data: serializeEventData(value.data || {}),
    });
  } catch {
    return null;
  }
}

function recordWebhookEvent(input) {
  try {
    const value = input && typeof input === "object" ? input : {};
    const base = serializeWebhookAttempt(value.data || {});
    return recordCallEvent({
      callSid: value.callSid,
      streamSid: value.streamSid,
      category: DEBUG_EVENT_CATEGORIES.WEBHOOK,
      type: value.type || DEBUG_EVENT_TYPES.WEBHOOK_DISPATCH_ATTEMPT,
      source: safeStr(value.source) || "webhooks",
      level: value.level || "info",
      message: value.message || "",
      ts: value.ts,
      data: base,
    });
  } catch {
    return null;
  }
}

function recordErrorEvent(input) {
  try {
    const value = input && typeof input === "object" ? input : {};
    return recordCallEvent({
      callSid: value.callSid,
      streamSid: value.streamSid,
      category: DEBUG_EVENT_CATEGORIES.ERROR,
      type: value.type || "ERROR",
      source: safeStr(value.source) || "unknown",
      level: value.level || "error",
      message: value.message || "",
      ts: value.ts,
      data: {
        error: toPlainError(value.error),
        ...(serializeEventData(value.data || {})),
      },
    });
  } catch {
    return null;
  }
}

function recordCallCompleted(input) {
  try {
    const value = input && typeof input === "object" ? input : {};
    const callSid = safeStr(value.callSid);
    if (!callSid) return false;

    return markCallCompleted(callSid, serializeEventData(value.summary || {}));
  } catch {
    return false;
  }
}

function getDebugCallRecord(callSid) {
  try {
    return getCallRecord(callSid);
  } catch {
    return null;
  }
}

function getDebugCallEvents(callSid) {
  try {
    return getCallEvents(callSid);
  } catch {
    return [];
  }
}

function getDebugCallCheckpoints(callSid) {
  try {
    return getCallCheckpoints(callSid);
  } catch {
    return [];
  }
}

function listDebugCalls(input) {
  try {
    return listCalls(input || {});
  } catch {
    return [];
  }
}

module.exports = {
  recordCallEvent,
  recordSnapshotCheckpoint,
  recordStateTransition,
  recordFinalizationEvent,
  recordWebhookEvent,
  recordErrorEvent,
  recordCallCompleted,
  getDebugCallRecord,
  getDebugCallEvents,
  getDebugCallCheckpoints,
  listDebugCalls,
};
