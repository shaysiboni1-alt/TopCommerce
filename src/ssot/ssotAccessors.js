"use strict";

const { getSSOT } = require("./ssotClient");

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function safeStr(value) {
  return value === undefined || value === null ? "" : String(value).trim();
}

function current() {
  return getSSOT() || {};
}

function getPromptByKey(key, fallback = "") {
  const prompts = current().prompts || {};
  const promptKey = safeStr(key);
  if (!promptKey) return fallback;
  return prompts[promptKey] || fallback;
}

function getRuntimeBehaviorSettings() {
  return clone(current().settings || {});
}

function getIntentCatalog() {
  return clone(current().intents || []);
}

function getBlockedCallers() {
  const settings = current().settings || {};
  const raw = safeStr(settings.BLOCKED_CALLERS || "");
  if (!raw) return [];
  return raw.split(/[,\n;]/).map((v) => safeStr(v)).filter(Boolean);
}

function getPromptStack() {
  const keys = [
    "MASTER_PROMPT",
    "GUARDRAILS_PROMPT",
    "KB_PROMPT",
    "LEAD_CAPTURE_PROMPT",
    "INTENT_ROUTER_PROMPT",
    "LEAD_PARSER_PROMPT",
  ];
  return keys.reduce((acc, key) => {
    acc[key] = getPromptByKey(key, "");
    return acc;
  }, {});
}

module.exports = {
  getPromptByKey,
  getRuntimeBehaviorSettings,
  getIntentCatalog,
  getBlockedCallers,
  getPromptStack,
};
