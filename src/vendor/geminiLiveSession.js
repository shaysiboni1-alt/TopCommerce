"use strict";

const WebSocket = require("ws");
const { env } = require("../config/env");
const { logger } = require("../utils/logger");
const {
  applyTemplate,
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
} = require("../config/runtimeSettings");
const {
  ulaw8kB64ToPcm16kB64,
  pcm24kB64ToUlaw8kB64,
} = require("./twilioGeminiAudio");
const {
  normalizeUtterance,
  detectExplicitLanguageSwitch,
} = require("../logic/hebrewNlp");
const { registerSession } = require("../runtime/callRegistry");
const { TranscriptStore } = require("../runtime/transcriptStore");
const { ConversationOrchestrator } = require("../runtime/conversationOrchestrator");
const { finalizeThroughCoordinator } = require("../finalization/finalizationCoordinator");
const { updateCallerDisplayName } = require("../memory/callerMemory");
const { hangupCall } = require("../utils/twilioRecordings");
const { getCachedOpening } = require("../logic/openingBuilder");
const { getCompiledPromptBundle } = require("../realtime/compiledPromptBundle");
const { buildSystemInstructionFromSSOT } = require("../realtime/systemInstructionBuilder");
const { handleBotTranscript, handleUserTranscript } = require("../realtime/transcriptHandlers");
const { recordCallEvent } = require("../debug/debugLogger");
const { DEBUG_EVENT_CATEGORIES, DEBUG_EVENT_TYPES } = require("../debug/debugEventTypes");
const {
  clampNum,
  hasHebrewLetters,
  isClosingUtterance,
  isLatinOnlyText,
  liveWsUrl,
  looksLikeReasoningText,
  normalizeCallerId,
  normalizeLikelyName,
  normalizeModelName,
  nowIso,
  safeStr,
  scrubReasoningText,
} = require("../realtime/sessionUtils");

let passiveCallContext = null;
try {
  passiveCallContext = require("../logic/passiveCallContext");
} catch {
  passiveCallContext = null;
}

function isHebrewChar(ch) {
  return /[\u0590-\u05FF]/u.test(safeStr(ch));
}

function longestSuffixPrefixOverlap(a, b, maxWindow) {
  const left = safeStr(a);
  const right = safeStr(b);
  if (!left || !right) return 0;

  const max = Math.min(left.length, right.length, Number.isFinite(Number(maxWindow)) ? Number(maxWindow) : 32);
  for (let len = max; len > 0; len -= 1) {
    if (left.slice(-len) === right.slice(0, len)) return len;
  }
  return 0;
}


function isNoiseOnlyText(text) {
  const value = safeStr(text).replace(/\s+/g, ' ').trim();
  if (!value) return true;
  if (/^<\s*noise\s*>$/iu.test(value)) return true;
  if (/^noise$/iu.test(value)) return true;
  if (/^[.\-,!?]+$/.test(value)) return true;
  return false;
}

function normalizeCompactHebrew(text) {
  return normalizeUtterance(safeStr(text)).normalized.replace(/\s+/g, '');
}

function shouldIgnoreAssistantTranscript(session, finalText) {
  const value = safeStr(finalText).replace(/\s+/g, ' ').trim();
  if (!value) return true;
  const convo = Array.isArray(session?._call?.conversationLog) ? session._call.conversationLog : [];
  const recentUserText = (() => {
    for (let i = convo.length - 1; i >= 0 && i >= convo.length - 8; i -= 1) {
      const it = convo[i];
      if (it?.role === 'user' && it?.text) return String(it.text);
    }
    return '';
  })();
  const compactRecentUser = normalizeCompactHebrew(recentUserText);
  const compactValue = normalizeCompactHebrew(value);
  const compactOpening = normalizeCompactHebrew(session?.meta?.prebuilt_opening_text || "");
  const compactImmediate = normalizeCompactHebrew(session?._lastImmediatePrompt?.text || "");
  if (compactRecentUser && compactValue && compactRecentUser === compactValue) return true;
  if (compactOpening && compactValue && compactOpening === compactValue) return true;
  if (compactImmediate && compactValue && compactImmediate === compactValue) return true;
  if (looksLikeReasoningText(value)) return true;
  const compact = value.replace(/\s+/g, '');
  if (compact.length <= 2) return true;
  if (/^[֐-׿]{1,2}$/u.test(compact)) return true;
  if (Date.now() < Number(session?._ignoreBotNameEchoUntilTs || 0)) return true;

  const callerName = normalizeLikelyName(
    safeStr(session?.meta?.caller_profile?.display_name)
      || safeStr(session?._passiveCtx?.name)
      || safeStr(session?._orchestrator?.memory?.snapshot?.()?.callerName)
  );
  const normalizedValue = normalizeLikelyName(value);
  if (callerName && normalizedValue && callerName == normalizedValue) return true;

  return false;
}

function mergeTranscriptChunks(prevText, nextChunk) {
  const prev = safeStr(prevText).trim();
  const next = safeStr(nextChunk).trim();

  if (!prev) return next;
  if (!next) return prev;
  if (prev === next) return prev;
  if (next.startsWith(prev)) return next;
  if (prev.endsWith(next)) return prev;

  const overlap = longestSuffixPrefixOverlap(prev, next, 48);
  if (overlap > 0) {
    return `${prev}${next.slice(overlap)}`.replace(/\s{2,}/g, " ").trim();
  }

  if (/[\u0590-\u05FF]$/.test(prev) && /^[\u0590-\u05FF]/.test(next)) {
    return `${prev} ${next}`.replace(/\s{2,}/g, " ").trim();
  }

  return `${prev} ${next}`.replace(/\s{2,}/g, " ").trim();
}

