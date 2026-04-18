"use strict";

const { safeStr } = require("./sessionUtils");
const { getPromptStack } = require("../ssot/ssotAccessors");

function approvedRows(rows, approvedKeyCandidates = ["approved", "Approved", "סטטוס", "status"]) {
  return (Array.isArray(rows) ? rows : []).filter((row) => {
    const raw = approvedKeyCandidates
      .map((key) => safeStr(row?.[key]))
      .find(Boolean)
      .toLowerCase();
    if (!raw) return true;
    return ["true", "1", "yes", "מאושר"].includes(raw);
  });
}

function buildApprovedScripts(ssot) {
  const rows = approvedRows(ssot?.script_suggestions);
  const out = [];
  for (const row of rows) {
    const key = safeStr(row?.script_key);
    const text = safeStr(row?.suggested_text || row?.text || row?.content);
    if (!key || !text) continue;
    out.push(`- ${key}: ${text}`);
  }
  return out.join("\n").trim();
}

function buildApprovedKbFacts(ssot) {
  const rows = approvedRows(ssot?.kb_suggestions).slice(0, 16);
  const out = [];
  for (const row of rows) {
    const q = safeStr(row?.question);
    const a = safeStr(row?.suggested_answer || row?.answer);
    if (!q || !a) continue;
    out.push(`- Q: ${q} | A: ${a}`);
  }
  return out.join("\n").trim();
}

function buildSupportedIntentSummary(ssot) {
  const rows = Array.isArray(ssot?.intents) ? ssot.intents.slice() : [];
  rows.sort((a, b) => Number(b?.priority || 0) - Number(a?.priority || 0));
  return rows
    .map((it) => {
      const id = safeStr(it?.intent_id);
      const type = safeStr(it?.intent_type || "other");
      if (!id) return "";
      return `- ${id} (${type})`;
    })
    .filter(Boolean)
    .join("\n")
    .trim();
}

function normalizeRuntimeMeta(runtimeMeta, settings) {
  return {
    caller_name: safeStr(runtimeMeta?.caller_name) || safeStr(runtimeMeta?.display_name) || "",
    display_name: safeStr(runtimeMeta?.display_name) || safeStr(runtimeMeta?.caller_name) || "",
    language_locked: safeStr(runtimeMeta?.language_locked) || safeStr(settings?.DEFAULT_LANGUAGE) || "he",
    caller_withheld: !!runtimeMeta?.caller_withheld,
    caller: safeStr(runtimeMeta?.caller),
    called: safeStr(runtimeMeta?.called),
    source: safeStr(runtimeMeta?.source),
    opening_played:
      runtimeMeta?.opening_played === undefined || runtimeMeta?.opening_played === null
        ? ""
        : safeStr(runtimeMeta?.opening_played),
  };
}

