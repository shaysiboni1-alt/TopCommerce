"use strict";

const { google } = require("googleapis");
const { env, applyRuntimeSettings } = require("../config/env");
const { logger } = require("../utils/logger");
const { validateSsotSnapshot } = require("./ssotSchema");

let CACHE = {
  loaded_at: null,
  expires_at: 0,
  settings: {},
  prompts: {},
  prompts_rows: [],
  intents: [],
  intent_suggestions: [],
  script_suggestions: [],
  kb_suggestions: [],
  validation: null,
};

function stripOuterQuotes(s) {
  if (typeof s !== "string") return s;
  const t = s.trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) return t.slice(1, -1);
  return t;
}

function b64ToJson(b64) {
  const raw = stripOuterQuotes(b64 || "");
  if (!raw) return null;
  return JSON.parse(Buffer.from(raw, "base64").toString("utf8"));
}

function isCacheValid() {
  return Date.now() < (CACHE.expires_at || 0) && CACHE.loaded_at;
}

async function getSheetsClient() {
  const sheetId = String(env.GSHEET_ID || "").trim();
  if (!sheetId) throw new Error("Missing GSHEET_ID");
  const sa = b64ToJson(env.GOOGLE_SERVICE_ACCOUNT_JSON_B64);
  if (!sa || !sa.client_email || !sa.private_key) throw new Error("Missing/invalid GOOGLE_SERVICE_ACCOUNT_JSON_B64");
  const auth = new google.auth.JWT({
    email: sa.client_email,
    key: sa.private_key,
    scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
  });
  return { sheets: google.sheets({ version: "v4", auth }), sheetId };
}

function normalizeCell(v) {
  return v === undefined || v === null ? "" : String(v);
}

function sheetRows(valueRange) {
  const values = valueRange?.values || [];
  if (!Array.isArray(values) || values.length === 0) return { headers: [], rows: [] };
  const headers = (values[0] || []).map((h) => normalizeCell(h).trim());
  const rows = values.slice(1).map((r) => headers.reduce((acc, h, i) => {
    acc[h] = normalizeCell(r?.[i]);
    return acc;
  }, {})).filter((row) => Object.values(row).some((v) => String(v).trim() !== ""));
  return { headers, rows };
}

function rowsToSettings(rows) {
  const out = {};
  for (const row of rows) {
    const key = String(row.key || row.Key || "").trim();
    if (!key) continue;
    out[key] = normalizeCell(row.value);
  }
  return out;
}

function rowsToPrompts(rows) {
  const out = {};
  for (const row of rows) {
    const key = String(row.PromptId || row.prompt_id || row.key || "").trim();
    if (!key) continue;
    out[key] = normalizeCell(row.Content || row.content || row.value);
  }
  return out;
}

function rowsToIntents(rows) {
  return rows.map((row) => ({
    intent_id: normalizeCell(row.intent_id).trim(),
    intent_type: normalizeCell(row.intent_type).trim(),
    priority: Number(normalizeCell(row.priority).trim() || 0) || 0,
    triggers_he: normalizeCell(row.triggers_he),
    triggers_en: normalizeCell(row.triggers_en),
    triggers_ru: normalizeCell(row.triggers_ru),
    description_he: normalizeCell(row["הסבר בעברית"]),
    examples: normalizeCell(row["דוגמאות שימוש"]),
  })).filter((r) => r.intent_id);
}

function buildCacheFromSheets({ ttl, settingsSheet, promptsSheet, intentsSheet, intentSuggestionsSheet, scriptSuggestionsSheet, kbSuggestionsSheet }) {
  const settings = rowsToSettings(settingsSheet.rows);
  const prompts = rowsToPrompts(promptsSheet.rows);
  const intents = rowsToIntents(intentsSheet.rows);
  const nextCache = {
    loaded_at: new Date().toISOString(),
    expires_at: Date.now() + ttl,
    settings,
    prompts,
    prompts_rows: promptsSheet.rows,
    intents,
    intent_suggestions: intentSuggestionsSheet.rows,
    script_suggestions: scriptSuggestionsSheet.rows,
    kb_suggestions: kbSuggestionsSheet.rows,
    _headers: {
      settings: settingsSheet.headers,
      prompts: promptsSheet.headers,
      intents: intentsSheet.headers,
      intent_suggestions: intentSuggestionsSheet.headers,
      script_suggestions: scriptSuggestionsSheet.headers,
      kb_suggestions: kbSuggestionsSheet.headers,
    },
  };
  nextCache.validation = validateSsotSnapshot(nextCache);
  return nextCache;
}

async function loadSSOT(force = false) {
  const ttl = Number(env.SSOT_TTL_MS || 60000) || 60000;
  if (!force && isCacheValid()) return CACHE;

  const startedAt = Date.now();
  try {
    const { sheets, sheetId } = await getSheetsClient();
    const ranges = [
      "SETTINGS!A:E",
      "PROMPTS!A:D",
      "INTENTS!A:I",
      "INTENT_SUGGESTIONS!A:H",
      "SCRIPT_SUGGESTIONS!A:H",
      "KB_SUGGESTIONS!A:G",
    ];
    const resp = await sheets.spreadsheets.values.batchGet({ spreadsheetId: sheetId, ranges });
    const vrs = resp?.data?.valueRanges || [];

    const nextCache = buildCacheFromSheets({
      ttl,
      settingsSheet: sheetRows(vrs[0]),
      promptsSheet: sheetRows(vrs[1]),
      intentsSheet: sheetRows(vrs[2]),
      intentSuggestionsSheet: sheetRows(vrs[3]),
      scriptSuggestionsSheet: sheetRows(vrs[4]),
      kbSuggestionsSheet: sheetRows(vrs[5]),
    });

    applyRuntimeSettings(nextCache.settings);
    CACHE = nextCache;

    logger.info("SSOT loaded", {
      settings_keys: Object.keys(nextCache.settings).length,
      prompts_keys: Object.keys(nextCache.prompts).length,
      intents: nextCache.intents.length,
      validation_ok: nextCache.validation?.ok !== false,
      validation_warnings: nextCache.validation?.warnings || [],
      validation_missing_required_prompt_ids: nextCache.validation?.missing_required_prompt_ids || [],
      ms: Date.now() - startedAt,
    });

    return CACHE;
  } catch (error) {
    if (CACHE.loaded_at) {
      logger.warn("SSOT reload failed; keeping last-known-good cache", {
        error: error?.message || String(error),
        loaded_at: CACHE.loaded_at,
      });
      CACHE.expires_at = Date.now() + Math.max(5000, ttl);
      return CACHE;
    }
    throw error;
  }
}

function getSSOT() {
  return CACHE;
}

module.exports = { loadSSOT, getSSOT };
