"use strict";

class AudioPolicy {
  constructor({ env, turnManager, memory }) {
    this.env = env || {};
    this.turnManager = turnManager || null;
    this.memory = memory || null;
  }

  getPreprocessOptions() {
    const out = {};
    if (Number.isFinite(Number(this.env.MB_AUDIO_HIGHPASS_ALPHA))) out.highPassAlpha = Number(this.env.MB_AUDIO_HIGHPASS_ALPHA);
    if (Number.isFinite(Number(this.env.MB_AUDIO_NOISE_GATE_FLOOR))) out.noiseGateFloor = Number(this.env.MB_AUDIO_NOISE_GATE_FLOOR);
    if (Number.isFinite(Number(this.env.MB_AUDIO_AGC_TARGET_RMS))) out.agcTargetRms = Number(this.env.MB_AUDIO_AGC_TARGET_RMS);
    if (Number.isFinite(Number(this.env.MB_AUDIO_AGC_MAX_GAIN))) out.agcMaxGain = Number(this.env.MB_AUDIO_AGC_MAX_GAIN);
    return out;
  }

  shouldAllowBargeIn({ openingPhase, baseAllowed, rms }) {
    if (baseAllowed === false) return false;

    const currentStage = String(this.memory?.snapshot?.()?.stage || "").trim().toLowerCase();
    const inClosing = currentStage === "closing";

    if (openingPhase) {
      const strict = this.env.OPENING_PROTECTION_STRICT === true || String(this.env.OPENING_PROTECTION_STRICT).toLowerCase() === "true";
      if (strict) return false;
      const openingMinRms = Number(this.env.OPENING_BARGE_IN_MIN_RMS || this.env.MB_BARGE_IN_RMS_THRESHOLD || 0.028);
      if (Number(rms) < openingMinRms) return false;
    } else if (inClosing) {
      const closingMinRms = Number(this.env.CLOSING_BARGE_IN_MIN_RMS || this.env.MB_BARGE_IN_RMS_THRESHOLD || 0.028);
      if (Number(rms) < closingMinRms) return false;
    } else {
      const minRms = Number(this.env.MB_BARGE_IN_RMS_THRESHOLD || 0.028);
      if (Number(rms) < minRms) return false;
    }

    if (this.turnManager?.shouldHoldBeforeModelSend?.()) return false;
    return true;
  }
}

module.exports = { AudioPolicy };
