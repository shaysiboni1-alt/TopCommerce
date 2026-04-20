"use strict";

function raw(name, def = "") {
  const v = process.env[name];
  return v === undefined || v === null || v === "" ? def : v;
}

function parseBool(v, def = false) {
  if (v === undefined || v === null || v === "") return def;
  const s = String(v).trim().toLowerCase();
  if (["1", "true", "yes", "y", "on"].includes(s)) return true;
  if (["0", "false", "no", "n", "off"].includes(s)) return false;
  return def;
}

function parseIntSafe(v, def) {
  if (v === undefined || v === null || v === "") return def;
  const n = parseInt(String(v).trim(), 10);
  return Number.isFinite(n) ? n : def;
}

function parseFloatSafe(v, def) {
  if (v === undefined || v === null || v === "") return def;
  const n = parseFloat(String(v).trim());
  return Number.isFinite(n) ? n : def;
}

const SECRET_KEYS = new Set([
  "DATABASE_URL",
  "GEMINI_API_KEY",
  "GEMINI_PROJECT_ID",
  "GOOGLE_SERVICE_ACCOUNT_JSON_B64",
  "SUPABASE_SERVICE_ROLE_KEY",
  "SUPABASE_USAGE_WEBHOOK_SECRET",
  "TWILIO_ACCOUNT_SID",
  "TWILIO_AUTH_TOKEN",
  "RUNTIME_ADMIN_TOKEN",
  "GSHEET_ID",
]);

