"use strict";

const { env } = require("./env");
const { getSetting } = require("../ssot/ssotRuntime");

function safeStr(v) {
  return v === undefined || v === null ? "" : String(v).trim();
}

function safeInt(v, fallback) {
  const n = Number.parseInt(safeStr(v), 10);
  return Number.isFinite(n) ? n : fallback;
}

function getSettingFirst(key, fallback) {
  const fromSsot = getSetting(key, undefined);
  if (fromSsot !== undefined && fromSsot !== null && String(fromSsot).trim() !== "") return fromSsot;
  if (Object.prototype.hasOwnProperty.call(env, key) && env[key] !== undefined && env[key] !== null && String(env[key]).trim() !== "") return env[key];
  return fallback;
}

function applyTemplate(template, vars = {}) {
  const s = safeStr(template);
  return s.replace(/\{([A-Za-z0-9_]+)\}/g, (_, rawKey) => {
    const key = String(rawKey || "");
    return vars[key] ?? vars[key.toUpperCase()] ?? vars[key.toLowerCase()] ?? "";
  }).replace(/\s{2,}/g, " ").trim();
}

function digitsSpoken(value) {
  const digits = safeStr(value).replace(/\D/g, "");
  return digits.split("").join(" ");
}

function businessContextLines() {
  const rows = [
    ["BUSINESS_NAME", getSettingFirst("BUSINESS_NAME", env.BUSINESS_NAME)],
    ["BUSINESS_OWNER", getSettingFirst("BUSINESS_OWNER", env.BUSINESS_OWNER)],
    ["BUSINESS_DESCRIPTION", getSettingFirst("BUSINESS_DESCRIPTION", env.BUSINESS_DESCRIPTION)],
    ["BUSINESS_EXPERIENCE_YEARS", getSettingFirst("BUSINESS_EXPERIENCE_YEARS", env.BUSINESS_EXPERIENCE_YEARS)],
    ["BUSINESS_EXPERTISE", getSettingFirst("BUSINESS_EXPERTISE", env.BUSINESS_EXPERTISE)],
    ["BUSINESS_AUTHORITIES_REPRESENTATION", getSettingFirst("BUSINESS_AUTHORITIES_REPRESENTATION", env.BUSINESS_AUTHORITIES_REPRESENTATION)],
    ["BUSINESS_SPECIAL_NOTES", getSettingFirst("BUSINESS_SPECIAL_NOTES", env.BUSINESS_SPECIAL_NOTES)],
    ["BUSINESS_SERVICES_LIST", getSettingFirst("BUSINESS_SERVICES_LIST", env.BUSINESS_SERVICES_LIST)],
    ["WORKING_HOURS", getSettingFirst("WORKING_HOURS", env.WORKING_HOURS)],
    ["BUSINESS_ADDRESS", getSettingFirst("BUSINESS_ADDRESS", env.BUSINESS_ADDRESS)],
    ["BUSINESS_EMAIL", getSettingFirst("BUSINESS_EMAIL", env.BUSINESS_EMAIL)],
    ["MAIN_PHONE", getSettingFirst("MAIN_PHONE", env.MAIN_PHONE)],
    ["BUSINESS_WEBSITE_URL", getSettingFirst("BUSINESS_WEBSITE_URL", env.BUSINESS_WEBSITE_URL)],
  ];
  return rows.filter(([, v]) => safeStr(v)).map(([k, v]) => `${k}: ${safeStr(v)}`);
}

function resolveClosingKey(intentId = "other") {
  const raw = safeStr(intentId).toLowerCase();
  const direct = `CLOSING_${raw}`;
  if (getSettingFirst(direct, undefined) !== undefined) return direct;

  const aliases = {
    callback_request: "CLOSING_callback",
    reach_margarita: "CLOSING_callback",
    appointment_request: "CLOSING_callback",
    reports_request: "CLOSING_support",
    ask_contact_info: "CLOSING_info",
    leave_message: "CLOSING_other",
    price_question: "CLOSING_sales",
    product_interest: "CLOSING_sales",
    new_customer: "CLOSING_sales",
    business_customer: "CLOSING_sales",
    private_customer: "CLOSING_sales",
    existing_customer: "CLOSING_support",
    complaint: "CLOSING_support",
    business_opening_guidance: "CLOSING_sales",
    callback: "CLOSING_callback",
    support: "CLOSING_support",
    info: "CLOSING_info",
    sales: "CLOSING_sales",
    other: "CLOSING_other",
  };
  return aliases[raw] || "CLOSING_other";
}

function getClosingText(intentId = "other") {
  const key = resolveClosingKey(intentId);
  return safeStr(getSettingFirst(key, "")) || safeStr(getSettingFirst("CLOSING_GOODBYE", ""));
}

function getOpeningPhaseMaxMs() {
  return Math.max(4000, safeInt(getSettingFirst("MB_OPENING_PHASE_MAX_MS", env.MB_OPENING_PHASE_MAX_MS), 12000));
}

function getUserTranscriptFlushMs() {
  return Math.max(260, safeInt(getSettingFirst("MB_USER_TRANSCRIPT_FLUSH_MS", env.MB_USER_TRANSCRIPT_FLUSH_MS), 420));
}

function getUserTranscriptStableGapMs() {
  return Math.max(180, safeInt(getSettingFirst("MB_USER_TRANSCRIPT_STABLE_GAP_MS", env.MB_USER_TRANSCRIPT_STABLE_GAP_MS), 360));
}

function getUserTranscriptMinChars() {
  return Math.max(3, safeInt(getSettingFirst("MB_USER_TRANSCRIPT_MIN_CHARS", env.MB_USER_TRANSCRIPT_MIN_CHARS), 6));
}

function getUserTranscriptMinWords() {
  return Math.max(1, safeInt(getSettingFirst("MB_USER_TRANSCRIPT_MIN_WORDS", env.MB_USER_TRANSCRIPT_MIN_WORDS), 2));
}

function getUserTranscriptMaxBufferMs() {
  return Math.max(500, safeInt(getSettingFirst("MB_USER_TRANSCRIPT_MAX_BUFFER_MS", env.MB_USER_TRANSCRIPT_MAX_BUFFER_MS), 1400));
}

function getBotTranscriptFlushMs() {
  return Math.max(200, safeInt(getSettingFirst("MB_BOT_TRANSCRIPT_FLUSH_MS", env.MB_BOT_TRANSCRIPT_FLUSH_MS), 320));
}

function getBotTranscriptStableGapMs() {
  return Math.max(120, safeInt(getSettingFirst("MB_BOT_TRANSCRIPT_STABLE_GAP_MS", env.MB_BOT_TRANSCRIPT_STABLE_GAP_MS), 220));
}

module.exports = {
  safeStr,
  applyTemplate,
  digitsSpoken,
  businessContextLines,
  getClosingText,
  getOpeningPhaseMaxMs,
  getUserTranscriptFlushMs,
  getUserTranscriptStableGapMs,
  getUserTranscriptMinChars,
  getUserTranscriptMinWords,
  getUserTranscriptMaxBufferMs,
  getBotTranscriptFlushMs,
  getBotTranscriptStableGapMs,
  getSettingFirst,
};