class GeminiLiveSession {
  constructor({ onGeminiAudioUlaw8kBase64, onGeminiText, onTranscript, meta, ssot, callSession }) {
    this.onGeminiAudioUlaw8kBase64 = onGeminiAudioUlaw8kBase64;
    this.onGeminiText = onGeminiText;
    this.onTranscript = onTranscript;
    this.meta = meta || {};
    this.ssot = ssot || {};
    this.callSession = callSession || null;
    this.env = env || {};

    this.ws = null;
    this.ready = false;
    this.closed = false;
    this._greetingSent = false;
    this._providerReconnectAttempts = 0;
    this._lastBotText = "";
    this._lastBotTextAt = 0;
    this._openingPromptSent = false;
    this._providerRecovering = false;
    this._stopRequested = false;
    this._lastImmediatePrompt = null;
    this._hangupScheduled = false;
    this._awaitingCallbackConfirmation = false;
    this._callbackConfirmed = false;
    this._lastDetectedIntent = "other";
    this._closingSentAfterCallback = false;
    this._hardClosingMode = false;
    this._ignoreLooseUserTurnsUntilTs = 0;
    this._ignoreBotNameEchoUntilTs = 0;
    this._lastNameAckTs = 0;
    this._awaitingNameModelEcho = false;
    this._pendingNameSourceUtterance = "";
    this._reportState = { reportType: null, period: null, forWhom: null };
    this._assistantPlaybackActive = false;
    this._awaitingFreshTurnAfterInterrupt = false;
    this._interruptRecoveryUntilTs = 0;

    this._openingPhase = true;
    this._conversationPhaseStarted = false;
    this._openingAudioStarted = false;
    this._openingSentAt = 0;
    this._openingBargeInGraceUntilTs = 0;
    this._openingPhaseFallbackTimer = null;

    this._langState = {
      lockedLanguage: safeStr(this.env.MB_DEFAULT_LANGUAGE) || "he",
      candidateLanguage: null,
      candidateHits: 0,
      minConsecutive: Math.max(
        2,
        Number(this.env.MB_LANGUAGE_SWITCH_MIN_CONSECUTIVE_UTTERANCES || 2)
      ),
    };

    this._transcriptStore = new TranscriptStore({
      getFlushDelayMs: (who) => (who === "user" ? this._getUserFlushDelayMs() : this._getBotFlushDelayMs()),
      getStableGapMs: (who) => (who === "user" ? this._getUserMinStableGapMs() : this._getBotMinStableGapMs()),
      shouldDelayFlush: (who, bufferedText, ctx) => {
        if (who !== "user") return false;
        const looksIncomplete =
          typeof this._looksIncompleteUserThought === "function"
            ? this._looksIncompleteUserThought(bufferedText)
            : false;
        const shouldHold = this._isShortUserFragment(bufferedText) || looksIncomplete;
        if (!shouldHold) return false;
        const maxAgeMs = Math.max(ctx.stableGapMs * 2, getUserTranscriptMaxBufferMs());
        return ctx.bufferAgeMs < maxAgeMs;
      },
      mergeChunks: mergeTranscriptChunks,
      normalizeText: (value) => normalizeUtterance(value),
      onFlush: (payload) => this._handleTranscriptFlush(payload),
    });

    const callerInfo = normalizeCallerId(this.meta?.caller || "");

    const initialCall = {
      callSid: safeStr(this.meta?.callSid),
      streamSid: safeStr(this.meta?.streamSid),
      source: safeStr(this.meta?.source) || "VoiceBot_Blank",
      caller_raw: callerInfo.value,
      caller_withheld: callerInfo.withheld,
      called: safeStr(this.meta?.called),
      started_at: nowIso(),
      ended_at: null,
      conversationLog: [],
      recording_sid: "",
      finalized: false,
    };

    if (this.callSession && typeof this.callSession.updateSnapshot === "function") {
      this.callSession.updateSnapshot((snap) => ({
        ...(snap || {}),
        call: {
          ...(snap?.call || {}),
          ...initialCall,
        },
        conversationLog: Array.isArray(snap?.conversationLog) ? snap.conversationLog : [],
        lead: snap?.lead || {},
      }));
    }

    registerSession(initialCall.callSid, this, {
      call: this._getCallData(),
      conversationLog: this._getConversationLog(),
    });

    if (this.callSession && typeof this.callSession.attachGeminiSession === "function") {
      this.callSession.attachGeminiSession(this);
    }

    this._orchestrator = new ConversationOrchestrator({
      env: this.env,
      ssot: this.ssot,
      meta: this.meta,
      callSession: this.callSession,
      sendImmediateText: (text, label) => this._sendImmediateText(text, label),
    });

    this._passiveCtx = null;
    try {
      if (passiveCallContext?.createPassiveCallContext) {
        const callData = this._getCallData();
        this._passiveCtx = passiveCallContext.createPassiveCallContext({
          callSid: callData.callSid,
          streamSid: callData.streamSid,
          caller: callData.caller_raw,
          called: callData.called,
          source: callData.source,
          caller_profile: this.meta?.caller_profile || null,
        });
      }
    } catch {}
  }

  _getCallData() {
    if (this.callSession && typeof this.callSession.getCall === "function") {
      return this.callSession.getCall() || {};
    }
    return {};
  }

  _getConversationLog() {
    if (this.callSession && typeof this.callSession.getConversationLog === "function") {
      return this.callSession.getConversationLog() || [];
    }
    return [];
  }

  _updateSnapshot(mutator) {
    if (this.callSession && typeof this.callSession.updateSnapshot === "function") {
      return this.callSession.updateSnapshot(mutator);
    }
    return null;
  }

  _updateCall(mutator) {
    if (this.callSession && typeof this.callSession.updateCall === "function") {
      return this.callSession.updateCall(mutator);
    }
    return null;
  }

  _setConversationLog(conversationLog) {
    if (this.callSession && typeof this.callSession.setConversationLog === "function") {
      return this.callSession.setConversationLog(conversationLog);
    }
    return null;
  }

  _appendConversationEntry(entry) {
    if (this.callSession && typeof this.callSession.appendConversationTurn === "function") {
      return this.callSession.appendConversationTurn(entry);
    }

    const currentLog = this._getConversationLog().slice();
    currentLog.push(entry);
    return this._setConversationLog(currentLog);
  }

  _beginOpeningPhase() {
    this._openingPhase = true;
    this._conversationPhaseStarted = false;
    this._openingAudioStarted = false;
    this._openingSentAt = Date.now();
    this._openingBargeInGraceUntilTs = Number.MAX_SAFE_INTEGER;

    if (this._openingPhaseFallbackTimer) {
      clearTimeout(this._openingPhaseFallbackTimer);
      this._openingPhaseFallbackTimer = null;
    }

    const fallbackMs = getOpeningPhaseMaxMs();
    this._openingPhaseFallbackTimer = setTimeout(() => {
      this._endOpeningPhase("fallback_timeout");
    }, fallbackMs);
  }

