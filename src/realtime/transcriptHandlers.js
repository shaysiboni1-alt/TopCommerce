"use strict";

const { logger } = require("../utils/logger");
const { detectIntent } = require("../logic/intentRouter");
const { extractCallerName, lastBotAskedForName, collapseHebrewSpacing } = require("../logic/nameExtractor");
const { applyTemplate, digitsSpoken } = require("../config/runtimeSettings");
const { hangupCall } = require("../utils/twilioRecordings");
const { normalizeUtterance } = require("../logic/hebrewNlp");
const {
  containsCallbackRequest,
  extractReportEntities,
  hasHebrewLetters,
  isAffirmativeUtterance,
  isClosingUtterance,
  isInternalLabelText,
  isNegativeUtterance,
  normalizeDigitsLoose,
  normalizeLikelyName,
  refersToOtherNumber,
  refersToSameCallerNumber,
  safeStr,
  stripNoiseMarkers,
} = require("./sessionUtils");

function getSessionEnv(session) {
  return session && typeof session === "object" && session.env && typeof session.env === "object"
    ? session.env
    : {};
}

function getConversationLog(session) {
  try {
    if (session && typeof session._getConversationLog === "function") {
      const log = session._getConversationLog();
      return Array.isArray(log) ? log : [];
    }
    if (Array.isArray(session?._call?.conversationLog)) return session._call.conversationLog;
  } catch {}
  return [];
}

function getCallSid(session) {
  try {
    if (session && typeof session._getCallData === "function") {
      return safeStr(session._getCallData()?.callSid) || safeStr(session?.meta?.callSid);
    }
  } catch {}
  return safeStr(session?._call?.callSid) || safeStr(session?.meta?.callSid);
}

function normalizeNlpInput(nlp) {
  const base = typeof nlp === "string"
    ? { raw: safeStr(nlp), normalized: safeStr(nlp) }
    : (nlp && typeof nlp === "object" ? nlp : {});

  const rawText = safeStr(base.raw_text || base.raw);
  const normalizedSeed = safeStr(base.normalized_text || base.normalized || rawText);
  const normalizedObj = normalizeUtterance(normalizedSeed || rawText || "");
  const raw = safeStr(rawText || normalizedObj.raw);
  const normalized = safeStr(base.normalized_text || normalizedObj.normalized || base.normalized || raw);
  const recovered = safeStr(base.recovered_text || normalizedObj.recovered || normalizedObj.normalized || base.normalized || raw);
  const finalText = safeStr(base.final_text || base.finalText || base.final || recovered || normalized || raw);
  const stageTexts = {
    raw,
    normalized,
    recovered,
    final: finalText,
  };

  return {
    ...base,
    raw,
    normalized,
    recovered,
    final: finalText,
    finalText,
    raw_text: raw,
    normalized_text: normalized,
    recovered_text: recovered,
    final_text: finalText,
    stage_order: Array.isArray(base.stage_order) && base.stage_order.length
      ? base.stage_order
      : ["raw", "normalized", "recovered", "final"],
    stage_texts: base.stage_texts && typeof base.stage_texts === "object"
      ? { ...stageTexts, ...base.stage_texts }
      : stageTexts,
    stages: base.stages && typeof base.stages === "object"
      ? base.stages
      : {
          raw: { name: "raw", text: raw, length: raw.length, present: Boolean(raw) },
          normalized: { name: "normalized", text: normalized, length: normalized.length, present: Boolean(normalized) },
          recovered: { name: "recovered", text: recovered, length: recovered.length, present: Boolean(recovered) },
          final: { name: "final", text: finalText, length: finalText.length, present: Boolean(finalText) },
        },
    compact: safeStr(base.compact || normalizedObj.compact || ""),
    lang: safeStr(base.lang || normalizedObj.lang),
    lang_confidence: Number.isFinite(Number(base.lang_confidence))
      ? Number(base.lang_confidence)
      : Number(normalizedObj.lang_confidence || 0),
  };
}

