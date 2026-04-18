"use strict";

const { lastBotAskedForName, sanitizeCandidate } = require("../logic/nameExtractor");
const {
  hasHebrewLetters,
  isAffirmativeUtterance,
  isNegativeUtterance,
} = require("../realtime/sessionUtils");

function safeStr(v) {
  return v === undefined || v === null ? "" : String(v).trim();
}

function collapseSpaces(v) {
  return safeStr(v).replace(/\s+/g, " ").trim();
}

function looksLikeShortDirectNameReply(text) {
  const value = collapseSpaces(text);
  if (!value) return false;
  if (value.length > 24) return false;
  const parts = value.split(/\s+/).filter(Boolean);
  if (parts.length < 1 || parts.length > 3) return false;
  if (/\d/.test(value)) return false;
  return true;
}

class LeadManager {
  constructor({ callSession, memory }) {
    this.callSession = callSession || null;
    this.memory = memory || null;
    this.nameRecovery = {
      awaitingConfirmation: false,
      pendingCandidate: "",
      attempts: 0,
      askSpeakUpCount: 0,
      lastPromptAt: 0,
      lastRawReply: "",
    };
  }

  _getCall() {
    try {
      return this.callSession?.getCall?.() || {};
    } catch {
      return {};
    }
  }

  _buildSpeakUpPrompt() {
    if (this.nameRecovery.askSpeakUpCount <= 0) {
      return "לא שמעתי טוב את השם. אפשר לחזור עליו שוב, קצת יותר חזק וברור?";
    }
    return "עדיין לא שמעתי טוב את השם. תגידו אותו שוב לאט וברור, בבקשה.";
  }

  _buildGenericRepeatPrompt() {
    return "אפשר להגיד שוב את השם בבקשה?";
  }

  _setPendingCandidate(candidate) {
    this.nameRecovery.awaitingConfirmation = !!candidate;
    this.nameRecovery.pendingCandidate = candidate ? collapseSpaces(candidate) : "";
    this.nameRecovery.lastPromptAt = Date.now();
  }

  clearNameRecovery() {
    this.nameRecovery.awaitingConfirmation = false;
    this.nameRecovery.pendingCandidate = "";
    this.nameRecovery.attempts = 0;
    this.nameRecovery.askSpeakUpCount = 0;
    this.nameRecovery.lastPromptAt = 0;
    this.nameRecovery.lastRawReply = "";
    return this.snapshot();
  }

  syncFromCall(callPatch = {}) {
    const call = { ...this._getCall(), ...(callPatch || {}) };
    const fullName = safeStr(call.known_full_name || call.caller_name || call.full_name || call.captured_name);
    const subject = safeStr(call.subject);
    const callbackNumber = safeStr(call.callback_number);
    const intent = safeStr(call.intent);

    if (fullName) {
      this.memory?.noteCallerName(fullName, call.full_name_source || (call.known_full_name ? "db" : "runtime"));
      this.clearNameRecovery();
    }
    if (subject) this.memory?.noteSubject(subject);
    if (callbackNumber) this.memory?.noteCallback(callbackNumber);
    if (intent) this.memory?.noteIntent(intent);

    const mem = this.memory?.snapshot?.() || {};
    let stage = mem.stage || "collect_name";
    if (!mem.collectedFields?.name) {
      stage = this.nameRecovery.awaitingConfirmation ? "confirm_name" : "collect_name";
    } else if (!mem.collectedFields?.subject && !mem.awaitingCallbackConfirmation) stage = "discover_need";
    else if (mem.awaitingCallbackConfirmation) stage = "confirm_callback";
    else if (!mem.collectedFields?.callback && intent === "callback_request") stage = "confirm_callback";
    else if (mem.collectedFields?.subject && !mem.closing) stage = "ready_to_close";
    if (mem.closing) stage = "closing";
    this.memory?.setStage(stage);
    return this.snapshot();
  }

  noteIntent(intent) {
    this.memory?.noteIntent(intent);
    return this.syncFromCall({ intent });
  }

