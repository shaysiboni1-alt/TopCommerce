"use strict";

class TurnManager {
  constructor() {
    this.seq = 0;
    this.state = {
      assistantSpeaking: false,
      lastUserAudioAt: 0,
      lastUserTurnAt: 0,
      lastAssistantTurnAt: 0,
      lastAssistantPlaybackStartAt: 0,
      lastAssistantPlaybackStopAt: 0,
      lastInterruptAt: 0,
      holdUntilTs: 0,
      currentTurnId: null,
      lastCommittedUserTurnId: null,
      lastCommittedAssistantTurnId: null,
      activeResponseId: null,
      activeResponseState: null,
      activeResponseTurnId: null,
      responseStartedAt: 0,
      responseEndedAt: 0,
      responseChunksSent: 0,
      interruptionPending: false,
      lowConfidenceUserTurns: 0,
    };
  }

  _nextId(prefix) {
    this.seq += 1;
    return `${prefix}-${this.seq}`;
  }

  noteUserAudio() {
    this.state.lastUserAudioAt = Date.now();
    return this.snapshot();
  }

  noteUserTurn() {
    const now = Date.now();
    const turnId = this._nextId("user");
    this.state.currentTurnId = turnId;
    this.state.lastCommittedUserTurnId = turnId;
    this.state.lastUserTurnAt = now;
    this.state.holdUntilTs = Math.max(this.state.holdUntilTs, now + 180);
    this.state.interruptionPending = false;
    return this.snapshot();
  }

  noteAssistantTurn() {
    const turnId = this._nextId("assistant");
    this.state.lastCommittedAssistantTurnId = turnId;
    this.state.lastAssistantTurnAt = Date.now();
    return { ...this.snapshot(), lastAssistantTurnId: turnId };
  }

  openResponse(response = {}) {
    this.state.activeResponseId = response.id || this._nextId("resp");
    this.state.activeResponseTurnId = response.turnId || this.state.lastCommittedAssistantTurnId || null;
    this.state.activeResponseState = response.state || "queued";
    this.state.responseChunksSent = 0;
    this.state.responseStartedAt = 0;
    this.state.responseEndedAt = 0;
    return this.snapshot();
  }

  startResponsePlayback(response = {}) {
    this.state.assistantSpeaking = true;
    this.state.lastAssistantPlaybackStartAt = Date.now();
    this.state.activeResponseId = response.id || this.state.activeResponseId;
    this.state.activeResponseTurnId = response.turnId || this.state.activeResponseTurnId;
    this.state.activeResponseState = response.state || "speaking";
    if (!this.state.responseStartedAt) this.state.responseStartedAt = Date.now();
    this.state.responseChunksSent += 1;
    return this.snapshot();
  }

  noteResponsePlaybackMark(response = {}) {
    this.state.activeResponseId = response.id || this.state.activeResponseId;
    this.state.activeResponseState = response.state || this.state.activeResponseState;
    return this.snapshot();
  }

  noteAssistantPlaybackStart() {
    this.state.assistantSpeaking = true;
    this.state.lastAssistantPlaybackStartAt = Date.now();
    return this.snapshot();
  }

  noteAssistantPlaybackStop() {
    this.state.assistantSpeaking = false;
    this.state.lastAssistantPlaybackStopAt = Date.now();
    return this.snapshot();
  }

  completeResponse(response = {}) {
    this.state.assistantSpeaking = false;
    this.state.activeResponseId = response.id || this.state.activeResponseId;
    this.state.activeResponseState = response.state || "completed";
    this.state.responseEndedAt = Date.now();
    this.state.lastAssistantPlaybackStopAt = Date.now();
    return this.snapshot();
  }

  interruptResponse(response = {}) {
    const now = Date.now();
    this.state.assistantSpeaking = false;
    this.state.activeResponseId = response.id || this.state.activeResponseId;
    this.state.activeResponseState = response.state || "interrupted";
    this.state.responseEndedAt = now;
    this.state.lastAssistantPlaybackStopAt = now;
    this.state.lastInterruptAt = now;
    this.state.interruptionPending = true;
    this.state.holdUntilTs = Math.max(this.state.holdUntilTs, now + 320);
    return this.snapshot();
  }

  cancelResponse(response = {}) {
    this.state.assistantSpeaking = false;
    this.state.activeResponseId = response.id || this.state.activeResponseId;
    this.state.activeResponseState = response.state || "cancelled";
    this.state.responseEndedAt = Date.now();
    return this.snapshot();
  }

  registerInterrupt() {
    const now = Date.now();
    this.state.assistantSpeaking = false;
    this.state.lastInterruptAt = now;
    this.state.interruptionPending = true;
    this.state.holdUntilTs = Math.max(this.state.holdUntilTs, now + 320);
    return this.snapshot();
  }

  noteLowConfidenceUserTurn() {
    this.state.lowConfidenceUserTurns += 1;
    this.state.holdUntilTs = Math.max(this.state.holdUntilTs, Date.now() + 120);
    return this.snapshot();
  }

  shouldHoldBeforeModelSend() {
    return Date.now() < this.state.holdUntilTs;
  }

  getSuggestedUserFlushMs(baseMs) {
    const now = Date.now();
    const timeSinceAudio = now - this.state.lastUserAudioAt;
    let hold = Number(baseMs) || 420;
    if (this.state.assistantSpeaking) hold += 120;
    if (now - this.state.lastInterruptAt < 1800) hold += 220;
    if (timeSinceAudio < 220) hold += 120;
    if (this.state.interruptionPending) hold += 120;
    return Math.max(280, Math.min(980, hold));
  }

  getSuggestedStableGapMs(baseMs) {
    const now = Date.now();
    let gap = Number(baseMs) || 360;
    if (now - this.state.lastInterruptAt < 1800) gap += 160;
    if (this.state.interruptionPending) gap += 80;
    return Math.max(220, Math.min(760, gap));
  }

  _tokenize(text) {
    return String(text || "")
      .trim()
      .split(/\s+/)
      .filter(Boolean);
  }

  _compact(text) {
    return String(text || "")
      .replace(/[\s.,!?;:'"()[\]{}\-_/\\]+/g, "")
      .trim();
  }

  isLowConfidenceTranscript(text) {
    const raw = String(text || "").trim();
    if (!raw) return true;

    const compact = this._compact(raw);
    if (compact.length < 3) return true;

    const tokens = this._tokenize(raw);
    if (!tokens.length) return true;

    const shortTokens = tokens.filter((token) => token.length <= 1).length;
    const mediumTokens = tokens.filter((token) => token.length >= 2).length;
    const longTokens = tokens.filter((token) => token.length >= 3).length;
    const hasDigits = /\d/.test(raw);
    const hasHebrew = /[\u0590-\u05FF]/.test(raw);
    const hasLatin = /[A-Za-z]/.test(raw);

    if (!hasDigits && !hasHebrew && !hasLatin) return true;
    if (tokens.length >= 4 && shortTokens / tokens.length >= 0.7 && longTokens === 0) return true;
    if (tokens.length >= 5 && mediumTokens <= 1 && !hasDigits) return true;

    const splitPatternCount = (raw.match(/(?:^|\s)[\u0590-\u05FF](?:\s+[\u0590-\u05FF]){2,}(?=\s|$)/gu) || []).length;
    if (splitPatternCount >= 1 && longTokens === 0 && compact.length < 10) return true;

    return false;
  }

  shouldCommitUserText(text) {
    return !this.isLowConfidenceTranscript(text);
  }

  snapshot() {
    return { ...this.state };
  }
}

module.exports = { TurnManager };
