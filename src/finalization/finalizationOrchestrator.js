"use strict";

const { deriveDecision } = require("./businessOutcomeRules");
const {
  buildCallLogPayload,
  buildCompletePayload,
  buildAbandonedPayload,
  buildWhatsAppPayload,
} = require("../webhooks/payloadBuilders");
const { deliverWebhook } = require("../webhooks/webhookDispatcher");
const { logger } = require("../utils/logger");

async function maybeDeliver(url, payload, eventType, callSid) {
  if (!url) return { skipped: true, reason: "missing_url" };
  return deliverWebhook(url, payload, eventType, callSid);
}

async function executeFinalization({ snapshot, settings }) {
  const decision = deriveDecision(snapshot, settings);
  const callSid = snapshot?.call?.callSid || null;
  const webhookResults = {};

  if (settings.CALL_LOG_WEBHOOK_ENABLED && settings.CALL_LOG_AT_END && settings.CALL_LOG_WEBHOOK_URL) {
    webhookResults.call_log = await maybeDeliver(
      settings.CALL_LOG_WEBHOOK_URL,
      buildCallLogPayload(snapshot, decision),
      "CALL_LOG",
      callSid
    );
  }

  if (decision.business_status === "COMPLETE") {
    if (settings.COMPLETE_WEBHOOK_ENABLED && settings.FINAL_WEBHOOK_URL) {
      webhookResults.complete = await maybeDeliver(
        settings.FINAL_WEBHOOK_URL,
        buildCompletePayload(snapshot, decision),
        "COMPLETE",
        callSid
      );
    }
    if (settings.WHATSAPP_SUMMARY_WEBHOOK_ENABLED && settings.WHATSAPP_SUMMARY_WEBHOOK_URL) {
      webhookResults.whatsapp = await maybeDeliver(
        settings.WHATSAPP_SUMMARY_WEBHOOK_URL,
        buildWhatsAppPayload(snapshot, decision, settings),
        "WHATSAPP_SUMMARY",
        callSid
      );
    }
  } else if (decision.business_status === "ABANDONED") {
    if (settings.ABANDONED_WEBHOOK_ENABLED && settings.ABANDONED_WEBHOOK_URL) {
      webhookResults.abandoned = await maybeDeliver(
        settings.ABANDONED_WEBHOOK_URL,
        buildAbandonedPayload(snapshot, decision),
        "ABANDONED",
        callSid
      );
    }
  }

  logger.info("FINALIZATION_ORCHESTRATOR_RESULT", {
    callSid,
    final_status: decision.business_status,
    final_reason: decision.reason,
    webhook_keys: Object.keys(webhookResults),
  });

  return { decision, webhookResults };
}

module.exports = { executeFinalization };
