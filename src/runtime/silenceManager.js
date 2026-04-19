"use strict";

function safeStr(v) {
  return v === undefined || v === null ? "" : String(v).trim();
}

function isTruthy(v, fallback = false) {
  if (v === undefined || v === null || v === "") return fallback;
  const s = String(v).trim().toLowerCase();
  if (["1", "true", "yes", "y", "on"].includes(s)) return true;
  if (["0", "false", "no", "n", "off"].includes(s)) return false;
  return fallback;
}

class SilenceManager {
  constructor({ env, ssot, memory, onPrompt, onLongSilence }) {
    this.env = env || {};
    this.ssot = ssot || {};
    this.memory = memory || null;
    this.onPrompt = typeof onPrompt === "function" ? onPrompt : () => {};
    this.onLongSilence = typeof onLongSilence === "function" ? onLongSilence : () => {};
    this.timer = null;
    this.longSilenceTimer = null;
    this.currentLevel = 0;
    this.referenceAt = 0;
    this.longSilenceAnchorAt = 0;
    this.lastPromptText = "";
  }

  _clearTimer() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  _clearLongSilenceTimer() {
    if (this.longSilenceTimer) clearTimeout(this.longSilenceTimer);
    this.longSilenceTimer = null;
  }

  _getThreshold(level) {
    if (level === 1) return Math.max(1500, Number(this.env.SILENCE_T1_MS || 4500));
    if (level === 2) return Math.max(2500, Number(this.env.SILENCE_T2_MS || 8000));
    return Math.max(3500, Number(this.env.SILENCE_T3_MS || 12000));
  }

  _getMaxReprompts() {
    const settings = this.ssot?.settings || {};
    const context = this.memory?.getSilenceContext?.() || "general";
    if (context === "lead") {
      return Math.max(1, Number(settings.SUBJECT_REASK_MAX || this.env.SUBJECT_REASK_MAX || settings.SILENCE_MAX_REPROMPTS || this.env.SILENCE_MAX_REPROMPTS || 2));
    }
    return Math.max(1, Number(settings.SILENCE_MAX_REPROMPTS || this.env.SILENCE_MAX_REPROMPTS || 3));
  }

  _longSilenceEnabled() {
    const settings = this.ssot?.settings || {};
    return isTruthy(settings.LONG_SILENCE_HANGUP_ENABLED ?? this.env.LONG_SILENCE_HANGUP_ENABLED, true);
  }

  _getLongSilenceMs() {
    const settings = this.ssot?.settings || {};
    return Math.max(15000, Number(settings.LONG_SILENCE_HANGUP_MS || this.env.LONG_SILENCE_HANGUP_MS || 60000));
  }

  _promptVariationEnabled() {
    const settings = this.ssot?.settings || {};
    return isTruthy(settings.PROMPT_VARIATION_BLOCK_ENABLED ?? this.env.PROMPT_VARIATION_BLOCK_ENABLED, true);
  }

  _buildPrompt(level) {
    const settings = this.ssot?.settings || {};
    const context = this.memory?.getSilenceContext?.() || "general";
    const base1 = safeStr(settings.SILENCE_PROMPT_1 || this.env.SILENCE_PROMPT_1) || "רק לבדוק שאתם עדיין איתי, במה אפשר לעזור?";
    const base2 = safeStr(settings.SILENCE_PROMPT_2 || this.env.SILENCE_PROMPT_2) || "אם נוח, תגידו לי בקצרה מה הפנייה.";
    const base3 = safeStr(settings.SILENCE_PROMPT_3 || this.env.SILENCE_PROMPT_3) || "אם תרצו, אפשר לסיים כאן או לתאם שיחזרו אליכם.";

    if (context === "opening") {
      if (level === 1) return "אני כאן. איך קוראים לכם בבקשה?";
      if (level === 2) return "רק כדי לרשום נכון, איך קוראים לכם?";
      return "אם לא נוח עכשיו, נסיים כאן ואפשר להתקשר שוב כשנוח.";
    }

    if (context === "callback") {
      if (level === 1) return "אני כאן. רק תגידו לי אם לחזור למספר הזה או למספר אחר.";
      if (level === 2) return "לחזור למספר שממנו התקשרתם או למספר אחר?";
      return "אם לא נוח עכשיו, אפשר לסיים כאן ולחזור אלינו שוב אחר כך.";
    }

    if (context === "reports") {
      if (level === 1) return "אני כאן. אפשר לפרט בקצרה איזה דוחות אתם צריכים?";
      if (level === 2) return "זה דוחות שנתיים, אישורים או משהו אחר?";
      return "אם לא נוח עכשיו, אפשר לסיים כאן ולחזור אלינו שוב אחר כך.";
    }

    if (context === "lead") {
      if (level === 1) return "אני כאן. אפשר להגיד לי בקצרה במה מדובר?";
      if (level === 2) return "זה קשור להנהלת חשבונות, דוחות או משהו אחר?";
      return "אם לא נוח עכשיו, אפשר לסיים כאן ולחזור אלינו שוב אחר כך.";
    }

    if (level === 1) return base1;
    if (level === 2) return base2;
    return base3;
  }

