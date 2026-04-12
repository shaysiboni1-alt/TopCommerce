"use strict";

// Finalize-once helper (scaffolding only)
// No runtime wiring

const finalizedCalls = new Map();

function tryAcquireFinalize(callSid) {
  const id = String(callSid || "").trim();
  if (!id) return false;
  if (finalizedCalls.has(id)) return false;

  finalizedCalls.set(id, {
    callSid: id,
    acquired_at: Date.now(),
  });

  return true;
}

function isFinalized(callSid) {
  const id = String(callSid || "").trim();
  if (!id) return false;
  return finalizedCalls.has(id);
}

function releaseFinalize(callSid) {
  const id = String(callSid || "").trim();
  if (!id) return false;
  return finalizedCalls.delete(id);
}

function getFinalizeInfo(callSid) {
  const id = String(callSid || "").trim();
  if (!id) return null;
  return finalizedCalls.get(id) || null;
}

module.exports = {
  tryAcquireFinalize,
  isFinalized,
  releaseFinalize,
  getFinalizeInfo,
};
