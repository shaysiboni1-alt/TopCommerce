"use strict";

// Canonical call state definitions (scaffolding only)
// No runtime wiring

const CALL_STATES = Object.freeze({
  INIT: "INIT",
  CONNECTING: "CONNECTING",
  ACTIVE: "ACTIVE",
  INTERRUPTED: "INTERRUPTED",
  CLOSING: "CLOSING",
  FINALIZING: "FINALIZING",
  FINALIZED: "FINALIZED",
});

function isTerminalState(state) {
  return state === CALL_STATES.FINALIZED;
}

function isActiveState(state) {
  return (
    state === CALL_STATES.CONNECTING ||
    state === CALL_STATES.ACTIVE ||
    state === CALL_STATES.INTERRUPTED ||
    state === CALL_STATES.CLOSING
  );
}

module.exports = {
  CALL_STATES,
  isTerminalState,
  isActiveState,
};
