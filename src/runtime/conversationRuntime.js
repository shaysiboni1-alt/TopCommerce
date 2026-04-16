"use strict";

const { CallStateStore } = require("./callStateStore");
const { createTranscriptTurn, safeStr } = require("./runtimeContracts");

class ConversationRuntime {
  constructor({ meta, callSession, interruptionManager, turnManager, responseCoordinator }) {
    this.meta = meta || {};
    this.callSession = callSession || null;
    this.interruptionManager = interruptionManager || null;
    this.turnManager = turnManager || null;
    this.responseCoordinator = responseCoordinator || null;
    this.stateStore = new CallStateStore(meta || {});
    this.turns = [];
  }

  bootstrap() {
    if (this.callSession?.updateCall) {
      const state = this.stateStore.snapshot();
      this.callSession.updateCall({
        source: state.source,
        started_at: state.startedAt,
        language_locked: state.language,
        known_full_name: state.storedCallerName || null,
      });
    }
    return this.snapshot();
  }

  attachProvider(provider) {
    this.provider = provider || null;
    if (this.callSession?.attachGeminiSession && provider) this.callSession.attachGeminiSession(provider);
    return this.snapshot();
  }

  onTranscriptTurn(input) {
    const turn = createTranscriptTurn(input);
    if (!turn.text) return null;
    this.turns.push(turn);

    if (turn.role === "user" && turn.meaningful) {
      this.stateStore.update({
        lastMeaningfulUserUtterance: turn.text,
      });
    }

    if (this.callSession?.appendConversationTurn) {
      this.callSession.appendConversationTurn({ role: turn.role, text: turn.text, at: turn.at });
    }

    return turn;
  }

  onAssistantPlayback(active) {
    this.stateStore.markAssistantSpeaking(active);
    if (this.callSession?.updateSnapshot) {
      this.callSession.updateSnapshot((snap) => ({
        ...(snap || {}),
        runtime_state: {
          ...(snap?.runtime_state || {}),
          runtime_assistant_speaking: !!active,
          runtime_turn_state: this.turnManager?.snapshot?.() || null,
          runtime_response_state: this.responseCoordinator?.current?.() || null,
        },
      }));
    }
    return this.snapshot();
  }

  onInterrupt(reason = "barge_in") {
    this.stateStore.markInterruption(reason);
    this.stateStore.markAssistantSpeaking(false);
    if (this.callSession?.updateSnapshot) {
      this.callSession.updateSnapshot((snap) => ({
        ...(snap || {}),
        runtime_state: {
          ...(snap?.runtime_state || {}),
          runtime_interruption_state: safeStr(reason) || "barge_in",
          runtime_assistant_speaking: false,
          runtime_turn_state: this.turnManager?.snapshot?.() || null,
          runtime_response_state: this.responseCoordinator?.current?.() || null,
        },
      }));
    }
    return this.snapshot();
  }

  mergeLeadFields(fields = {}) {
    const patch = {};
    if (safeStr(fields.full_name)) patch.capturedCallerName = safeStr(fields.full_name);
    if (safeStr(fields.callback_number)) patch.callbackNumber = safeStr(fields.callback_number);
    if (safeStr(fields.callback_number_source)) patch.callbackNumberSource = safeStr(fields.callback_number_source);
    if (safeStr(fields.subject)) patch.subject = safeStr(fields.subject);
    if (safeStr(fields.subject_source)) patch.subjectSource = safeStr(fields.subject_source);
    if (safeStr(fields.intent)) patch.intent = safeStr(fields.intent);
    if (safeStr(fields.notes)) patch.notes = safeStr(fields.notes);
    return this.stateStore.update(patch);
  }

  markRecording({ recordingUrlPublic, recordingProvider }) {
    return this.stateStore.update({
      recordingUrlPublic: safeStr(recordingUrlPublic) || null,
      recordingProvider: safeStr(recordingProvider) || null,
    });
  }

  markClosingInitiated() {
    this.stateStore.markClosingInitiated();
    return this.snapshot();
  }

  markTwilioTerminal({ status, endedAt }) {
    return this.stateStore.update({
      twilioStatus: safeStr(status) || this.stateStore.snapshot().twilioStatus,
      endedAt: endedAt || new Date().toISOString(),
    });
  }

  snapshot() {
    return {
      state: this.stateStore.snapshot(),
      turns: this.turns.slice(),
      turnManager: this.turnManager?.snapshot?.() || null,
      activeResponse: this.responseCoordinator?.current?.() || null,
    };
  }
}

module.exports = { ConversationRuntime };