function buildBaseInstructionFromSSOT(ssot, runtimeMeta) {
  const settings = ssot?.settings || {};
  const compactMode = String(settings.MB_COMPACT_SYSTEM_PROMPT_ENABLED ?? "true").trim().toLowerCase() !== "false";
  const promptStack = { ...getPromptStack(), ...(ssot?.prompts || {}) };
  const meta = normalizeRuntimeMeta(runtimeMeta, settings);
  const defaultLang = meta.language_locked || "he";
  const sections = [];

  sections.push([
    "IDENTITY (NON-NEGOTIABLE):",
    `- You are ${safeStr(settings.BOT_NAME) || "the business phone representative"} for ${safeStr(settings.BUSINESS_NAME) || "the business"}.`,
    "- Never identify as an AI, model, assistant model, or LLM.",
    "- Speak briefly, naturally, and only as a customer-facing phone representative.",
    "- Output ONLY the final customer-facing sentence(s) to be spoken aloud.",
    "- Never say internal labels, reasoning, JSON, bullets, or technical statuses.",
  ].join("\n"));

  sections.push([
    "LANGUAGE POLICY (HARD RULE):",
    `- locked_language=${defaultLang}`,
    "- Start and stay in Hebrew by default.",
    "- Switch language only if the caller explicitly asks to switch or clearly speaks another supported language for multiple turns.",
    "- If in doubt, remain in Hebrew.",
  ].join("\n"));

  sections.push([
    "DIALOG POLICY (HARD RULE):",
    "- Ask only ONE question at a time.",
    "- Prefer short, focused follow-up questions.",
    "- If the caller corrects you, apologize briefly, align to the correction, and continue naturally.",
    "- If the call is only for information, answer briefly and do not force lead capture.",
    "- Use approved SSOT scripts and approved KB only; do not invent business rules or unsupported facts.",
  ].join("\n"));

  ["MASTER_PROMPT", "GUARDRAILS_PROMPT", "KB_PROMPT", "LEAD_CAPTURE_PROMPT", "INTENT_ROUTER_PROMPT"].forEach((key) => {
    const content = safeStr(promptStack[key]);
    if (content) sections.push(`${key}:\n${content}`);
  });

  const approvedScripts = buildApprovedScripts(ssot);
  if (approvedScripts) {
    sections.push(`APPROVED_SCRIPT_SNIPPETS:\n${approvedScripts}`);
  }

  const approvedKbFacts = buildApprovedKbFacts(ssot);
  if (approvedKbFacts) {
    sections.push(`APPROVED_KB_FACTS:\n${approvedKbFacts}`);
  }

  const intentSummary = buildSupportedIntentSummary(ssot);
  if (intentSummary) {
    sections.push(`SUPPORTED_INTENTS:\n${intentSummary}`);
  }

  sections.push([
    "SSOT GOVERNANCE (HARD RULE):",
    "- Use SETTINGS, PROMPTS, INTENTS, INTENT_SUGGESTIONS, SCRIPT_SUGGESTIONS, and KB_SUGGESTIONS as the source of truth.",
    "- When an approved script exists for the current flow step, prefer it before improvising.",
    "- Do not ask for the caller name again when caller memory already provides a reliable name unless the caller explicitly corrects it.",
  ].join("\n"));

  return sections.filter(Boolean).join("\n\n---\n\n").trim();
}

function buildDeltaInstruction(runtimeMeta, settings) {
  const meta = normalizeRuntimeMeta(runtimeMeta, settings);
  const sections = [];

  if (meta.caller_name) {
    sections.push([
      "CALLER MEMORY POLICY:",
      `- Known caller name: \"${meta.caller_name}\"`,
      "- Treat it as correct unless the caller explicitly corrects it.",
      "- The caller name is already collected. NEVER ask for the name again unless the caller corrects it or asks to replace it.",
    ].join("\n"));
  }

  if (meta.caller_withheld) {
    sections.push([
      "WITHHELD NUMBER POLICY:",
      "- The caller number is withheld/private.",
      "- If the caller asks for a callback, you MUST collect a callback number explicitly.",
      "- Do not promise a return call to the identified number because there is no usable caller ID.",
    ].join("\n"));
  }

  const runtimeLines = [
    "RUNTIME CONTEXT:",
    `- caller=${meta.caller || "unknown"}`,
    `- called=${meta.called || "unknown"}`,
    `- source=${meta.source || "unknown"}`,
  ];
  if (meta.opening_played !== "") runtimeLines.push(`- opening_played=${meta.opening_played}`);
  sections.push(runtimeLines.join("\n"));

  return sections.filter(Boolean).join("\n\n---\n\n").trim();
}

function buildSystemInstructionFromSSOT(ssot, runtimeMeta) {
  const settings = ssot?.settings || {};
  const baseInstruction = buildBaseInstructionFromSSOT(ssot, runtimeMeta);
  const deltaInstruction = buildDeltaInstruction(runtimeMeta, settings);
  return [baseInstruction, deltaInstruction].filter(Boolean).join("\n\n---\n\n").trim();
}

module.exports = {
  buildBaseInstructionFromSSOT,
  buildDeltaInstruction,
  buildSystemInstructionFromSSOT,
};