function safeImmediateText(session, text, label) {
  if (session && typeof session._sendImmediateText === "function") {
    try {
      session._sendImmediateText(text, label);
    } catch {}
  }
}

function safeCommitRuntimeName(session, name, reason, sourceUtterance) {
  if (session && typeof session._commitRuntimeName === "function") {
    try {
      return !!session._commitRuntimeName(name, reason, sourceUtterance);
    } catch {}
  }
  return false;
}

function safeCallbackConfirmed(session, nextQuestion) {
  if (session && typeof session._sendImmediateCallbackConfirmed === "function") {
    try {
      session._sendImmediateCallbackConfirmed(nextQuestion);
      return true;
    } catch {}
  }
  return false;
}

function ensureReportState(session) {
  session._reportState = session._reportState || { reportType: null, period: null, forWhom: null };
  session._reportPromptState = session._reportPromptState || {
    lastAskedSlot: null,
    lastAskedAt: 0,
    askedWithoutStateChange: {},
  };
}

function getMissingReportSlot(session) {
  ensureReportState(session);
  const state = session._reportState;
  if (!state.reportType || state.reportType === "דוחות") return "type";
  if (!state.period) return "period";
  if (!state.forWhom) return "forWhom";
  return null;
}

function getReportQuestionForSlot(session, slot) {
  if (slot === "type") {
    return {
      key: "type",
      label: "REPORTS_TYPE_PROMPT_SENT",
      text: safeStr(session.ssot?.settings?.REPORTS_ASK_TYPE_PHRASE) || "איזה דוחות אתה צריך?",
    };
  }
  if (slot === "period") {
    return {
      key: "period",
      label: "REPORTS_PERIOD_PROMPT_SENT",
      text: safeStr(session.ssot?.settings?.REPORTS_ASK_PERIOD_PHRASE) || "לאיזו תקופה אתה צריך את הדוחות?",
    };
  }
  if (slot === "forWhom") {
    return {
      key: "forWhom",
      label: "REPORTS_FOR_WHOM_PROMPT_SENT",
      text: safeStr(session.ssot?.settings?.REPORTS_ASK_FORWHOM_PHRASE) || "עבור מי או עבור איזה עסק אתם צריכים את הדוחות?",
    };
  }
  return null;
}

function cloneReportState(session) {
  ensureReportState(session);
  return {
    reportType: session._reportState.reportType || null,
    period: session._reportState.period || null,
    forWhom: session._reportState.forWhom || null,
  };
}

function reportStateChanged(prevState, nextState) {
  return !!(
    (prevState?.reportType || null) !== (nextState?.reportType || null) ||
    (prevState?.period || null) !== (nextState?.period || null) ||
    (prevState?.forWhom || null) !== (nextState?.forWhom || null)
  );
}

function applyReportEntities(session, text) {
  ensureReportState(session);
  const entities = extractReportEntities(text || "");
  if (!session._reportState.reportType && entities.reportType) session._reportState.reportType = entities.reportType;
  if (!session._reportState.period && entities.period) session._reportState.period = entities.period;
  if (!session._reportState.forWhom && entities.forWhom) session._reportState.forWhom = entities.forWhom;
  return session._reportState;
}

function maybeGetNextReportQuestion(session, prevState) {
  ensureReportState(session);
  const promptState = session._reportPromptState;
  const missingSlot = getMissingReportSlot(session);
  if (!missingSlot) {
    promptState.lastAskedSlot = null;
    promptState.lastAskedAt = 0;
    promptState.askedWithoutStateChange = {};
    return null;
  }

  if (reportStateChanged(prevState, session._reportState)) {
    promptState.askedWithoutStateChange = {};
  }

  promptState.askedWithoutStateChange[missingSlot] = promptState.askedWithoutStateChange[missingSlot] || 0;

  if (promptState.lastAskedSlot === missingSlot && promptState.askedWithoutStateChange[missingSlot] >= 1) {
    return null;
  }

  const question = getReportQuestionForSlot(session, missingSlot);
  if (!question) return null;

  promptState.lastAskedSlot = missingSlot;
  promptState.lastAskedAt = Date.now();
  promptState.askedWithoutStateChange[missingSlot] += 1;
  return question;
}

