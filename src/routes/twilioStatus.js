"use strict";

const express = require("express");
const https = require("https");
const { URL } = require("url");
const { logger } = require("../utils/logger");
const { ensureFinalized } = require("../logic/ensureFinalized");
const { env } = require("../config/env");

const twilioStatusRouter = express.Router();

const TERMINAL_STATUSES = new Set(["completed", "busy", "failed", "no-answer", "canceled"]);

function extractMeta(body) {
  return {
    callSid: body.CallSid || body.callSid || null,
    callStatus: String(body.CallStatus || body.callStatus || "").trim().toLowerCase() || null,
    from: body.From || body.from || null,
    to: body.To || body.to || null,
    apiVersion: body.ApiVersion || body.apiVersion || null,
    callDurationRaw: body.CallDuration || body.callDuration || body.duration || null,
  };
}

function parseDurationSeconds(value) {
  if (value === null || value === undefined || value === "") return 0;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.floor(n);
}

function getUsageWebhookConfig() {
  const url = String(env.SUPABASE_USAGE_WEBHOOK_URL || "").trim();
  const secret = String(env.SUPABASE_USAGE_WEBHOOK_SECRET || "").trim();
  return { url, secret, enabled: Boolean(url) };
}

function postJson(urlString, payload, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    let urlObj;
    try {
      urlObj = new URL(urlString);
    } catch (err) {
      return reject(new Error(`Invalid URL: ${urlString}`));
    }
    const data = Buffer.from(JSON.stringify(payload), "utf8");
    const req = https.request({
      method: "POST",
      hostname: urlObj.hostname,
      port: urlObj.port || 443,
      path: `${urlObj.pathname}${urlObj.search}`,
      headers: {
        "content-type": "application/json",
        "content-length": data.length,
        ...extraHeaders,
      },
    }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ statusCode: res.statusCode || 0, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

async function forwardUsageToSupabase(meta) {
  const cfg = getUsageWebhookConfig();
  if (!cfg.enabled) return;
  const durationSeconds = parseDurationSeconds(meta.callDurationRaw);
  if (meta.callStatus !== "completed" || durationSeconds <= 0) {
    logger.info("Supabase usage forwarding skipped: non-billable terminal call", {
      callSid: meta.callSid,
      callStatus: meta.callStatus,
      callDurationRaw: meta.callDurationRaw,
    });
    return;
  }
  const response = await postJson(cfg.url, {
    callSid: meta.callSid,
    callStatus: meta.callStatus,
    to: meta.to,
    durationSeconds,
  }, cfg.secret ? { "x-webhook-secret": cfg.secret } : {});
  if (response.statusCode < 200 || response.statusCode >= 300) {
    throw new Error(`Usage webhook failed with status ${response.statusCode}: ${response.body || "<empty>"}`);
  }
  logger.info("Supabase usage forwarding success", { callSid: meta.callSid, callStatus: meta.callStatus, to: meta.to, durationSeconds, statusCode: response.statusCode });
}

function handleTwilioStatus(req, res) {
  try {
    const body = req.body && typeof req.body === "object" ? req.body : {};
    const meta = extractMeta(body);
    logger.info("Twilio status webhook", meta);

    if (meta.callSid && meta.callStatus && TERMINAL_STATUSES.has(meta.callStatus)) {
      setImmediate(() => {
        ensureFinalized({
          callSid: meta.callSid,
          source: `twilio_status_${meta.callStatus}`,
          twilioStatus: meta.callStatus,
          durationSeconds: parseDurationSeconds(meta.callDurationRaw),
        }).catch((err) => {
          logger.warn("Twilio status finalize failed", { callSid: meta.callSid, callStatus: meta.callStatus, err: String(err?.message || err) });
        });
        forwardUsageToSupabase(meta).catch((err) => {
          logger.warn("Supabase usage forwarding failed", { callSid: meta.callSid, callStatus: meta.callStatus, to: meta.to, callDurationRaw: meta.callDurationRaw, err: String(err?.message || err) });
        });
      });
    }
  } catch (e) {
    logger.warn("Twilio status webhook parse error", { err: String(e?.message || e) });
  }

  res.status(200).type("text/plain").send("ok");
}

twilioStatusRouter.post("/twilio/status", handleTwilioStatus);
twilioStatusRouter.get("/twilio/status", handleTwilioStatus);
twilioStatusRouter.post("/twilio-status-callback", handleTwilioStatus);
twilioStatusRouter.get("/twilio-status-callback", handleTwilioStatus);

module.exports = { twilioStatusRouter };
