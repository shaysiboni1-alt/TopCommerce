"use strict";

const { rmsInt16 } = require("./audioPreprocessor");

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

class TelephonyAec {
  constructor(opts = {}) {
    this.sampleRate = Number(opts.sampleRate || 16000);
    this.historyMs = Number(opts.historyMs || 900);
    this.searchMs = Number(opts.searchMs || 180);
    this.strength = Number(opts.strength || 0.78);
    this.corrThreshold = Number(opts.corrThreshold || 0.78);
    this.duckThreshold = Number(opts.duckThreshold || 0.62);
    this.nearSpeechFloor = Number(opts.nearSpeechFloor || 0.016);
    this.echoFloor = Number(opts.echoFloor || 0.010);

    this.maxHistorySamples = Math.max(
      320,
      Math.round((this.sampleRate * this.historyMs) / 1000)
    );
    this.searchSamples = Math.max(
      160,
      Math.round((this.sampleRate * this.searchMs) / 1000)
    );
    this.refHistory = new Int16Array(0);
  }

  pushReference(samples) {
    const ref = Int16Array.from(samples || []);
    if (!ref.length) return;
    const merged = new Int16Array(
      Math.min(this.refHistory.length + ref.length, this.maxHistorySamples)
    );
    const keep = Math.max(0, merged.length - ref.length);
    const srcStart = Math.max(0, this.refHistory.length - keep);
    if (keep > 0) merged.set(this.refHistory.subarray(srcStart), 0);
    merged.set(ref.subarray(Math.max(0, ref.length - (merged.length - keep))), keep);
    this.refHistory = merged;
  }

  processNearEnd(samples) {
    const near = Int16Array.from(samples || []);
    const nearRms = rmsInt16(near);
    if (!near.length || !this.refHistory.length) {
      return { samples: near, action: "ignore", nearRms, echoRms: 0, corr: 0, delaySamples: null };
    }

    const echoLen = Math.min(this.refHistory.length, near.length + this.searchSamples);
    const history = this.refHistory.subarray(this.refHistory.length - echoLen);

    let bestCorr = -1;
    let bestOffset = 0;
    let bestEchoRms = 0;
    const maxOffset = Math.max(0, history.length - near.length);
    for (let offset = 0; offset <= maxOffset; offset += 1) {
      const ref = history.subarray(offset, offset + near.length);
      let dot = 0;
      let nearPow = 0;
      let refPow = 0;
      for (let i = 0; i < near.length; i += 1) {
        const a = near[i];
        const b = ref[i];
        dot += a * b;
        nearPow += a * a;
        refPow += b * b;
      }
      if (!nearPow || !refPow) continue;
      const corr = dot / Math.sqrt(nearPow * refPow);
      if (corr > bestCorr) {
        bestCorr = corr;
        bestOffset = offset;
        bestEchoRms = Math.sqrt(refPow / near.length) / 32768;
      }
    }

    const alignedRef = history.subarray(bestOffset, bestOffset + near.length);
    if (
      bestCorr < this.duckThreshold ||
      bestEchoRms < this.echoFloor ||
      nearRms < this.nearSpeechFloor
    ) {
      return {
        samples: near,
        action: "ignore",
        nearRms,
        echoRms: bestEchoRms,
        corr: bestCorr,
        delaySamples: history.length - near.length - bestOffset,
      };
    }

    const out = Int16Array.from(near);
    let action = "duck";
    if (bestCorr >= this.corrThreshold) {
      action = "cancel";
      for (let i = 0; i < out.length; i += 1) {
        out[i] = clamp(
          Math.round(out[i] - alignedRef[i] * this.strength),
          -32768,
          32767
        );
      }
    } else {
      for (let i = 0; i < out.length; i += 1) {
        out[i] = clamp(Math.round(out[i] * 0.35), -32768, 32767);
      }
    }

    return {
      samples: out,
      action,
      nearRms,
      echoRms: bestEchoRms,
      corr: bestCorr,
      delaySamples: history.length - near.length - bestOffset,
    };
  }
}

module.exports = { TelephonyAec };