  noteName(name, source) {
    this.memory?.noteCallerName(name, source);
    this.clearNameRecovery();
    return this.syncFromCall({ caller_name: name, full_name_source: source });
  }

  noteSubject(subject) {
    this.memory?.noteSubject(subject);
    return this.syncFromCall({ subject });
  }

  noteCallback(number) {
    this.memory?.noteCallback(number);
    return this.syncFromCall({ callback_number: number });
  }

  noteCallbackAwaiting(active) {
    this.memory?.noteCallbackAwaiting(active);
    return this.syncFromCall();
  }

  evaluateNameCaptureRecovery({ userText, lastBotUtterance }) {
    const text = collapseSpaces(userText);
    const lastBot = collapseSpaces(lastBotUtterance);
    const askedForName = lastBotAskedForName(lastBot);
    const hasName = !!this.memory?.snapshot?.()?.collectedFields?.name;

    if (hasName) {
      this.clearNameRecovery();
      return { handled: false };
    }

    if (!text) return { handled: false };

    if (this.nameRecovery.awaitingConfirmation) {
      if (isAffirmativeUtterance(text)) {
        const confirmed = safeStr(this.nameRecovery.pendingCandidate);
        if (!confirmed) return { handled: false };
        return {
          handled: true,
          action: "commit_name",
          name: confirmed,
          reason: "name_confirmation_yes",
          sourceUtterance: text,
        };
      }

      if (isNegativeUtterance(text)) {
        this.nameRecovery.awaitingConfirmation = false;
        this.nameRecovery.pendingCandidate = "";
        this.nameRecovery.attempts += 1;
        this.nameRecovery.askSpeakUpCount += 1;
        this.nameRecovery.lastRawReply = text;
        return {
          handled: true,
          action: "prompt_repeat",
          promptKind: "name_recovery",
          text: this._buildSpeakUpPrompt(),
        };
      }
    }

    const allowNameRecovery = askedForName || this.nameRecovery.awaitingConfirmation;
    const sanitized = allowNameRecovery
      ? (sanitizeCandidate(text, { directReply: askedForName, explicit: false }) || "")
      : "";
    if (sanitized && hasHebrewLetters(sanitized)) {
      this.nameRecovery.attempts += 1;
      this.nameRecovery.lastRawReply = text;
      this._setPendingCandidate(sanitized);
      return {
        handled: true,
        action: "confirm_candidate",
        promptKind: "name_confirm",
        candidate: sanitized,
        text: `רק לוודא, אמרת ${sanitized}?`,
      };
    }

    if (allowNameRecovery) {
      const directReply = looksLikeShortDirectNameReply(text);
      if (directReply) {
        const sameAsPrevious = this.nameRecovery.lastRawReply && this.nameRecovery.lastRawReply === text;
        this.nameRecovery.attempts += 1;
        this.nameRecovery.lastRawReply = text;
        if (sameAsPrevious || this.nameRecovery.attempts >= 1) {
          this.nameRecovery.askSpeakUpCount += 1;
          return {
            handled: true,
            action: "prompt_repeat",
            promptKind: "name_recovery",
            text: this._buildSpeakUpPrompt(),
          };
        }
        return {
          handled: true,
          action: "prompt_repeat",
          promptKind: "name_recovery",
          text: this._buildGenericRepeatPrompt(),
        };
      }
    }

    return { handled: false };
  }

  snapshot() {
    const memorySnapshot = this.memory?.snapshot?.() || {};
    return {
      ...memorySnapshot,
      nameRecovery: {
        awaitingConfirmation: !!this.nameRecovery.awaitingConfirmation,
        pendingCandidate: this.nameRecovery.pendingCandidate || null,
        attempts: this.nameRecovery.attempts || 0,
        askSpeakUpCount: this.nameRecovery.askSpeakUpCount || 0,
        lastRawReply: this.nameRecovery.lastRawReply || null,
      },
    };
  }
}

module.exports = { LeadManager };