  _endOpeningPhase(reason) {
    if (!this._openingPhase) return;
    this._openingPhase = false;
    this._conversationPhaseStarted = true;
    this._openingAudioStarted = false;
    this._openingBargeInGraceUntilTs = Date.now();

    if (this._openingPhaseFallbackTimer) {
      clearTimeout(this._openingPhaseFallbackTimer);
      this._openingPhaseFallbackTimer = null;
    }

    recordCallEvent({
      callSid: this._getCallData().callSid,
      streamSid: this._getCallData().streamSid,
      category: DEBUG_EVENT_CATEGORIES.CONVERSATION,
      type: "OPENING_PHASE_ENDED",
      source: "geminiLiveSession",
      level: "debug",
      data: {
        reason: safeStr(reason) || "unknown",
      },
    });
  }

  isOpeningPhase() {
    return this._openingPhase === true;
  }

  _getUserFlushDelayMs() {
    const base = getUserTranscriptFlushMs();
    return this._orchestrator?.getUserFlushDelayMs?.(base) || base;
  }

  _getBotFlushDelayMs() {
    return getBotTranscriptFlushMs();
  }

  _getUserMinStableGapMs() {
    const base = getUserTranscriptStableGapMs();
    return this._orchestrator?.getUserStableGapMs?.(base) || base;
  }

  _getBotMinStableGapMs() {
    return getBotTranscriptStableGapMs();
  }

  _countWords(text) {
    return safeStr(text)
      .split(/\s+/)
      .map((part) => safeStr(part))
      .filter(Boolean).length;
  }

  _isShortUserFragment(text) {
    const value = safeStr(text);
    const chars = value.replace(/\s+/g, "").length;
    const words = this._countWords(value);
    return chars < getUserTranscriptMinChars() ||
      words < getUserTranscriptMinWords();
  }

  _looksIncompleteUserThought(text) {
    const value = safeStr(text).trim();
    if (!value) return false;

    const compact = value.replace(/\s+/g, "");
    if (!compact) return false;

    if (/[,.:;\-־]$/.test(value)) return true;
    if (/(?:^|\s)(?:ו|ש|ה|ל|כ|מ|ב)$/u.test(value)) return true;

    const incompletePrefixes = [
      "היי",
      "שלום",
      "בעצם",
      "רציתי",
      "אני רוצה",
      "אני צריך",
      "אני מחפש",
      "אפשר",
      "יש לכם",
      "רק רציתי",
      "רציתי לדעת",
    ];
    if (incompletePrefixes.some((prefix) => value === prefix || value.startsWith(prefix + " "))) {
      return true;
    }

    const words = value.split(/\s+/).filter(Boolean);
    const last = safeStr(words[words.length - 1]);
    if (last && last.length === 1) return true;

    return false;
  }

