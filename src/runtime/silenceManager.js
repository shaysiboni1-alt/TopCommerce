"use strict";

function safeStr(v) {
  return v === undefined || v === null ? "" : String(v).trim();
}

class SilenceManager {
  constructor({ env, ssot, memory, onPrompt }) {
    this.env = env || {};
    this.ssot = ssot || {};
    this.memory = memory || null;
    this.onPrompt = typeof onPrompt === "function" ? onPrompt : () => {};
    this.timer = null;
    this.currentLevel = 0;
    this.referenceAt = 0;
  }

  _clearTimer() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  _getThreshold(level) {
    if (level === 1) return Math.max(1500, Number(this.env.SILENCE_T1_MS || 4500));
    if (level === 2) return Math.max(2500, Number(this.env.SILENCE_T2_MS || 8000));
    return Math.max(3500, Number(this.env.SILENCE_T3_MS || 12000));
  }

  _buildPrompt(level) {
    const settings = this.ssot?.settings || {};
    const base1 = safeStr(settings.SILENCE_PROMPT_1 || this.env.SILENCE_PROMPT_1) || "רק לבדוק שאתם עדיין איתי, במה אפשר לעזור?";
    const base2 = safeStr(settings.SILENCE_PROMPT_2 || this.env.SILENCE_PROMPT_2) || "אם נוח, תגידו לי בקצרה מה הפנייה.";
    const base3 = safeStr(settings.SILENCE_PROMPT_3 || this.env.SILENCE_PROMPT_3) || "אם תרצו, אפשר לסיים כאן או לתאם שיחזרו אליכם.";

    if (level === 1) return base1;
    if (level === 2) return base2;
    return base3;
  }

  _scheduleNext() {
    this._clearTimer();
    if (!this.referenceAt) return;
    const nextLevel = Math.min(3, this.currentLevel + 1);
    const delay = this._getThreshold(nextLevel);
    const dueAt = this.referenceAt + delay;
    const ms = Math.max(120, dueAt - Date.now());
    this.timer = setTimeout(() => this._fire(nextLevel), ms);
  }

  _fire(level) {
    this.currentLevel = level;
    this.memory?.noteSilence?.();
    this.onPrompt({ level, text: this._buildPrompt(level), context: this.memory?.getSilenceContext?.() || "general" });
    if (level < 3) this._scheduleNext();
  }

  arm(reference = Date.now()) {
    this.referenceAt = Number(reference) || Date.now();
    this.currentLevel = 0;
    this._scheduleNext();
  }

  reset(reference = Date.now()) {
    this._clearTimer();
    this.referenceAt = Number(reference) || Date.now();
    this.currentLevel = 0;
  }

  stop() {
    this.referenceAt = 0;
    this.currentLevel = 0;
    this._clearTimer();
  }
}

module.exports = { SilenceManager };
