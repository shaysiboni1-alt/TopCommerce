"use strict";

const { logger } = require("../utils/logger");
const { normalizeUtterance } = require("./hebrewNlp");

function splitTriggersCell(value) {
  return String(value || "")
    .split("|")
    .map((s) => s.trim())
    .filter(Boolean);
}

function unique(arr) {
  return Array.from(new Set(arr.filter(Boolean)));
}

function buildVariants(text) {
  const base = normalizeUtterance(text || "");
  const variants = unique([
    base.raw,
    base.normalized,
    base.normalized_for_numbers,
    String(base.normalized || "").replace(/\s+/g, ""),
  ]).map((s) => String(s || "").trim());

  return {
    lang: base.lang,
    normalized: base.normalized,
    variants: variants.filter(Boolean),
  };
}

function scoreTriggerAgainstVariants(trigger, variants) {
  const t = normalizeUtterance(trigger || "").normalized;
  if (!t) return { score: 0, matched: null };

  const compactTrigger = t.replace(/\s+/g, "");

  for (const v of variants) {
    const nv = normalizeUtterance(v).normalized;
    const compact = nv.replace(/\s+/g, "");

    if (nv.includes(t)) {
      return { score: t.length >= 5 ? 8 : 6, matched: trigger };
    }

    if (compact.includes(compactTrigger) && compactTrigger.length >= 3) {
      return { score: 6, matched: trigger };
    }
  }

  return { score: 0, matched: null };
}


function scoreIntentSuggestions(textRaw, suggestions) {
  const text = normalizeUtterance(textRaw || "").normalized;
  if (!text) return null;
  let best = null;
  for (const row of Array.isArray(suggestions) ? suggestions : []) {
    const phrase = normalizeUtterance(row?.phrase_he || "").normalized;
    const suggested_intent_id = String(row?.suggested_intent_id || "").trim();
    if (!phrase || !suggested_intent_id) continue;
    let score = 0;
    if (text.includes(phrase) || phrase.includes(text)) score = 9;
    else if (text.replace(/\s+/g,"").includes(phrase.replace(/\s+/g,""))) score = 7;
    if (!score) continue;
    const confidence = Number(row?.confidence || 0) || 0;
    const candidate = { intent_id: suggested_intent_id, intent_type: String(row?.suggested_intent_type || "other").trim() || "other", score: score + confidence, priority: 0, matched_triggers: [row?.phrase_he || phrase] };
    if (!best || candidate.score > best.score) best = candidate;
  }
  return best;
}
function detectIntent(input, maybeIntents, maybeOpts = {}) {
  let textRaw = "";
  let intents = [];
  let opts = maybeOpts || {};

  if (typeof input === "object" && input !== null && !Array.isArray(input)) {
    textRaw = String(input.text || "");
    intents = Array.isArray(input.intents) ? input.intents : [];
    opts = { ...input, text: undefined, intents: undefined };
  } else {
    textRaw = String(input || "");
    intents = Array.isArray(maybeIntents) ? maybeIntents : [];
  }

  if (!intents.length) {
    return {
      intent_id: "other",
      intent_type: "other",
      score: 0,
      priority: 0,
      matched_triggers: [],
    };
  }

  const prepared = buildVariants(textRaw);
  const suggestions = Array.isArray(opts.intentSuggestions) ? opts.intentSuggestions : [];
  const lang =
    opts.forceLang ||
    prepared.lang ||
    "unknown";

  let best = null;

  for (const it of intents) {
    const intentId = String(it?.intent_id || "").trim();
    const intentType = String(it?.intent_type || "").trim() || "other";
    const priority = Number(it?.priority ?? 0) || 0;
    if (!intentId) continue;

    const langOrderedCells = lang === "he"
      ? [it?.triggers_he, it?.triggers_en, it?.triggers_ru]
      : lang === "ru"
        ? [it?.triggers_ru, it?.triggers_he, it?.triggers_en]
        : [it?.triggers_en, it?.triggers_he, it?.triggers_ru];

    const triggers = unique(langOrderedCells.flatMap((cell) => splitTriggersCell(cell)));
    if (!triggers.length) continue;

    let score = 0;
    const matched = [];

    for (const tr of triggers) {
      const res = scoreTriggerAgainstVariants(tr, prepared.variants);
      if (res.score > 0) {
        score += res.score;
        matched.push(res.matched);
      }
    }

    const nv = prepared.normalized;
    const compact = nv.replace(/\s+/g, "");

    if (
      intentId === "reports_request" &&
      (
        /דוחות|דוח|מסמכים|רווח והפסד/u.test(nv) ||
        compact.includes("רווחוהפסד")
      )
    ) {
      score += 4;
      matched.push('דו"ח');
    }

    if (
      intentId === "callback_request" &&
      (/לחזור|תחזור|יחזרו|שיחזרו|תחזרי|שתחזור/u.test(nv) || compact.includes("לחזור"))
    ) {
      score += 4;
      matched.push("לחזור");
    }

    if (
      intentId === "negation" &&
      (/^(לא|לא נכון|לא לא|no|nope|nah|lo|لا)$/iu.test(nv) || /^(lo)$/i.test(nv))
    ) {
      score += 8;
      matched.push("לא");
    }

    if (score <= 0) continue;

    const candidate = {
      intent_id: intentId,
      intent_type: intentType,
      score,
      priority,
      matched_triggers: unique(matched).slice(0, 8),
    };

    if (!best) {
      best = candidate;
      continue;
    }

    if (candidate.score > best.score) best = candidate;
    else if (candidate.score === best.score) {
      if (candidate.priority > best.priority) best = candidate;
      else if (candidate.priority === best.priority) {
        if (candidate.intent_id.localeCompare(best.intent_id) < 0) best = candidate;
      }
    }
  }

  const suggestionBest = scoreIntentSuggestions(textRaw, suggestions);
  if (suggestionBest && (!best || suggestionBest.score > best.score)) best = suggestionBest;

  if (!best) {
    return {
      intent_id: "other",
      intent_type: "other",
      score: 0,
      priority: 0,
      matched_triggers: [],
    };
  }

  if (opts.logDebug) {
    logger.info("INTENT_DEBUG", {
      lang,
      normalized: prepared.normalized,
      variants: prepared.variants,
      best,
    });
  }

  return best;
}

module.exports = { detectIntent };
