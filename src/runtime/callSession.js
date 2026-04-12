"use strict";

const { CALL_STATES } = require("./callState");
const { createInitialSnapshot } = require("./callSnapshot");
const {
  recordCallEvent,
  recordStateTransition,
  recordSnapshotCheckpoint,
} = require("../debug/debugLogger");
const { DEBUG_EVENT_CATEGORIES, DEBUG_EVENT_TYPES } = require("../debug/debugEventTypes");

function safeStr(v) {
  return v === undefined || v === null ? "" : String(v).trim();
}

class CallSession {
  constructor(input) {
    const meta = input && typeof input === "object" ? input : {};
    const startedAt = meta.started_at || new Date().toISOString();

    this.callSid = safeStr(meta.callSid);
    this.streamSid = safeStr(meta.streamSid);
    this.state = CALL_STATES.INIT;
    this.createdAt = Date.now();
    this.updatedAt = this.createdAt;

    this.meta = {
      callSid: this.callSid || null,
      streamSid: this.streamSid || null,
      caller: meta.caller || null,
      called: meta.called || null,
      source: meta.source || null,
      caller_profile: meta.caller_profile || null,
      started_at: startedAt,
    };

    const snapshot = createInitialSnapshot({
      callSid: this.callSid || null,
      streamSid: this.streamSid || null,
      caller: meta.caller || null,
      called: meta.called || null,
      started_at: startedAt,
      caller_name:
        (meta.caller_profile && (meta.caller_profile.display_name || meta.caller_profile.name)) || null,
      known_caller: !!(meta.caller_profile && (meta.caller_profile.display_name || meta.caller_profile.name)),
      returning_caller: !!meta.caller_profile,
    });

    const storedCallerName = (meta.caller_profile && (meta.caller_profile.display_name || meta.caller_profile.name)) || null;

    snapshot.call = {
      ...(snapshot.call || {}),
      callSid: this.callSid || null,
      streamSid: this.streamSid || null,
      source: meta.source || "VoiceBot_Blank",
      caller_raw: meta.caller || null,
      caller_withheld: false,
      called: meta.called || null,
      started_at: startedAt,
      ended_at: null,
      recording_sid: "",
      finalized: false,
      caller_profile: meta.caller_profile || null,
      known_full_name: storedCallerName,
      full_name_source: storedCallerName ? "db" : null,
    };

    snapshot.conversationLog = Array.isArray(snapshot.conversationLog)
      ? snapshot.conversationLog
      : [];

    if (meta.caller_profile) {
      snapshot.caller_profile = meta.caller_profile;
    }

    this.snapshot = snapshot;

    this.timeline = {
      call_answered_at: startedAt,
      ws_connected_at: null,
      provider_session_ready_at: null,
      first_opening_sent_at: null,
      first_audio_out_at: null,
      first_user_audio_at: null,
      first_user_stable_utterance_at: null,
      first_bot_response_at: null,
      finalization_started_at: null,
      finalization_completed_at: null,
    };

    this.refs = {
      twilioWs: null,
      geminiSession: null,
    };

    recordCallEvent({
      callSid: this.callSid,
      streamSid: this.streamSid,
      category: DEBUG_EVENT_CATEGORIES.SESSION,
      type: DEBUG_EVENT_TYPES.CALL_SESSION_CREATED,
      source: "callSession",
      level: "info",
      data: {
        started_at: startedAt,
        source: this.meta.source || null,
        caller: this.meta.caller || null,
        called: this.meta.called || null,
        known_caller: !!(meta.caller_profile && (meta.caller_profile.display_name || meta.caller_profile.name)),
        returning_caller: !!meta.caller_profile,
      },
    });
  }

  touch() {
    this.updatedAt = Date.now();
    return this;
  }

  setState(nextState) {
    const prevState = this.state;
    if (nextState) this.state = nextState;
    this.touch();

    if (nextState && prevState !== this.state) {
      recordStateTransition({
        callSid: this.callSid,
        streamSid: this.streamSid,
        source: "callSession",
        from: prevState,
        to: this.state,
      });
    }

    return this;
  }

  getState() {
    return this.state;
  }

  getSnapshot() {
    return this.snapshot;
  }

  getCall() {
    return (this.snapshot && this.snapshot.call) || {};
  }

  getConversationLog() {
    return Array.isArray(this.snapshot && this.snapshot.conversationLog)
      ? this.snapshot.conversationLog
      : [];
  }

