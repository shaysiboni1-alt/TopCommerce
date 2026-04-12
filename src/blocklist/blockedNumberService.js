"use strict";

const { getSSOT } = require("../ssot/ssotClient");
const { splitBlockedNumbers, normalizePhone } = require("./blockedNumberMatcher");

function getBlockedCallerSet() {
  const ssot = getSSOT();
  return new Set(splitBlockedNumbers(ssot?.settings?.BLOCKED_CALLERS || ""));
}

function isBlockedCaller(caller) {
  const normalized = normalizePhone(caller);
  if (!normalized) return { blocked: false, normalized: "" };
  const blocked = getBlockedCallerSet().has(normalized);
  return { blocked, normalized, reason: blocked ? "blocked_callers_ssot" : null };
}

module.exports = { getBlockedCallerSet, isBlockedCaller };
