"use strict";

const { SUPPORTED_SETTING_KEYS } = require("../config/settingCatalog");

const REQUIRED_PROMPT_IDS = Object.freeze([
  "MASTER_PROMPT",
  "GUARDRAILS_PROMPT",
  "KB_PROMPT",
  "LEAD_CAPTURE_PROMPT",
  "INTENT_ROUTER_PROMPT",
  "LEAD_PARSER_PROMPT",
]);

function safeStr(value) {
  return value === undefined || value === null ? "" : String(value).trim();
}

function uniq(values) {
  return Array.from(new Set((Array.isArray(values) ? values : []).filter(Boolean)));
}

function collectDuplicateIds(values) {
  const seen = new Set();
  const duplicates = new Set();
  for (const value of values || []) {
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
    row.suggested_intent_id ||
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

function validateSsotSnapshot(ssot) {
  const settings = ssot?.settings || {};
  const prompts = ssot?.prompts || {};
  const promptRows = Array.isArray(ssot?.prompts_rows) ? ssot.prompts_rows : [];
  const intents = Array.isArray(ssot?.intents) ? ssot.intents : [];
  const intentSuggestions = Array.isArray(ssot?.intent_suggestions) ? ssot.intent_suggestions : [];
  const scriptSuggestions = Array.isArray(ssot?.script_suggestions) ? ssot.script_suggestions : [];
  const kbSuggestions = Array.isArray(ssot?.kb_suggestions) ? ssot.kb_suggestions : [];

  const missingPromptIds = REQUIRED_PROMPT_IDS.filter((id) => !safeStr(prompts[id]));
  const duplicatePromptIds = collectDuplicateIds(
    promptRows.map((row) => row?.PromptId || row?.prompt_id || row?.key)
  );
  const duplicateIntentIds = collectDuplicateIds(intents.map((row) => row?.intent_id));
  const missingSupportedSettings = SUPPORTED_SETTING_KEYS.filter((key) => !Object.prototype.hasOwnProperty.call(settings, key));

  const knownIntentIds = new Set(intents.map((row) => safeStr(row?.intent_id)).filter(Boolean));
  const unknownSuggestionIntentReferences = {
    intent_suggestions: [],
    script_suggestions: [],
    kb_suggestions: [],
  };

  intentSuggestions.forEach((row, index) => {
    const intentId = extractSuggestionIntentId(row);
    if (intentId && !knownIntentIds.has(intentId)) {
      unknownSuggestionIntentReferences.intent_suggestions.push({ index, intent_id: intentId });
    }
  });
  scriptSuggestions.forEach((row, index) => {
    const intentId = extractSuggestionIntentId(row);
    if (intentId && !knownIntentIds.has(intentId)) {
      unknownSuggestionIntentReferences.script_suggestions.push({ index, intent_id: intentId });
    }
  });
  kbSuggestions.forEach((row, index) => {
    const intentId = extractSuggestionIntentId(row);
    if (intentId && !knownIntentIds.has(intentId)) {
      unknownSuggestionIntentReferences.kb_suggestions.push({ index, intent_id: intentId });
    }
  });

  // Warn when lead-type intents have no slot schema — these will not drive dynamic collection.
  const intentsWithoutSlotSchema = intents
    .filter((row) => {
      const type = safeStr(row?.intent_type).toLowerCase();
      const hasRequired = Array.isArray(row?.required_slots) && row.required_slots.length > 0;
      return type === "lead" && !hasRequired;
    })
    .map((row) => safeStr(row?.intent_id));

  const warnings = [];
  if (missingSupportedSettings.length) warnings.push(`missing_supported_settings:${missingSupportedSettings.join(",")}`);
  if (Object.values(unknownSuggestionIntentReferences).some((rows) => rows.length)) warnings.push("unknown_suggestion_intent_references");
  if (intentsWithoutSlotSchema.length) warnings.push(`intent_schema_incomplete:${intentsWithoutSlotSchema.join(",")}`);

  return {
    ok: missingPromptIds.length === 0 && duplicatePromptIds.length === 0 && duplicateIntentIds.length === 0,
    missing_required_prompt_ids: missingPromptIds,
    duplicate_prompt_ids: duplicatePromptIds,
    duplicate_intent_ids: duplicateIntentIds,
    missing_supported_settings: missingSupportedSettings,
    unknown_suggestion_intent_references: unknownSuggestionIntentReferences,
    intents_without_slot_schema: intentsWithoutSlotSchema,
    warnings: uniq(warnings),
  };
}

module.exports = {
  REQUIRED_PROMPT_IDS,
  validateSsotSnapshot,
};
