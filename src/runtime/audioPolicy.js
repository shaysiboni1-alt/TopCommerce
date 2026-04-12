"use strict";

class AudioPolicy {
  constructor({ env, turnManager }) {
    this.env = env || {};
    this.turnManager = turnManager || null;
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
    if (openingPhase) return false;
    if (baseAllowed === false) return false;
    const minRms = Number(this.env.MB_BARGE_IN_RMS_THRESHOLD || 0.028);
    if (Number(rms) < minRms) return false;
    if (this.turnManager?.shouldHoldBeforeModelSend?.()) return false;
    return true;
  }
}

module.exports = { AudioPolicy };
