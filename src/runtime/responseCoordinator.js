"use strict";

const { ActiveResponseHandle } = require("./activeResponseHandle");

function safeStr(value) {
  return value === undefined || value === null ? "" : String(value).trim();
}

class ResponseCoordinator {
  constructor({ turnManager, onStateChange } = {}) {
    this.turnManager = turnManager || null;
    this.onStateChange = typeof onStateChange === "function" ? onStateChange : () => {};
    this.active = null;
    this.sequence = 0;
  }

  _emit(event, data = {}) {
    try {
      this.onStateChange({ event, ...(data || {}) });
    } catch {}
  }

  beginResponse({ turnId, textPreview, allowInterruptions = true, source = "agent" } = {}) {
    if (this.active && this.active.state !== "completed" && this.active.state !== "cancelled") {
      this.active.cancel("superseded_response");
      this._emit("response_cancelled", { response: this.active.snapshot() });
    }

    this.sequence += 1;
    const id = `resp-${this.sequence}`;
    this.active = new ActiveResponseHandle({
      id,
      turnId,
      textPreview,
      allowInterruptions,
      source,
    });
    this.turnManager?.openResponse?.(this.active.snapshot());
    this._emit("response_opened", { response: this.active.snapshot() });
    return this.active.snapshot();
  }

  noteAudioChunk() {
    if (!this.active) return null;
    this.active.noteAudioChunk();
    this.turnManager?.startResponsePlayback?.(this.active.snapshot());
    this._emit("response_audio_chunk", { response: this.active.snapshot() });
    return this.active.snapshot();
  }

  notePlaybackMark() {
    if (!this.active) return null;
    this.active.notePlaybackMark();
    this.turnManager?.noteResponsePlaybackMark?.(this.active.snapshot());
    return this.active.snapshot();
  }

  notePlaybackCompleted() {
    if (!this.active) return null;
    this.active.complete();
    this.turnManager?.completeResponse?.(this.active.snapshot());
    this._emit("response_completed", { response: this.active.snapshot() });
    return this.active.snapshot();
  }

  interrupt(reason = "user_speech") {
    if (!this.active) return null;
    if (this.active.allowInterruptions === false) return this.active.snapshot();
    this.active.interrupt(reason);
    this.turnManager?.interruptResponse?.(this.active.snapshot());
    this._emit("response_interrupted", { response: this.active.snapshot(), reason: safeStr(reason) || "user_speech" });
    return this.active.snapshot();
  }

  cancel(reason = "cancelled") {
    if (!this.active) return null;
    this.active.cancel(reason);
    this.turnManager?.cancelResponse?.(this.active.snapshot());
    this._emit("response_cancelled", { response: this.active.snapshot(), reason: safeStr(reason) || "cancelled" });
    return this.active.snapshot();
  }

  current() {
    return this.active ? this.active.snapshot() : null;
  }
}

module.exports = { ResponseCoordinator };
