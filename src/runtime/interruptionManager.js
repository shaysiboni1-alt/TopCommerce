"use strict";

class InterruptionManager {
  constructor({
    rmsThreshold,
    minFrames,
    cooldownMs,
    onInterrupt,
    minSpeechMs,
    playbackStartGraceMs,
    maxInterFrameGapMs,
    requireConsecutiveFrames,
  }) {
    this.rmsThreshold = Number.isFinite(Number(rmsThreshold)) ? Number(rmsThreshold) : 0.028;
    this.minFrames = Math.max(1, Number(minFrames) || 2);
    this.cooldownMs = Math.max(100, Number(cooldownMs) || 600);
    this.minSpeechMs = Math.max(60, Number(minSpeechMs) || 170);
    this.playbackStartGraceMs = Math.max(0, Number(playbackStartGraceMs) || 260);
    this.maxInterFrameGapMs = Math.max(20, Number(maxInterFrameGapMs) || 120);
    this.requireConsecutiveFrames = requireConsecutiveFrames !== false;
    this.onInterrupt = typeof onInterrupt === "function" ? onInterrupt : () => {};

    this.pendingPlaybackMarks = 0;
    this.markSeq = 0;
    this.recentOutboundTs = 0;
    this.playbackStartedAt = 0;
    this.recentInterruptTs = 0;
    this.speechFrames = 0;
    this.firstSpeechFrameAt = 0;
    this.lastSpeechFrameAt = 0;
  }

  noteOutboundAudioSent() {
    const now = Date.now();
    this.recentOutboundTs = now;
    if (!this.playbackStartedAt || now - this.playbackStartedAt > 1200) {
      this.playbackStartedAt = now;
    }
  }

  registerPlaybackMarkSent() {
    this.markSeq += 1;
    this.pendingPlaybackMarks += 1;
    return this.markSeq;
  }

  notePlaybackMarkReceived() {
    this.pendingPlaybackMarks = Math.max(0, this.pendingPlaybackMarks - 1);
    if (this.pendingPlaybackMarks === 0 && Date.now() - this.recentOutboundTs > 700) {
      this._resetSpeechCandidate();
    }
    return this.pendingPlaybackMarks;
  }

  assistantPlaybackActive() {
    return this.pendingPlaybackMarks > 0 || Date.now() - this.recentOutboundTs < 500;
  }

  _resetSpeechCandidate() {
    this.speechFrames = 0;
    this.firstSpeechFrameAt = 0;
    this.lastSpeechFrameAt = 0;
  }

  _candidateSpeechDurationMs(now) {
    if (!this.firstSpeechFrameAt) return 0;
    return Math.max(0, now - this.firstSpeechFrameAt);
  }

  evaluateSpeech({ rms, bargeInAllowed }) {
    const now = Date.now();
    const numericRms = Number(rms);

    if (!this.assistantPlaybackActive()) {
      this._resetSpeechCandidate();
      return false;
    }
    if (bargeInAllowed === false) {
      this._resetSpeechCandidate();
      return false;
    }
    if (now - this.recentInterruptTs < this.cooldownMs) return false;
    if (this.playbackStartedAt && now - this.playbackStartedAt < this.playbackStartGraceMs) return false;

    const aboveThreshold = Number.isFinite(numericRms) && numericRms >= this.rmsThreshold;
    if (!aboveThreshold) {
      if (this.lastSpeechFrameAt && now - this.lastSpeechFrameAt > this.maxInterFrameGapMs) {
        this._resetSpeechCandidate();
      }
      return false;
    }

    if (this.requireConsecutiveFrames && this.lastSpeechFrameAt && now - this.lastSpeechFrameAt > this.maxInterFrameGapMs) {
      this._resetSpeechCandidate();
    }

    if (!this.firstSpeechFrameAt) this.firstSpeechFrameAt = now;
    this.lastSpeechFrameAt = now;
    this.speechFrames += 1;

    const candidateMs = this._candidateSpeechDurationMs(now);
    const framesReady = this.speechFrames >= this.minFrames;
    const durationReady = candidateMs >= this.minSpeechMs;
    if (!framesReady || !durationReady) return false;

    this.recentInterruptTs = now;
    this.pendingPlaybackMarks = 0;
    this._resetSpeechCandidate();
    this.onInterrupt({
      rms: numericRms,
      threshold: this.rmsThreshold,
      minFrames: this.minFrames,
      minSpeechMs: this.minSpeechMs,
      playbackStartGraceMs: this.playbackStartGraceMs,
    });
    return true;
  }
}

module.exports = { InterruptionManager };
