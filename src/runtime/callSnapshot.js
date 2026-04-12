"use strict";

// Canonical call snapshot scaffolding
// Pure structure + pure mutators only
// No runtime wiring

function createInitialSnapshot(meta) {
  const input = meta && typeof meta === "object" ? meta : {};
  const now = new Date().toISOString();

  return {
    call: {
      callSid: input.callSid || null,
      streamSid: input.streamSid || null,
      caller: input.caller || null,
      called: input.called || null,
      started_at: input.started_at || now,
      ended_at: input.ended_at || null,
      twilio_call_status: input.twilio_call_status || null,
      detected_language: input.detected_language || "he",
      language_locked: typeof input.language_locked === "boolean" ? input.language_locked : false,
      caller_name: input.caller_name || null,
      callback_number: input.callback_number || null,
      callback_number_source: input.callback_number_source || null,
      subject: input.subject || null,
      notes: input.notes || null,
      intent: input.intent || null,
      summary: input.summary || null,
      returning_caller: typeof input.returning_caller === "boolean" ? input.returning_caller : false,
      known_caller: typeof input.known_caller === "boolean" ? input.known_caller : false,
      last_meaningful_user_utterance: input.last_meaningful_user_utterance || null,
      meaningful_interaction: typeof input.meaningful_interaction === "boolean" ? input.meaningful_interaction : false,
      recording_url_public: input.recording_url_public || null,
      recording_provider: input.recording_provider || null,
      final_status: input.final_status || null,
      final_reason: input.final_reason || null,
    },
    conversationLog: Array.isArray(input.conversationLog) ? input.conversationLog.slice() : [],
    lead: {
      full_name: input.full_name || null,
      callback_number: input.lead_callback_number || input.callback_number || null,
      subject: input.lead_subject || input.subject || null,
      notes: input.lead_notes || input.notes || null,
      intent: input.lead_intent || input.intent || null,
      summary: input.lead_summary || input.summary || null,
    },
  };
}

function setCallFields(snapshot, patch) {
  const safePatch = patch && typeof patch === "object" ? patch : {};
  return {
    ...(snapshot || {}),
    call: {
      ...(((snapshot || {}).call) || {}),
      ...safePatch,
    },
  };
}

function setLeadFields(snapshot, patch) {
  const safePatch = patch && typeof patch === "object" ? patch : {};
  return {
    ...(snapshot || {}),
    lead: {
      ...(((snapshot || {}).lead) || {}),
      ...safePatch,
    },
  };
}

function appendConversationTurn(snapshot, turn) {
  const current = snapshot || createInitialSnapshot();
  const nextLog = Array.isArray(current.conversationLog) ? current.conversationLog.slice() : [];
  nextLog.push(turn);
  return {
    ...current,
    conversationLog: nextLog,
  };
}

function setCallEnded(snapshot, endedAt) {
  return setCallFields(snapshot, {
    ended_at: endedAt || new Date().toISOString(),
  });
}

function setTwilioCallStatus(snapshot, twilioStatus) {
  return setCallFields(snapshot, {
    twilio_call_status: twilioStatus || null,
  });
}

function setDetectedLanguage(snapshot, language) {
  return setCallFields(snapshot, {
    detected_language: language || null,
  });
}

function lockLanguage(snapshot, language) {
  return setCallFields(snapshot, {
    detected_language: language || null,
    language_locked: true,
  });
}

function setCallerProfile(snapshot, profile) {
  const safeProfile = profile && typeof profile === "object" ? profile : {};
  return setCallFields(snapshot, {
    returning_caller:
      typeof safeProfile.returning_caller === "boolean" ? safeProfile.returning_caller : false,
    known_caller: typeof safeProfile.known_caller === "boolean" ? safeProfile.known_caller : false,
    caller_name: safeProfile.caller_name || null,
  });
}

function setCallerName(snapshot, callerName) {
  const next = setCallFields(snapshot, {
    caller_name: callerName || null,
  });

  return setLeadFields(next, {
    full_name: callerName || null,
  });
}

function setCallbackNumber(snapshot, callbackNumber, source) {
  const next = setCallFields(snapshot, {
    callback_number: callbackNumber || null,
    callback_number_source: source || null,
  });

  return setLeadFields(next, {
    callback_number: callbackNumber || null,
  });
}

function setSubject(snapshot, subject) {
  const next = setCallFields(snapshot, {
    subject: subject || null,
  });

  return setLeadFields(next, {
    subject: subject || null,
  });
}

function setNotes(snapshot, notes) {
  const next = setCallFields(snapshot, {
    notes: notes || null,
  });

  return setLeadFields(next, {
    notes: notes || null,
  });
}

function setIntent(snapshot, intent) {
  const next = setCallFields(snapshot, {
    intent: intent || null,
  });

  return setLeadFields(next, {
    intent: intent || null,
  });
}

function setSummary(snapshot, summary) {
  const next = setCallFields(snapshot, {
    summary: summary || null,
  });

  return setLeadFields(next, {
    summary: summary || null,
  });
}

function setLastMeaningfulUserUtterance(snapshot, utterance) {
  return setCallFields(snapshot, {
    last_meaningful_user_utterance: utterance || null,
    meaningful_interaction: utterance ? true : (((snapshot || {}).call || {}).meaningful_interaction || false),
  });
}

function setRecording(snapshot, recording) {
  const safeRecording = recording && typeof recording === "object" ? recording : {};
  return setCallFields(snapshot, {
    recording_url_public: safeRecording.recording_url_public || safeRecording.url || null,
    recording_provider: safeRecording.recording_provider || safeRecording.provider || null,
  });
}

function setFinalDisposition(snapshot, finalStatus, finalReason) {
  return setCallFields(snapshot, {
    final_status: finalStatus || null,
    final_reason: finalReason || null,
  });
}

module.exports = {
  createInitialSnapshot,
  setCallFields,
  setLeadFields,
  appendConversationTurn,
  setCallEnded,
  setTwilioCallStatus,
  setDetectedLanguage,
  lockLanguage,
  setCallerProfile,
  setCallerName,
  setCallbackNumber,
  setSubject,
  setNotes,
  setIntent,
  setSummary,
  setLastMeaningfulUserUtterance,
  setRecording,
  setFinalDisposition,
};
