"use strict";

const { GeminiLiveSession } = require("../vendor/geminiLiveSession");
const { ConversationRuntime } = require("../runtime/conversationRuntime");
const { ResponseCoordinator } = require("../runtime/responseCoordinator");
const { TurnManager } = require("../runtime/turnManager");

function safeStr(value) {
  return value === undefined || value === null ? "" : String(value).trim();
}

function createGeminiSessionAdapter(options = {}) {
  const turnManager = options.turnManager || new TurnManager();
  const responseCoordinator = new ResponseCoordinator({ turnManager });
  const runtime = new ConversationRuntime({
    meta: options.meta,
    callSession: options.callSession,
    interruptionManager: options.interruptionManager,
    turnManager,
    responseCoordinator,
  });

  const session = new GeminiLiveSession({
    ...options,
    onGeminiAudioUlaw8kBase64: (ulawB64) => {
      responseCoordinator.noteAudioChunk();
      runtime.onAssistantPlayback(true);
      if (typeof options.onGeminiAudioUlaw8kBase64 === "function") options.onGeminiAudioUlaw8kBase64(ulawB64);
    },
    onGeminiText: (text) => {
      const preview = safeStr(text);
      const current = responseCoordinator.current();
      if (!current || current.state === "completed" || current.state === "cancelled" || current.state === "interrupted") {
        responseCoordinator.beginResponse({
          turnId: turnManager.snapshot().lastCommittedAssistantTurnId || null,
          textPreview: preview,
          allowInterruptions: true,
          source: "gemini",
        });
      }
      if (typeof options.onGeminiText === "function") options.onGeminiText(text);
    },
    onTranscript: (payload) => {
      const who = safeStr(payload?.who);
      if (who === "user") turnManager.noteUserTurn();
      if (who === "bot") turnManager.noteAssistantTurn();
      runtime.onTranscriptTurn({
        role: who === "bot" ? "assistant" : who,
        text: payload?.final_text || payload?.text || "",
        rawText: payload?.raw_text || payload?.text || "",
        normalized_text: payload?.normalized_text || payload?.text || "",
      });
      if (typeof options.onTranscript === "function") options.onTranscript(payload);
    },
  });

  runtime.attachProvider(session);
  runtime.bootstrap();

  return {
    start: () => session.start(),
    stop: () => session.stop(),
    endInput: () => session.endInput(),
    sendPcm16kBase64: (data) => session.sendPcm16kBase64(data),
    sendUlaw8kFromTwilio: (data) => session.sendUlaw8kFromTwilio(data),
    isOpeningPhase: () => session.isOpeningPhase(),
    isBargeInAllowed: () => session.isBargeInAllowed(),
    shouldAllowBargeIn: (ctx) => session.shouldAllowBargeIn(ctx),
    getAudioPreprocessOptions: () => session.getAudioPreprocessOptions(),
    noteInboundUserAudio: () => session.noteInboundUserAudio(),
    noteAssistantPlaybackStart: () => {
      const current = responseCoordinator.current();
      if (!current) {
        responseCoordinator.beginResponse({
          turnId: turnManager.snapshot().lastCommittedAssistantTurnId || null,
          textPreview: null,
          allowInterruptions: true,
          source: "gemini",
        });
      }
      runtime.onAssistantPlayback(true);
      session.noteAssistantPlaybackStart();
    },
    noteAssistantPlaybackStop: () => {
      responseCoordinator.notePlaybackCompleted();
      runtime.onAssistantPlayback(false);
      session.noteAssistantPlaybackStop();
    },
    handleInterruption: (reason = "user_speech") => {
      responseCoordinator.interrupt(reason);
      runtime.onInterrupt(reason);
      session.handleInterruption(reason);
    },
    markTwilioTerminal: ({ status, endedAt }) => runtime.markTwilioTerminal({ status, endedAt }),
    notePlaybackMarkReceived: () => {
      responseCoordinator.notePlaybackMark();
      return responseCoordinator.current();
    },
    getRuntimeSnapshot: () => runtime.snapshot(),
    getActiveResponse: () => responseCoordinator.current(),
    getTurnSnapshot: () => turnManager.snapshot(),
    _session: session,
  };
}

module.exports = { createGeminiSessionAdapter };
