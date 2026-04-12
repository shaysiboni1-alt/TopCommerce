"use strict";

const { parseLeadPostcall } = require("./postcallLeadParser");
const { upsertCallerProfile } = require("../memory/callerMemory");
const { finalizeCall } = require("../finalization/finalizeCall");
const { logger } = require("../utils/logger");
const { waitForRecording } = require("../utils/recordingRegistry");
const { publicRecordingUrl } = require("../utils/twilioRecordings");
const { normalizePhone } = require("../blocklist/blockedNumberMatcher");
const { normalizeUtterance } = require("../logic/hebrewNlp");
const { recordFinalizationEvent } = require("../debug/debugLogger");
const { DEBUG_EVENT_TYPES } = require("../debug/debugEventTypes");

function safe(v) {
  return typeof v === "string" ? v.trim() : "";
}

function cleanText(v) {
  const text = safe(v);
  if (!text) return "";
  const nlp = normalizeUtterance(text);
  return safe(nlp.normalized || nlp.raw || text);
}

function chooseBestCallback(...values) {
  for (const v of values) {
    const n = normalizePhone(safe(v));
    if (n && n.length >= 9) return n;
  }
  return "";
}

function normalizeTurns(conversationLog) {
  const rows = Array.isArray(conversationLog) ? conversationLog : [];
  return rows
    .map((r) => ({ role: String(r?.role || "").toLowerCase(), text: cleanText(r?.text) }))
    .filter((r) => r.text);
}

function buildTranscript(turns) {
  return turns.map((r) => `${r.role.toUpperCase()}: ${r.text}`).join("\n");
}

function looksLikeCallbackRequest(text) {
  const value = cleanText(text).toLowerCase();
  if (!value) return false;
  return /(לחזור|תחזור|תחזרו|חזרה|שיחזרו|שתחזור|שיחזור)/u.test(value);
}

function mentionsBusiness(text) {
  const value = cleanText(text);
  if (!value) return false;
  return /(טופ\s*קומרס|טופקומרס)/u.test(value);
}

function deriveFallbackSubject({ conversationLog, parsed, call }) {
  const rows = Array.isArray(conversationLog) ? conversationLog : [];
  const mergedUserText = rows.filter((r) => r.role === "user").map((r) => cleanText(r.text)).filter(Boolean).join(" ");
  const notes = cleanText(parsed?.notes || call?.notes || "");
  const summary = cleanText(parsed?.parsing_summary || parsed?.summary || call?.summary || "");
  const intent = cleanText(parsed?.intent || call?.intent || "").toLowerCase();
  const corpus = [mergedUserText, notes, summary].filter(Boolean).join(" ");

  if (looksLikeCallbackRequest(corpus) || intent === "callback_request") {
    return "בקשה לחזרה";
  }

  if (intent === "leave_message") {
    return "השארת הודעה";
  }

  if (intent === "complaint") {
    return "פניית שירות";
  }

  if (intent === "product_interest" || intent === "price_question" || mentionsBusiness(corpus)) {
    return "התעניינות במוצר";
  }

  return "";
}