function clearReportPromptLoopForCapturedName(session) {
  ensureReportState(session);
  session._reportPromptState.askedWithoutStateChange = {};
}

function hasConfiguredIntent(session, intentId) {
  const intents = Array.isArray(session?.ssot?.intents) ? session.ssot.intents : [];
  const target = safeStr(intentId);
  return intents.some((it) => safeStr(it?.intent_id) === target);
}

function getApprovedScriptText(session, scriptKey, fallback = "") {
  const target = safeStr(scriptKey);
  const rows = Array.isArray(session?.ssot?.script_suggestions) ? session.ssot.script_suggestions : [];
  for (const row of rows) {
    if (safeStr(row?.script_key) !== target) continue;
    const approved = safeStr(row?.approved || row?.Approved || row?.סטטוס || row?.status).toLowerCase();
    if (approved && !["true", "1", "yes", "מאושר"].includes(approved)) continue;
    const text = safeStr(row?.suggested_text || row?.text || row?.content);
    if (text) return text;
  }
  return safeStr(fallback);
}

function maybeGetStructuredFollowup(session, normalizedUserText, intent) {
  if (!session || typeof session !== "object") return null;
  if (session._awaitingCallbackConfirmation || session._callbackConfirmed || session._hardClosingMode) return null;

  const mem = session._orchestrator?.memory?.snapshot?.() || {};
  const ssotSettings = session.ssot?.settings || {};
  const intentId = safeStr(intent?.intent_id || "other");
  const stage = safeStr(mem.stage || "");
  const callerKnown = !!safeStr(session.meta?.caller_profile?.display_name || mem.callerName);
  const hasName = !!(callerKnown || mem.collectedFields?.name);
  const hasSubject = !!mem.collectedFields?.subject;
  const hasCallback = !!mem.collectedFields?.callback;
  const looksMeaningful = safeStr(normalizedUserText).replace(/\s+/g, "").length >= 6;
  const isReturningFlow = callerKnown || intentId === "existing_customer" || stage === "discover_need" || stage === "clarify_need";

  const askSegment = getApprovedScriptText(session, "ASK_NEW_SEGMENT", "אמרו לי בבקשה האם אתם לקוחות עסקיים או פרטיים");
  const askName = getApprovedScriptText(session, "ASK_NAME", "הבנתי, תודה. אמרו לי מה השם בבקשה");
  const askProduct = getApprovedScriptText(session, "ASK_PRODUCT_INTEREST", "נהדר, אשמח שתפרטו לי באיזה מוצר או שירות שלנו אתם מתעניינים");
  const askNeedReturning = getApprovedScriptText(session, "ASK_EXISTING_NEED", "איזה כיף לשמוע מכם שוב, אמרו לי בבקשה במה אפשר לעזור");
  const askCallback = safeStr(ssotSettings.CALLBACK_ASK_PHRASE) || "אוקיי, תרצו שנחזור למספר ממנו התקשרתם או למספר אחר?";

  if (intentId === "new_customer") {
    return { text: askSegment, label: "FLOW_ASK_SEGMENT_SENT" };
  }

  if ((intentId === "business_customer" || intentId === "private_customer") && !hasName) {
    return { text: askName, label: "FLOW_ASK_NAME_SENT" };
  }

  if ((intentId === "business_customer" || intentId === "private_customer") && hasName && !hasSubject) {
    return { text: askProduct, label: "FLOW_ASK_PRODUCT_SENT" };
  }

  if (intentId === "existing_customer" && !hasSubject) {
    return { text: askNeedReturning, label: "FLOW_ASK_EXISTING_NEED_SENT" };
  }

  if (intentId === "product_interest") {
    if (!hasName && !callerKnown) {
      return { text: askName, label: "FLOW_ASK_NAME_SENT" };
    }
    if (hasSubject && !hasCallback) {
      return { text: askCallback, label: "CALLBACK_ASK_SENT", callback: true };
    }
    return null;
  }

  if (isReturningFlow && looksMeaningful && hasSubject && !hasCallback && intentId !== "repeat" && intentId !== "negation" && intentId !== "caller_correction" && intentId !== "other" && intentId !== "yes") {
    if (!hasName && !callerKnown) {
      return { text: askName, label: "FLOW_ASK_NAME_SENT" };
    }
    return { text: askCallback, label: "CALLBACK_ASK_SENT", callback: true };
  }

  return null;
}


