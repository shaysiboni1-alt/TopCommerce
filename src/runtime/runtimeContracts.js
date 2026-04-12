"use strict";

function safeStr(value) {
  return value === undefined || value === null ? "" : String(value).trim();
}

function nowIso() {
  return new Date().toISOString();
}

function createTranscriptTurn(input = {}) {
  const role = safeStr(input.role || input.who).toLowerCase() || "system";
  const text = safeStr(input.text || input.finalText || input.rawText);
  return {
    role,
    text,
    raw_text: safeStr(input.rawText),
    normalized_text: safeStr(input.normalized?.normalized || input.normalized?.raw || input.normalized_text || text),
    at: input.at || nowIso(),
    meaningful: input.meaningful !== false && Boolean(text),
  };
}

function createCallStateSeed(meta = {}) {
  return {
    callSid: safeStr(meta.callSid) || null,
    streamSid: safeStr(meta.streamSid) || null,
    callerId: safeStr(meta.caller) || null,
    calledNumber: safeStr(meta.called) || null,
    source: safeStr(meta.source) || null,
    startedAt: meta.started_at || nowIso(),
    endedAt: null,
    twilioStatus: "in-progress",
    knownCaller: Boolean(meta.caller_profile && (meta.caller_profile.display_name || meta.caller_profile.name)),
    storedCallerName: safeStr(meta.caller_profile?.display_name || meta.caller_profile?.name) || null,
    capturedCallerName: null,
    callbackNumber: null,
    callbackNumberSource: null,
    subject: null,
    subjectSource: null,
    notes: null,
    intent: null,
    language: safeStr(meta.language_locked || "he") || "he",
    lastMeaningfulUserUtterance: null,
    recordingUrlPublic: null,
    recordingProvider: null,
    assistantSpeaking: false,
    interruptionState: "idle",
    closingInitiated: false,
    finalized: false,
    finalBusinessStatus: null,
    finalReason: null,
    webhookSent: {
      call_log: false,
      complete: false,
      abandoned: false,
      whatsapp: false,
    },
  };
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

module.exports = {
  safeStr,
  nowIso,
  clone,
  createTranscriptTurn,
  createCallStateSeed,
};
