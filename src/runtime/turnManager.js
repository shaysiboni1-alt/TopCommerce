"use strict";

class TurnManager {
  constructor() {
    this.state = {
      assistantSpeaking: false,
      lastUserAudioAt: 0,
      lastUserTurnAt: 0,
      lastAssistantTurnAt: 0,
      lastAssistantPlaybackStartAt: 0,
      lastAssistantPlaybackStopAt: 0,
      lastInterruptAt: 0,
      holdUntilTs: 0,
    };
  }

  noteUserAudio() {
    this.state.lastUserAudioAt = Date.now();
    return this.snapshot();
  }

  noteUserTurn() {
    const now = Date.now();
    this.state.lastUserTurnAt = now;
    this.state.holdUntilTs = Math.max(this.state.holdUntilTs, now + 180);
    return this.snapshot();
  }

  noteAssistantTurn() {
    this.state.lastAssistantTurnAt = Date.now();
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

  registerInterrupt() {
    const now = Date.now();
    this.state.assistantSpeaking = false;
    this.state.lastInterruptAt = now;
    this.state.holdUntilTs = Math.max(this.state.holdUntilTs, now + 320);
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
    if (now - this.state.lastInterruptAt < 1800) hold += 160;
    if (timeSinceAudio < 220) hold += 120;
    return Math.max(260, Math.min(900, hold));
  }

  getSuggestedStableGapMs(baseMs) {
    const now = Date.now();
    let gap = Number(baseMs) || 360;
    if (now - this.state.lastInterruptAt < 1800) gap += 120;
    return Math.max(180, Math.min(720, gap));
  }

  snapshot() {
    return { ...this.state };
  }
}

module.exports = { TurnManager };