  start() {
    if (this.ws) return;

    this.ws = new WebSocket(liveWsUrl(this.env));

    this.ws.on("open", async () => {
      this.callSession?.markTimeline?.("provider_session_ready_at");
      logger.info("Gemini Live WS connected", this.meta);
      if (!this._providerRecovering) this._providerReconnectAttempts = 0;
    this._lastBotText = "";
    this._lastBotTextAt = 0;
    this._openingPromptSent = false;

      recordCallEvent({
        callSid: this._getCallData().callSid,
        streamSid: this._getCallData().streamSid,
        category: DEBUG_EVENT_CATEGORIES.PROVIDER,
        type: DEBUG_EVENT_TYPES.PROVIDER_CONNECTED,
        source: "geminiLiveSession",
        level: "info",
        data: {},
      });

      const callerProfile = this.meta?.caller_profile || null;
      const callerName = safeStr(callerProfile?.display_name) || "";

      let prebuiltSystemText = safeStr(this.meta?.prebuilt_system_instruction);
      if (!prebuiltSystemText) {
        const compiledBundle = getCompiledPromptBundle({
          ssot: this.ssot,
          runtimeMeta: {
            caller_name: callerName,
            display_name: callerName,
            language_locked: this._langState.lockedLanguage,
            caller_withheld: this._getCallData().caller_withheld,
          },
          isReturning: !!callerProfile,
          timeZone: this.env.TIME_ZONE,
        });
        prebuiltSystemText = safeStr(compiledBundle?.system_instruction);
        if (!safeStr(this.meta?.prebuilt_opening_text) && safeStr(compiledBundle?.opening)) {
          this.meta.prebuilt_opening_text = safeStr(compiledBundle.opening);
          this.meta.prebuilt_opening_cache_hit = !!compiledBundle?.opening_cache_hit;
        }
      }

      const systemText = prebuiltSystemText || buildSystemInstructionFromSSOT(this.ssot, {
        caller_name: callerName,
        display_name: callerName,
        language_locked: this._langState.lockedLanguage,
        caller_withheld: this._getCallData().caller_withheld,
      });

      const vadPrefix = clampNum(this.env.MB_VAD_PREFIX_MS ?? 40, 20, 600, 40);
      const vadSilence = clampNum(this.env.MB_VAD_SILENCE_MS ?? 120, 80, 1500, 120);

      const setup = {
        setup: {
          model: normalizeModelName(this.env.GEMINI_LIVE_MODEL),
          systemInstruction: systemText
            ? { parts: [{ text: systemText }] }
            : undefined,
          generationConfig: {
            responseModalities: ["AUDIO"],
            temperature: 0.1,
            speechConfig: {
              voiceConfig: {
                prebuiltVoiceConfig: {
                  voiceName:
                    this.env.VOICE_NAME_OVERRIDE ||
                    safeStr(this.ssot?.settings?.VOICE_NAME) ||
                    "Kore",
                },
              },
            },
          },
          realtimeInputConfig: {
            automaticActivityDetection: {
              prefixPaddingMs: vadPrefix,
              silenceDurationMs: vadSilence,
            },
          },
          inputAudioTranscription: {},
        },
      };

      try {
        this.ws.send(JSON.stringify(setup));
        this.ready = true;

        recordCallEvent({
          callSid: this._getCallData().callSid,
          streamSid: this._getCallData().streamSid,
          category: DEBUG_EVENT_CATEGORIES.PROVIDER,
          type: DEBUG_EVENT_TYPES.PROVIDER_SETUP_SENT,
          source: "geminiLiveSession",
          level: "debug",
          data: {
            model: normalizeModelName(this.env.GEMINI_LIVE_MODEL),
            voice_name:
              this.env.VOICE_NAME_OVERRIDE ||
              safeStr(this.ssot?.settings?.VOICE_NAME) ||
              "Kore",
          },
        });
      } catch (e) {
        logger.error("Failed to send Gemini setup", {
          ...this.meta,
          error: e.message,
        });
        return;
      }

      try {
        if (this._providerRecovering) {
          this._providerRecovering = false;
          this.meta.opening_played = "1";
          const replay = this._lastImmediatePrompt && (Date.now() - Number(this._lastImmediatePrompt.at || 0) <= 15000)
            ? this._lastImmediatePrompt
            : null;
          if (replay?.text && !['OPENING_SENT','NAME_ACK_SENT'].includes(String(replay.label || ''))) {
            setTimeout(() => this._sendImmediateText(replay.text, replay.label || "PROVIDER_RECOVERY_REPLAY_SENT"), 180);
            return;
          }
        }

        const openingPlayed = String(this.meta?.opening_played || "") === "1" || this._openingPromptSent;
        if (openingPlayed) {
          logger.info("Opening already played by Twilio; skipping Gemini greeting", this.meta);
          this._endOpeningPhase("opening_already_played");
          return;
        }

        let openingText = safeStr(this.meta?.prebuilt_opening_text);
        try {
          if (!openingText) {
            const openingData = await Promise.resolve(
              getCachedOpening({
                ssot: this.ssot || {},
                callerName,
                isReturning: !!callerProfile,
              })
            );
            openingText = safeStr(openingData?.opening || openingData?.text || openingData);
          }
        } catch (e) {
          logger.warn("getCachedOpening failed; using fallback opening", {
            ...this.meta,
            error: e?.message || String(e),
          });
        }

        if (!openingText) {
          const settings = this.ssot?.settings || {};
          const fallbackBotName = safeStr(settings.BOT_NAME) || "הנציגה הווירטואלית";
          const fallbackBusinessName = safeStr(settings.BUSINESS_NAME);
          openingText =
            (Array.isArray(businessContextLines())
              ? businessContextLines().join(" ")
              : "") ||
            `שלום, מדברת ${fallbackBotName}${fallbackBusinessName ? ` מ${fallbackBusinessName}` : ""}, איך אפשר לעזור?`;
        }

        this._beginOpeningPhase();

        this._openingPromptSent = true;
        this._sendImmediateText(openingText, "OPENING_SENT");
        this.callSession?.markTimeline?.("first_opening_sent_at");
        this._greetingSent = true;
      } catch (e) {
        logger.warn("Failed to send opening message", { ...this.meta, error: e.message });
        this._endOpeningPhase("opening_send_failed");
      }
    });

    this.ws.on("message", async (data) => {
      let msg;
      try {
        msg = JSON.parse(data.toString("utf8"));
      } catch {
        return;
      }

      try {
        const sc = msg?.serverContent;
        const modelTurn = sc?.modelTurn;
        const parts = Array.isArray(modelTurn?.parts) ? modelTurn.parts : [];
        for (const p of parts) {
          if (p?.inlineData?.mimeType?.startsWith("audio/pcm")) {
            const pcm24kB64 = p.inlineData.data;
            const ulaw8kB64 = pcm24kB64ToUlaw8kB64(pcm24kB64);
            if (this.onGeminiAudioUlaw8kBase64) {
              this.onGeminiAudioUlaw8kBase64(ulaw8kB64);
            }
          } else if (typeof p?.text === "string") {
            const cleaned = scrubReasoningText(p.text);
            const duplicateBotText = cleaned && cleaned === this._lastBotText && (Date.now() - this._lastBotTextAt) < 2500;
            const suppressed = this._shouldSuppressBotText(cleaned) || duplicateBotText;
            if (cleaned && !suppressed && this.onGeminiText) this.onGeminiText(cleaned);
            if (cleaned && !suppressed) {
              this._lastBotText = cleaned;
              this._lastBotTextAt = Date.now();
            } else if (cleaned && suppressed) {
              recordCallEvent({
                callSid: this._getCallData().callSid,
                streamSid: this._getCallData().streamSid,
                category: DEBUG_EVENT_CATEGORIES.TRANSCRIPT,
                type: DEBUG_EVENT_TYPES.TRANSCRIPT_SUPPRESSED,
                source: "geminiLiveSession",
                level: "debug",
                data: {
                  who: "bot",
                  text: cleaned,
                },
              });
            }
          }
        }
      } catch (e) {
        logger.debug("Gemini message parse error", {
          ...this.meta,
          error: e.message,
        });
      }

      try {
        const inTr = msg?.serverContent?.inputTranscription?.text;
        if (inTr) this._onTranscriptChunk("user", String(inTr));

        const outTr = msg?.serverContent?.outputTranscription?.text;
        const cleanedOut = scrubReasoningText(String(outTr || ""));
        const duplicateOut = cleanedOut && cleanedOut === this._lastBotText && (Date.now() - this._lastBotTextAt) < 2500;
        if (cleanedOut && !isInternalLabelText(cleanedOut) && !this._shouldSuppressBotText(cleanedOut) && !duplicateOut) {
          this._lastBotText = cleanedOut;
          this._lastBotTextAt = Date.now();
        }
      } catch {}
    });

    this.ws.on("close", async (code, reasonBuf) => {
      const reason = reasonBuf ? reasonBuf.toString("utf8") : "";
      const openingWindowActive = this._openingPhase || (Date.now() - Number(this._openingSentAt || 0) < 2500);
      const maxReconnectAttempts = openingWindowActive ? 1 : 2;
      const reconnectable = !this._stopRequested && Number(code) === 1011 && this._providerReconnectAttempts < maxReconnectAttempts;
      this.closed = true;
      this.ready = false;
      this.ws = null;

      this._transcriptStore.flush("user", { force: true });
      this._transcriptStore.flush("bot", { force: true });

      logger.info("Gemini Live WS closed", { ...this.meta, code, reason, reconnectable });

      recordCallEvent({
        callSid: this._getCallData().callSid,
        streamSid: this._getCallData().streamSid,
        category: DEBUG_EVENT_CATEGORIES.PROVIDER,
        type: DEBUG_EVENT_TYPES.PROVIDER_CLOSED,
        source: "geminiLiveSession",
        level: "info",
        data: {
          code,
          reason,
        },
      });

      if (reconnectable) {
        this._providerReconnectAttempts += 1;
        this._providerRecovering = true;
        logger.warn("Gemini Live WS closed with recoverable internal error; reconnecting", {
          ...this.meta,
          code,
          reason,
          reconnect_attempt: this._providerReconnectAttempts,
        });
        setTimeout(() => {
          this.closed = false;
          this.ready = false;
          this.start();
        }, this._providerReconnectAttempts > 1 ? 900 : 350);
        return;
      }

      await this._finalizeOnce("gemini_ws_close");
    });

    this.ws.on("error", (err) => {
      logger.error("Gemini Live WS error", {
        ...this.meta,
        error: err.message,
      });

      recordCallEvent({
        callSid: this._getCallData().callSid,
        streamSid: this._getCallData().streamSid,
        category: DEBUG_EVENT_CATEGORIES.ERROR,
        type: DEBUG_EVENT_TYPES.PROVIDER_ERROR,
        source: "geminiLiveSession",
        level: "error",
        data: {
          error: err.message,
        },
      });
    });
  }

