"use strict";

const { safeStr } = require("./sessionUtils");
const { getPromptStack } = require("../ssot/ssotAccessors");

function buildSettingsContext(settings) {
  const keys = Object.keys(settings || {}).sort();
  return keys.map((k) => `${k}: ${safeStr(settings[k])}`).join("\n").trim();
}

function buildSuggestionsContext(rows, title) {
  const arr = Array.isArray(rows) ? rows : [];
  if (!arr.length) return "";
  return `${title}:\n` + arr.map((row) => JSON.stringify(row)).join("\n");
}

function buildIntentsContext(intents) {
  const rows = Array.isArray(intents) ? intents.slice() : [];
  rows.sort((a, b) => {
    const pa = Number(a?.priority ?? 0);
    const pb = Number(b?.priority ?? 0);
    if (pb !== pa) return pb - pa;
    return String(a?.intent_id ?? "").localeCompare(String(a?.intent_id ?? ""));
  });
  return rows
    .map((it) => `- ${safeStr(it.intent_id)} | type=${safeStr(it.intent_type)} | priority=${Number(it.priority ?? 0) || 0} | triggers_he=${safeStr(it.triggers_he)} | triggers_en=${safeStr(it.triggers_en)} | triggers_ru=${safeStr(it.triggers_ru)}`)
    .join("\n")
    .trim();
}