function looksLikeNeedStatement(text) {
  const value = safeStr(text).replace(/\s+/g, " ").trim();
  if (!value) return false;
  const compact = value.replace(/\s+/g, "");
  if (compact.length < 5) return false;
  if (isAffirmativeUtterance(value) || isNegativeUtterance(value)) return false;
  if (/^(כן|לא|אוקיי|בסדר|טוב|תודה)$/u.test(value)) return false;
  return true;
}

function isIgnorableNoiseText(text) {
  const value = safeStr(text).replace(/\s+/g, " ").trim();
  if (!value) return true;
  if (/^<\s*noise\s*>$/iu.test(value)) return true;
  if (/^noise$/iu.test(value)) return true;
  if (/^[.\-,!?]+$/.test(value)) return true;
  return false;
}

function isIgnorableShortBotEcho(session, text) {
  const value = safeStr(text).replace(/\s+/g, " ").trim();
  if (!value) return true;
  const callerName = normalizeLikelyName(
    safeStr(session?.meta?.caller_profile?.display_name)
      || safeStr(session?._passiveCtx?.name)
      || safeStr(session?._orchestrator?.memory?.snapshot?.()?.callerName)
  );
  const normalizedValue = normalizeLikelyName(value);
  if (callerName && normalizedValue && normalizedValue === callerName) return true;
  const compact = value.replace(/\s+/g, "");
  if (compact.length <= 2) return true;
  if (/^[֐-׿]{1,2}$/u.test(compact)) return true;
  return false;
}

function countSingleHebrewLetterTokens(text) {
  return safeStr(text)
    .split(/[^\u0590-\u05FF]+/u)
    .map((part) => safeStr(part))
    .filter((part) => /^[א-ת]$/u.test(part)).length;
}

function looksLikeLowConfidenceHebrewTurn(nlp, normalizedUserText) {
  const value = safeStr(normalizedUserText).replace(/\s+/g, " ").trim();
  const raw = safeStr(nlp?.raw_text || nlp?.raw || "");
  const compact = value.replace(/\s+/g, "");

  if (!value) return true;
  if (compact.length < 6) return true;
  if (/^(היי|שלום|היי, שלום|שלום לך)[\s,.!?]*[א-ת]?$/u.test(value)) return true;
  if (/[א-ת]$/u.test(value) && compact.length <= 18) return true;
  if (/\b(בעצם|רציתי|אני רוצה|אני צריך|אפשר|שאלה)\b/u.test(value) && compact.length <= 24 && !/[?.!]$/u.test(value)) return true;

  const isolated = countSingleHebrewLetterTokens(raw || value);
  if (isolated >= 2) return true;

  if (/תילדעת/u.test(compact)) return true;
  return false;
}

function noteLowConfidenceTurn(session) {
  if (!session || typeof session !== "object") return { count: 0 };
  const now = Date.now();
  const state = session._lowConfidenceTurnState || { count: 0, lastAt: 0 };
  if (!state.lastAt || now - state.lastAt > 6000) state.count = 0;
  state.count += 1;
  state.lastAt = now;
  session._lowConfidenceTurnState = state;
  return state;
}

function resetLowConfidenceTurns(session) {
  if (!session || typeof session !== "object") return;
  session._lowConfidenceTurnState = { count: 0, lastAt: 0 };
}