  _scheduleFlush(who, options) {
    const opts = options && typeof options === "object" ? options : {};
    const delayMs = this._transcriptStore.scheduleFlush(who, opts);

    recordCallEvent({
      callSid: this._getCallData().callSid,
      streamSid: this._getCallData().streamSid,
      category: DEBUG_EVENT_CATEGORIES.TRANSCRIPT,
      type: DEBUG_EVENT_TYPES.TRANSCRIPT_FLUSH_SCHEDULED,
      source: "geminiLiveSession",
      level: "debug",
      data: {
        who,
        delay_ms: delayMs,
        force: !!opts.force,
      },
    });
  }

  _onTranscriptChunk(who, chunk) {
    const c = safeStr(chunk);
    if (!c) return;
    if (who === "bot" && looksLikeReasoningText(c)) return;

    if (this._openingPhase) {
      recordCallEvent({
        callSid: this._getCallData().callSid,
        streamSid: this._getCallData().streamSid,
        category: DEBUG_EVENT_CATEGORIES.TRANSCRIPT,
        type: DEBUG_EVENT_TYPES.TRANSCRIPT_SUPPRESSED,
        source: "geminiLiveSession",
        level: "debug",
        data: {
          who,
          reason: "opening_phase",
          text: c,
        },
      });
      return;
    }

    const chunkResult = this._transcriptStore.bufferChunk(who, c);
    if (!chunkResult.accepted) return;

    const prev = chunkResult.holder && chunkResult.holder.text ? chunkResult.holder.text : "";
    const currentText = chunkResult.holder && chunkResult.holder.text ? chunkResult.holder.text : c;

    recordCallEvent({
      callSid: this._getCallData().callSid,
      streamSid: this._getCallData().streamSid,
      category: DEBUG_EVENT_CATEGORIES.TRANSCRIPT,
      type: DEBUG_EVENT_TYPES.TRANSCRIPT_CHUNK_BUFFERED,
      source: "geminiLiveSession",
      level: "debug",
      data: {
        who,
        chunk: c,
        buffered_length: currentText.length,
        merged: !!chunkResult.merged,
      },
    });

    this._scheduleFlush(who);
  }

  _applyLanguageDecision(nlp) {
    const explicitSwitch = detectExplicitLanguageSwitch(
      nlp.raw || nlp.normalized || ""
    );

    if (explicitSwitch) {
      this._langState.lockedLanguage = explicitSwitch;
      this._langState.candidateLanguage = null;
      this._langState.candidateHits = 0;
    } else if (
      nlp.lang &&
      nlp.lang !== "unknown" &&
      nlp.lang !== this._langState.lockedLanguage
    ) {
      if (nlp.lang === this._langState.candidateLanguage) {
        this._langState.candidateHits += 1;
      } else {
        this._langState.candidateLanguage = nlp.lang;
        this._langState.candidateHits = 1;
      }

      if (this._langState.candidateHits >= this._langState.minConsecutive) {
        this._langState.lockedLanguage = this._langState.candidateLanguage;
        this._langState.candidateLanguage = null;
        this._langState.candidateHits = 0;
      }
    } else {
      this._langState.candidateLanguage = null;
      this._langState.candidateHits = 0;
    }

    logger.info("LANGUAGE_DECISION", {
      ...this.meta,
      observed_lang: nlp.lang,
      observed_confidence: nlp.lang_confidence,
      explicit_switch: explicitSwitch,
      locked_language: this._langState.lockedLanguage,
      candidate_language: this._langState.candidateLanguage,
      candidate_hits: this._langState.candidateHits,
    });
  }

  noteAssistantPlaybackStart() {
    this._assistantPlaybackActive = true;
    this.callSession?.markTimeline?.("first_audio_out_at");
    if (this._openingPhase) this._openingAudioStarted = true;
    this._orchestrator?.noteAssistantPlaybackStart?.();

    recordCallEvent({
      callSid: this._getCallData().callSid,
      streamSid: this._getCallData().streamSid,
      category: DEBUG_EVENT_CATEGORIES.INTERRUPT,
      type: DEBUG_EVENT_TYPES.ASSISTANT_PLAYBACK_STARTED,
      source: "geminiLiveSession",
      level: "debug",
      data: {
        opening_phase: !!this._openingPhase,
      },
    });
  }

