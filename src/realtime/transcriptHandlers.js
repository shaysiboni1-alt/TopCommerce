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

  const normalizedObj = normalizeUtterance(base.normalized || base.raw || "");
  return {
    ...base,
    raw: safeStr(base.raw || normalizedObj.raw),
    normalized: safeStr(normalizedObj.normalized || base.normalized || base.raw),
    recovered: safeStr(normalizedObj.recovered || normalizedObj.normalized || base.normalized || base.raw),
    compact: safeStr(normalizedObj.compact || ""),
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

function handleUserTranscript(session, nlp) {
  try {
    if (!session || typeof session !== "object") return false;

    const normalizedNlp = normalizeNlpInput(nlp);
    if (!normalizedNlp.raw && !normalizedNlp.normalized) return false;

    if (session._awaitingFreshTurnAfterInterrupt) session._awaitingFreshTurnAfterInterrupt = false;
    if (session._hardClosingMode && session._ignoreLooseUserTurnsUntilTs > Date.now()) {
      logger.info("USER_TURN_IGNORED_DURING_CLOSING", { ...session.meta, text: normalizedNlp.raw });
      return true;
    }

    const normalizedUserText = stripNoiseMarkers(normalizedNlp.recovered || normalizedNlp.normalized || normalizedNlp.raw);

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
            if (recovery.text) {
              safeImmediateText(session, recovery.text, recovery.promptKind === "name_confirm" ? "NAME_CONFIRMATION_SENT" : "NAME_HEARING_REPAIR_SENT");
              return true;
            }
          }
        }
      }
    } catch {}

    if (!safeStr(session.meta?.caller_profile?.display_name || session._passiveCtx?.name)) {
      const explicitHebName = collapseHebrewSpacing(normalizedUserText).match(
        /(?:^|\b)(?:שלום\s+אני|אני|שמי|קוראים לי|השם שלי(?:\s+זה)?)\s+([\u0590-\u05FF]{2,}(?:\s+[\u0590-\u05FF]{2,})?)$/u
      );
      if (explicitHebName && explicitHebName[1]) {
        const directName = normalizeLikelyName(explicitHebName[1]);
        if (directName && hasHebrewLetters(directName)) {
          clearReportPromptLoopForCapturedName(session);
          safeCommitRuntimeName(session, directName, "explicit_name_phrase_fallback", normalizedNlp.raw);
          return true;
        }
      }
    }

    ensureReportState(session);
    const previousReportState = cloneReportState(session);
    applyReportEntities(session, normalizedUserText);

    const callbackText = normalizedUserText;
    if (session._awaitingCallbackConfirmation) {
      if (refersToSameCallerNumber(callbackText)) {
        const question = maybeGetNextReportQuestion(session, previousReportState);
        const nextQuestion = question ? question.text : "איך אפשר לעזור?";
        safeCallbackConfirmed(session, nextQuestion);
        return true;
      }

      if (refersToOtherNumber(callbackText) || normalizeDigitsLoose(callbackText).length >= 8) {
        session._awaitingCallbackConfirmation = false;
        const digits = normalizeDigitsLoose(callbackText);
        if (digits.length >= 8) {
          const tpl = safeStr(session.ssot?.settings?.CALLBACK_CONFIRM_NEW_NUMBER_TEMPLATE);
          if (tpl) {
            safeImmediateText(session, applyTemplate(tpl, { DIGITS_SPOKEN: digitsSpoken(digits) }), "CALLBACK_NUMBER_CONFIRM_SENT");
            return true;
          }
        }
        safeImmediateText(session, safeStr(session.ssot?.settings?.CALLBACK_ALT_NUMBER_PHRASE) || "אין בעיה, לאיזה מספר תרצו שנחזור?", "CALLBACK_ALT_NUMBER_SENT");
        return true;
      }

      if (isNegativeUtterance(callbackText)) {
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

    const intent = detectIntent({
      text: normalizedUserText,
      intents: session.ssot?.intents || [],
      intentSuggestions: session.ssot?.intent_suggestions || [],
    });
    session._lastDetectedIntent = intent?.intent_id || "other";

    logger.info("INTENT_DETECTED", {
      ...session.meta,
      text: normalizedNlp.raw,
      normalized: normalizedNlp.normalized,
      recovered: normalizedNlp.recovered,
      lang: normalizedNlp.lang,
      language_locked: session._langState?.lockedLanguage,
      intent,
    });

    const wantsCallback = containsCallbackRequest(normalizedUserText) || intent?.intent_id === "callback_request";
    const reportIntent = intent?.intent_id === "reports_request" ||
      !!session._reportState.reportType || !!session._reportState.period || !!session._reportState.forWhom;

    if (reportIntent) {
      if (wantsCallback && !session._awaitingCallbackConfirmation && !session._callbackConfirmed && !session._hardClosingMode) {
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

    if (wantsCallback && !session._awaitingCallbackConfirmation && !session._callbackConfirmed && !session._hardClosingMode) {
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
      return true;
    }

    if (session._lastDetectedIntent === "reports_request" && /^דו["']?חות?(?:\s+רווח\s+והפסד)?[.!?]?$/u.test(botText)) {
      const prevState = cloneReportState(session);
      const question = maybeGetNextReportQuestion(session, prevState);
      if (question) safeImmediateText(session, question.text, question.label);
      return true;
    }

    if (/(לחזור למספר|לחזור אל המספר|לחזור למספר המזוהה|האם לחזור למספר|שנחזור למספר)/u.test(botText)) {
      session._awaitingCallbackConfirmation = true;
    }

    const sessionEnv = getSessionEnv(session);
    if (sessionEnv.FORCE_HANGUP_AFTER_CLOSE && !session._hangupScheduled && isClosingUtterance(botText, session.ssot)) {
      const callSid = getCallSid(session);
      if (callSid) {
        session._hangupScheduled = true;
        const graceMs = Math.max(15000, Number(sessionEnv.HANGUP_AFTER_CLOSE_GRACE_MS || 15000));
        setTimeout(() => {
          hangupCall(callSid, logger).catch(() => {});
        }, graceMs);
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

module.exports = { handleBotTranscript, handleUserTranscript };
