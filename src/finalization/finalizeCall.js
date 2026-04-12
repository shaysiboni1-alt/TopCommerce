"use strict";

const { env } = require("../config/env");
const { logger } = require("../utils/logger");
const { recordFinalizationEvent } = require("../debug/debugLogger");
const { DEBUG_EVENT_TYPES } = require("../debug/debugEventTypes");
const { executeFinalization } = require("./finalizationOrchestrator");

async function finalizeCall(snapshot, ssot) {
  const settings = {
    CALL_LOG_WEBHOOK_ENABLED: env.CALL_LOG_WEBHOOK_ENABLED,
    CALL_LOG_AT_END: env.CALL_LOG_AT_END,
    CALL_LOG_WEBHOOK_URL: env.CALL_LOG_WEBHOOK_URL,
    COMPLETE_WEBHOOK_ENABLED: env.COMPLETE_WEBHOOK_ENABLED,
    FINAL_WEBHOOK_URL: env.FINAL_WEBHOOK_URL,
    WHATSAPP_SUMMARY_WEBHOOK_ENABLED: env.WHATSAPP_SUMMARY_WEBHOOK_ENABLED,
    WHATSAPP_SUMMARY_WEBHOOK_URL: env.WHATSAPP_SUMMARY_WEBHOOK_URL,
    ABANDONED_WEBHOOK_ENABLED: env.ABANDONED_WEBHOOK_ENABLED,
    ABANDONED_WEBHOOK_URL: env.ABANDONED_WEBHOOK_URL,
    SUBJECT_MIN_WORDS: env.SUBJECT_MIN_WORDS,
    MIN_CALL_DURATION_FOR_FINAL: env.MIN_CALL_DURATION_FOR_FINAL,
    MIN_UTTERANCES_FOR_FINAL: env.MIN_UTTERANCES_FOR_FINAL,
    ...((ssot && ssot.settings) || {}),
  };

  const result = await executeFinalization({ snapshot, settings });
  logger.info("FINALIZE_DECISION", {
    callSid: snapshot?.call?.callSid || null,
    twilio_call_status: snapshot?.call?.twilio_call_status || null,
    decision: result?.decision?.business_status,
    reason: result?.decision?.reason,
    full_name: result?.decision?.full_name,
    callback_number: result?.decision?.callback_number,
    subject: result?.decision?.subject,
  });

  recordFinalizationEvent({
    callSid: snapshot?.call?.callSid || null,
    source: "finalizeCall",
    type: DEBUG_EVENT_TYPES.FINALIZATION_COMPLETED,
    level: "debug",
    data: {
      phase: "decision_derived",
      twilio_call_status: snapshot?.call?.twilio_call_status || null,
      final_status: result?.decision?.business_status || null,
      final_reason: result?.decision?.reason || null,
    },
  });

  return result;
}

module.exports = { finalizeCall };