  noteAssistantPlaybackStop() {
    this._assistantPlaybackActive = false;
    this._orchestrator?.noteAssistantPlaybackStop?.();

    if (this._openingPhase) {
      this._endOpeningPhase(this._openingAudioStarted ? "opening_playback_finished" : "opening_playback_stopped");
    }

    recordCallEvent({
      callSid: this._getCallData().callSid,
      streamSid: this._getCallData().streamSid,
      category: DEBUG_EVENT_CATEGORIES.INTERRUPT,
      type: DEBUG_EVENT_TYPES.ASSISTANT_PLAYBACK_STOPPED,
      source: "geminiLiveSession",
      level: "debug",
      data: {
        opening_phase: !!this._openingPhase,
      },
    });
  }

  isBargeInAllowed() {
    if (this._openingPhase) return false;
    return Date.now() >= this._openingBargeInGraceUntilTs;
  }

  shouldAllowBargeIn(ctx = {}) {
    return this._orchestrator?.shouldAllowBargeIn?.(ctx) ?? this.isBargeInAllowed();
  }

  getAudioPreprocessOptions() {
    return this._orchestrator?.getAudioPreprocessOptions?.() || {};
  }

  noteInboundUserAudio() {
    this._orchestrator?.noteUserAudio?.();
  }

  handleInterruption(reason = "user_speech") {
    if (this._openingPhase) return;

    this._assistantPlaybackActive = false;
    this._orchestrator?.noteInterrupt?.(reason);
    this._awaitingFreshTurnAfterInterrupt = true;
    if (this.env.MB_INTERRUPT_RECOVERY_ENABLED) {
      this._interruptRecoveryUntilTs = Date.now() + Math.max(300, Number(this.env.MB_INTERRUPT_RECOVERY_WINDOW_MS || 2500));
    }
    this._transcriptStore.resetBuffer("bot");
    logger.info("MODEL_INTERRUPTED", { ...this.meta, reason });

    recordCallEvent({
      callSid: this._getCallData().callSid,
      streamSid: this._getCallData().streamSid,
      category: DEBUG_EVENT_CATEGORIES.INTERRUPT,
      type: DEBUG_EVENT_TYPES.MODEL_INTERRUPTED,
      source: "geminiLiveSession",
      level: "info",
      data: {
        reason,
      },
    });
  }

  _sendImmediateText(exactText, label) {
    if (!this.ws || this.closed || !this.ready) return;
    const safeText = safeStr(exactText);
    if (!safeText) return;
    this._lastImmediatePrompt = { text: safeText, label: safeStr(label), at: Date.now() };
    const msg = {
      clientContent: {
        turns: [{
          role: "user",
          parts: [{ text: `ענה עכשיו רק במשפט הבא, בדיוק כפי שהוא, בלי הקדמה, בלי הסבר, בלי טקסט נוסף. אחרי המשפט עצור והמתן ללקוח. ${safeText}` }],
        }],
        turnComplete: true,
      },
    };
    try {
      this.ws.send(JSON.stringify(msg));
      if (label === "NAME_ACK_SENT") this._orchestrator?.noteImmediatePrompt?.("name");
      if (label === "CALLBACK_ASK_SENT") this._orchestrator?.noteImmediatePrompt?.("callback");
      if (String(label || "").startsWith("SILENCE_PROMPT_")) this._orchestrator?.noteImmediatePrompt?.("silence");
      logger.info(label || "IMMEDIATE_TEXT_SENT", { ...this.meta, text: safeText });

      recordCallEvent({
        callSid: this._getCallData().callSid,
        streamSid: this._getCallData().streamSid,
        category: DEBUG_EVENT_CATEGORIES.CONVERSATION,
        type: DEBUG_EVENT_TYPES.IMMEDIATE_TEXT_SENT,
        source: "geminiLiveSession",
        level: "debug",
        data: {
          label: label || "IMMEDIATE_TEXT_SENT",
          text: safeText,
        },
      });
    } catch (e) {
      logger.debug("Failed sending immediate text", { ...this.meta, error: e.message });
    }
  }

  _sendNaturalRetryForIntent(intentId) {
    const settings = this.ssot?.settings || {};
    if (intentId === "reports_request") {
      this._sendImmediateText(safeStr(settings.REPORTS_ASK_TYPE_PHRASE) || "תפרטו בבקשה אילו דוחות אתם צריכים.", "REPORTS_TYPE_PROMPT_SENT");
      return;
    }
    if (intentId === "callback_request" || this._awaitingCallbackConfirmation) {
      this._sendImmediateText(safeStr(settings.CALLBACK_ASK_PHRASE) || "האם לחזור למספר שממנו התקשרתם?", "CALLBACK_ASK_SENT");
      this._awaitingCallbackConfirmation = true;
      this._orchestrator?.noteCallbackAwaiting?.(true);
      return;
    }
    this._sendImmediateText(safeStr(settings.NO_DATA_MESSAGE) || "איך אפשר לעזור?", "GENERIC_RECOVERY_SENT");
  }

  _sendImmediateNameAcknowledgement(name) {
    const safeName = normalizeLikelyName(name);
    if (!safeName) return;
    this._ignoreBotNameEchoUntilTs = Date.now() + 3000;
    this._lastNameAckTs = Date.now();
    const template = safeStr(this.ssot?.settings?.MB_ACK_NAME_TEMPLATE) || "תודה {name}, איך אפשר לעזור?";
    this._sendImmediateText(applyTemplate(template, { name: safeName, NAME: safeName }), "NAME_ACK_SENT");
  }

