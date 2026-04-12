"use strict";

const express = require("express");
const {
  buildTimeline,
  buildCallDebugView,
  buildRecentCallsTimelineIndex,
} = require("../debug/timelineBuilder");

const router = express.Router();

function safeStr(v) {
  return v === undefined || v === null ? "" : String(v).trim();
}

function parsePositiveInt(value, fallbackValue) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallbackValue;
  return Math.floor(n);
}

function parseBoolean(value, fallbackValue) {
  const normalized = safeStr(value).toLowerCase();
  if (normalized === "true" || normalized === "1") return true;
  if (normalized === "false" || normalized === "0") return false;
  return !!fallbackValue;
}

router.get("/debug/calls", (req, res) => {
  const status = safeStr(req.query.status || "all").toLowerCase() || "all";
  const limit = parsePositiveInt(req.query.limit, 50);

  const items = buildRecentCallsTimelineIndex({
    status,
    limit,
  });

  res.json({
    items,
  });
});

router.get("/debug/calls/:callSid", (req, res) => {
  const callSid = safeStr(req.params.callSid);
  const includeCheckpoints = parseBoolean(req.query.includeCheckpoints, true);
  const compact = parseBoolean(req.query.compact, false);
  const category = safeStr(req.query.category || "");
  const type = safeStr(req.query.type || "");

  const view = buildCallDebugView(callSid, {
    includeCheckpoints,
    compact,
    category,
    type,
  });

  if (!view || !view.summary) {
    return res.status(404).json({
      error: "call_not_found",
      callSid,
    });
  }

  res.json(view);
});

router.get("/debug/calls/:callSid/timeline", (req, res) => {
  const callSid = safeStr(req.params.callSid);
  const includeCheckpoints = parseBoolean(req.query.includeCheckpoints, true);
  const compact = parseBoolean(req.query.compact, false);
  const category = safeStr(req.query.category || "");
  const type = safeStr(req.query.type || "");

  const view = buildCallDebugView(callSid, {
    includeCheckpoints,
    compact,
    category,
    type,
  });

  if (!view || !view.summary) {
    return res.status(404).json({
      error: "call_not_found",
      callSid,
    });
  }

  const timeline = buildTimeline(callSid, {
    includeCheckpoints,
    compact,
    category,
    type,
  });

  res.json({
    callSid,
    summary: view.summary,
    timeline,
  });
});

module.exports = {
  debugCallsRouter: router,
};
