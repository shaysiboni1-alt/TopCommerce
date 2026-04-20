"use strict";

const { ConversationMemory, safeStr } = require("./conversationMemory");
const { LeadManager } = require("./leadManager");
const { TurnManager } = require("./turnManager");
const { SilenceManager } = require("./silenceManager");
const { AudioPolicy } = require("./audioPolicy");
const { SlotManager } = require("./slotManager");
const { recordCallEvent } = require("../debug/debugLogger");
const { DEBUG_EVENT_CATEGORIES } = require("../debug/debugEventTypes");

class ConversationOrchestrator {
  constructor({ env, ssot, meta, callSession, sendImmediateText, onLongSilence }) {
    this.env = env || {};
    this.ssot = ssot || {};
    this.meta = meta || {};
    this.callSession = callSession || null;
    this.sendImmediateText = typeof sendImmediateText === "function" ? sendImmediateText : () => {};
    this.onLongSilence = typeof onLongSilence === "function" ? onLongSilence : () => {};

    this.memory = new ConversationMemory({ meta, ssot });
    this.turnManager = new TurnManager();
    this.leadManager = new LeadManager({ callSession, memory: this.memory, ssot });
    this.audioPolicy = new AudioPolicy({ env, turnManager: this.turnManager, memory: this.memory });
    this.slotManager = (env || {}).SLOT_MANAGER_ENABLED ? new SlotManager() : null;
    this.silenceManager = new SilenceManager({
      env,
      ssot,
      memory: this.memory,
      onPrompt: ({ level, text, context }) => {
        if (!safeStr(text)) return;
        this.sendImmediateText(text, `SILENCE_PROMPT_${level}`);
        this._record("SILENCE_PROMPT_SENT", { level, context, text });
        this._syncSnapshot();
      },
      onLongSilence: ({ text, context, timeoutMs }) => {
        this.memory.noteClosing(true);
        this._record("LONG_SILENCE_HANGUP_TRIGGERED", { context, timeout_ms: timeoutMs, text }, "info");
        this.onLongSilence({ text, context, timeoutMs });
        this._syncSnapshot();
      },
    });

    this._syncSnapshot();
  }

  _record(type, data = {}, level = "debug") {
    recordCallEvent({
      callSid: this.meta?.callSid || this.callSession?.callSid || null,
      streamSid: this.meta?.streamSid || this.callSession?.streamSid || null,
      category: DEBUG_EVENT_CATEGORIES.CONVERSATION,
      type,
      source: "conversationOrchestrator",
      level,
      data,
    });
  }

  _syncSnapshot() {
    if (!this.callSession?.updateSnapshot) return;
    const mem = this.memory.snapshot();
    const lead = this.leadManager.snapshot();
    const turn = this.turnManager.snapshot();
    this.callSession.updateSnapshot((snap) => ({
      ...(snap || {}),
      call: {
        ...(snap?.call || {}),
        orchestrator_stage: mem.stage || null,
        orchestrator_intent: mem.intent || null,
        active_step: mem.activeStep || null,
        turn_count: mem.turns || 0,
        meaningful_user_turn_count: mem.meaningfulUserTurns || 0,
        silence_count: mem.silenceCount || 0,
        barge_in_count: mem.bargeInCount || 0,
        interruption_count: mem.interruptionCount || 0,
        repair_count: mem.repairCount || 0,
        assistant_speaking: !!turn.assistantSpeaking,
        last_user_text: mem.lastUserText || null,
        last_bot_text: mem.lastBotText || null,
        last_question_type: mem.lastQuestionType || null,
        callback_confirmed: !!mem.callbackConfirmed,
        name_recovery_state: lead.nameRecovery || null,
      },
      runtime_state: {
        ...(snap?.runtime_state || {}),
        conversation_memory: mem,
        lead_manager: lead,
        turn_manager: turn,
        slot_manager: this.slotManager ? this.slotManager.snapshot() : undefined,
      },
    }));
  }

  noteUserAudio() {
    this.turnManager.noteUserAudio();
  }

  syncFromCall() {
    this.leadManager.syncFromCall();
    this._syncSnapshot();
  }

