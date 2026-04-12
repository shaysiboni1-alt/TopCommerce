"use strict";

const { env } = require("../config/env");
const { logger } = require("../utils/logger");
const { recordWebhookEvent } = require("../debug/debugLogger");
const { DEBUG_EVENT_TYPES } = require("../debug/debugEventTypes");

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function postJson(url, payload, label, callSid, attempt) {
  const controller = new AbortController();
  const timeoutMs = Number(env.WEBHOOK_TIMEOUT_MS || 10000);
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = Date.now();

  recordWebhookEvent({
    callSid,
    source: "webhookDispatcher",
    type: DEBUG_EVENT_TYPES.WEBHOOK_DISPATCH_ATTEMPT,
    level: "debug",
    data: {
      webhook_type: label,
      url_key: label,
      attempt,
      timeout_ms: timeoutMs,
    },
  });

  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    const text = await resp.text().catch(() => "");
    logger.info("Webhook delivered", { label, status: resp.status, ok: resp.ok });

    const latencyMs = Date.now() - startedAt;

    if (resp.ok) {
      recordWebhookEvent({
        callSid,
        source: "webhookDispatcher",
        type: DEBUG_EVENT_TYPES.WEBHOOK_DISPATCH_SUCCEEDED,
        level: "info",
        data: {
          webhook_type: label,
          url_key: label,
          attempt,
          http_status: resp.status,
          latency_ms: latencyMs,
        },
      });
    } else {
      recordWebhookEvent({
        callSid,
        source: "webhookDispatcher",
        type: DEBUG_EVENT_TYPES.WEBHOOK_DISPATCH_FAILED,
        level: "warn",
        data: {
          webhook_type: label,
          url_key: label,
          attempt,
          http_status: resp.status,
          latency_ms: latencyMs,
        },
      });
    }

    return { ok: resp.ok, status: resp.status, body: text };
  } finally {
    clearTimeout(timeout);
  }
}

async function deliverWebhook(url, payload, label, callSid) {
  if (!url) {
    recordWebhookEvent({
      callSid,
      source: "webhookDispatcher",
      type: DEBUG_EVENT_TYPES.WEBHOOK_DISPATCH_FAILED,
      level: "warn",
      data: {
        webhook_type: label,
        url_key: label,
        attempt: 0,
        error: { message: "missing_url" },
      },
    });
    return { ok: false, reason: "missing_url" };
  }

  const tries = Math.max(1, Number(env.WEBHOOK_RETRY_COUNT || 2) + 1);
  let lastError = null;

  for (let attempt = 1; attempt <= tries; attempt += 1) {
    try {
      const result = await postJson(url, payload, label, callSid, attempt);
      if (result.ok) return { ...result, attempt };
      lastError = new Error(`status_${result.status}`);
    } catch (err) {
      lastError = err;
      logger.warn("Webhook delivery failed", { label, attempt, error: String(err?.message || err) });

      recordWebhookEvent({
        callSid,
        source: "webhookDispatcher",
        type: DEBUG_EVENT_TYPES.WEBHOOK_DISPATCH_FAILED,
        level: "warn",
        data: {
          webhook_type: label,
          url_key: label,
          attempt,
          error: { message: String(err?.message || err) },
        },
      });
    }
    if (attempt < tries) await sleep(300 * attempt);
  }

  return { ok: false, error: String(lastError?.message || lastError || "unknown_webhook_error") };
}

module.exports = { deliverWebhook };
