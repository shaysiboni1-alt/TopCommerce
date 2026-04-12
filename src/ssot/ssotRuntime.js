"use strict";

const { getSSOT, loadSSOT } = require("./ssotClient");

const REQUIRED_PROMPT_IDS = Object.freeze([
  "MASTER_PROMPT",
  "GUARDRAILS_PROMPT",
  "KB_PROMPT",
  "LEAD_CAPTURE_PROMPT",
  "INTENT_ROUTER_PROMPT",
  "LEAD_PARSER_PROMPT",
]);

function safeStr(v) {
  return v === undefined || v === null ? "" : String(v).trim();
}

function safeArray(v) {
  return Array.isArray(v) ? v : [];
}

function safeObject(v) {
  return v && typeof v === "object" && !Array.isArray(v) ? v : {};
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function currentCache() {
  return safeObject(getSSOT());
}

function getSSOTSnapshot() {
  return clone(currentCache());
}

function getSettings() {
  return clone(safeObject(currentCache().settings));
}

function getSetting(key, fallback) {
  const settings = safeObject(currentCache().settings);
  if (!Object.prototype.hasOwnProperty.call(settings, key)) return fallback;
  return settings[key];
}

function getPrompts() {
  return clone(safeObject(currentCache().prompts));
}

function getPrompt(promptId, fallback) {
  const prompts = safeObject(currentCache().prompts);
  const key = safeStr(promptId);
  if (!key || !Object.prototype.hasOwnProperty.call(prompts, key)) return fallback;
  return prompts[key];
}

function getIntents() {
  return clone(safeArray(currentCache().intents));
}

function getIntentById(intentId) {
  const target = safeStr(intentId);
  if (!target) return null;
  const intents = safeArray(currentCache().intents);
  return clone(intents.find((item) => safeStr(item && item.intent_id) === target) || null);
}

function getIntentSuggestions() {
  return clone(safeArray(currentCache().intent_suggestions));
}

function getScriptSuggestions() {
  return clone(safeArray(currentCache().script_suggestions));
}

function getKBSuggestions() {
  return clone(safeArray(currentCache().kb_suggestions));
}

function getBlockedCallersRaw() {
  return safeStr(getSetting("BLOCKED_CALLERS", ""));
}

function getBlockedCallers() {
  const raw = getBlockedCallersRaw();
  if (!raw) return [];
  return raw
    .split(/[,\n;]/)
    .map((item) => safeStr(item))
    .filter(Boolean);
}

function collectDuplicateValues(values) {
  const seen = new Set();
  const duplicates = new Set();

  for (const value of values) {
    const key = safeStr(value);
    if (!key) continue;
    if (seen.has(key)) duplicates.add(key);
    seen.add(key);
  }

  return Array.from(duplicates);
}

function extractSuggestionIntentId(row) {
  if (!row || typeof row !== "object") return "";
  return safeStr(
    row.intent_id ||
      row.intentId ||
      row.IntentId ||
      row.parent_intent_id ||
      row.parent_intent ||
      row.canonical_intent_id ||
      row.related_intent_id ||
      row.linked_intent_id
  );
}

function validatePromptIds(ssot) {
  const prompts = safeObject(ssot.prompts);
  const missing = REQUIRED_PROMPT_IDS.filter((id) => !safeStr(prompts[id]));
  return {
    missing_required_prompt_ids: missing,
  };
}

function validateDuplicates(ssot) {
  const headers = safeObject(ssot._headers);
  const promptsRows = safeArray(ssot.prompts_rows);
  const intents = safeArray(ssot.intents);
  const settingsHeaders = safeArray(headers.settings);

  const promptIds = promptsRows.map((row) => safeStr(row && (row.PromptId || row.prompt_id || row.key)));
  const intentIds = intents.map((row) => safeStr(row && row.intent_id));

  return {
    duplicate_prompt_ids: collectDuplicateValues(promptIds),
    duplicate_intent_ids: collectDuplicateValues(intentIds),
    settings_headers: settingsHeaders,
  };
}

function validateSuggestions(ssot) {
  const intents = safeArray(ssot.intents);
  const knownIntentIds = new Set(
    intents.map((row) => safeStr(row && row.intent_id)).filter(Boolean)
  );

  const suggestionBuckets = {
    intent_suggestions: safeArray(ssot.intent_suggestions),
    script_suggestions: safeArray(ssot.script_suggestions),
    kb_suggestions: safeArray(ssot.kb_suggestions),
  };

  const unknownReferences = {};

  for (const [bucketName, rows] of Object.entries(suggestionBuckets)) {
    const missing = [];

    rows.forEach((row, index) => {
      const intentId = extractSuggestionIntentId(row);
      if (!intentId) return;
      if (!knownIntentIds.has(intentId)) {
        missing.push({
          index,
          intent_id: intentId,
        });
      }
    });

    unknownReferences[bucketName] = missing;
  }

  return {
    unknown_suggestion_intent_references: unknownReferences,
  };
}

function getValidationReport() {
  const ssot = currentCache();

  return {
    loaded_at: ssot.loaded_at || null,
    expires_at: ssot.expires_at || 0,
    ...validatePromptIds(ssot),
    ...validateDuplicates(ssot),
    ...validateSuggestions(ssot),
  };
}

async function ensureSSOTLoaded(force) {
  return loadSSOT(force === true);
}

module.exports = {
  REQUIRED_PROMPT_IDS,
  ensureSSOTLoaded,
  getSSOTSnapshot,
  getSettings,
  getSetting,
  getPrompts,
  getPrompt,
  getIntents,
  getIntentById,
  getIntentSuggestions,
  getScriptSuggestions,
  getKBSuggestions,
  getBlockedCallersRaw,
  getBlockedCallers,
  getValidationReport,
};