  noteTranscript(role, text, normalized, meta = {}) {
    const value = safeStr(text);
    if (!value) return;
    const label = safeStr(meta.immediateLabel || meta.label);
    const isSilencePrompt = /^SILENCE_PROMPT_/u.test(label);
    const isLongSilencePrompt = label === "LONG_SILENCE_FINAL_PROMPT_SENT";

    if (role === "assistant") {
      this.turnManager.noteAssistantTurn();
      this.memory.noteAssistantTurn(value);
      if (!isSilencePrompt && !isLongSilencePrompt) this.silenceManager.arm(Date.now());
    } else {
      this.turnManager.noteUserTurn();
      this.memory.noteUserTurn(value, true);
      this.silenceManager.reset(Date.now());
    }

    const n = normalized && typeof normalized === "object" ? normalized : {};
    if (role === "user") {
      const intent = safeStr(n.intent || n.intent_id);
      const subject = safeStr(n.subject);
      const callbackNumber = safeStr(n.callback_number || n.callback_to_number);
      if (intent) this.noteIntent(intent);
      if (subject) this.leadManager.noteSubject(subject);
      if (callbackNumber) this.leadManager.noteCallback(callbackNumber);
    }

    this.leadManager.syncFromCall();
    this._syncSnapshot();
  }

  noteAssistantPlaybackStart() {
    this.turnManager.noteAssistantPlaybackStart();
    this.silenceManager.stop();
    this._syncSnapshot();
  }

  noteAssistantPlaybackStop(meta = {}) {
    const label = safeStr(meta.outputLabel || meta.label);
    this.turnManager.noteAssistantPlaybackStop();
    if (/^SILENCE_PROMPT_(\d+)$/u.test(label)) {
      const m = label.match(/^SILENCE_PROMPT_(\d+)$/u);
      const level = Number(m?.[1] || 1);
      this.silenceManager.afterAssistantPrompt(level);
    } else if (label === "LONG_SILENCE_FINAL_PROMPT_SENT") {
      this.silenceManager.stop();
    } else if (this.memory.snapshot().closing) {
      this.silenceManager.stop();
    } else {
      this.silenceManager.arm(Date.now());
    }
    this._syncSnapshot();
  }

  noteImmediatePrompt(kind, label = null) {
    if (kind === "name") this.memory.noteAsked("name", label);
    if (kind === "callback") this.memory.noteAsked("callback", label);
    if (kind === "subject") this.memory.noteAsked("subject", label);
    if (kind === "reports_type") this.memory.noteAsked("reports_type", label);
    if (kind === "reports_period") this.memory.noteAsked("reports_period", label);
    if (kind === "reports_for_whom") this.memory.noteAsked("reports_for_whom", label);
    if (kind === "silence") {
      const ctx = this.memory.getSilenceContext();
      if (ctx === "callback") this.memory.setActiveStep("callback");
      else if (ctx === "opening") this.memory.setActiveStep("name");
      else if (ctx === "lead") this.memory.setActiveStep("subject");
    }
    this._syncSnapshot();
  }

  noteName(name, source) {
    this.leadManager.noteName(name, source);
    this._syncSnapshot();
  }

  noteIntent(intent) {
    this.leadManager.noteIntent(intent);
    if (this.env.SLOT_MANAGER_ENABLED && this.slotManager && intent) {
      const schema = (this.ssot?.intents || []).find((r) => r.intent_id === intent);
      if (schema && !this.slotManager.schema) this.slotManager.init(schema);
    }
    this._syncSnapshot();
  }

  noteCallback(number) {
    this.leadManager.noteCallback(number);
    this._syncSnapshot();
  }

  noteCallbackAwaiting(active) {
    this.leadManager.noteCallbackAwaiting(active);
    this._syncSnapshot();
  }

  noteClosing() {
    this.memory.noteClosing(true);
    this.silenceManager.stop();
    this._syncSnapshot();
  }

  noteInterrupt(reason) {
    this.turnManager.registerInterrupt();
    this.memory.noteBargeIn();
    this.silenceManager.reset(Date.now());
    this._record("ORCHESTRATOR_INTERRUPT", { reason }, "info");
    this._syncSnapshot();
  }

  handleNameCaptureRecovery({ userText, lastBotUtterance }) {
    const result = this.leadManager.evaluateNameCaptureRecovery({ userText, lastBotUtterance });
    if (result?.handled) {
      this.memory.noteAsked("name");
      this._record("NAME_CAPTURE_RECOVERY", {
        action: result.action || null,
        candidate: result.candidate || null,
        source_text: safeStr(userText) || null,
      }, "info");
      this._syncSnapshot();
    }
    return result;
  }

  getContextSummary() {
    return this.memory.snapshot();
  }

  getSlotManagerSnapshot() {
    return this.slotManager ? this.slotManager.snapshot() : null;
  }

  getUserFlushDelayMs(baseMs) {
    return this.turnManager.getSuggestedUserFlushMs(baseMs);
  }

  getUserStableGapMs(baseMs) {
    return this.turnManager.getSuggestedStableGapMs(baseMs);
  }

  shouldAllowBargeIn(args) {
    return this.audioPolicy.shouldAllowBargeIn(args);
  }

  getAudioPreprocessOptions() {
    return this.audioPolicy.getPreprocessOptions();
  }
}

module.exports = { ConversationOrchestrator };
