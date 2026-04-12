"use strict";

const { normalizeUtterance } = require("./hebrewNlp");

const HEBREW_RE = /[\u0590-\u05FF]/;
const LATIN_RE = /[A-Za-z]/;
const CYRILLIC_RE = /[\u0400-\u04FF]/;
const ARABIC_RE = /[\u0600-\u06FF]/;
const DEVANAGARI_RE = /[\u0900-\u097F]/;

const DIRECT_NAME_ALIASES = new Map([
  ["شاي", "שי"],
  ["شآي", "שי"],
  ["ش ي", "שי"],
  ["शाय", "שי"],
  ["شיי", "שי"],
]);

const STOPWORDS_HE = new Set([
  "כן","לא","אוקיי","אוקי","טוב","בסדר","סבבה","אה","אממ","הממ","רגע","שלום","היי","הלו",
  "מה","מי","אני","קוראים","לי","שמי","זה","כאן","מדבר","מדברת","איתך","אתך","נעים",
  "אישה","בת","גברת","אדוני","רוצה","רציתי","צריך","צריכה","צריכים","צריכות","מחפש","מחפשת",
  "משרד","מיטל","טופ","קומרס","דוח","דוחות","אישור","אישורים","מסמך","מסמכים","שירות","פעילות"
]);

const INVALID_SINGLE_TOKEN_HE = new Set([
  "אני","אישה","בת","גבר","ילד","ילדה","גברת","אדוני","שלום","הלו","רגע","כן","לא",
  "טוב","בסדר","רוצה","רציתי","צריך","צריכה","צריכים","צריכות","מבקש","מבקשת","מחפש","מחפשת",
  "דוח","דוחות","אישור","אישורים","מסמך","מסמכים","משרד","מיטל","טופ","קומרס","מייל","טלפון",
  "שעות","פעילות","עזרה","בעיה","חזרה","מבטא","קול","בשם"
]);

const INVALID_ANY_TOKEN_HE = new Set([
  "אני","היא","הוא","אנחנו","אתם","אתן","בת","אישה","גברת","אדוני","צריך","צריכה",
  "צריכים","צריכות","רוצה","רציתי","מחפש","מחפשת","שלום","הלו","כן","לא","משרד","מיטל","טופ","קומרס"
]);

function collapseHebrewSpacing(s) {
  return String(s || "").replace(/\s+/g, " ").trim();
}

function isSupportedScript(t) {
  return HEBREW_RE.test(t) || LATIN_RE.test(t) || CYRILLIC_RE.test(t) || ARABIC_RE.test(t) || DEVANAGARI_RE.test(t);
}