// Runtime/business settings are loaded primarily from Google Sheets (SSOT).
// The values here are in-memory defaults and safe fallback values only.
const SETTING_DEFAULTS = {
  BUSINESS_NAME: "",
  BOT_NAME: "",
  DEFAULT_LANGUAGE: "he",
  MAIN_PHONE: "",
  BUSINESS_EMAIL: "",
  BUSINESS_ADDRESS: "",
  WORKING_HOURS: "",
  BUSINESS_WEBSITE_URL: "",
  VOICE_NAME: "Callirrhoe",
  OPENING_SCRIPT: "",
  OPENING_SCRIPT_RETURNING: "",
  NO_DATA_MESSAGE: "אין לי את המידע הזה כרגע, אבל אפשר להשאיר פנייה למשרד והם יחזרו אליכם.",
  SUBJECT_MIN_WORDS: 3,
  CALLBACK_ASK_PHRASE: "כדי שנוכל לחזור אליכם, לחזור למספר שממנו התקשרתם או למספר אחר?",
  CALLBACK_RETRY_PHRASE: "לא הצלחתי לקלוט את המספר, תוכלו לומר אותו שוב בבקשה?",
  CALLBACK_CONFIRM_NEW_NUMBER_TEMPLATE: "רק לוודא, המספר הוא {DIGITS_SPOKEN}. זה נכון?",
  CLOSING_sales: "",
  CLOSING_support: "",
  CLOSING_callback: "",
  CLOSING_info: "",
  CLOSING_other: "",
  CLOSING_ASK_MORE: "יש משהו נוסף שתרצו להוסיף?",
  CLOSING_GOODBYE: "",
  UNSUPPORTED_LANGUAGE_MESSAGE: "מצטערת, כרגע אני מדברת בעברית אלא אם תבקשו אחרת.",
  CALLBACK_WITHHELD_MESSAGE: "שימו לב שהמספר שממנו התקשרתם חסוי, לכן אצטרך מספר טלפון לחזרה.",
  LEAD_MODE: "intent_based",
  BUSINESS_DESCRIPTION: "",
  BUSINESS_OWNER: "",
  BUSINESS_EXPERIENCE_YEARS: "",
  BUSINESS_EXPERTISE: "",
  BUSINESS_AUTHORITIES_REPRESENTATION: "",
  BUSINESS_SPECIAL_NOTES: "",
  BUSINESS_SERVICES_LIST: "",
  BLOCKED_CALLERS: "",
  CALL_LOG_WEBHOOK_URL: "",
  FINAL_WEBHOOK_URL: "",
  ABANDONED_WEBHOOK_URL: "",
  SUPABASE_USAGE_WEBHOOK_URL: "",
  WHATSAPP_SUMMARY_WEBHOOK_URL: "",
  CALL_LOG_AT_START: false,
  CALL_LOG_AT_END: true,
  CALL_LOG_MODE: "end",
  FINAL_ON_STOP: false,
  FORCE_HANGUP_AFTER_CLOSE: true,
  HANGUP_AFTER_CLOSE_GRACE_MS: 10000,
  GEMINI_AUDIO_IN_FORMAT: "ulaw8k",
  GEMINI_AUDIO_OUT_FORMAT: "ulaw8k",
  VOICE_NAME_OVERRIDE: "Callirrhoe",
  MB_VAD_THRESHOLD: 0.60,
  MB_VAD_SILENCE_MS: 300,
  MB_VAD_PREFIX_MS: 100,
  MB_AEC_ENABLED: true,
  MB_AEC_HISTORY_MS: 900,
  MB_AEC_SEARCH_MS: 180,
  MB_AEC_STRENGTH: 0.78,
  MB_AEC_CORR_THRESHOLD: 0.78,
  MB_AEC_DUCK_THRESHOLD: 0.62,
  MB_AEC_NEAR_SPEECH_FLOOR: 0.016,
  MB_AEC_ECHO_FLOOR: 0.010,
  MB_INTERRUPT_RECOVERY_ENABLED: true,
  MB_INTERRUPT_RECOVERY_WINDOW_MS: 2500,
  MB_AUDIO_NOISE_GATE_FLOOR: 280,
  MB_AUDIO_AGC_TARGET_RMS: 0.14,
  MB_AUDIO_AGC_MAX_GAIN: 4.0,
  MB_AUDIO_HIGHPASS_ALPHA: 0.97,
  MB_BARGE_IN_RMS_THRESHOLD: 0.028,
  MB_BARGE_IN_MIN_FRAMES: 2,
  MB_BARGEIN_ENABLED: true,
  MB_BARGEIN_MIN_MS: 110,
  MB_BARGEIN_COOLDOWN_MS: 130,
  MB_BARGEIN_AUDIO_DROP_MS: 35,
  MB_ENABLE_RECORDING: true,
  RECORDING_PROXY_TIMEOUT_MS: 20000,
  SILENCE_T1_MS: 4500,
  SILENCE_T2_MS: 8000,
  SILENCE_T3_MS: 12000,
  SILENCE_PROMPT_1: "",
  SILENCE_PROMPT_2: "",
  SILENCE_PROMPT_3: "",
  SILENCE_MAX_REPROMPTS: 3,
  SILENCE_FORCE_HANGUP_ON_MAX: false,
  PROMPT_VARIATION_BLOCK_ENABLED: true,
  ACTIVE_STEP_LOCK_ENABLED: true,
  SUBJECT_REASK_MAX: 2,
  LEAD_PARSER_ENABLED: true,
  LEAD_PARSER_MODE: "postcall",
  LEAD_PARSER_MODEL: "gemini-2.0-flash",
  LEAD_SUMMARY_STYLE: "crm_short",
  MB_ACK_NAME_TEMPLATE: "תודה {name}, איך אפשר לעזור?",
  MB_DEFAULT_LANGUAGE: "he",
  MB_LANGUAGE_SWITCH_MIN_CONSECUTIVE_UTTERANCES: 4,
  MB_LANGUAGE_LOCK_ENABLED: true,
  MB_USER_UTTERANCE_FLUSH_MS: 700,
  MB_BOT_UTTERANCE_FLUSH_MS: 900,
  MB_MIN_STABLE_UTTERANCE_CHARS: 4,
  MB_NUMERIC_CONTINUATION_GRACE_MS: 900,
  MB_LOW_LATENCY_MODE: true,
  MB_NAME_MAX_ATTEMPTS: 2,
  MB_REQUIRE_NAME_BEFORE_DETAILS: true,
  MB_LOG_TRANSCRIPTS: true,
  MB_LOG_TURNS: false,
  MB_LOG_TURNS_MAX_CHARS: 900,
  MB_LOG_ASSISTANT_TEXT: false,
  MB_DEBUG: false,
  PROVIDER_MODE: "gemini",
  GEMINI_LIVE_MODEL: "gemini-2.5-flash-native-audio-preview-12-2025",
  GEMINI_LOCATION: "us-central1",
  PUBLIC_BASE_URL: "",
  SSOT_TTL_MS: 60000,
  TIME_ZONE: "Asia/Jerusalem",
  FINAL_RULE_MODE: "twilio_completed_name_phone",
  ABANDONED_RULE_MODE: "ended_before_complete",
  MIN_CALL_DURATION_FOR_FINAL: 0,
  MIN_UTTERANCES_FOR_FINAL: 0,
  WHATSAPP_SUMMARY_WEBHOOK_ENABLED: true,
  CALL_LOG_WEBHOOK_ENABLED: true,
  COMPLETE_WEBHOOK_ENABLED: true,
  ABANDONED_WEBHOOK_ENABLED: true,
  WEBHOOK_TIMEOUT_MS: 10000,
  WEBHOOK_RETRY_COUNT: 1,
  CALLBACK_ALT_NUMBER_PHRASE: "אין בעיה, לאיזה מספר תרצו שנחזור?",
  REPORTS_ASK_TYPE_PHRASE: "תפרטו בבקשה אילו דוחות אתם צריכים.",
  REPORTS_ASK_PERIOD_PHRASE: "לאיזו תקופה אתם צריכים את הדוחות?",
  REPORTS_ASK_FORWHOM_PHRASE: "עבור מי או עבור איזה עסק אתם צריכים את הדוחות?",
  MB_OPENING_PHASE_MAX_MS: 12000,
  MB_USER_TRANSCRIPT_FLUSH_MS: 420,
  MB_USER_TRANSCRIPT_STABLE_GAP_MS: 360,
  MB_USER_TRANSCRIPT_MIN_CHARS: 6,
  MB_USER_TRANSCRIPT_MIN_WORDS: 2,
  MB_USER_TRANSCRIPT_MAX_BUFFER_MS: 1400,
  MB_BOT_TRANSCRIPT_FLUSH_MS: 320,
  MB_BOT_TRANSCRIPT_STABLE_GAP_MS: 220,
  MB_END_CALL_DELAY_MS: 5000,
  WHATSAPP_SUMMARY_TEMPLATE: "בהמשך לשיחתנו פניתם אלינו בעניין {topic}. הנושא הועבר ויטופל בהקדם",
  CALLBACK_CONFIRMATION_MIN_CONFIDENCE: 0.78,
  CALLBACK_CONFIRMATION_REASK_MAX: 2,
  CALLBACK_CONFIRMATION_ENDPOINT_MS: 1400,
  CALLBACK_CONFIRMATION_REQUIRE_EXPLICIT_MATCH: true,
  NOISY_ENV_SHORT_UTTERANCE_MIN_CHARS: 4,
  NOISY_ENV_UNCLEAR_REASK_ENABLED: true,
  NOISY_ENV_UNKNOWN_LANG_HOLD_STATE: true,
  BARGE_IN_MIN_RMS_CALLBACK_STATE: 0.18,
  BARGE_IN_MIN_DURATION_MS_CALLBACK_STATE: 260,
  ASSISTANT_FRAGMENT_MIN_LENGTH: 8,
  ASSISTANT_FRAGMENT_BLOCK_ENABLED: true,
  KNOWN_CALLER_NAME_ECHO_BLOCK_ENABLED: true,
  CLOSING_BARGE_IN_MIN_RMS: 0.22,
  CLOSING_BARGE_IN_MIN_DURATION_MS: 320,
  CLOSING_REOPEN_ON_WEAK_SPEECH: false,
  LONG_SILENCE_HANGUP_ENABLED: true,
  LONG_SILENCE_HANGUP_MS: 120000,
  LONG_SILENCE_FINAL_PROMPT: "לא נשמע שיש מענה, אז אני מנתקת את השיחה כרגע. אפשר להתקשר שוב כשנוח.",
  OPENING_PROTECTION_STRICT: true,
  OPENING_BARGE_IN_MIN_RMS: 0.06,
  OPENING_BARGE_IN_MIN_DURATION_MS: 260,
  OPENING_BARGE_IN_MIN_FRAMES: 4,
  NOISE_STATE_CHANGE_BLOCK_ENABLED: true,
  BARGE_IN_REQUIRE_SPEECH_LIKELIHOOD: true,
  SLOT_MANAGER_ENABLED: false,
  PORT: 10000,
};

