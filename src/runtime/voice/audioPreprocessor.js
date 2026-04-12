"use strict";

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function rmsInt16(samples) {
  const len = samples?.length || 0;
  if (!len) return 0;
  let sum = 0;
  for (let i = 0; i < len; i += 1) {
    const s = samples[i] / 32768;
    sum += s * s;
  }
  return Math.sqrt(sum / len);
}

function applyHighPass(samples, state, alpha) {
  let prevX = Number(state.prevX || 0);
  let prevY = Number(state.prevY || 0);
  for (let i = 0; i < samples.length; i += 1) {
    const x = samples[i];
    const y = alpha * (prevY + x - prevX);
    prevX = x;
    prevY = y;
    samples[i] = clamp(Math.round(y), -32768, 32767);
  }
  state.prevX = prevX;
  state.prevY = prevY;
}

function applyNoiseGate(samples, floor) {
  for (let i = 0; i < samples.length; i += 1) {
    const s = samples[i];
    if (Math.abs(s) < floor) samples[i] = 0;
  }
}

function applyAgc(samples, targetRms, maxGain) {
  const current = rmsInt16(samples);
  if (current <= 0.00001) return { gain: 1, rms: current };
  const gain = clamp(targetRms / current, 1, maxGain);
  if (gain <= 1.001) return { gain, rms: current };
  for (let i = 0; i < samples.length; i += 1) {
    samples[i] = clamp(Math.round(samples[i] * gain), -32768, 32767);
  }
  return { gain, rms: current };
}

function preprocessInt16(samples, state, opts) {
  const options = Object.assign(
    {
      highPassAlpha: 0.97,
      noiseGateFloor: 280,
      agcTargetRms: 0.14,
      agcMaxGain: 4,
      enableHighPass: true,
      enableNoiseGate: true,
      enableAgc: true,
    },
    opts || {}
  );

  const out = Int16Array.from(samples || []);
  if (!out.length) {
    return {
      samples: out,
      metrics: { inputRms: 0, outputRms: 0, gain: 1 },
    };
  }

  const inputRms = rmsInt16(out);
  if (options.enableHighPass) applyHighPass(out, state, options.highPassAlpha);
  if (options.enableNoiseGate) applyNoiseGate(out, options.noiseGateFloor);
  let gain = 1;
  if (options.enableAgc) {
    const agc = applyAgc(out, options.agcTargetRms, options.agcMaxGain);
    gain = agc.gain;
  }

  return {
    samples: out,
    metrics: {
      inputRms,
      outputRms: rmsInt16(out),
      gain,
    },
  };
}

module.exports = {
  preprocessInt16,
  rmsInt16,
};
