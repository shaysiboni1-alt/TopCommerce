"use strict";

function ulawByteToPcm16(sample) {
  sample = ~sample & 0xff;
  const sign = sample & 0x80;
  const exponent = (sample >> 4) & 0x07;
  const mantissa = sample & 0x0f;
  let pcm = ((mantissa << 3) + 0x84) << exponent;
  pcm -= 0x84;
  return sign ? -pcm : pcm;
}

function pcm16ToUlawByte(pcm) {
  const BIAS = 0x84;
  const CLIP = 32635;

  let sign = 0;
  if (pcm < 0) {
    sign = 0x80;
    pcm = -pcm;
  }
  if (pcm > CLIP) pcm = CLIP;
  pcm += BIAS;

  let exponent = 7;
  for (let expMask = 0x4000; (pcm & expMask) === 0 && exponent > 0; expMask >>= 1) {
    exponent -= 1;
  }
  const mantissa = (pcm >> (exponent + 3)) & 0x0f;
  return (~(sign | (exponent << 4) | mantissa)) & 0xff;
}

function b64ToBuf(b64) {
  return Buffer.from(b64, "base64");
}
function bufToB64(buf) {
  return Buffer.from(buf).toString("base64");
}

function ulaw8kToInt16Array(ulawB64) {
  const ulaw = b64ToBuf(ulawB64);
  const out = new Int16Array(ulaw.length);
  for (let i = 0; i < ulaw.length; i += 1) out[i] = ulawByteToPcm16(ulaw[i]);
  return out;
}

function int16ArrayToBufferLE(arr) {
  const buf = Buffer.alloc(arr.length * 2);
  for (let i = 0; i < arr.length; i += 1) buf.writeInt16LE(arr[i], i * 2);
  return buf;
}

function resampleLinear(input, inRate, outRate) {
  if (!input.length || inRate === outRate) return Int16Array.from(input);
  const ratio = outRate / inRate;
  const outLen = Math.max(1, Math.round(input.length * ratio));
  const out = new Int16Array(outLen);
  for (let i = 0; i < outLen; i += 1) {
    const pos = i / ratio;
    const left = Math.floor(pos);
    const right = Math.min(left + 1, input.length - 1);
    const frac = pos - left;
    const sample = input[left] + (input[right] - input[left]) * frac;
    out[i] = Math.max(-32768, Math.min(32767, Math.round(sample)));
  }
  return out;
}

function ulaw8kB64ToPcm16kBuffer(ulawB64) {
  return int16ArrayToBufferLE(resampleLinear(ulaw8kToInt16Array(ulawB64), 8000, 16000));
}

function ulaw8kB64ToPcm16kB64(ulawB64) {
  return bufToB64(ulaw8kB64ToPcm16kBuffer(ulawB64));
}

function pcm24kB64ToUlaw8kB64(pcmB64) {
  const pcm = b64ToBuf(pcmB64);
  const inputSamples = new Int16Array(pcm.length / 2);
  for (let i = 0; i < inputSamples.length; i += 1) inputSamples[i] = pcm.readInt16LE(i * 2);
  const down = resampleLinear(inputSamples, 24000, 8000);
  const ulaw = Buffer.alloc(down.length);
  for (let i = 0; i < down.length; i += 1) ulaw[i] = pcm16ToUlawByte(down[i]);
  return bufToB64(ulaw);
}

module.exports = {
  ulaw8kB64ToPcm16kB64,
  ulaw8kB64ToPcm16kBuffer,
  pcm24kB64ToUlaw8kB64,
};