function castSettingValue(key, value) {
  const def = SETTING_DEFAULTS[key];
  if (typeof def === "boolean") return parseBool(value, def);
  if (typeof def === "number" && Number.isInteger(def)) return parseIntSafe(value, def);
  if (typeof def === "number") return parseFloatSafe(value, def);
  return value === undefined || value === null ? def : String(value);
}

const env = {
  DATABASE_URL: raw("DATABASE_URL", ""),
  GEMINI_API_KEY: raw("GEMINI_API_KEY", ""),
  GEMINI_PROJECT_ID: raw("GEMINI_PROJECT_ID", ""),
  GOOGLE_SERVICE_ACCOUNT_JSON_B64: raw("GOOGLE_SERVICE_ACCOUNT_JSON_B64", ""),
  SUPABASE_SERVICE_ROLE_KEY: raw("SUPABASE_SERVICE_ROLE_KEY", ""),
  SUPABASE_USAGE_WEBHOOK_SECRET: raw("SUPABASE_USAGE_WEBHOOK_SECRET", ""),
  TWILIO_ACCOUNT_SID: raw("TWILIO_ACCOUNT_SID", ""),
  TWILIO_AUTH_TOKEN: raw("TWILIO_AUTH_TOKEN", ""),
  RUNTIME_ADMIN_TOKEN: raw("RUNTIME_ADMIN_TOKEN", ""),
  GSHEET_ID: raw("GSHEET_ID", ""),
  LOCAL_RECORDINGS_DIR: raw("LOCAL_RECORDINGS_DIR", ""),
  RECORDING_CACHE_DIR: raw("RECORDING_CACHE_DIR", ""),
  RECORDING_STATUS_TIMEOUT_MS: parseIntSafe(raw("RECORDING_STATUS_TIMEOUT_MS", 8000), 8000),
  RECORDING_TOTAL_TIMEOUT_MS: parseIntSafe(raw("RECORDING_TOTAL_TIMEOUT_MS", 12000), 12000),
  PORT: parseIntSafe(raw("PORT", SETTING_DEFAULTS.PORT), SETTING_DEFAULTS.PORT),
};

function hydrateDefaults() {
  for (const [key, def] of Object.entries(SETTING_DEFAULTS)) {
    if (key === "PORT") {
      env[key] = parseIntSafe(raw("PORT", def), def);
      continue;
    }
    env[key] = castSettingValue(key, def);
  }
}

hydrateDefaults();

function applyRuntimeSettings(settings = {}) {
  for (const [key, value] of Object.entries(settings || {})) {
    if (!Object.prototype.hasOwnProperty.call(SETTING_DEFAULTS, key)) continue;
    env[key] = castSettingValue(key, value);
  }
}

function getPublicRuntimeConfig() {
  const out = {};
  for (const key of Object.keys(SETTING_DEFAULTS)) out[key] = env[key];
  return out;
}

module.exports = {
  env,
  SECRET_KEYS,
  SETTING_DEFAULTS,
  parseBool,
  parseIntSafe,
  parseFloatSafe,
  applyRuntimeSettings,
  getPublicRuntimeConfig,
};
