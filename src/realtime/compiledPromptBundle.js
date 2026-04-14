"use strict";

const { getCachedOpening } = require("../logic/openingBuilder");
const { buildSystemInstructionFromSSOT } = require("./systemInstructionBuilder");

const CACHE = new Map();
const DEFAULT_TTL_MS = 10 * 60 * 1000;

function safeStr(v) {
  if (v === undefined || v === null) return "";
  return String(v).trim();
}

function nowMs() {
  return Date.now();
}

function buildRuntimeMeta(runtimeMeta) {
  return {
    caller_name: safeStr(runtimeMeta?.caller_name || runtimeMeta?.display_name),
    display_name: safeStr(runtimeMeta?.display_name || runtimeMeta?.caller_name),
    language_locked: safeStr(runtimeMeta?.language_locked) || "he",
    caller_withheld: !!runtimeMeta?.caller_withheld,
  };
}

function buildBundleKey({ ssot, runtimeMeta, timeZone, isReturning }) {
  const settings = ssot?.settings || {};
  const prompts = ssot?.prompts || {};
  const meta = buildRuntimeMeta(runtimeMeta);

  return JSON.stringify({
    settings,
    prompts,
    intents: ssot?.intents || [],
    intent_suggestions: ssot?.intent_suggestions || [],
    script_suggestions: ssot?.script_suggestions || [],
    kb_suggestions: ssot?.kb_suggestions || [],
    runtimeMeta: meta,
    timeZone: safeStr(timeZone) || "Asia/Jerusalem",
    isReturning: !!isReturning,
  });
}

function buildCompiledPromptBundle({ ssot, runtimeMeta, timeZone, isReturning }) {
  const meta = buildRuntimeMeta(runtimeMeta);
  const openingData = getCachedOpening({
    ssot,
    callerName: meta.display_name,
    isReturning: !!isReturning,
    timeZone,
  });

  const systemInstruction = buildSystemInstructionFromSSOT(ssot, meta);

  return {
    opening: safeStr(openingData?.opening || openingData?.text),
    opening_cache_hit: !!openingData?.cache_hit,
    greeting: safeStr(openingData?.greeting),
    system_instruction: safeStr(systemInstruction),
    runtime_meta: meta,
  };
}

function getCompiledPromptBundle({ ssot, runtimeMeta, timeZone, isReturning, ttlMs = DEFAULT_TTL_MS }) {
  const key = buildBundleKey({ ssot, runtimeMeta, timeZone, isReturning });
  const cached = CACHE.get(key);
  const now = nowMs();

  if (cached && cached.expiresAt > now) {
    return { ...cached.value, bundle_cache_hit: true };
  }

  const value = buildCompiledPromptBundle({ ssot, runtimeMeta, timeZone, isReturning });
  CACHE.set(key, {
    value,
    expiresAt: now + Math.max(1000, Number(ttlMs) || DEFAULT_TTL_MS),
  });

  return { ...value, bundle_cache_hit: false };
}

function warmCompiledPromptBundle(opts) {
  return getCompiledPromptBundle(opts);
}

module.exports = {
  buildCompiledPromptBundle,
  getCompiledPromptBundle,
  warmCompiledPromptBundle,
};
