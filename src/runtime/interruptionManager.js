"use strict";

class InterruptionManager {
  constructor({ rmsThreshold, minFrames, cooldownMs, onInterrupt }) {
    this.rmsThreshold = Number.isFinite(Number(rmsThreshold)) ? Number(rmsThreshold) : 0.028;
    this.minFrames = Math.max(1, Number(minFrames) || 2);
    this.cooldownMs = Math.max(100, Number(cooldownMs) || 600);
    this.onInterrupt = typeof onInterrupt === "function" ? onInterrupt : () => {};

    this.pendingPlaybackMarks = 0;
    this.markSeq = 0;
    this.recentOutboundTs = 0;
    this.recentInterruptTs = 0;
    this.speechFrames = 0;
  }

  noteOutboundAudioSent() {
    this.recentOutboundTs = Date.now();
  }

  registerPlaybackMarkSent() {
    this.markSeq += 1;
    this.pendingPlaybackMarks += 1;
    return this.markSeq;
  }

  notePlaybackMarkReceived() {
    this.pendingPlaybackMarks = Math.max(0, this.pendingPlaybackMarks - 1);
    return this.pendingPlaybackMarks;
  }

  assistantPlaybackActive() {
    return this.pendingPlaybackMarks > 0 || Date.now() - this.recentOutboundTs < 500;
  }

  evaluateSpeech({ rms, bargeInAllowed }) {
    if (!this.assistantPlaybackActive()) return false;
    if (bargeInAllowed === false) return false;
    if (Date.now() - this.recentInterruptTs < this.cooldownMs) return false;

    if (Number(rms) >= this.rmsThreshold) this.speechFrames += 1;
    else this.speechFrames = 0;

    if (this.speechFrames < this.minFrames) return false;

    this.recentInterruptTs = Date.now();
    this.speechFrames = 0;
    this.pendingPlaybackMarks = 0;
    this.onInterrupt({ rms: Number(rms), threshold: this.rmsThreshold, minFrames: this.minFrames });
    return true;
  }
}

module.exports = { InterruptionManager };