function stripPunct(s) {
  const normalized = normalizeUtterance(String(s || "")).normalized || String(s || "");
  return collapseHebrewSpacing(
    String(normalized || "")
      .replace(/[\u200f\u200e]/g, "")
      .replace(/[“”„״'"`´]/g, "")
      .replace(/[.,!?;:()\[\]{}<>\/\\-]/g, " ")
      .replace(/\s{2,}/g, " ")
      .trim()
  );
}

function hasMixedScripts(t) {
  const hasHebrew = HEBREW_RE.test(t);
  const hasLatin = LATIN_RE.test(t);
  const hasCyrillic = CYRILLIC_RE.test(t);
  const hasArabic = ARABIC_RE.test(t);
  const hasDevanagari = DEVANAGARI_RE.test(t);
  return [hasHebrew, hasLatin, hasCyrillic, hasArabic, hasDevanagari].filter(Boolean).length > 1;
}

function isLikelyInvalidHebrewToken(token) {
  const t = String(token || "").trim();
  if (!t) return true;
  if (INVALID_ANY_TOKEN_HE.has(t)) return true;
  if (/^[\u0590-\u05FF]$/.test(t)) return true;
  if (/^(שלי|שלכם|שלכן|שלו|שלה|פה|כאן|זה|זאת|הזה|הזאת)$/u.test(t)) return true;
  return false;
}

function normalizeSingleHebrewNameToken(token) {
  let t = String(token || "").trim();
  t = t.replace(/^ו(?=[\u0590-\u05FF]{2,}$)/u, "");
  if (t === "בשם") return "";
  return t;
}

function sanitizeCandidate(raw, opts = {}) {
  const directReply = !!opts.directReply;
  const explicit = !!opts.explicit;

  let t = stripPunct(raw);
  if (!t) return null;

  t = t.replace(/^(שלום|היי|הלו)\s+/u, "");
  t = t.replace(/^(אני|שמי|קוראים לי)\s+/u, "");
  if (!t) return null;

  const compact = t.replace(/\s+/g, " ");
  if (DIRECT_NAME_ALIASES.has(compact)) return DIRECT_NAME_ALIASES.get(compact);

  if (/\d/.test(t)) return null;
  if (!isSupportedScript(t)) return null;
  if (hasMixedScripts(t)) return null;

  let parts = t.split(/\s+/).filter(Boolean);
  if (parts.length < 1 || parts.length > 2) return null;
  if (t.length < 2 || t.length > 30) return null;

  if (directReply && !explicit && parts.length > 1) return null;

  for (let i = 0; i < parts.length; i += 1) {
    parts[i] = normalizeSingleHebrewNameToken(parts[i]);
    const p = parts[i];
    if (p.length < 2) return null;
    if (!/^[\p{L}]+$/u.test(p)) return null;
  }

  if (parts.length === 1) {
    if (STOPWORDS_HE.has(parts[0]) || INVALID_SINGLE_TOKEN_HE.has(parts[0])) return null;
  }

  if (HEBREW_RE.test(parts.join(" "))) {
    for (const p of parts) {
      if (isLikelyInvalidHebrewToken(p)) return null;
    }
  }

  if (directReply && LATIN_RE.test(parts.join(" ")) && !HEBREW_RE.test(parts.join(" ")) && parts.length !== 1) {
    return null;
  }

  return parts.join(" ");
}

function lastBotAskedForName(lastBotUtterance) {
  const t = stripPunct(lastBotUtterance || "");
  if (!t) return false;
  return /מה\s*השם|איך\s*קוראים|מי\s*מדבר|מי\s*מדברת|שמך|שמך\s*בבקשה|איך\s*קוראים\s*לכם|איך\s*קוראים\s*לך/i.test(t);
}

function extractCallerName({ userText, lastBotUtterance }) {
  const normalizedObj = normalizeUtterance(String(userText || "").trim());
  const raw = collapseHebrewSpacing(normalizedObj.recovered || normalizedObj.normalized || normalizedObj.raw);
  if (!raw) return null;

  const patterns = [
    { re: /(?:^|\b)שלום\s+אני\s+(.+)$/iu, reason: "explicit_shalom_ani" },
    { re: /(?:^|\b)אני\s+(.+)$/iu, reason: "explicit_ani" },
    { re: /(?:^|\b)קוראים\s+לי\s+(.+)$/iu, reason: "explicit_korim_li" },
    { re: /(?:^|\b)שמי\s+(.+)$/iu, reason: "explicit_shmi" },
    { re: /(?:^|\b)השם\s+שלי\s+זה\s+(.+)$/iu, reason: "explicit_hashem_sheli_ze" },
    { re: /(?:^|\b)השם\s+שלי\s+(.+)$/iu, reason: "explicit_hashem_sheli" },
    { re: /(?:^|\b)השם\s+זה\s+(.+)$/iu, reason: "explicit_hashem_ze" },
    { re: /(?:^|\b)my\s+name\s+is\s+(.+)$/iu, reason: "explicit_my_name_is" },
    { re: /(?:^|\b)меня\s+зовут\s+(.+)$/iu, reason: "explicit_menya_zovut" },
  ];

  for (const p of patterns) {
    const m = raw.match(p.re);
    if (!m || !m[1]) continue;
    const cand = sanitizeCandidate(m[1], { explicit: true });
    if (cand) return { name: cand, reason: p.reason };
  }

  if (lastBotAskedForName(lastBotUtterance)) {
    const cand = sanitizeCandidate(raw, { directReply: true });
    if (cand) return { name: cand, reason: "direct_answer_to_name_question" };
  }

  return null;
}

module.exports = {
  extractCallerName,
  lastBotAskedForName,
  sanitizeCandidate,
  collapseHebrewSpacing,
};
