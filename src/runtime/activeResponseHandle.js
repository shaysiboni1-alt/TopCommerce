"use strict";

function safeStr(value) {
  return value === undefined || value === null ? "" : String(value).trim();
}

class ActiveResponseHandle {
  constructor({ id, turnId, allowInterruptions = true, textPreview = "", source = "agent" } = {}) {
    this.id = safeStr(id);
    this.turnId = safeStr(turnId) || null;
    this.source = safeStr(source) || "agent";
    this.allowInterruptions = allowInterruptions !== false;
    this.textPreview = safeStr(textPreview) || null;
    this.state = "queued";
    this.createdAt = new Date().toISOString();
    this.startedAt = null;
    this.endedAt = null;
    this.audioChunksSent = 0;
    this.playbackMarksSent = 0;
    this.clearSent = false;
    this.interruptReason = null;
  }

  start() {
    if (this.state === "completed" || this.state === "cancelled") return this.snapshot();
    this.state = "speaking";
    if (!this.startedAt) this.startedAt = new Date().toISOString();
    return this.snapshot();
  }

  noteAudioChunk() {
    this.audioChunksSent += 1;
    if (!this.startedAt) this.startedAt = new Date().toISOString();
    if (this.state === "queued") this.state = "speaking";
    return this.snapshot();
  }

  notePlaybackMark() {
    this.playbackMarksSent += 1;
    return this.snapshot();
  }

  interrupt(reason = "user_speech") {
    if (this.state === "completed" || this.state === "cancelled") return this.snapshot();
    this.state = "interrupted";
    this.interruptReason = safeStr(reason) || "user_speech";
    this.clearSent = true;
    this.endedAt = new Date().toISOString();
    return this.snapshot();
  }

  complete() {
    if (this.state === "completed") return this.snapshot();
    this.state = "completed";
    this.endedAt = new Date().toISOString();
    return this.snapshot();
  }

  cancel(reason = "cancelled") {
    if (this.state === "completed") return this.snapshot();
    this.state = "cancelled";
    this.interruptReason = safeStr(reason) || "cancelled";
    this.endedAt = new Date().toISOString();
    return this.snapshot();
  }

  snapshot() {
    return {
      id: this.id,
      turnId: this.turnId,
      source: this.source,
      allowInterruptions: this.allowInterruptions,
      textPreview: this.textPreview,
      state: this.state,
      createdAt: this.createdAt,
      startedAt: this.startedAt,
      endedAt: this.endedAt,
      audioChunksSent: this.audioChunksSent,
      playbackMarksSent: this.playbackMarksSent,
      clearSent: this.clearSent,
      interruptReason: this.interruptReason,
    };
  }
}

module.exports = { ActiveResponseHandle };
