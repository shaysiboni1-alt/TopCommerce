"use strict";

const { normalizePhone } = require("../blocklist/blockedNumberMatcher");

function safe(value) {
  return typeof value === "string" ? value.trim() : "";
}

function wordCount(text) {
  const value = safe(text);
  return value ? value.split(/\s+/).filter(Boolean).length : 0;
}

function hasMeaningfulText(text) {
  const value = safe(text);
  if (!value) return false;
  if (/^(כן|לא|הלו|שלום|רגע|טוב|אוקיי|אוקי|בסדר)$/u.test(value)) return false;
  return value.length >= 2;
}

function chooseBestCallback(options = {}) {
  const values = Array.isArray(options.values) ? options.values : [];
  const allowCallerId = options.allowCallerId !== false;
  const sources = Array.isArray(options.sources) ? options.sources : [];

  for (let index = 0; index < values.length; index += 1) {
    if (!allowCallerId && sources[index] === "caller_id") continue;
    const normalized = normalizePhone(values[index]);
    if (normalized && normalized.length >= 9) {
      return {
        value: normalized,
        source: sources[index] || null,
      };
    }
  }

  return { value: "", source: null };
}

function buildSummary(fullName, subject, notes, parsingSummary) {
  const preferred = safe(parsingSummary);
  if (preferred) return preferred;
  if (fullName && subject) return `לקוח בשם ${fullName} פנה בנושא ${subject}.`;
  if (fullName && notes) return `לקוח בשם ${fullName} השאיר הודעה: ${notes}.`;
  if (fullName) return `לקוח בשם ${fullName} השאיר פרטי חזרה.`;
  if (subject) return `התקבלה פנייה בנושא ${subject}.`;
  return "השיחה הסתיימה ללא פנייה מלאה.";
}

function deriveDecision(snapshot, settings = {}) {
  const call = snapshot?.call || {};
  const lead = snapshot?.lead || {};
  const rootCallerProfile = snapshot?.caller_profile || null;
  const twilioStatus = safe(call.twilio_call_status).toLowerCase();
  const withholdCallerId = Boolean(call.caller_withheld);
  const explicitName = safe(lead.full_name || call.known_full_name || call.caller_profile?.display_name || rootCallerProfile?.display_name);
  const callbackChoice = chooseBestCallback({
    values: [lead.callback_number, call.callback_number, call.caller, call.caller_raw],
    sources: [lead.callback_number ? "lead" : null, call.callback_number_source || (call.callback_number ? "runtime" : null), "caller_id", "caller_id"],
    allowCallerId: !withholdCallerId,
  });

  const subject = safe(lead.subject || call.subject);
  const notes = safe(lead.notes || call.notes);
  const intent = safe(lead.intent || call.intent) || "other";
  const meaningfulTurns = Number(call.meaningful_user_turn_count || 0);
  const durationSeconds = Number(call.duration_seconds || 0);
  const minDuration = Math.max(0, Number(settings.MIN_CALL_DURATION_FOR_FINAL || 0));
  const minTurns = Math.max(0, Number(settings.MIN_UTTERANCES_FOR_FINAL || 0));
  const minSubjectWords = Math.max(1, Number(settings.SUBJECT_MIN_WORDS || 3));
  const hadMeaningfulInteraction = Boolean(
    meaningfulTurns > 0 || hasMeaningfulText(call.last_meaningful_user_utterance) || hasMeaningfulText(subject) || hasMeaningfulText(notes)
  );

  const base = {
    full_name: explicitName || null,
    callback_number: callbackChoice.value || null,
    subject: subject || null,
    notes: notes || null,
    intent: intent || null,
    summary: buildSummary(explicitName, subject, notes, lead.parsing_summary || lead.summary),
    name_source: call.full_name_source || (rootCallerProfile?.display_name ? "db" : null),
    callback_number_source: call.callback_number_source || callbackChoice.source || null,
    subject_source: call.subject_source || null,
    had_meaningful_interaction: hadMeaningfulInteraction,
    last_meaningful_user_utterance: call.last_meaningful_user_utterance || null,
    is_returning_caller: Boolean(call.caller_profile?.display_name || rootCallerProfile?.display_name),
    known_from_db: Boolean(call.caller_profile?.display_name || rootCallerProfile?.display_name),
    next_action: callbackChoice.value ? "return_call" : "review_message",
    priority: subject ? "normal" : "low",
    recording_url_public: call.recording_url_public || null,
    recording_provider: call.recording_provider || null,
  };

  if (call.business_status === "BLOCKED") {
    return { ...base, event_type: "BLOCKED", business_status: "BLOCKED", reason: call.blocked_reason || "blocked_callers_ssot" };
  }

  if (["no-answer", "busy", "failed", "canceled"].includes(twilioStatus)) {
    return { ...base, event_type: "NO_ANSWER", business_status: "NO_ANSWER", reason: twilioStatus || "no_answer" };
  }

  const hasName = Boolean(explicitName);
  const hasPhone = Boolean(callbackChoice.value);
  const meetsTwilioRule = twilioStatus === "completed";
  const meetsThresholds = durationSeconds >= minDuration && meaningfulTurns >= minTurns;
  const subjectOkay = !subject || wordCount(subject) >= minSubjectWords || hasMeaningfulText(notes);

  const canComplete = meetsTwilioRule && hasName && hasPhone && meetsThresholds && subjectOkay;
  if (canComplete) {
    return {
      ...base,
      event_type: "COMPLETE",
      business_status: "COMPLETE",
      reason: subject ? "complete_full_lead" : "complete_without_subject",
      next_action: "return_call",
      priority: subject ? "normal" : "low",
    };
  }

  let abandonedReason = "ended_before_complete";
  if (!meetsTwilioRule) abandonedReason = twilioStatus || "ended_before_complete";
  else if (!hasName) abandonedReason = "missing_name";
  else if (!hasPhone) abandonedReason = withholdCallerId ? "missing_explicit_callback_number" : "missing_callback_number";
  else if (!meetsThresholds) abandonedReason = meaningfulTurns < minTurns ? "insufficient_user_turns" : "insufficient_duration";
  else if (!subjectOkay) abandonedReason = "subject_too_short";

  return { ...base, event_type: "ABANDONED", business_status: "ABANDONED", reason: abandonedReason };
}

module.exports = { deriveDecision };
