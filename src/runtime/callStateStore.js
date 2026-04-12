"use strict";

const { clone, createCallStateSeed, safeStr } = require("./runtimeContracts");

class CallStateStore {
  constructor(meta = {}) {
    this.state = createCallStateSeed(meta);
  }

  update(patch = {}) {
    if (!patch || typeof patch !== "object") return this.snapshot();
    this.state = {
      ...this.state,
      ...patch,
      webhookSent: {
        ...(this.state.webhookSent || {}),
        ...((patch && patch.webhookSent) || {}),
      },
    };
    return this.snapshot();
  }

  markAssistantSpeaking(active) {
    this.state.assistantSpeaking = Boolean(active);
    return this.snapshot();
  }

  markInterruption(state) {
    this.state.interruptionState = safeStr(state) || "idle";
    return this.snapshot();
  }

  markClosingInitiated() {
    this.state.closingInitiated = true;
    return this.snapshot();
  }

  setFinalization(decision = {}) {
    this.state.finalized = true;
    this.state.finalBusinessStatus = safeStr(decision.business_status) || null;
    this.state.finalReason = safeStr(decision.reason) || null;
    return this.snapshot();
  }

  noteWebhook(kind, sent = true) {
    this.state.webhookSent = {
      ...(this.state.webhookSent || {}),
      [kind]: Boolean(sent),
    };
    return this.snapshot();
  }

  snapshot() {
    return clone(this.state);
  }
}

module.exports = { CallStateStore };