function buildSystemInstructionFromSSOT(ssot, runtimeMeta) {
  const settings = ssot?.settings || {};
  const promptStack = { ...getPromptStack(), ...(ssot?.prompts || {}) };
  const intents = ssot?.intents || [];
  const defaultLang = safeStr(runtimeMeta?.language_locked) || safeStr(settings.DEFAULT_LANGUAGE) || "he";
  const callerName = safeStr(runtimeMeta?.caller_name) || safeStr(runtimeMeta?.display_name) || "";
  const callerWithheld = !!runtimeMeta?.caller_withheld;
  const sections = [];

  sections.push([
    "IDENTITY (NON-NEGOTIABLE):",
    "- You are the business phone assistant defined by SETTINGS and PROMPTS.",
    "- Never identify as an AI, model, assistant model, or LLM.",
    "- Speak briefly, naturally, and only as a customer-facing phone representative.",
    "- NEVER output analysis, internal planning, reasoning, markdown, bullets, JSON, stage labels, or notes.",
    "- NEVER say internal IDs, intent labels, or technical statuses aloud.",
    "- Output ONLY the final customer-facing sentence(s) to be spoken aloud.",
  ].join("\n"));

  sections.push([
    "LANGUAGE POLICY (HARD RULE):",
    `- locked_language=${defaultLang}`,
    "- Start and stay in Hebrew by default.",
    "- Do NOT switch language because of accent, pronunciation, or a foreign-sounding name.",
    "- Switch language only if the caller explicitly asks to switch, or clearly speaks in a supported language for multiple turns.",
    "- If in doubt, remain in Hebrew.",
  ].join("\n"));

  sections.push([
    "DIALOG POLICY (HARD RULE):",
    "- Ask only ONE question at a time.",
    "- Never bundle multiple data-collection questions into one turn.",
    "- The first priority is caller name capture unless a reliable known caller name already exists.",
    "- Prefer short, focused follow-up questions.",
    "- If the caller corrects you, apologize briefly, align to the correction, and continue naturally.",
    "- If the call is only for information, answer briefly and do not force lead capture.",
    "- Any customer-specific flow or discovery path must come from PROMPTS/INTENTS/INTENT_SUGGESTIONS/SCRIPT_SUGGESTIONS/KB_SUGGESTIONS, not from hidden business rules.",
  ].join("\n"));

  if (callerName) {
    sections.push([
      "CALLER MEMORY POLICY:",
      `- Known caller name: \"${callerName}\"`,
      "- Treat it as correct unless the caller explicitly corrects it.",
      "- Do not ask for the caller name again if it is already known.",
    ].join("\n"));
  }

  if (callerWithheld) {
    sections.push([
      "WITHHELD NUMBER POLICY:",
      "- The caller number is withheld/private.",
      "- If the caller leaves a request or asks for a callback, you MUST collect a callback number explicitly.",
      "- Do not say you will return to the identified number because there is no usable caller ID.",
    ].join("\n"));
  }

  ["MASTER_PROMPT", "GUARDRAILS_PROMPT", "KB_PROMPT", "LEAD_CAPTURE_PROMPT", "INTENT_ROUTER_PROMPT"].forEach((key) => {
    if (promptStack[key]) sections.push(`${key}:\n${safeStr(promptStack[key])}`);
  });

  const settingsContext = buildSettingsContext(settings);
  if (settingsContext) sections.push(`SETTINGS_CONTEXT:\n${settingsContext}`);

  const intentsContext = buildIntentsContext(intents);
  if (intentsContext) sections.push(`INTENTS_TABLE:\n${intentsContext}`);

  const intentSuggestionsContext = buildSuggestionsContext(ssot?.intent_suggestions, "INTENT_SUGGESTIONS_TABLE");
  if (intentSuggestionsContext) sections.push(intentSuggestionsContext);
  const scriptSuggestionsContext = buildSuggestionsContext(ssot?.script_suggestions, "SCRIPT_SUGGESTIONS_TABLE");
  if (scriptSuggestionsContext) sections.push(scriptSuggestionsContext);
  const kbSuggestionsContext = buildSuggestionsContext(ssot?.kb_suggestions, "KB_SUGGESTIONS_TABLE");
  if (kbSuggestionsContext) sections.push(kbSuggestionsContext);

  sections.push([
    "SSOT GOVERNANCE (HARD RULE):",
    "- Use the SSOT tables as the source of truth for customer-facing conversation behavior.",
    "- Do not invent customer-specific flows that are not grounded in SETTINGS, PROMPTS, INTENTS, INTENT_SUGGESTIONS, SCRIPT_SUGGESTIONS, or KB_SUGGESTIONS.",
    "- When a matching intent or suggestion exists in SSOT, follow it before improvising.",
  ].join("\n"));

  sections.push([
    "CONTEXT_UPDATE PROTOCOL (HARD RULE):",
    "- During the call you will receive structured [CONTEXT_UPDATE]...[/CONTEXT_UPDATE] blocks.",
    "- These are runtime memory injections from the system. They are NOT user speech.",
    "- Do NOT read them aloud. Do NOT respond to them directly. Do NOT acknowledge them.",
    "- Use the 'collected' fields to know what you already have — never ask for those again.",
    "- Use the 'missing' fields to guide what to ask next, naturally, in one question at a time.",
    "- If all required fields are collected, proceed to close the conversation naturally.",
  ].join("\n"));

  return sections.filter(Boolean).join("\n\n---\n\n").trim();
}

function buildContextUpdateBlock(memorySnapshot) {
  const s = memorySnapshot || {};
  const fields = s.collectedFields || {};

  const collected = [];
  const missing = [];

  if (fields.name && s.callerName) {
    collected.push(`name: ${s.callerName}`);
  } else {
    missing.push(`name: required`);
  }

  if (s.customerType) {
    collected.push(`customer_type: ${s.customerType}`);
  }

  if (fields.intent && s.intent) {
    collected.push(`intent: ${s.intent}`);
  }

  if (fields.subject) {
    collected.push(`subject: collected`);
  } else if (s.intent !== "info") {
    missing.push(`subject: required`);
  }

  if (fields.callback) {
    collected.push(`callback: confirmed`);
  } else if (s.intent === "callback_request" || s.awaitingCallbackConfirmation) {
    missing.push(`callback: required`);
  }

  return [
    "[CONTEXT_UPDATE]",
    "collected:",
    ...(collected.length ? collected : ["(none)"]),
    "missing:",
    ...(missing.length ? missing : ["(none)"]),
    "[/CONTEXT_UPDATE]",
  ].join("\n");
}

module.exports = { buildSystemInstructionFromSSOT, buildContextUpdateBlock };
