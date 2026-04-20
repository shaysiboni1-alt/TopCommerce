"use strict";

const ACTIONS = Object.freeze({
  CONTINUE: "CONTINUE",
  CLOSE_NORMAL: "CLOSE_NORMAL",
  CLOSE_FORCE: "CLOSE_FORCE",
  CLOSE_CALLER_EXIT: "CLOSE_CALLER_EXIT",
});

/**
 * Stateless closing decision evaluator.
 *
 * @param {object} params
 * @param {object} params.slotState      - SlotManager.snapshot()
 * @param {number} params.turnCount      - current total turn count
 * @param {object} params.intentSchema   - loaded SSOT intent schema (from slotManager.schema)
 * @param {object} [params.flags]        - { callerExitDetected, silenceTimeout }
 * @returns {{ action: string, reason: string, template: string|null }}
 */
function evaluate({ slotState, turnCount, intentSchema, flags = {} }) {
  if (!slotState?.schema_loaded || !intentSchema) {
    return { action: ACTIONS.CONTINUE, reason: "no_schema", template: null };
  }

  const maxTurns = Number(intentSchema.max_turns) || 10;
  const closingTemplate = String(intentSchema.closing_template || "CLOSING_other");
  const forceTemplate = String(intentSchema.force_close_template || "CLOSING_other");
  const isMinViable = !!slotState.is_minimum_viable;
  const currentTurn = Number(turnCount) || 0;

  // Rule 1 — Caller initiated exit and we have minimum viable data.
  if (flags.callerExitDetected && isMinViable) {
    return { action: ACTIONS.CLOSE_CALLER_EXIT, reason: "caller_exit_with_data", template: closingTemplate };
  }

  // Rule 2 — Hard ceiling reached. Close regardless of slot state.
  if (currentTurn >= maxTurns) {
    return { action: ACTIONS.CLOSE_FORCE, reason: "max_turns_reached", template: forceTemplate };
  }

  // Rule 3 — Minimum viable data collected. Normal close.
  if (isMinViable) {
    return { action: ACTIONS.CLOSE_NORMAL, reason: "minimum_viable_met", template: closingTemplate };
  }

  // Rule 4 — Keep collecting.
  return { action: ACTIONS.CONTINUE, reason: "slots_incomplete", template: null };
}

module.exports = { evaluate, ACTIONS };
