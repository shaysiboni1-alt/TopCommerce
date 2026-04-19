"use strict";

const { sanitizeCandidate, collapseHebrewSpacing } = require("../logic/nameExtractor");
const { normalizeUtterance } = require("../logic/hebrewNlp");

function normalizeModelName(m) {
  if (!m) return "";
  return m.startsWith("models/") ? m : `models/${m}`;
}

function safeStr(x) {
  if (x === undefined || x === null) return "";
  return String(x).trim();
}

function nowIso() {
  return new Date().toISOString();
}

function clampNum(n, min, max, fallback) {
  const v = Number(n);
  if (Number.isNaN(v)) return fallback;
  return Math.max(min, Math.min(max, v));
}

function normalizeCallerId(caller) {
  const s = (caller || "").trim();
  const low = s.toLowerCase();
  if (!s) return { value: "", withheld: true };
  if (["anonymous", "restricted", "unavailable", "unknown", "private", "withheld"].includes(low)) {
    return { value: s, withheld: true };
  }
  const digits = s.replace(/\D/g, "");
  return { value: s, withheld: digits.length < 5 };
}

function isTruthyEnv(v) {
  const s = String(v ?? "").trim().toLowerCase();
  return s === "true" || s === "1" || s === "yes" || s === "y";
}

function isClosingUtterance(text) {
  const t = safeStr(text);
  if (!t) return false;
  if (/(תודה\s*ו?להתראות|להתראות|ביי|נתראה|יום טוב|המשך יום נעים|אשמח לעזור שוב)/.test(t)) return true;
  if (/(спасибо.*до свидания|до свидания|пока)/i.test(t)) return true;
  if (/(thank(s)?\b.*(bye|goodbye)|\bbye\b|\bgoodbye\b)/i.test(t)) return true;
  return false;
}