  _buildLongSilencePrompt() {
    const settings = this.ssot?.settings || {};
    return safeStr(settings.LONG_SILENCE_FINAL_PROMPT || this.env.LONG_SILENCE_FINAL_PROMPT)
      || "לא נשמע שיש מענה, אז אני מנתקת את השיחה כרגע. אפשר להתקשר שוב כשנוח.";
  }

  _scheduleNext() {
    this._clearTimer();
    if (!this.referenceAt) return;
    const maxReprompts = this._getMaxReprompts();
    const nextLevel = Math.min(maxReprompts, this.currentLevel + 1);
    if (nextLevel <= this.currentLevel) return;
    const delay = this._getThreshold(nextLevel);
    const dueAt = this.referenceAt + delay;
    const ms = Math.max(120, dueAt - Date.now());
    this.timer = setTimeout(() => this._fire(nextLevel), ms);
  }

  _scheduleLongSilence() {
    this._clearLongSilenceTimer();
    if (!this.longSilenceAnchorAt || !this._longSilenceEnabled()) return;
    const dueAt = this.longSilenceAnchorAt + this._getLongSilenceMs();
    const ms = Math.max(250, dueAt - Date.now());
    this.longSilenceTimer = setTimeout(() => this._fireLongSilence(), ms);
  }

  _fire(level) {
    const maxReprompts = this._getMaxReprompts();
    const nextLevel = Math.min(level, maxReprompts);
    const text = this._buildPrompt(nextLevel);
    if (!text) return;
    if (this._promptVariationEnabled() && this.lastPromptText && this.lastPromptText === text) return;

    this.currentLevel = nextLevel;
    this.lastPromptText = text;
    this.memory?.noteSilence?.();
    this.onPrompt({ level: nextLevel, text, context: this.memory?.getSilenceContext?.() || "general" });
    if (nextLevel >= maxReprompts && isTruthy(this.ssot?.settings?.SILENCE_FORCE_HANGUP_ON_MAX ?? this.env.SILENCE_FORCE_HANGUP_ON_MAX, false) && !this._longSilenceEnabled()) {
      this._fireLongSilence();
    }
  }

  _fireLongSilence() {
    this._clearTimer();
    this._clearLongSilenceTimer();
    if (!this.longSilenceAnchorAt) return;
    this.currentLevel = this._getMaxReprompts();
    this.memory?.noteSilence?.();
    this.onLongSilence({
      text: this._buildLongSilencePrompt(),
      context: this.memory?.getSilenceContext?.() || "general",
      timeoutMs: this._getLongSilenceMs(),
    });
  }

  arm(reference = Date.now(), options = {}) {
    const opts = options && typeof options === "object" ? options : {};
    const nowRef = Number(reference) || Date.now();
    this._clearTimer();
    this.referenceAt = nowRef;
    this.currentLevel = opts.preserveProgress ? this.currentLevel : 0;
    this.lastPromptText = opts.preserveProgress ? this.lastPromptText : "";
    if (!opts.preserveLongSilenceAnchor || !this.longSilenceAnchorAt) this.longSilenceAnchorAt = nowRef;
    this._scheduleNext();
    this._scheduleLongSilence();
  }

  afterAssistantPrompt(level) {
    const numericLevel = Math.max(1, Number(level) || this.currentLevel || 1);
    this.currentLevel = numericLevel;
    if (numericLevel < this._getMaxReprompts()) this._scheduleNext();
    else this._clearTimer();
    this._scheduleLongSilence();
  }

  reset(reference = Date.now()) {
    this._clearTimer();
    this._clearLongSilenceTimer();
    this.referenceAt = Number(reference) || Date.now();
    this.longSilenceAnchorAt = this.referenceAt;
    this.currentLevel = 0;
    this.lastPromptText = "";
    this._scheduleNext();
    this._scheduleLongSilence();
  }

  stop() {
    this.referenceAt = 0;
    this.longSilenceAnchorAt = 0;
    this.currentLevel = 0;
    this.lastPromptText = "";
    this._clearTimer();
    this._clearLongSilenceTimer();
  }
}

module.exports = { SilenceManager };
