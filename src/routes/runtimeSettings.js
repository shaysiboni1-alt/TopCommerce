"use strict";

const express = require("express");
const { loadSSOT, getSSOT } = require("../ssot/ssotClient");

const router = express.Router();

function parseBlockedCallers(raw) {
  return String(raw || "")
    .split(",")
    .map((x) => String(x || "").trim())
    .filter(Boolean);
}

router.get("/runtime/blocked-callers", async (req, res) => {
  try {
    const adminToken = String(req.headers["x-admin-token"] || "").trim();
    const expectedToken = String(process.env.RUNTIME_ADMIN_TOKEN || "").trim();

    if (!expectedToken || adminToken !== expectedToken) {
      return res.status(401).json({ ok: false, error: "unauthorized" });
    }

    let ssot = getSSOT();
    const hasSettings =
      ssot && ssot.settings && Object.keys(ssot.settings).length > 0;

    if (!hasSettings) {
      ssot = await loadSSOT(false);
    }

    const blocked = parseBlockedCallers(ssot?.settings?.BLOCKED_CALLERS || "");

    return res.status(200).json({
      ok: true,
      blocked_callers: blocked,
    });
  } catch (e) {
    return res.status(200).json({
      ok: true,
      blocked_callers: [],
    });
  }
});

module.exports = { runtimeSettingsRouter: router };
