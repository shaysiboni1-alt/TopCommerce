"use strict";

// Safe debug serializers
// Scaffolding only. No runtime wiring.

function safeStr(v) {
  return v === undefined || v === null ? "" : String(v).trim();
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function toPlainError(err) {
  if (!err) return null;

  return {
    name: safeStr(err.name) || "Error",
    message: safeStr(err.message) || String(err),
    code: safeStr(err.code) || null,
  };
}

function trimText(text, maxLen) {
  const limit = Number.isFinite(Number(maxLen)) ? Number(maxLen) : 1000;
  const value = safeStr(text);
  if (value.length <= limit) return value;
  return value.slice(0, limit) + "…";
}

function redactPotentialSecrets(obj) {
  if (!obj || typeof obj !== "object") return obj;

  if (Array.isArray(obj)) {
    return obj.map(redactPotentialSecrets);
  }

  const out = {};
  for (const [key, value] of Object.entries(obj)) {
    const lower = key.toLowerCase();

    if (
      lower.includes("token") ||
      lower.includes("secret") ||
      lower.includes("password") ||
      lower.includes("authorization") ||
      lower.includes("api_key") ||
      lower.includes("apikey")
    ) {
      out[key] = "[REDACTED]";
      continue;
    }

    if (typeof value === "string") {
      out[key] = trimText(value, 2000);
      continue;
    }

    if (value && typeof value === "object") {
      out[key] = redactPotentialSecrets(value);
      continue;
    }

    out[key] = value;
  }

  return out;
}

function serializeSnapshot(snapshot) {
  const safe = snapshot && typeof snapshot === "object" ? clone(snapshot) : {};

  if (safe.call && typeof safe.call === "object") {
    safe.call = redactPotentialSecrets(safe.call);
  }

  if (Array.isArray(safe.conversationLog)) {
    safe.conversationLog = safe.conversationLog.map((item) => {
      const row = item && typeof item === "object" ? clone(item) : {};
      if (typeof row.text === "string") {
        row.text = trimText(row.text, 500);
      }
      return row;
    });
  }

  if (safe.caller_profile && typeof safe.caller_profile === "object") {
    safe.caller_profile = redactPotentialSecrets(safe.caller_profile);
  }

  if (safe.lead && typeof safe.lead === "object") {
    safe.lead = redactPotentialSecrets(safe.lead);
  }

  return safe;
}

function serializeEventData(data) {
  const safe = data && typeof data === "object" ? clone(data) : {};
  return redactPotentialSecrets(safe);
}

function serializeWebhookAttempt(input) {
  const value = input && typeof input === "object" ? input : {};
  return {
    webhook_type: safeStr(value.webhook_type) || null,
    url_key: safeStr(value.url_key) || null,
    attempt: Number.isFinite(Number(value.attempt)) ? Number(value.attempt) : null,
    http_status: Number.isFinite(Number(value.http_status)) ? Number(value.http_status) : null,
    latency_ms: Number.isFinite(Number(value.latency_ms)) ? Number(value.latency_ms) : null,
    error: value.error ? toPlainError(value.error) : null,
  };
}

module.exports = {
  toPlainError,
  trimText,
  redactPotentialSecrets,
  serializeSnapshot,
  serializeEventData,
  serializeWebhookAttempt,
};
