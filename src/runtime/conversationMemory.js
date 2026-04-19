"use strict";

function safeStr(v) {
  return v === undefined || v === null ? "" : String(v).trim();
}

class ConversationMemory {
  constructor({ meta, ssot }) {
    const callerName = safeStr(meta?.caller_profile?.display_name || meta?.caller_profile?.name);
    this.ssot = ssot || {};
    this.state = {
      callerName: callerName || null,
      callerNameSource: callerName ? "db" : null,
      intent: null,
      stage: callerName ? "discover_need" : "collect_name",
      askedFields: {},
      collectedFields: {
        name: !!callerName,
        intent: false,
        subject: false,
        callback: false,
      },
      lastUserText: "",
      lastBotText: "",
      lastMeaningfulUserText: "",
      lastQuestionType: null,
      lastUserAt: 0,
      lastBotAt: 0,
      turns: 0,
      userTurns: 0,
      assistantTurns: 0,
      meaningfulUserTurns: 0,
      silenceCount: 0,
      bargeInCount: 0,
      interruptionCount: 0,
      repairCount: 0,
      callbackConfirmed: false,
      awaitingCallbackConfirmation: false,
      closing: false,
    };
  }

  noteAsked(field) {
    const key = safeStr(field);
    if (!key) return this.snapshot();
    this.state.askedFields[key] = (this.state.askedFields[key] || 0) + 1;
    this.state.lastQuestionType = key;
    return this.snapshot();
  }

  noteUserTurn(text, meaningful = true) {
    const value = safeStr(text);
    if (!value) return this.snapshot();
    this.state.turns += 1;
    this.state.userTurns += 1;
    this.state.lastUserText = value;
    this.state.lastUserAt = Date.now();
    if (meaningful) {
      this.state.meaningfulUserTurns += 1;
      this.state.lastMeaningfulUserText = value;
    }
    return this.snapshot();
  }

  noteAssistantTurn(text) {
    const value = safeStr(text);
    if (!value) return this.snapshot();
    this.state.turns += 1;
    this.state.assistantTurns += 1;
    this.state.lastBotText = value;
    this.state.lastBotAt = Date.now();
    return this.snapshot();
  }

  noteIntent(intent) {
    const value = safeStr(intent);
    if (!value) return this.snapshot();
    const CLASSIFICATION_INTENTS = ["new_customer", "existing_customer", "business_customer", "private_customer"];
    const currentIsClassification = CLASSIFICATION_INTENTS.includes(safeStr(this.state.intent));
    const newIsClassification = CLASSIFICATION_INTENTS.includes(value);
    if (currentIsClassification && !newIsClassification) return this.snapshot();
    this.state.intent = value;
    this.state.collectedFields.intent = true;
    return this.snapshot();
  }

  noteCallerName(name, source = "runtime") {
    const value = safeStr(name);
    if (!value) return this.snapshot();
    this.state.callerName = value;
    this.state.callerNameSource = source;
    this.state.collectedFields.name = true;
    if (this.state.stage === "collect_name") this.state.stage = "discover_need";
    return this.snapshot();
  }

  noteSubject(subject) {
    const value = safeStr(subject);
    if (!value) return this.snapshot();
    this.state.collectedFields.subject = true;
    if (["collect_name", "discover_need"].includes(this.state.stage)) this.state.stage = "clarify_need";
    return this.snapshot();
  }

  noteCallback(value) {
    const hasValue = !!safeStr(value);
    this.state.collectedFields.callback = hasValue;
    if (hasValue) this.state.callbackConfirmed = true;
    return this.snapshot();
  }

  noteCallbackAwaiting(active) {
    this.state.awaitingCallbackConfirmation = !!active;
    return this.snapshot();
  }

  noteBargeIn() {
    this.state.bargeInCount += 1;
    this.state.interruptionCount += 1;
    this.state.repairCount += 1;
    return this.snapshot();
  }

  noteSilence() {
    this.state.silenceCount += 1;
    return this.snapshot();
  }

  noteClosing(active = true) {
    this.state.closing = !!active;
    if (active) this.state.stage = "closing";
    return this.snapshot();
  }

  setStage(stage) {
    const value = safeStr(stage);
    if (!value) return this.snapshot();
    this.state.stage = value;
    return this.snapshot();
  }

  getSilenceContext() {
    if (this.state.closing) return "closing";
    if (!this.state.collectedFields.name) return "opening";
    if (this.state.awaitingCallbackConfirmation || this.state.lastQuestionType === "callback") return "callback";
    if (!this.state.collectedFields.subject) return "lead";
    return "general";
  }

  snapshot() {
    return JSON.parse(JSON.stringify(this.state));
  }
}

module.exports = { ConversationMemory, safeStr };
