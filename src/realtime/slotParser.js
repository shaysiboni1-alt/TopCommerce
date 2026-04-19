"use strict";

const ALLOWED_SLOT_KEYS = new Set(["name", "intent", "subject", "callback", "customer_type"]);
const SLOT_TAG_RE = /\[SLOT:(\w+)=([^\]\n]{1,80})\]/gu;
const FORBIDDEN_VALUE_RE = /[\[\]\n]/;

function parseSlotTags(text) {
  const raw = String(text || "");
  const slots = {};
  const cleanText = raw.replace(SLOT_TAG_RE, (_match, key, value) => {
    if (ALLOWED_SLOT_KEYS.has(key) && !FORBIDDEN_VALUE_RE.test(value)) {
      slots[key] = value.trim();
    }
    return "";
  }).replace(/\s{2,}/g, " ").trim();
  return { slots, cleanText };
}

function slotValueInRecentBuffer(value, buffer) {
  if (!value || !buffer) return false;
  const v = value.replace(/\s+/gu, "").toLowerCase();
  const b = buffer.replace(/\s+/gu, "").toLowerCase();
  return v.length > 0 && b.includes(v);
}

module.exports = { parseSlotTags, slotValueInRecentBuffer };