  _sendImmediateCallbackConfirmed(nextQuestion) {
    this._callbackConfirmed = true;
    this._awaitingCallbackConfirmation = false;
    this._orchestrator?.noteCallbackAwaiting?.(false);
    const base = safeStr(getClosingText("callback")) || "מעולה, נחזור למספר הזה.";
    const suffix = safeStr(nextQuestion);
    this._sendImmediateText(suffix ? `${base} ${suffix}` : base, "CALLBACK_CONFIRMED_SENT");

    const callData = this._getCallData();
    const callbackNumber = safeStr(callData.caller_raw) || safeStr(callData.caller) || "";

    this._updateCall((currentCall) => ({
      ...(currentCall || {}),
      callback_number: callbackNumber || currentCall?.callback_number || "",
      callback_number_source: callbackNumber ? "caller_id" : (currentCall?.callback_number_source || "caller_id"),
    }));

    this._updateSnapshot((snap) => ({
      ...(snap || {}),
      call: {
        ...(snap?.call || {}),
        callback_number: callbackNumber || snap?.call?.callback_number || null,
        callback_number_source: callbackNumber ? "caller_id" : (snap?.call?.callback_number_source || null),
      },
      conversationLog: this._getConversationLog(),
      callback_confirmed: true,
    }));

    this._orchestrator?.noteCallback?.(callbackNumber);

    recordCallEvent({
      callSid: this._getCallData().callSid,
      streamSid: this._getCallData().streamSid,
      category: DEBUG_EVENT_CATEGORIES.CONVERSATION,
      type: DEBUG_EVENT_TYPES.CALLBACK_CONFIRMED,
      source: "geminiLiveSession",
      level: "info",
      data: {
        callback_number: callbackNumber || null,
      },
    });
  }

  _shouldSuppressBotText(text) {
    const cleaned = safeStr(text);
    if (!cleaned) return true;
    if (cleaned.includes("[") || cleaned.includes("]")) return true;
    if (isInternalLabelText(cleaned)) return true;
    const compact = cleaned.replace(/[.,!?\s]+/g, "");
    if (compact.length <= 2) return true;
    const callerName = normalizeLikelyName(
      safeStr(this.meta?.caller_profile?.display_name)
      || safeStr(this._passiveCtx?.name)
      || safeStr(this._orchestrator?.memory?.snapshot?.()?.callerName)
    );
    const possibleName = normalizeLikelyName(cleaned);
    if (callerName && possibleName && possibleName === callerName) return true;
    if (this._ignoreBotNameEchoUntilTs > Date.now()) {
      if (possibleName && compact === possibleName.replace(/\s+/g, "")) {
        return true;
      }
    }
    if ((this._langState?.lockedLanguage || "he") === "he" && isLatinOnlyText(cleaned)) {
      return true;
    }
    return false;
  }

  _commitRuntimeName(name, reason, sourceUtterance) {
    const normalizedName = normalizeLikelyName(name);
    if (!normalizedName || !hasHebrewLetters(normalizedName)) return false;

    const existing = safeStr(this.meta?.caller_profile?.display_name) || "";
    if (existing) {
      return existing === normalizedName;
    }

    if (!this.meta.caller_profile) this.meta.caller_profile = {};
    this.meta.caller_profile.display_name = normalizedName;
    if (this._passiveCtx) this._passiveCtx.name = normalizedName;

    const callerId = safeStr(this.meta?.caller) || "";
    if (callerId && existing !== normalizedName) {
      updateCallerDisplayName(callerId, normalizedName).catch(() => {});
    }

    this._updateSnapshot((snap) => ({
      ...(snap || {}),
      call: {
        ...(snap?.call || {}),
      },
      conversationLog: this._getConversationLog(),
      caller_profile: this.meta?.caller_profile || null,
    }));

    logger.info("CALLER_NAME_CAPTURED", {
      ...this.meta,
      caller: callerId,
      name: normalizedName,
      confidence_reason: reason,
      source_utterance: sourceUtterance || "",
    });

    recordCallEvent({
      callSid: this._getCallData().callSid,
      streamSid: this._getCallData().streamSid,
      category: DEBUG_EVENT_CATEGORIES.CONVERSATION,
      type: DEBUG_EVENT_TYPES.CALLER_NAME_CAPTURED,
      source: "geminiLiveSession",
      level: "info",
      data: {
        caller: callerId,
        name: normalizedName,
        confidence_reason: reason,
        source_utterance: sourceUtterance || "",
      },
    });

    this._ignoreBotNameEchoUntilTs = Date.now() + 3000;
    this._lastNameAckTs = Date.now();
    this._awaitingNameModelEcho = false;
    this._pendingNameSourceUtterance = "";
    this._reportState = { reportType: null, period: null, forWhom: null };
    this._assistantPlaybackActive = false;
    this._awaitingFreshTurnAfterInterrupt = false;
    this._interruptRecoveryUntilTs = 0;
    this._orchestrator?.noteName?.(normalizedName, reason === "db" ? "db" : "runtime");
    this._sendImmediateNameAcknowledgement(normalizedName);
    return true;
  }