function looksLikeReasoningText(text) {
  const t = safeStr(text);
  if (!t) return false;
  return (
    /\*\*.+\*\*/.test(t) ||
    /\b(Composing the Response|Confirming|Implementing|Addressing|Gathering|Finalizing|Prioritizing|Initiating|Acknowledge|Pinpointing|Reasoning|I(?:'| a)m now|I've|I have successfully|I will now|The user is asking|triggering the|based on the context|SETTINGS_CONTEXT|OPENING_SCRIPT|OPENING_SCRIPT_RETURNING|INTENT_ROUTER_PROMPT|LEAD_CAPTURE_PROMPT|MASTER_PROMPT|GUARDRAILS_PROMPT|KB_PROMPT|INTENTS_TABLE|INTENT_SUGGESTIONS_TABLE|SCRIPT_SUGGESTIONS_TABLE|KB_SUGGESTIONS_TABLE)\b/i.test(t) ||
    /^(?:לאחר קבלת השם יש לומר|ענה עכשיו רק במשפט הבא|יש לבחור תמיד|השיטס הוא מקור הידע|כאשר המתקשרים|אם המתקשרים|תחילת השיחה תמיד תהיה|המטרה הראשונה היא לקבל)/u.test(t)
  );
}

function scrubReasoningText(text) {
  if (!looksLikeReasoningText(text)) return safeStr(text);
  const quoted = safeStr(text).match(/["“](.+?)["”]/);
  if (quoted && quoted[1] && !looksLikeReasoningText(quoted[1])) return quoted[1].trim();
  return "";
}

function isAffirmativeUtterance(text) {
  const t = safeStr(text);
  if (!t) return false;
  return /^(אה,\s*)?(כן([.!?,\s]|$)|נכון([.!?,\s]|$)|אוקיי([.!?,\s]|$)|אוקי([.!?,\s]|$)|בסדר([.!?,\s]|$)|בטח([.!?,\s]|$)|יאללה([.!?,\s]|$))+/u.test(t);
}

function isNegativeUtterance(text) {
  const t = safeStr(text).toLowerCase();
  if (!t) return false;
  return /^(לא|לא נכון|לא לא|no|nope|nah|lo|لا)([.!?,\s]|$)/iu.test(t);
}

function containsCallbackRequest(text) {
  const raw = safeStr(text);
  const t = collapseHebrewSpacing(raw);
  if (!t) return false;
  const spaced = raw.replace(/\s+/g, "");
  return /(לחזור\s+אליי|תחזרו\s+אליי|שיחזרו\s+אליי|שתחזרי\s+אליי|תחזרי\s+אליי|לחזור\s+למספר|תחזרו\s+למספר|בקשת\s+חזרה|call me back|callback)/iu.test(t)
    || /ש[הת]חזור|שיחזור|תחזור|תחזרו/u.test(spaced);
}

function isInternalLabelText(text) {
  const t = safeStr(text);
  if (!t) return false;
  return /^(reports_request|callback_request|reach_margarita|ask_contact_info|leave_message|appointment_request|price_question|complaint|meta_voice_question|caller_correction|negation|other)\.?$/i.test(t);
}

function isLatinOnlyText(text) {
  const t = safeStr(text);
  if (!t) return false;
  return /[A-Za-z]/.test(t) && !/[\u0590-\u05FF]/u.test(t);
}

function normalizeLikelyName(text) {
  const s = safeStr(text);
  if (!s) return "";
  if (s === "שאי" || s === "שיי") return "שי";
  const cand = sanitizeCandidate(s, { explicit: true }) || sanitizeCandidate(s, { directReply: true });
  return cand || "";
}

function hasHebrewLetters(text) {
  return /[\u0590-\u05FF]/u.test(safeStr(text));
}

function normalizeDigitsLoose(text) {
  return safeStr(text).replace(/\D/g, "");
}

function stripNoiseMarkers(text) {
  return collapseHebrewSpacing(
    safeStr(text)
      .replace(/<\s*noise\s*>/giu, " ")
      .replace(/<\s*unk\s*>/giu, " ")
      .replace(/\[(?:noise|unk)\]/giu, " ")
      .replace(/\s{2,}/g, " ")
      .trim()
  );
}

function extractReportEntities(text) {
  const t = collapseHebrewSpacing(stripNoiseMarkers(text));
  const compact = t.replace(/\s+/g, "");
  const out = { reportType: null, period: null, forWhom: null };
  if (/רווח\s*והפסד/u.test(t) || compact.includes("רווחוהפסד")) out.reportType = '\"דו\"חות רווח והפסד';
  else if (/מאזן/u.test(t)) out.reportType = 'מאזן';
  else if (/אישור(?:ים)?/u.test(t)) out.reportType = 'אישורים';
  else if (/\bדוח(?:ות)?\b/u.test(t)) out.reportType = 'דוחות';

  if (!out.reportType) return out;

  const m = t.match(/(?:20\d{2})/);
  if (m) out.period = m[0];
  if (/עבורי|בשבילי|שלי/u.test(t)) out.forWhom = 'הלקוח';
  else {
    const fm = t.match(/(?:עבור|בשביל|של)\s+([^.,!?]+)/u);
    if (fm && fm[1]) out.forWhom = collapseHebrewSpacing(fm[1]);
  }
  return out;
}

function refersToSameCallerNumber(text) {
  const raw = safeStr(text);
  const normalized = normalizeUtterance(raw);
  const t = collapseHebrewSpacing(normalized.recovered || normalized.normalized || raw);
  const compact = t.replace(/\s+/g, "");
  if (!t) return false;
  if (/(למספר הזה|למספר שממנו התקשרתי|למספר שממנו התקשרתם|למספר שממנו התקשרנו|למספר הנוכחי|למספר המזוהה|לאותו מספר)/iu.test(t)) return true;
  if (/(^|\s)כן[, ]*(ה)?מספר\s+ש(?:ממנו|מנו)\s+התקשר(?:תי|נו|תם)(\s|$)/iu.test(t)) return true;
  return /(המספרש(?:ממנו|מנו)?התקשר(?:תי|נו|תם)|מספרש(?:ממנו|מנו)?התקשר(?:תי|נו|תם)|ממנוהתקשר(?:תי|נו|תם)|אותומספר)/u.test(compact);
}

function refersToOtherNumber(text) {
  const t = collapseHebrewSpacing(safeStr(text));
  if (!t) return false;
  return /(למספר אחר|לא למספר הזה|למספר שונה|יש מספר אחר)/iu.test(t);
}

module.exports = {
  clampNum,
  containsCallbackRequest,
  extractReportEntities,
  hasHebrewLetters,
  isAffirmativeUtterance,
  isClosingUtterance,
  isInternalLabelText,
  isLatinOnlyText,
  isNegativeUtterance,
  isTruthyEnv,
  liveWsUrl: function liveWsUrl(env) {
    const key = env.GEMINI_API_KEY;
    if (!key) throw new Error("Missing GEMINI_API_KEY");
    return `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${encodeURIComponent(key)}`;
  },
  looksLikeReasoningText,
  normalizeCallerId,
  normalizeDigitsLoose,
  normalizeLikelyName,
  normalizeModelName,
  nowIso,
  refersToOtherNumber,
  refersToSameCallerNumber,
  safeStr,
  scrubReasoningText,
  stripNoiseMarkers,
};
