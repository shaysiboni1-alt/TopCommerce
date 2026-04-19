"use strict";

class LongSilenceManager {
  constructor({ timeoutMs, enabled, onTimeout, onTick } = {}) {
    this.timeoutMs = Math.max(15000, Number(timeoutMs) || 60000);
    this.enabled = enabled !== false;
    this.onTimeout = typeof onTimeout === "function" ? onTimeout : async () => {};
    this.onTick = typeof onTick === "function" ? onTick : () => {};
    this.timer = null;
    this.armedAt = 0;
    this.fired = false;
  }

  configure({ timeoutMs, enabled } = {}) {
    if (Number.isFinite(Number(timeoutMs))) this.timeoutMs = Math.max(15000, Number(timeoutMs));
    if (enabled !== undefined) this.enabled = enabled !== false;
  }

  _clear() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  _schedule() {
    this._clear();
    if (!this.enabled || !this.armedAt || this.fired) return;
    const dueAt = this.armedAt + this.timeoutMs;
    const waitMs = Math.max(100, dueAt - Date.now());
    this.timer = setTimeout(async () => {
      if (!this.enabled || !this.armedAt || this.fired) return;
      this.fired = true;
      this.onTick({ type: "LONG_SILENCE_TIMEOUT", armed_at: this.armedAt, timeout_ms: this.timeoutMs });
      await Promise.resolve(this.onTimeout({ armedAt: this.armedAt, timeoutMs: this.timeoutMs }));
    }, waitMs);
  }

  arm(referenceTs = Date.now()) {
    this.armedAt = Number(referenceTs) || Date.now();
    this.fired = false;
    this.onTick({ type: "LONG_SILENCE_ARMED", armed_at: this.armedAt, timeout_ms: this.timeoutMs });
    this._schedule();
  }

  reset(referenceTs = Date.now()) {
    this.armedAt = Number(referenceTs) || Date.now();
    this.fired = false;
    this.onTick({ type: "LONG_SILENCE_RESET", armed_at: this.armedAt, timeout_ms: this.timeoutMs });
    this._schedule();
  }

  stop(reason = "stopped") {
    this._clear();
    if (this.armedAt) {
      this.onTick({ type: "LONG_SILENCE_STOPPED", reason, armed_at: this.armedAt, timeout_ms: this.timeoutMs });
    }
    this.armedAt = 0;
    this.fired = false;
  }
}

module.exports = { LongSilenceManager };