  _handleTranscriptFlush(payload) {
    const { who, role, rawText, normalized, finalText } = payload || {};
    if (!finalText) return;

    const recoveredText = safeStr(payload?.recovered_text || normalized?.recovered || normalized?.normalized || rawText || finalText);
    const effectiveUserText = safeStr(recoveredText || finalText);

    if (who === "bot" && shouldIgnoreAssistantTranscript(this, finalText)) {
      logger.info("IGNORED_ASSISTANT_TRANSCRIPT", {
        ...this.meta,
        text: finalText,
      });
      return;
    }

    if (role === "user" && isNoiseOnlyText(effectiveUserText)) {
      logger.info("IGNORED_NOISE_USER_TRANSCRIPT", {
        ...this.meta,
        text: effectiveUserText,
      });
      return;
    }

    this._appendConversationEntry({
      role,
      text: finalText,
      ts: nowIso(),
    });

    this._updateSnapshot((snap) => ({
      ...(snap || {}),
      call: {
        ...(snap?.call || {}),
      },
      conversationLog: this._getConversationLog(),
      lead: snap?.lead || {},
    }));

    recordCallEvent({
      callSid: this._getCallData().callSid,
      streamSid: this._getCallData().streamSid,
      category: DEBUG_EVENT_CATEGORIES.TRANSCRIPT,
      type: DEBUG_EVENT_TYPES.TRANSCRIPT_FLUSHED,
      source: "geminiLiveSession",
      level: "info",
      data: {
        who,
        role,
        // ── Stage envelope (Task 3.1) ──────────────────────────────────
        raw_text: payload.raw_text || safeStr(rawText),
        normalized_text: payload.normalized_text || safeStr(normalized?.normalized || normalized?.raw),
        recovered_text: payload.recovered_text || safeStr(normalized?.recovered || normalized?.normalized),
        final_text: payload.final_text || finalText,
        stage_order: payload.stage_order || ["raw", "normalized", "recovered", "final"],
        stages: payload.stages || null,
        // ─────────────────────────────────────────────────────────────
        raw_length: safeStr(rawText).length,
        normalized_length: finalText.length,
      },
    });

    if (this.onTranscript) {
      try {
        this.onTranscript({
          who,
          role,
          text: finalText,
          raw_text: payload.raw_text || safeStr(rawText),
          normalized_text: payload.normalized_text || safeStr(normalized?.normalized || normalized?.raw),
          recovered_text: payload.recovered_text || safeStr(normalized?.recovered || normalized?.normalized),
          final_text: payload.final_text || finalText,
          stage_order: payload.stage_order || ["raw", "normalized", "recovered", "final"],
          stage_texts: payload.stage_texts || null,
          stages: payload.stages || null,
        });
      } catch {}
    }

    this._orchestrator?.noteTranscript?.(role, finalText, normalized);

    if (role === "assistant") {
      this.callSession?.markTimeline?.("first_bot_response_at");
      if (isClosingUtterance(finalText, this.ssot)) {
        this._hardClosingMode = true;
        this._orchestrator?.noteClosing?.();

        recordCallEvent({
          callSid: this._getCallData().callSid,
          streamSid: this._getCallData().streamSid,
          category: DEBUG_EVENT_CATEGORIES.CONVERSATION,
          type: DEBUG_EVENT_TYPES.CLOSING_DETECTED,
          source: "geminiLiveSession",
          level: "info",
          data: {
            text: finalText,
          },
        });

        this._scheduleHangupAfterAssistantDone();
      }
      // ── FIX (Task 3.1): pass full payload instead of normalized only ──
      handleBotTranscript(this, payload);
      this._orchestrator?.syncFromCall?.();
      return;
    }

    this.callSession?.markTimeline?.("first_user_stable_utterance_at");
    this._applyLanguageDecision(normalized);
    handleUserTranscript(this, payload, {
      onNameDetected: (name, reason, sourceUtterance) =>
        this._commitRuntimeName(name, reason, sourceUtterance),
      onNeedRetryPrompt: (intentId) => this._sendNaturalRetryForIntent(intentId),
      onCallbackConfirmed: (nextQuestion) => this._sendImmediateCallbackConfirmed(nextQuestion),
    });
    this._orchestrator?.syncFromCall?.();
  }

  _scheduleHangupAfterAssistantDone() {
    if (this._hangupScheduled) return;
    this._hangupScheduled = true;

    recordCallEvent({
      callSid: this._getCallData().callSid,
      streamSid: this._getCallData().streamSid,
      category: DEBUG_EVENT_CATEGORIES.CONVERSATION,
      type: DEBUG_EVENT_TYPES.CLOSING_HANGUP_SCHEDULED,
      source: "geminiLiveSession",
      level: "info",
      data: {
        delay_ms: Math.max(600, Number(this.env.MB_END_CALL_DELAY_MS || 1200)),
      },
    });

    const delayMs = Math.max(600, Number(this.env.MB_END_CALL_DELAY_MS || 1200));
    setTimeout(async () => {
      try {
        await hangupCall(this._getCallData().callSid, logger).catch(() => false);
      } finally {
        this._hangupScheduled = false;
      }
    }, delayMs);
  }

  sendUlaw8kFromTwilio(ulaw8kB64) {
    if (!this.ws || this.closed || !this.ready || !ulaw8kB64) return;
    try {
      const pcm16kB64 = ulaw8kB64ToPcm16kB64(ulaw8kB64);
      this.sendPcm16kBase64(pcm16kB64);
    } catch (e) {
      logger.debug("sendUlaw8kFromTwilio failed", { ...this.meta, error: e.message });
    }
  }

  sendPcm16kBase64(pcm16kB64) {
    if (!this.ws || this.closed || !this.ready || !pcm16kB64) return;
    try {
      this.ws.send(
        JSON.stringify({
          realtimeInput: {
            mediaChunks: [{ mimeType: "audio/pcm;rate=16000", data: pcm16kB64 }],
          },
        })
      );
    } catch (e) {
      logger.debug("Failed to send audio to Gemini", { ...this.meta, error: e.message });
    }
  }

  endInput() {
    try {
      if (this.ws && !this.closed && this.ready) {
        this.ws.send(JSON.stringify({ realtimeInput: { audioStreamEnd: true } }));
      }
    } catch {}
  }

  stop() {
    this._stopRequested = true;
    this.closed = true;
    this.ready = false;
    this._transcriptStore.flush("user", { force: true });
    this._transcriptStore.flush("bot", { force: true });
    this._finalizeOnce("stop_called").catch(() => {});
    try {
      if (this.ws) this.ws.close();
    } catch {}
  }

  async _finalizeOnce(source) {
    const currentCall = this._getCallData();
    if (currentCall.finalized) return;

    this._updateCall((callData) => ({
      ...(callData || {}),
      finalized: true,
    }));

    try {
      const endedAt = nowIso();

      this._updateCall((callData) => ({
        ...(callData || {}),
        ended_at: endedAt,
      }));

      const callData = this._getCallData();
      const durationMs = Date.now() - new Date(callData.started_at).getTime();

      const callMeta = {
        ...callData,
        duration_ms: durationMs,
        duration_seconds: Math.max(0, Math.round(durationMs / 1000)),
        finalize_reason: source || "",
        language_locked: this._langState.lockedLanguage,
      };

      if (this._passiveCtx && passiveCallContext?.finalizeCtx) {
        try {
          callMeta.passive_context = passiveCallContext.finalizeCtx(this._passiveCtx);
        } catch {}
      }

      await finalizeThroughCoordinator({
        callSid: callData.callSid,
        source,
        sessionFinalizeData: callMeta,
        conversationLog: this._getConversationLog(),
      });
    } catch (e) {
      logger.warn("Finalize coordination failed", { error: String(e) });
    }
  }
}

function isInternalLabelText(text) {
  const t = safeStr(text).toLowerCase();
  if (!t) return false;
  return (
    t.includes("intent:") ||
    t.includes("intent_id") ||
    t.includes("internal") ||
    t.includes("label:")
  );
}

module.exports = { GeminiLiveSession };
