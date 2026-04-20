"use strict";

const DEFAULT_MAX_ATTEMPTS = 2;

function safeStr(v) {
  return v === undefined || v === null ? "" : String(v).trim();
}

class SlotManager {
  constructor() {
    this.schema = null;
    this._collected = {};
    this._attempts = {};
    this._dropped = {};
    this._pending = {};
  }

  /**
   * Load intent schema from an SSOT intent row.
   * Existing collected slots are preserved — init can be called mid-call when intent resolves.
   */
  init(schema) {
    if (!schema || typeof schema !== "object") return;
    this.schema = {
      intent_id: safeStr(schema.intent_id),
      intent_type: safeStr(schema.intent_type),
      required_slots: Array.isArray(schema.required_slots) ? schema.required_slots.map(safeStr).filter(Boolean) : [],
      minimum_viable_slots: Array.isArray(schema.minimum_viable_slots) ? schema.minimum_viable_slots.map(safeStr).filter(Boolean) : [],
      optional_slots: Array.isArray(schema.optional_slots) ? schema.optional_slots.map(safeStr).filter(Boolean) : [],
      slot_max_attempts: (schema.slot_max_attempts && typeof schema.slot_max_attempts === "object") ? schema.slot_max_attempts : {},
      max_turns: Number(schema.max_turns) || 10,
      closing_template: safeStr(schema.closing_template) || "CLOSING_other",
      force_close_template: safeStr(schema.force_close_template) || "CLOSING_other",
    };
  }

  _maxAttemptsFor(key) {
    if (!this.schema) return DEFAULT_MAX_ATTEMPTS;
    const v = this.schema.slot_max_attempts[key];
    return (Number.isFinite(Number(v)) && Number(v) > 0) ? Number(v) : DEFAULT_MAX_ATTEMPTS;
  }

  /**
   * Commit a confirmed slot value.
   * Returns false if: key/value empty, slot already dropped, or would downgrade an explicit slot.
   */
  commit(key, value, confidence = "explicit", source = "unknown") {
    const k = safeStr(key);
    const v = safeStr(value);
    if (!k || !v) return false;
    if (this._dropped[k]) return false;
    const existing = this._collected[k];
    if (existing && existing.confidence === "explicit" && confidence !== "explicit" && source !== "explicit_correction") {
      return false;
    }
    this._collected[k] = { value: v, confidence, source, committed_at: Date.now() };
    delete this._pending[k];
    return true;
  }

  /**
   * Record a failed collection attempt for a slot.
   * Automatically drops the slot when max_attempts is reached.
   * Returns the new attempt count, or 0 if slot is already collected/dropped.
   */
  noteAttempt(key) {
    const k = safeStr(key);
    if (!k || this._dropped[k] || this._collected[k]) return 0;
    this._attempts[k] = (this._attempts[k] || 0) + 1;
    if (this._attempts[k] >= this._maxAttemptsFor(k)) {
      this.drop(k);
    }
    return this._attempts[k];
  }

  /** Permanently abandon a slot. After drop it will not be re-asked. */
  drop(key) {
    const k = safeStr(key);
    if (!k) return;
    this._dropped[k] = true;
    delete this._pending[k];
  }

  /**
   * Mark a high-stakes slot as pending confirmation.
   * The slot is not committed until confirmPending() is called.
   */
  setPending(key, value, confidence = "inferred") {
    const k = safeStr(key);
    const v = safeStr(value);
    if (!k || !v) return;
    this._pending[k] = { value: v, confidence };
  }

  /** Confirm a pending slot — upgrades it to explicit and commits. */
  confirmPending(key) {
    const k = safeStr(key);
    if (!k || !this._pending[k]) return false;
    const { value } = this._pending[k];
    return this.commit(k, value, "explicit", "confirmed");
  }

  /** Discard a pending slot and count it as a failed attempt. */
  cancelPending(key) {
    const k = safeStr(key);
    if (!k) return;
    delete this._pending[k];
    this.noteAttempt(k);
  }

  /** True if slot has not been collected and has not been dropped. */
  shouldAsk(key) {
    const k = safeStr(key);
    if (!k) return false;
    return !this._collected[k] && !this._dropped[k];
  }

  /**
   * True if all minimum_viable_slots are either collected or dropped.
   * An empty minimum_viable_slots list means no minimum requirement (always viable).
   */
  isMinimumViable() {
    if (!this.schema) return false;
    const slots = this.schema.minimum_viable_slots;
    if (!slots.length) return true;
    return slots.every((k) => this._collected[k] || this._dropped[k]);
  }

  /**
   * True if all required_slots are either collected or dropped.
   */
  isComplete() {
    if (!this.schema) return false;
    const slots = this.schema.required_slots;
    if (!slots.length) return true;
    return slots.every((k) => this._collected[k] || this._dropped[k]);
  }

  /** Required slots that have not been collected and have not been dropped. */
  getMissing() {
    if (!this.schema) return [];
    return this.schema.required_slots.filter((k) => !this._collected[k] && !this._dropped[k]);
  }

  /** Keys of all slots that were abandoned after hitting max_attempts. */
  getDropped() {
    return Object.keys(this._dropped);
  }

  /** Serializable snapshot for CONTEXT_UPDATE injection and debug logging. */
  snapshot() {
    return {
      schema_loaded: !!this.schema,
      intent_id: this.schema?.intent_id || null,
      max_turns: this.schema?.max_turns || null,
      closing_template: this.schema?.closing_template || null,
      force_close_template: this.schema?.force_close_template || null,
      collected: Object.fromEntries(Object.entries(this._collected).map(([k, v]) => [k, { ...v }])),
      attempts: { ...this._attempts },
      dropped: Object.fromEntries(Object.keys(this._dropped).map((k) => [k, true])),
      pending: Object.fromEntries(Object.entries(this._pending).map(([k, v]) => [k, { ...v }])),
      missing: this.getMissing(),
      is_minimum_viable: this.isMinimumViable(),
      is_complete: this.isComplete(),
    };
  }
}

module.exports = { SlotManager };
