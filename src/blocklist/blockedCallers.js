"use strict";

const { getSSOT } = require("../ssot/ssotClient");
const { env } = require("../config/env");

function normalizeDigits(value) {
  const digits = String(value || "").replace(/\D/g, "");
  if (!digits) return "";
  if (digits.startsWith("972")) return digits;
  if (digits.startsWith("0")) return `972${digits.slice(1)}`;
  return digits;
}

function getBlockedCallers() {
  const ssot = getSSOT();
  const raw = ssot?.settings?.BLOCKED_CALLERS ?? env.BLOCKED_CALLERS ?? "";
  return String(raw || "")
    .split(",")
    .map((item) => normalizeDigits(item))
    .filter(Boolean);
}

function isBlockedCaller(phone) {
  const normalized = normalizeDigits(phone);
  if (!normalized) return { blocked: false, normalized: "", matched: null };
  const blocked = getBlockedCallers();
  const matched = blocked.find((item) => item === normalized) || null;
  return { blocked: !!matched, normalized, matched };
}

module.exports = { getBlockedCallers, isBlockedCaller, normalizeDigits };