function handleUserTranscript(session, nlp) {
  try {
    if (!session || typeof session !== "object") return false;

    const normalizedNlp = normalizeNlpInput(nlp);
    if (!normalizedNlp.raw && !normalizedNlp.normalized) return false;

    if (session._awaitingFreshTurnAfterInterrupt) session._awaitingFreshTurnAfterInterrupt = false;
    if (session._hardClosingMode && session._ignoreLooseUserTurnsUntilTs > Date.now()) {
      logger.info("USER_TURN_IGNORED_DURING_CLOSING", {
        ...session.meta,
        text: normalizedNlp.raw,
        raw_text: normalizedNlp.raw_text,
        normalized_text: normalizedNlp.normalized_text,
        recovered_text: normalizedNlp.recovered_text,
        final_text: normalizedNlp.final_text,
      });
      return true;
    }

    const normalizedUserText = stripNoiseMarkers(normalizedNlp.recovered || normalizedNlp.normalized || normalizedNlp.raw);
    if (isIgnorableNoiseText(normalizedUserText)) {
      logger.info("IGNORED_NOISE_USER_TRANSCRIPT", {
        ...session.meta,
        text: normalizedUserText,
        raw_text: normalizedNlp.raw_text,
        normalized_text: normalizedNlp.normalized_text,
      });
      return true;
    }

    try {
      const callerId = safeStr(session.meta?.caller) || "";
      if (callerId) {
        let lastBot = "";
        const logArr = getConversationLog(session);
        for (let i = logArr.length - 2; i >= 0; i -= 1) {
          const it = logArr[i];
          if (it?.role === "assistant" && it.text) {
            lastBot = String(it.text);
            break;
          }
        }

        const found = extractCallerName({ userText: normalizedUserText, lastBotUtterance: lastBot });
        if (found?.name) {
          const normalizedName = normalizeLikelyName(found.name);
          const askedForName = lastBotAskedForName(lastBot);
          const explicit = String(found.reason || "").startsWith("explicit_");
          if (normalizedName && hasHebrewLetters(normalizedName) && (askedForName || explicit)) {
            clearReportPromptLoopForCapturedName(session);
            safeCommitRuntimeName(session, normalizedName, found.reason, normalizedNlp.raw);
            return true;
          }
          if (askedForName || explicit) {
            const recovery = session._orchestrator?.handleNameCaptureRecovery?.({
              userText: normalizedName || normalizedUserText,
              lastBotUtterance: lastBot,
            });
            if (recovery?.handled && recovery.action === "confirm_candidate" && recovery.text) {
              safeImmediateText(session, recovery.text, "NAME_CONFIRMATION_SENT");
              return true;
            }
            session._awaitingNameModelEcho = true;
            session._pendingNameSourceUtterance = normalizedNlp.raw;
          }
        } else {
          const recovery = session._orchestrator?.handleNameCaptureRecovery?.({
            userText: normalizedUserText,
            lastBotUtterance: lastBot,
          });
          if (recovery?.handled) {
            if (recovery.action === "commit_name" && recovery.name) {
              clearReportPromptLoopForCapturedName(session);
              safeCommitRuntimeName(session, recovery.name, recovery.reason || "name_confirmation_yes", recovery.sourceUtterance || normalizedNlp.raw);
              return true;
            }
            if (recovery.action === "confirm_candidate" && recovery.text) {
              safeImmediateText(session, recovery.text, "NAME_CONFIRMATION_SENT");
              return true;
            }
          }
        }
      }
    } catch {}

    try {
      const explicitHebName = collapseHebrewSpacing(normalizedUserText).match(
        /(?:קוראים לי|שמי|השם שלי|אני)\s+([\u0590-\u05FF]{2,}(?:\s+[\u0590-\u05FF]{2,}){0,2})/u
      );
      const directName = normalizeLikelyName(explicitHebName?.[1] || "");
      if (directName && hasHebrewLetters(directName)) {
        const ctxArr = getConversationLog(session);
        let lastBot = "";
        for (let i = ctxArr.length - 2; i >= 0; i -= 1) {
          const it = ctxArr[i];
          if (it?.role === "assistant" && it.text) {
            lastBot = String(it.text);
            break;
          }
        }
        const askedForName = lastBotAskedForName(lastBot);
        if (askedForName || /קוראים לי|שמי|השם שלי/u.test(normalizedUserText)) {
          clearReportPromptLoopForCapturedName(session);
          safeCommitRuntimeName(session, directName, "explicit_name_phrase_fallback", normalizedNlp.raw);
          return true;
        }
      }
    } catch {}

    const previousReportState = cloneReportState(session);
    const hasReportsIntent = hasConfiguredIntent(session, "reports_request");
    if (hasReportsIntent) applyReportEntities(session, normalizedUserText);

    const callbackText = normalizedUserText;
    const memSnapshot = session._orchestrator?.memory?.snapshot?.() || {};

    if (looksLikeLowConfidenceHebrewTurn(normalizedNlp, normalizedUserText)) {
      const lowConfidenceState = noteLowConfidenceTurn(session);
      logger.info("LOW_CONFIDENCE_USER_TURN_IGNORED", {
        ...session.meta,
        count: lowConfidenceState.count,
        text: normalizedUserText,
        raw_text: normalizedNlp.raw_text,
        normalized_text: normalizedNlp.normalized_text,
        recovered_text: normalizedNlp.recovered_text,
        final_text: normalizedNlp.final_text,
      });

      if (lowConfidenceState.count >= 2) {
        const retryText = getApprovedScriptText(
          session,
          "ERROR_REPEAT",
          safeStr(session.ssot?.settings?.NO_DATA_MESSAGE) || "סליחה, לא הבנתי, אפשר לחזור שוב"
        );
        safeImmediateText(session, retryText, "LOW_CONFIDENCE_REPEAT_SENT");
      }
      return true;
    }
    const callbackQuestionActive = !!(
      session._awaitingCallbackConfirmation ||
      memSnapshot.awaitingCallbackConfirmation
    );
    if (callbackQuestionActive) {
      if (refersToSameCallerNumber(callbackText, safeStr(session.meta?.caller))) {
        session._callbackConfirmed = true;
        session._awaitingCallbackConfirmation = false;
        if (!safeCallbackConfirmed(session, null)) {
          const closing = safeStr(session.ssot?.settings?.CLOSING_callback)
            || safeStr(session.ssot?.settings?.CLOSING_GOODBYE)
            || "תודה רבה, רשמתי את הפרטים. נציג יחזור אליכם בהקדם.";
          safeImmediateText(session, closing, "CALLBACK_CONFIRMED_SENT");
        }
        return true;
      }

      if (refersToOtherNumber(callbackText) || isNegativeUtterance(callbackText)) {
        session._awaitingCallbackConfirmation = false;
        safeImmediateText(session, safeStr(session.ssot?.settings?.CALLBACK_ALT_NUMBER_PHRASE) || "אין בעיה, לאיזה מספר תרצו שנחזור?", "CALLBACK_ALT_NUMBER_SENT");
        return true;
      }

      if (isAffirmativeUtterance(callbackText)) {
        const askPhrase = safeStr(session.ssot?.settings?.CALLBACK_ASK_PHRASE) || "לחזור למספר שממנו התקשרתם או למספר אחר?";
        safeImmediateText(session, askPhrase, "CALLBACK_CONFIRM_CLARIFY_SENT");
        return true;
      }
    }

    resetLowConfidenceTurns(session);
    const shouldRunIntent = !isIgnorableNoiseText(normalizedUserText) && !isInternalLabelText(normalizedUserText);
    const intent = shouldRunIntent ? detectIntent({
      text: normalizedUserText,
      intents: session.ssot?.intents || [],
      intentSuggestions: session.ssot?.intent_suggestions || [],
    }) : { intent_id: "other", intent_type: "other", score: 0, priority: 0, matched_triggers: [] };
    session._lastDetectedIntent = intent?.intent_id || "other";

    logger.info("INTENT_DETECTED", {
      ...session.meta,
      text: normalizedNlp.raw,
      normalized: normalizedNlp.normalized,
      recovered: normalizedNlp.recovered,
      raw_text: normalizedNlp.raw_text,
      normalized_text: normalizedNlp.normalized_text,
      recovered_text: normalizedNlp.recovered_text,
      final_text: normalizedNlp.final_text,
      stage_order: normalizedNlp.stage_order,
      stages: normalizedNlp.stages,
      lang: normalizedNlp.lang,
      language_locked: session._langState?.lockedLanguage,
      intent,
    });

    const shouldCaptureSubject = !callbackQuestionActive && (looksLikeNeedStatement(normalizedUserText) || intent?.intent_id === "product_interest" || intent?.intent_id === "price_question" || intent?.intent_id === "complaint");
    if (shouldCaptureSubject) {
      session._orchestrator?.noteSubject?.(normalizedUserText);
    }
    session._orchestrator?.noteIntent?.(intent?.intent_id || "other");

    const structuredFollowup = maybeGetStructuredFollowup(session, normalizedUserText, intent);
    if (structuredFollowup?.text) {
      if (structuredFollowup.callback) {
        session._awaitingCallbackConfirmation = true;
        session._orchestrator?.noteCallbackAwaiting?.(true);
      }
      safeImmediateText(session, structuredFollowup.text, structuredFollowup.label || "FLOW_FOLLOWUP_SENT");
      return true;
    }

    const wantsCallback = containsCallbackRequest(normalizedUserText) || intent?.intent_id === "callback_request";
    const reportIntent = hasReportsIntent && (intent?.intent_id === "reports_request" ||
      !!session._reportState.reportType || !!session._reportState.period || !!session._reportState.forWhom);

    if (reportIntent) {
      if (wantsCallback && (memSnapshot.collectedFields?.subject || intent?.intent_id === "callback_request") && !session._awaitingCallbackConfirmation && !session._callbackConfirmed && !session._hardClosingMode) {
        const askPhrase = safeStr(session.ssot?.settings?.CALLBACK_ASK_PHRASE) || "כדי שנוכל לחזור אליכם, לחזור למספר שממנו התקשרתם או למספר אחר?";
        session._awaitingCallbackConfirmation = true;
        safeImmediateText(session, askPhrase, "CALLBACK_ASK_SENT");
        return true;
      }

      const question = maybeGetNextReportQuestion(session, previousReportState);
      if (question) {
        safeImmediateText(session, question.text, question.label);
        return true;
      }
    }

    if (wantsCallback && (memSnapshot.collectedFields?.subject || intent?.intent_id === "callback_request") && !session._awaitingCallbackConfirmation && !session._callbackConfirmed && !session._hardClosingMode) {
      const askPhrase = safeStr(session.ssot?.settings?.CALLBACK_ASK_PHRASE) || "כדי שנוכל לחזור אליכם, לחזור למספר שממנו התקשרתם או למספר אחר?";
      session._awaitingCallbackConfirmation = true;
      safeImmediateText(session, askPhrase, "CALLBACK_ASK_SENT");
      return true;
    }

    return false;
  } catch (err) {
    logger.warn("handleUserTranscript failed safely", {
      error: err?.message || String(err),
      callSid: getCallSid(session),
    });
    return false;
  }
}