  updateSnapshot(updater) {
    const prevSnapshot = this.snapshot;

    if (typeof updater === "function") {
      const next = updater(this.snapshot);
      if (next) this.snapshot = next;
    } else if (updater && typeof updater === "object") {
      this.snapshot = {
        ...(this.snapshot || {}),
        ...updater,
      };
    }

    this.touch();

    if (this.snapshot && this.snapshot !== prevSnapshot) {
      const nextCall = (this.snapshot && this.snapshot.call) || {};
      const prevCall = (prevSnapshot && prevSnapshot.call) || {};
      const nextConversationLog = Array.isArray(this.snapshot && this.snapshot.conversationLog)
        ? this.snapshot.conversationLog
        : [];
      const prevConversationLog = Array.isArray(prevSnapshot && prevSnapshot.conversationLog)
        ? prevSnapshot.conversationLog
        : [];

      recordCallEvent({
        callSid: this.callSid,
        streamSid: this.streamSid,
        category: DEBUG_EVENT_CATEGORIES.SNAPSHOT,
        type: DEBUG_EVENT_TYPES.SNAPSHOT_UPDATED,
        source: "callSession",
        level: "debug",
        data: {
          call_keys: Object.keys(nextCall),
          lead_keys: Object.keys((this.snapshot && this.snapshot.lead) || {}),
          conversation_log_length: nextConversationLog.length,
          conversation_log_delta: nextConversationLog.length - prevConversationLog.length,
          twilio_call_status: nextCall.twilio_call_status || null,
          final_status: nextCall.final_status || null,
          final_reason: nextCall.final_reason || null,
          ended_at: nextCall.ended_at || null,
          started_at: nextCall.started_at || null,
          changed_call_fields: Object.keys(nextCall).filter((key) => prevCall[key] !== nextCall[key]),
        },
      });
    }

    return this.snapshot;
  }

  updateCall(updater) {
    return this.updateSnapshot((snapshot) => {
      const current = snapshot || {};
      const currentCall = current.call || {};
      const nextCall =
        typeof updater === "function"
          ? updater(currentCall, current)
          : {
              ...currentCall,
              ...(updater && typeof updater === "object" ? updater : {}),
            };

      return {
        ...current,
        call: nextCall || currentCall,
      };
    });
  }

  setConversationLog(conversationLog) {
    const nextLog = Array.isArray(conversationLog) ? conversationLog : [];
    return this.updateSnapshot((snapshot) => ({
      ...(snapshot || {}),
      conversationLog: nextLog,
    }));
  }

  appendConversationTurn(turn) {
    return this.updateSnapshot((snapshot) => {
      const current = snapshot || {};
      const currentLog = Array.isArray(current.conversationLog)
        ? current.conversationLog
        : [];
      return {
        ...current,
        conversationLog: currentLog.concat([turn]),
      };
    });
  }

  attachTwilioWs(twilioWs) {
    this.refs.twilioWs = twilioWs || null;
    this.touch();

    recordCallEvent({
      callSid: this.callSid,
      streamSid: this.streamSid,
      category: DEBUG_EVENT_CATEGORIES.SESSION,
      type: DEBUG_EVENT_TYPES.CALL_SESSION_ATTACHED_TWILIO_WS,
      source: "callSession",
      level: "debug",
      data: {
        attached: !!this.refs.twilioWs,
      },
    });

    return this;
  }

  attachGeminiSession(geminiSession) {
    this.refs.geminiSession = geminiSession || null;
    this.touch();

    recordCallEvent({
      callSid: this.callSid,
      streamSid: this.streamSid,
      category: DEBUG_EVENT_CATEGORIES.SESSION,
      type: DEBUG_EVENT_TYPES.CALL_SESSION_ATTACHED_PROVIDER,
      source: "callSession",
      level: "debug",
      data: {
        attached: !!this.refs.geminiSession,
        provider: "gemini",
      },
    });

    return this;
  }

  getTwilioWs() {
    return this.refs.twilioWs || null;
  }

  getGeminiSession() {
    return this.refs.geminiSession || null;
  }

  getMeta() {
    return this.meta;
  }

  markTimeline(name, value) {
    const key = safeStr(name);
    if (!key || !Object.prototype.hasOwnProperty.call(this.timeline || {}, key)) {
      return null;
    }

    if (this.timeline[key]) {
      return this.timeline[key];
    }

    const ts = safeStr(value) || new Date().toISOString();
    this.timeline[key] = ts;
    this.touch();

    recordSnapshotCheckpoint({
      callSid: this.callSid,
      label: `timeline_${key}`,
      snapshot: {
        timeline: {
          ...(this.timeline || {}),
        },
      },
      ts,
    });

    recordCallEvent({
      callSid: this.callSid,
      streamSid: this.streamSid,
      category: DEBUG_EVENT_CATEGORIES.SESSION,
      type: 'TIMELINE_MARKED',
      source: 'callSession',
      level: 'debug',
      ts,
      data: {
        marker: key,
        value: ts,
      },
    });

    return ts;
  }

  getTimeline() {
    return { ...(this.timeline || {}) };
  }

  toJSON() {
    return {
      callSid: this.callSid || null,
      streamSid: this.streamSid || null,
      state: this.state,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
      meta: this.meta,
      timeline: this.timeline,
      snapshot: this.snapshot,
      refs: {
        twilioWsAttached: !!this.refs.twilioWs,
        geminiSessionAttached: !!this.refs.geminiSession,
      },
    };
  }
}

module.exports = {
  CallSession,
};
