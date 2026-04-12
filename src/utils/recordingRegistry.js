"use strict";

// In-memory registry: CallSid -> { recordingSid, recordingUrl, startRequested, updatedAt }
// Best-effort only (per canonical spec). If the process restarts, data may be lost.

const RECORDINGS = new Map();

function getKey(callId) {
  return String(callId || "").trim();
}

function markRecordingStartRequested(callId) {
  const key = getKey(callId);
  if (!key) return false;

  const prev = RECORDINGS.get(key) || {};
  if (prev.startRequested) return false;

  RECORDINGS.set(key, {
    ...prev,
    startRequested: true,
    updatedAt: Date.now(),
  });
  return true;
}

function setRecordingForCall(callId, { recordingSid, recordingUrl } = {}) {
  const key = getKey(callId);
  if (!key) return;

  const prev = RECORDINGS.get(key) || {};
  const next = {
    recordingSid: recordingSid ?? prev.recordingSid ?? null,
    recordingUrl: recordingUrl ?? prev.recordingUrl ?? null,
    startRequested: prev.startRequested === true || !!recordingSid || !!recordingUrl,
    updatedAt: Date.now(),
  };
  RECORDINGS.set(key, next);
}

function getRecordingForCall(callId) {
  const key = getKey(callId);
  if (!key) return { recordingSid: null, recordingUrl: null, startRequested: false };
  const rec = RECORDINGS.get(key) || {};
  return {
    recordingSid: rec.recordingSid ?? null,
    recordingUrl: rec.recordingUrl ?? null,
    startRequested: rec.startRequested === true,
  };
}

async function waitForRecording(callId, timeoutMs = 12000) {
  const key = getKey(callId);
  if (!key) return { recordingSid: null, recordingUrl: null, startRequested: false };

  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const rec = getRecordingForCall(key);
    if (rec.recordingUrl) return rec;
    await new Promise((r) => setTimeout(r, 250));
  }
  return getRecordingForCall(key);
}

module.exports = {
  markRecordingStartRequested,
  setRecordingForCall,
  getRecordingForCall,
  waitForRecording,
};