function handleBotTranscript(session, nlp) {
  try {
    if (!session || typeof session !== "object") return false;

    const normalizedNlp = normalizeNlpInput(nlp);
    const botText = safeStr(normalizedNlp.recovered || normalizedNlp.normalized || normalizedNlp.raw);
    if (!botText) return false;
    if (isIgnorableShortBotEcho(session, botText)) return true;

    if (botText.includes("[") || botText.includes("]")) {
      const safeName = normalizeLikelyName(
        safeStr(session.meta?.caller_profile?.display_name) || safeStr(session._passiveCtx?.name) || ""
      );
      if (safeName && typeof session._sendImmediateNameAcknowledgement === "function") {
        try {
          session._sendImmediateNameAcknowledgement(safeName);
        } catch {}
      }
      return true;
    }

    if (isInternalLabelText(botText)) return true;

    const ctxArr = getConversationLog(session);
    let recentUser = "";
    let previousAssistant = "";
    for (let i = ctxArr.length - 2; i >= 0; i -= 1) {
      if (!recentUser && ctxArr[i]?.role === "user") recentUser = safeStr(ctxArr[i]?.text);
      else if (recentUser && ctxArr[i]?.role === "assistant") {
        previousAssistant = safeStr(ctxArr[i]?.text);
        break;
      }
    }

    const normalizedBotCompact = normalizeUtterance(botText).normalized.replace(/\s+/g, "");
    const normalizedRecentUserCompact = normalizeUtterance(recentUser).normalized.replace(/\s+/g, "");
    if (normalizedBotCompact && normalizedRecentUserCompact && normalizedBotCompact === normalizedRecentUserCompact) {
      return true;
    }

    const botAsName = normalizeLikelyName(botText);
    const userLooksLikeExplicitName = /השם שלי|שמי|קוראים לי|שלום אני|אני\s+[\u0590-\u05FF]{2,}/u.test(recentUser);
    if (
      botAsName &&
      hasHebrewLetters(botAsName) &&
      (session._awaitingNameModelEcho || lastBotAskedForName(previousAssistant) || userLooksLikeExplicitName)
    ) {
      clearReportPromptLoopForCapturedName(session);
      safeCommitRuntimeName(
        session,
        botAsName,
        session._awaitingNameModelEcho ? "awaiting_name_model_echo" : "bot_name_echo",
        session._pendingNameSourceUtterance || recentUser || botText
      );
      session._awaitingNameModelEcho = false;
      session._pendingNameSourceUtterance = "";
      return true;
    }

    if (session._awaitingCallbackDigits) {
      const digits = normalizeDigitsLoose(botText);
      const askedQuestion = safeStr(session._pendingCallbackDigitsQuestion || "");
      if (digits.length >= 9) {
        session._awaitingCallbackDigits = false;
        session._pendingCallbackDigitsQuestion = "";
        session._call = session._call || {};
        session._call.callback_number = digits;
        const confirmTemplate = safeStr(session.ssot?.settings?.CALLBACK_CONFIRM_NEW_NUMBER_TEMPLATE)
          || "רק לוודא, המספר הוא {DIGITS_SPOKEN}. זה נכון?";
        const text = applyTemplate(confirmTemplate, { DIGITS_SPOKEN: digitsSpoken(digits) });
        safeImmediateText(session, text, "CALLBACK_NEW_NUMBER_CONFIRM_SENT");
        session._awaitingCallbackConfirmation = true;
        session._callbackConfirmed = false;
        return true;
      }

      if (askedQuestion) {
        const retryPhrase = safeStr(session.ssot?.settings?.CALLBACK_RETRY_PHRASE)
          || "סליחה, לא שמעתי טוב, אנא חיזרו על המספר באופן רציף או ללא עצירה.";
        safeImmediateText(session, retryPhrase, "CALLBACK_NEW_NUMBER_RETRY_SENT");
        return true;
      }
    }

    if (isClosingUtterance(botText)) {
      session._hardClosingMode = true;
      session._ignoreLooseUserTurnsUntilTs = Date.now() + 1500;

      const forceHangup = String(session.ssot?.settings?.FORCE_HANGUP_AFTER_CLOSE || "").toLowerCase() === "true";
      if (forceHangup) {
        const callSid = getCallSid(session);
        const graceMs = Math.max(0, Number(session.ssot?.settings?.MB_END_CALL_DELAY_MS || 1200) || 1200);
        if (callSid) {
          setTimeout(() => {
            hangupCall(callSid, logger).catch(() => false);
          }, graceMs);
        }
        logger.info("Proactive hangup scheduled", { ...session.meta, callSid, delay_ms: graceMs });
      }
    }

    return false;
  } catch (err) {
    logger.warn("handleBotTranscript failed safely", {
      error: err?.message || String(err),
      callSid: getCallSid(session),
    });
    return false;
  }
}

module.exports = {
  handleUserTranscript,
  handleBotTranscript,
};
