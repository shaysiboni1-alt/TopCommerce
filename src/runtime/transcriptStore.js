"use strict";

const {
  joinCommonHebrewFragments,
  normalizeHebrewBusinessTerms,
} = require("../logic/hebrewNlp");

function _applyHebrewRecovery(text) {
  if (!text) return text;
  try {
    let s = joinCommonHebrewFragments(text);
    s = normalizeHebrewBusinessTerms(s);
    return s || text;
  } catch {
    return text;
  }
}

class TranscriptStore {
  constructor({ onFlush, getFlushDelayMs, getStableGapMs, shouldDelayFlush, mergeChunks, normalizeText }) {
    this.onFlush = typeof onFlush === "function" ? onFlush : () => {};
    this.getFlushDelayMs = typeof getFlushDelayMs === "function" ? getFlushDelayMs : (() => 320);
    this.getStableGapMs = typeof getStableGapMs === "function" ? getStableGapMs : (() => 220);
    this.shouldDelayFlush = typeof shouldDelayFlush === "function" ? shouldDelayFlush : (() => false);
    this.mergeChunks = typeof mergeChunks === "function" ? mergeChunks : ((prev, next) => `${prev || ""} ${next || ""}`.trim());
    this.normalizeText = typeof normalizeText === "function"
      ? normalizeText
      : ((value) => ({ raw: String(value || "").trim(), normalized: String(value || "").trim() }));
    this.buffers = {
      user: this._newBuffer(),
      bot: this._newBuffer(),
    };
  }

  _newBuffer() {
    return {
      text: "",
      timer: null,
      lastChunk: "",
      lastTs: 0,
      firstTs: 0,
    };
  }

  _safeStr(value) {
    return value === undefined || value === null ? "" : String(value).trim();
  }

  _buildStageEnvelope(rawText, normalizedValue) {
    const normalizedObj = normalizedValue && typeof normalizedValue === "object"
      ? normalizedValue
      : { raw: rawText, normalized: rawText };

    const raw = this._safeStr(rawText);
    const normalized = this._safeStr(normalizedObj.normalized || normalizedObj.raw || raw);

    // ── Hebrew Recovery Layer (Task 3.2) ──────────────────────────────
    // Apply joinCommonHebrewFragments + normalizeHebrewBusinessTerms on
    // top of normalized to produce a deeper-corrected recovered stage.
    // Falls back to normalized if recovery produces nothing.
    const recoveredCandidate = this._safeStr(normalizedObj.recovered || "");
    const recovered = this._safeStr(
      recoveredCandidate
        ? _applyHebrewRecovery(recoveredCandidate)
        : _applyHebrewRecovery(normalized) || normalized
    );
    // ─────────────────────────────────────────────────────────────────

    const finalText = this._safeStr(normalizedObj.final || normalizedObj.finalText || recovered || normalized || raw);

    return {
      raw,
      normalized,
      recovered,
      final: finalText,
      stage_order: ["raw", "normalized", "recovered", "final"],
      stage_texts: {
        raw,
        normalized,
        recovered,
        final: finalText,
      },
      stages: {
        raw: {
          name: "raw",
          text: raw,
          length: raw.length,
          present: Boolean(raw),
        },
        normalized: {
          name: "normalized",
          text: normalized,
          length: normalized.length,
          present: Boolean(normalized),
        },
        recovered: {
          name: "recovered",
          text: recovered,
          length: recovered.length,
          present: Boolean(recovered),
        },
        final: {
          name: "final",
          text: finalText,
          length: finalText.length,
          present: Boolean(finalText),
        },
      },
    };
  }

  bufferChunk(who, chunk) {
    const holder = this.buffers[who];
    const value = this._safeStr(chunk);
    if (!holder || !value) return { accepted: false };
    if (holder.lastChunk === value) return { accepted: false, duplicate: true, holder };

    if (!holder.firstTs) holder.firstTs = Date.now();
    holder.lastChunk = value;
    holder.lastTs = Date.now();
    const prev = holder.text;
    holder.text = this.mergeChunks(holder.text, value);
    return { accepted: true, merged: prev ? holder.text !== prev : false, holder };
  }

  scheduleFlush(who, options) {
    const holder = this.buffers[who];
    if (!holder) return 0;
    if (holder.timer) clearTimeout(holder.timer);
    const delayMs = Math.max(50, Number(this.getFlushDelayMs(who, options)) || 320);
    holder.timer = setTimeout(() => this.flush(who, options), delayMs);
    return delayMs;
  }

  flush(who, options = {}) {
    const holder = this.buffers[who];
    if (!holder) return null;

    if (holder.timer) {
      clearTimeout(holder.timer);
      holder.timer = null;
    }

    const rawText = this._safeStr(holder.text);
    if (!rawText) {
      holder.text = "";
      holder.lastChunk = "";
      holder.lastTs = 0;
      holder.firstTs = 0;
      return null;
    }

    const stableGapMs = Math.max(50, Number(this.getStableGapMs(who, options)) || 220);
    const sinceLastChunkMs = holder.lastTs ? Date.now() - holder.lastTs : stableGapMs;
    if (!options.force && sinceLastChunkMs < stableGapMs) {
      this.scheduleFlush(who, options);
      return { delayed: true, reason: "stable_gap", text: rawText };
    }

    const bufferAgeMs = holder.firstTs ? Date.now() - holder.firstTs : 0;
    if (!options.force && this.shouldDelayFlush(who, rawText, { stableGapMs, bufferAgeMs, options })) {
      this.scheduleFlush(who, options);
      return { delayed: true, reason: "predicate", text: rawText };
    }

    holder.text = "";
    holder.lastChunk = "";
    holder.lastTs = 0;
    holder.firstTs = 0;

    const normalized = this.normalizeText(rawText, who, options) || { raw: rawText, normalized: rawText };
    const stageEnvelope = this._buildStageEnvelope(rawText, normalized);
    const finalText = this._safeStr(stageEnvelope.final);
    if (!finalText) return null;

    const payload = {
      who,
      role: who === "user" ? "user" : "assistant",
      rawText,
      normalized,
      finalText,
      forced: !!options.force,
      raw_text: stageEnvelope.raw,
      normalized_text: stageEnvelope.normalized,
      recovered_text: stageEnvelope.recovered,
      final_text: stageEnvelope.final,
      stage_order: stageEnvelope.stage_order,
      stage_texts: stageEnvelope.stage_texts,
      stages: stageEnvelope.stages,
    };

    this.onFlush(payload);
    return payload;
  }

  resetBuffer(who) {
    const holder = this.buffers[who];
    if (!holder) return;
    if (holder.timer) clearTimeout(holder.timer);
    this.buffers[who] = this._newBuffer();
  }

  resetAll() {
    this.resetBuffer("user");
    this.resetBuffer("bot");
  }
}

module.exports = { TranscriptStore };
