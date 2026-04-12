"use strict";

function normalizePhone(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const digits = raw.replace(/\D/g, "");
  if (!digits) return "";
  if (digits.startsWith("972")) return digits;
  if (digits.startsWith("0")) return `972${digits.slice(1)}`;
  return digits;
}

function splitBlockedNumbers(raw) {
  if (Array.isArray(raw)) return raw.map(normalizePhone).filter(Boolean);
  return String(raw || "")
    .split(/[\s,;\n]+/)
    .map(normalizePhone)
    .filter(Boolean);
}

module.exports = { normalizePhone, splitBlockedNumbers };
