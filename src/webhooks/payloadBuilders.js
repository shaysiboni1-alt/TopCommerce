"use strict";

function safe(v) {
  return v === undefined || v === null ? null : v;
}

function safeStr(v) {
  return v === undefined || v === null ? "" : String(v).trim();
}

function applyTemplate(template, vars = {}) {
  const s = safeStr(template);
  return s.replace(/\{([A-Za-z0-9_]+)\}/g, (_, rawKey) => {
    const key = String(rawKey || "");
    return vars[key] ?? vars[key.toUpperCase()] ?? vars[key.toLowerCase()] ?? "";
  }).replace(/\s{2,}/g, " ").trim();
}

function buildCorePayload(snapshot, decision, eventTypeOverride) {
  const call = snapshot?.call || {};
  return {
    event_type: eventTypeOverride || decision.event_type,
    business_status: decision.business_status,
    classification_reason: decision.reason || null,
    final_reason: decision.reason || null,
    final_business_status: decision.business_status || null,
    call_sid: call.callSid || null,
    stream_sid: call.streamSid || null,
    twilio_call_status: call.twilio_call_status || null,
    from: call.caller || call.caller_raw || null,
    to: call.called || null,
    caller_id: call.caller || call.caller_raw || null,
    called_number: call.called || null,
    duration_seconds: safe(call.duration_seconds),
    started_at: call.started_at || null,
    ended_at: call.ended_at || null,
    recording_url_public: decision.recording_url_public || null,
    recording_provider: decision.recording_provider || null,
    has_recording: Boolean(decision.recording_url_public),
    language: call.language_locked || null,
    source: call.source || null,
    caller_name: decision.full_name || null,
    callback_number: decision.callback_number || null,
    subject: decision.subject || null,
    notes: decision.notes || null,
    intent: decision.intent || null,
    summary: decision.summary || null,
    had_meaningful_interaction: Boolean(decision.had_meaningful_interaction),
    last_meaningful_user_utterance: decision.last_meaningful_user_utterance || null,
    is_returning_caller: Boolean(decision.is_returning_caller),
    known_from_db: Boolean(decision.known_from_db),
  };
}

function buildCallLogPayload(snapshot, decision) {
  const call = snapshot?.call || {};
  return {
    ...buildCorePayload(snapshot, decision, "CALL_LOG"),
    final_decision: decision.business_status,
    next_action: decision.next_action || null,
    turn_count: call.turn_count || 0,
    meaningful_user_turn_count: call.meaningful_user_turn_count || 0,
    silence_count: call.silence_count || 0,
    barge_in_count: call.barge_in_count || 0,
  };
}

function buildCompletePayload(snapshot, decision) {
  return {
    ...buildCorePayload(snapshot, decision),
    name_source: decision.name_source || null,
    callback_number_source: decision.callback_number_source || null,
    subject_source: decision.subject_source || null,
    next_action: decision.next_action || null,
  };
}

function buildAbandonedPayload(snapshot, decision) {
  return {
    ...buildCorePayload(snapshot, decision),
    abandoned_reason: decision.reason || null,
  };
}

function buildWhatsAppPayload(snapshot, decision, settings = {}) {
  const topic = safeStr(decision.subject || decision.intent || decision.summary || "פנייה כללית");
  const template = safeStr(settings.WHATSAPP_SUMMARY_TEMPLATE);
  const whatsappSummaryText = template
    ? applyTemplate(template, { topic, TOPIC: topic })
    : null;

  return {
    ...buildCorePayload(snapshot, decision, "WHATSAPP_SUMMARY"),
    next_action: decision.next_action || null,
    priority: decision.priority || null,
    whatsapp_summary_text: whatsappSummaryText,
  };
}

module.exports = {
  buildCallLogPayload,
  buildCompletePayload,
  buildAbandonedPayload,
  buildWhatsAppPayload,
};
