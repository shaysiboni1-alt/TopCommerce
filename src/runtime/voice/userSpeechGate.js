"use strict";

function clampNumber(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

class UserSpeechGate {
  constructor(config = {}) {
    this.config = {
      rmsThreshold: clampNumber(config.rmsThreshold, 0.04),
      openingRmsThreshold: clampNumber(config.openingRmsThreshold, 0.06),
      minFrames: Math.max(1, clampNumber(config.minFrames, 3)),
      openingMinFrames: Math.max(1, clampNumber(config.openingMinFrames, 4)),
      minDurationMs: Math.max(20, clampNumber(config.minDurationMs, 160)),
      openingMinDurationMs: Math.max(20, clampNumber(config.openingMinDurationMs, 260)),
      cooldownMs: Math.max(80, clampNumber(config.cooldownMs, 220)),
      weakRmsFloor: clampNumber(config.weakRmsFloor, 0.018),
      frameDurationMs: Math.max(10, clampNumber(config.frameDurationMs, 20)),
    };

    this.consecutiveFrames = 0;
    this.lastAcceptedAt = 0;
  }

  _reset() {
    this.consecutiveFrames = 0;
  }

  evaluate({ rms, openingPhase = false, assistantPlaybackActive = false, baseAllowed = true } = {}) {
    const now = Date.now();
    const currentRms = clampNumber(rms, 0);
    const requiredFrames = openingPhase ? this.config.openingMinFrames : this.config.minFrames;
    const requiredDurationMs = openingPhase ? this.config.openingMinDurationMs : this.config.minDurationMs;
    const requiredRms = openingPhase ? this.config.openingRmsThreshold : this.config.rmsThreshold;

    if (currentRms < this.config.weakRmsFloor) {
      this._reset();
      return {
        accepted: false,
        reason: "weak_noise_floor",
        speechLikelihood: 0,
        consecutiveFrames: 0,
        durationMs: 0,
      };
    }

    if (currentRms >= requiredRms) this.consecutiveFrames += 1;
    else this._reset();

    const durationMs = this.consecutiveFrames * this.config.frameDurationMs;
    const speechLikelihood = Math.max(0, Math.min(1, currentRms / Math.max(requiredRms, 0.001)));

    if (!assistantPlaybackActive && !openingPhase) {
      return {
        accepted: durationMs >= requiredDurationMs,
        reason: durationMs >= requiredDurationMs ? "user_speech_detected" : "collecting_frames",
        speechLikelihood,
        consecutiveFrames: this.consecutiveFrames,
        durationMs,
      };
    }

    if (baseAllowed === false) {
      return {
        accepted: false,
        reason: "barge_in_blocked_by_state",
        speechLikelihood,
        consecutiveFrames: this.consecutiveFrames,
        durationMs,
      };
    }

    if (now - this.lastAcceptedAt < this.config.cooldownMs) {
      return {
        accepted: false,
        reason: "cooldown",
        speechLikelihood,
        consecutiveFrames: this.consecutiveFrames,
        durationMs,
      };
    }

    if (this.consecutiveFrames < requiredFrames || durationMs < requiredDurationMs) {
      return {
        accepted: false,
        reason: "collecting_frames",
        speechLikelihood,
        consecutiveFrames: this.consecutiveFrames,
        durationMs,
      };
    }

    this.lastAcceptedAt = now;
    this._reset();
    return {
      accepted: true,
      reason: openingPhase ? "opening_strong_speech" : "strong_user_speech",
      speechLikelihood,
      consecutiveFrames: requiredFrames,
      durationMs,
    };
  }
}

module.exports = { UserSpeechGate };