async function finalizePipeline({ snapshot, ssot }) {
  try {
    const call = snapshot?.call || {};

    recordFinalizationEvent({
      callSid: call.callSid || null,
      source: "finalizePipeline",
      type: DEBUG_EVENT_TYPES.FINALIZATION_REQUESTED,
      level: "debug",
      data: {
        phase: "pipeline_start",
        twilio_call_status: call.twilio_call_status || null,
      },
    });

    const conversationLog = normalizeTurns(snapshot?.conversationLog || call?.conversationLog || []);
    snapshot.conversationLog = conversationLog;
    call.conversationLog = conversationLog;
    call.turn_count = conversationLog.length;
    call.meaningful_user_turn_count = conversationLog.filter((t) => t.role === "user" && t.text.length >= 2).length;
    if (!call.last_meaningful_user_utterance) {
      const lastUser = [...conversationLog].reverse().find((t) => t.role === "user" && t.text.length >= 2);
      call.last_meaningful_user_utterance = lastUser?.text || null;
    }
    snapshot.call = call;

    const transcript = buildTranscript(conversationLog);
    if (!call.caller_profile && snapshot?.caller_profile) call.caller_profile = snapshot.caller_profile;

    const known = {
      full_name: cleanText(call.known_full_name || call.caller_profile?.display_name || snapshot?.caller_profile?.display_name || null) || null,
      callback_to_number: chooseBestCallback(call.callback_number, call.caller, call.caller_raw),
    };

    let parsed = {};
    if (transcript) {
      try {
        parsed = await parseLeadPostcall({ transcriptText: transcript, turns: conversationLog, ssot, known });
      } catch (err) {
        logger.warn("Postcall lead parsing failed", { callSid: call.callSid, error: String(err?.message || err) });

        recordFinalizationEvent({
          callSid: call.callSid || null,
          source: "finalizePipeline",
          type: DEBUG_EVENT_TYPES.FINALIZATION_FAILED,
          level: "warn",
          data: {
            phase: "postcall_parser",
            error: String(err?.message || err),
          },
        });
      }
    }

    const parsedCallback = chooseBestCallback(parsed?.callback_to_number);
    const knownCallback = chooseBestCallback(known.callback_to_number);
    snapshot.lead = {
      full_name: known.full_name || cleanText(parsed?.full_name) || null,
      callback_number: knownCallback || parsedCallback || null,
      subject: cleanText(parsed?.subject) || deriveFallbackSubject({ conversationLog, parsed, call }) || null,
      notes: cleanText(parsed?.notes) || null,
      intent: cleanText(parsed?.intent) || null,
      parsing_summary: cleanText(parsed?.parsing_summary || parsed?.summary) || null,
      brand: cleanText(parsed?.brand) || null,
      model: cleanText(parsed?.model) || null,
    };
    if (!snapshot.lead.callback_number && knownCallback) snapshot.lead.callback_number = knownCallback;

    try {
      const rec = await waitForRecording(call.callSid, 12000);
      if (rec?.recordingUrl || rec?.recordingSid) {
        call.recording_provider = "Twilio";
        call.recording_sid = rec.recordingSid || null;
        call.recording_url_public = rec.recordingUrl || publicRecordingUrl(rec.recordingSid) || null;
      }
    } catch (err) {
      logger.warn("Recording wait failed", { callSid: call.callSid, error: String(err?.message || err) });

      recordFinalizationEvent({
        callSid: call.callSid || null,
        source: "finalizePipeline",
        type: DEBUG_EVENT_TYPES.FINALIZATION_FAILED,
        level: "warn",
        data: {
          phase: "recording_wait",
          error: String(err?.message || err),
        },
      });
    }

    if (!call.full_name_source && snapshot.lead.full_name) {
      call.full_name_source = snapshot.lead.full_name === known.full_name ? (call.caller_profile?.display_name ? "db" : "memory") : "postcall_parser";
    }
    if (!call.callback_number_source && snapshot.lead.callback_number) {
      call.callback_number_source = snapshot.lead.callback_number === known.callback_to_number ? "caller_id" : "postcall_parser";
    }
    if (knownCallback && (!snapshot.lead.callback_number || snapshot.lead.callback_number.length < knownCallback.length)) {
      snapshot.lead.callback_number = knownCallback;
      call.callback_number = knownCallback;
      call.callback_number_source = "caller_id";
    }
    if (!call.subject_source && snapshot.lead.subject) {
      call.subject_source = "postcall_parser";
    }

    const result = await finalizeCall(snapshot, ssot);

    try {
      if (snapshot.lead.full_name && (call.caller || call.caller_raw) && !known.full_name) {
        await upsertCallerProfile(call.caller || call.caller_raw, {
          display_name: snapshot.lead.full_name,
          meta_patch: {
            last_subject: snapshot.lead.subject || null,
            last_call_sid: call.callSid || null,
          },
        });
      }
    } catch (err) {
      logger.warn("Caller memory update failed", { callSid: call.callSid, error: String(err?.message || err) });

      recordFinalizationEvent({
        callSid: call.callSid || null,
        source: "finalizePipeline",
        type: DEBUG_EVENT_TYPES.FINALIZATION_FAILED,
        level: "warn",
        data: {
          phase: "caller_memory_update",
          error: String(err?.message || err),
        },
      });
    }

    recordFinalizationEvent({
      callSid: call.callSid || null,
      source: "finalizePipeline",
      type: DEBUG_EVENT_TYPES.FINALIZATION_COMPLETED,
      level: "debug",
      data: {
        phase: "pipeline_complete",
        final_status: result?.decision?.business_status || null,
        final_reason: result?.decision?.reason || null,
      },
    });

    return { status: "ok", event: result.decision.business_status, decision: result.decision, webhooks: result.webhookResults };
  } catch (err) {
    logger.warn("finalizePipeline error", { error: String(err?.message || err) });

    recordFinalizationEvent({
      callSid: snapshot?.call?.callSid || null,
      source: "finalizePipeline",
      type: DEBUG_EVENT_TYPES.FINALIZATION_FAILED,
      level: "warn",
      data: {
        phase: "pipeline_exception",
        error: String(err?.message || err),
      },
    });

    return { status: "error", event: "SYSTEM_FAILURE", error: String(err?.message || err) };
  }
}

module.exports = { finalizePipeline };
