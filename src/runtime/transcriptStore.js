"use strict";

class TranscriptStore {
  constructor({ onFlush, getFlushDelayMs, getStableGapMs, shouldDelayFlush, mergeChunks, normalizeText }) {
    this.onFlush = typeof onFlush === "function" ? onFlush : () => {};
    this.getFlushDelayMs = typeof getFlushDelayMs === "function" ? getFlushDelayMs : (() => 320);
    this.getStableGapMs = typeof getStableGapMs === "function" ? getStableGapMs : (() => 220);
    this.shouldDelayFlush = typeof shouldDelayFlush === "function" ? shouldDelayFlush : (() => false);
    this.mergeChunks = typeof mergeChunks === "function" ? mergeChunks : ((prev, next) => `${prev || ""} ${next || ""}`.trim());
    this.normalizeText = typeof normalizeText === "function" ? normalizeText : ((value) => ({ raw: String(value || "").trim(), normalized: String(value || "").trim() }));
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

  bufferChunk(who, chunk) {
    const holder = this.buffers[who];
    const value = String(chunk || "").trim();
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

    const rawText = String(holder.text || "").trim();
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
    const finalText = String(normalized.normalized || normalized.raw || "").trim();
    if (!finalText) return null;

    const payload = {
      who,
      role: who === "user" ? "user" : "assistant",
      rawText,
      normalized,
      finalText,
      forced: !!options.force,
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
