"use strict";

const { finalizeThroughCoordinator } = require("../finalization/finalizationCoordinator");

async function ensureFinalized({ callSid, source, twilioStatus, durationSeconds }) {
  return finalizeThroughCoordinator({
    callSid,
    source,
    twilioStatus,
    durationSeconds,
  });
}

module.exports = { ensureFinalized };
