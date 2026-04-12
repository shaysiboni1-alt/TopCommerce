"use strict";

const calls = new Map();

function ensure(callSid) {
  const id = String(callSid || "").trim();
  if (!id) return null;
  let e = calls.get(id);
  if (!e) {
    e = {
      callSid: id,
      session: null,
      snapshot: {
        call: { callSid: id, started_at: new Date().toISOString() },
        conversationLog: [],
        lead: {},
      },
      finalized: false,
      finalizedSource: null,
      updatedAt: Date.now(),
    };
    calls.set(id, e);
  }
  e.updatedAt = Date.now();
  return e;
}

function registerSession(callSid, session, snapshot) {
  const e = ensure(callSid);
  if (!e) return null;
  e.session = session || null;
  if (snapshot) e.snapshot = snapshot;
  e.updatedAt = Date.now();
  return e;
}

function updateSnapshot(callSid, updater) {
  const e = ensure(callSid);
  if (!e) return null;
  if (typeof updater === "function") {
    e.snapshot = updater(e.snapshot) || e.snapshot;
  } else if (updater && typeof updater === "object") {
    e.snapshot = { ...(e.snapshot || {}), ...updater };
  }
  e.updatedAt = Date.now();
  return e.snapshot;
}

function appendConversationTurn(callSid, turn) {
  const e = ensure(callSid);
  if (!e) return null;
  if (!Array.isArray(e.snapshot.conversationLog)) e.snapshot.conversationLog = [];
  e.snapshot.conversationLog.push(turn);
  e.updatedAt = Date.now();
  return e.snapshot;
}

function getEntry(callSid) {
  const id = String(callSid || "").trim();
  return id ? calls.get(id) || null : null;
}

function markFinalized(callSid, source) {
  const e = ensure(callSid);
  if (!e) return false;
  if (e.finalized) return false;
  e.finalized = true;
  e.finalizedSource = source || null;
  e.updatedAt = Date.now();
  return true;
}

function clearSession(callSid) {
  const e = getEntry(callSid);
  if (!e) return;
  e.session = null;
  e.updatedAt = Date.now();
}

module.exports = { registerSession, updateSnapshot, appendConversationTurn, getEntry, markFinalized, clearSession };
