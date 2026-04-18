// src/ws/twilioMediaWs.js
"use strict";

const WebSocket = require("ws");
const { logger } = require("../utils/logger");
const { env } = require("../config/env");
const { createGeminiSessionAdapter } = require("../provider/geminiSessionAdapter");
const { CallSession } = require("../runtime/callSession");
const { InterruptionManager } = require("../runtime/interruptionManager");
const { startCallRecording, hangupCall } = require("../utils/twilioRecordings");
const { setRecordingForCall, markRecordingStartRequested } = require("../utils/recordingRegistry");
const { getSSOT } = require("../ssot/ssotClient");
const { getCallerProfile } = require("../memory/callerMemory");
const { warmCompiledPromptBundle } = require("../realtime/compiledPromptBundle");
const { ulaw8kB64ToPcm16kBuffer } = require("../vendor/twilioGeminiAudio");
const { preprocessInt16, rmsInt16 } = require("../runtime/voice/audioPreprocessor");
const { TelephonyAec } = require("../runtime/voice/telephonyAec");
const { updateSnapshot } = require("../runtime/callRegistry");
const { isBlockedCaller } = require("../blocklist/blockedNumberService");
const { recordCallEvent } = require("../debug/debugLogger");
const { DEBUG_EVENT_CATEGORIES, DEBUG_EVENT_TYPES } = require("../debug/debugEventTypes");

function installTwilioMediaWs(server) {
  const wss = new WebSocket.Server({ noServer: true });

  server.on("upgrade", (req, socket, head) => {
    if (!req.url || !req.url.startsWith("/twilio-media-stream")) return;
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  });

  wss.on("connection", (twilioWs) => {
    logger.info("Twilio media WS connected");

    let streamSid = null;
    let callSid = null;
    let customParameters = {};
    let gemini = null;
    let callSession = null;
    let stopped = false;

    const preState = { prevX: 0, prevY: 0 };
    let voiceActiveFrames = 0;
    let lastVoiceAt = 0;
    const aec = new TelephonyAec({
      sampleRate: 16000,
      historyMs: env.MB_AEC_HISTORY_MS,
      searchMs: env.MB_AEC_SEARCH_MS,
      strength: env.MB_AEC_STRENGTH,
      corrThreshold: env.MB_AEC_CORR_THRESHOLD,
      duckThreshold: env.MB_AEC_DUCK_THRESHOLD,
      nearSpeechFloor: env.MB_AEC_NEAR_SPEECH_FLOOR,
      echoFloor: env.MB_AEC_ECHO_FLOOR,
    });

    const interruptionManager = new InterruptionManager({
      rmsThreshold: env.MB_BARGE_IN_RMS_THRESHOLD,
      minFrames: env.MB_BARGE_IN_MIN_FRAMES,
      cooldownMs: 600,
      onInterrupt: ({ rms, threshold, minFrames }) => {
        if (gemini?.handleInterruption) gemini.handleInterruption("local_speech_barge_in");
        sendClear();
        logger.info("BARGE_IN_TRIGGERED", { streamSid, callSid, rms });
        recordCallEvent({
          callSid,
          streamSid,
          category: DEBUG_EVENT_CATEGORIES.INTERRUPT,
          type: DEBUG_EVENT_TYPES.BARGE_IN_TRIGGERED,
          source: "twilioMediaWs",
          level: "info",
          data: { rms, threshold, min_frames: minFrames },
        });
      },
    });

    function sendJson(payload) {
      try {
        twilioWs.send(JSON.stringify(payload));
      } catch {}
    }

    function sendClear() {
      if (!streamSid) return;
      sendJson({ event: "clear", streamSid });
    }

    function sendMark() {
      if (!streamSid) return;
      const markSeq = interruptionManager.registerPlaybackMarkSent();
      sendJson({ event: "mark", streamSid, mark: { name: `mb-${markSeq}` } });
    }

    function sendToTwilioMedia(ulaw8kB64) {
      if (!streamSid || !ulaw8kB64) return;
      interruptionManager.noteOutboundAudioSent();
      if (gemini?.noteAssistantPlaybackStart) gemini.noteAssistantPlaybackStart();

      try {
        const outboundPcm = ulaw8kB64ToPcm16kBuffer(ulaw8kB64);
        const outboundSamples = new Int16Array(
          outboundPcm.buffer,
          outboundPcm.byteOffset,
          outboundPcm.byteLength / 2
        );
        if (env.MB_AEC_ENABLED) aec.pushReference(outboundSamples);
      } catch {}

      sendJson({ event: "media", streamSid, media: { payload: ulaw8kB64 } });
      sendMark();

      recordCallEvent({
        callSid,
        streamSid,
        category: DEBUG_EVENT_CATEGORIES.TRANSPORT,
        type: DEBUG_EVENT_TYPES.TWILIO_MEDIA_SENT,
        source: "twilioMediaWs",
        level: "debug",
        data: {
          payload_length: typeof ulaw8kB64 === "string" ? ulaw8kB64.length : 0,
          pending_playback_marks: interruptionManager.pendingPlaybackMarks,
          mark_seq: interruptionManager.markSeq,
        },
      });
    }

    twilioWs.on("message", async (data) => {
      let msg;
      try {
        msg = JSON.parse(data.toString("utf8"));
      } catch {
        return;
      }

      const ev = msg.event;

      if (ev === "start") {
        streamSid = msg?.start?.streamSid || null;
        callSid = msg?.start?.callSid || null;
        customParameters = msg?.start?.customParameters || {};
        logger.info("Twilio stream start", { streamSid, callSid, customParameters });
        callSession?.markTimeline?.("ws_connected_at");

        recordCallEvent({
          callSid,
          streamSid,
          category: DEBUG_EVENT_CATEGORIES.TRANSPORT,
          type: DEBUG_EVENT_TYPES.TWILIO_STREAM_STARTED,
          source: "twilioMediaWs",
          level: "info",
          data: {
            caller: customParameters?.caller || null,
            called: customParameters?.called || null,
            source: customParameters?.source || "VoiceBot_Blank",
          },
        });

        updateSnapshot(callSid, (snap) => ({
          ...(snap || {}),
          call: {
            ...(snap?.call || {}),
            callSid,
            streamSid,
            caller: customParameters?.caller || null,
            caller_raw: customParameters?.caller || null,
            called: customParameters?.called || null,
            source: customParameters?.source || "VoiceBot_Blank",
            started_at: snap?.call?.started_at || new Date().toISOString(),
            twilio_call_status: "in-progress",
          },
          conversationLog: Array.isArray(snap?.conversationLog) ? snap.conversationLog : [],
          lead: snap?.lead || {},
        }));

        const blocked = isBlockedCaller(customParameters?.caller || "");
        if (blocked.blocked && callSid) {
          updateSnapshot(callSid, (snap) => ({
            ...(snap || {}),
            call: {
              ...(snap?.call || {}),
              business_status: "BLOCKED",
              blocked_reason: blocked.reason,
              ended_at: new Date().toISOString(),
              twilio_call_status: "completed",
            },
            conversationLog: Array.isArray(snap?.conversationLog) ? snap.conversationLog : [],
            lead: snap?.lead || {},
          }));
          logger.info("Blocked caller matched", {
            callSid,
            caller: customParameters?.caller || null,
            normalized: blocked.normalized,
          });

          recordCallEvent({
            callSid,
            streamSid,
            category: DEBUG_EVENT_CATEGORIES.TRANSPORT,
            type: "BLOCKED_CALLER_MATCHED",
            source: "twilioMediaWs",
            level: "info",
            data: {
              caller: customParameters?.caller || null,
              normalized: blocked.normalized || null,
              reason: blocked.reason || null,
            },
          });

          await hangupCall(callSid, logger).catch(() => false);
          try {
            twilioWs.close();
          } catch {}
          return;
        }

        if (env.MB_ENABLE_RECORDING && callSid && markRecordingStartRequested(callSid)) {
          startCallRecording(callSid, logger)
            .then((r) => {
              if (r?.ok && r?.recordingSid) {
                setRecordingForCall(callSid, { recordingSid: r.recordingSid });
                logger.info("Recording started + stored in registry", {
                  callSid,
                  recordingSid: r.recordingSid,
                });
              } else {
                logger.info("Recording start skipped/failed (best-effort)", {
                  callSid,
                  ok: r?.ok,
                  reason: r?.reason || null,
                });
              }
            })
            .catch((e) => {
              logger.warn("Failed to start call recording", {
                callSid,
                err: e?.message || String(e),
              });
            });
        }

        const ssot = getSSOT();
        const meta = {
          streamSid,
          callSid,
          caller: customParameters?.caller,
          called: customParameters?.called,
          source: customParameters?.source,
        };

        try {
          const prof = await getCallerProfile(meta.caller);
          if (prof) meta.caller_profile = prof;
        } catch {}

        try {
          const callerProfile = meta.caller_profile || null;
          const callerName = String(callerProfile?.display_name || "").trim();
          const compiledBundle = await Promise.resolve(
            warmCompiledPromptBundle({
              ssot,
              runtimeMeta: {
                caller_name: callerName,
                display_name: callerName,
                language_locked: String(env.MB_DEFAULT_LANGUAGE || "he").trim() || "he",
                caller_withheld:
                  !meta.caller ||
                  String(meta.caller || "").trim().toLowerCase() === "anonymous",
                caller: meta.caller || "",
                called: meta.called || "",
                source: meta.source || "",
                opening_played:
                  customParameters?.opening_played === undefined ||
                  customParameters?.opening_played === null
                    ? ""
                    : String(customParameters.opening_played).trim(),
              },
              isReturning: !!callerProfile,
              timeZone: env.TIME_ZONE,
            })
          );

          const prebuiltOpeningText = String(compiledBundle?.opening || "").trim();
          if (prebuiltOpeningText) {
            meta.prebuilt_opening_text = prebuiltOpeningText;
            meta.prebuilt_opening_cache_hit = !!compiledBundle?.opening_cache_hit;
          }

          const prebuiltSystemInstruction = String(
            compiledBundle?.system_instruction || ""
          ).trim();
          if (prebuiltSystemInstruction) {
            meta.prebuilt_system_instruction = prebuiltSystemInstruction;
          }
          meta.prebuilt_prompt_bundle_cache_hit = !!compiledBundle?.bundle_cache_hit;
        } catch (e) {
          logger.warn("Failed to prebuild opening/system instruction", {
            callSid,
            streamSid,
            error: e?.message || String(e),
          });
        }

        callSession = new CallSession(meta);
        callSession?.markTimeline?.(
          "call_answered_at",
          meta.started_at || new Date().toISOString()
        );
        callSession?.markTimeline?.("ws_connected_at");
        if (callSession?.attachTwilioWs) callSession.attachTwilioWs(twilioWs);

        gemini = createGeminiSessionAdapter({
          meta,
          ssot,
          callSession,
          onGeminiAudioUlaw8kBase64: (ulawB64) => sendToTwilioMedia(ulawB64),
          onGeminiText: (t) => logger.debug("Gemini text", { streamSid, callSid, t }),
          onTranscript: ({
            who,
            text,
            raw_text,
            normalized_text,
            recovered_text,
            final_text,
            stage_order,
            stage_texts,
            stages,
          }) => {
            logger.info(`TRANSCRIPT ${who}`, {
              streamSid,
              callSid,
              text,
              raw_text: raw_text || text || "",
              normalized_text: normalized_text || text || "",
              recovered_text: recovered_text || normalized_text || text || "",
              final_text: final_text || text || "",
              stage_order: Array.isArray(stage_order) && stage_order.length
                ? stage_order
                : ["raw", "normalized", "recovered", "final"],
              stage_texts: stage_texts || null,
              stages: stages || null,
            });
          },
        });

        gemini.start();
        return;
      }

      if (ev === "media") {
        const b64 = msg?.media?.payload;
        if (!b64 || !gemini) return;
        if (typeof gemini.isOpeningPhase === "function" && gemini.isOpeningPhase()) return;

        try {
          const pcmBuf = ulaw8kB64ToPcm16kBuffer(b64);
          let samples = new Int16Array(
            pcmBuf.buffer,
            pcmBuf.byteOffset,
            pcmBuf.byteLength / 2
          );

          if (env.MB_AEC_ENABLED) {
            const aecResult = aec.processNearEnd(samples);
            samples = aecResult.samples;
          }

          callSession?.markTimeline?.("first_user_audio_at");
          if (gemini?.noteInboundUserAudio) gemini.noteInboundUserAudio();
          const preprocessOptions = gemini?.getAudioPreprocessOptions
            ? gemini.getAudioPreprocessOptions()
            : {};

          const processed = preprocessInt16(samples, preState, preprocessOptions);
          const currentRms = processed.metrics.outputRms || rmsInt16(processed.samples);
          const minVoiceRms = Number(process.env.MB_BACKGROUND_NOISE_MIN_RMS || 0.012);
          const voiceFramesNeeded = Math.max(1, Number(process.env.MB_BACKGROUND_NOISE_MIN_FRAMES || 2));
          const voiceHoldMs = Math.max(120, Number(process.env.MB_BACKGROUND_NOISE_HOLD_MS || 420));
          if (currentRms >= minVoiceRms) {
            voiceActiveFrames += 1;
            lastVoiceAt = Date.now();
          } else {
            voiceActiveFrames = 0;
          }
          const shouldForwardUserAudio = voiceActiveFrames >= voiceFramesNeeded || (Date.now() - lastVoiceAt) <= voiceHoldMs;
          if (!shouldForwardUserAudio) {
            return;
          }
          const baseAllowed = !(gemini?.isBargeInAllowed) || gemini.isBargeInAllowed();
          const allowBarge = gemini?.shouldAllowBargeIn
            ? gemini.shouldAllowBargeIn({
                openingPhase: gemini?.isOpeningPhase?.(),
                baseAllowed,
                rms: currentRms,
              })
            : baseAllowed;
          interruptionManager.evaluateSpeech({
            rms: currentRms,
            bargeInAllowed: allowBarge,
          });
          gemini.sendPcm16kBase64(
            Buffer.from(
              processed.samples.buffer,
              processed.samples.byteOffset,
              processed.samples.byteLength
            ).toString("base64")
          );
        } catch (e) {
          logger.debug("Inbound audio preprocess failed; forwarding raw audio", {
            streamSid,
            callSid,
            error: e?.message || String(e),
          });
          gemini.sendUlaw8kFromTwilio(b64);
        }
        return;
      }

      if (ev === "mark") {
        const pendingPlaybackMarks = interruptionManager.notePlaybackMarkReceived();
        if (gemini?.notePlaybackMarkReceived) gemini.notePlaybackMarkReceived();
        if (pendingPlaybackMarks === 0 && gemini?.noteAssistantPlaybackStop) {
          gemini.noteAssistantPlaybackStop();
        }

        recordCallEvent({
          callSid,
          streamSid,
          category: DEBUG_EVENT_CATEGORIES.TRANSPORT,
          type: DEBUG_EVENT_TYPES.TWILIO_MARK_RECEIVED,
          source: "twilioMediaWs",
          level: "debug",
          data: { pending_playback_marks: pendingPlaybackMarks },
        });
        return;
      }

      if (ev === "stop") {
        logger.info("Twilio stream stop", { streamSid, callSid });
        recordCallEvent({
          callSid,
          streamSid,
          category: DEBUG_EVENT_CATEGORIES.TRANSPORT,
          type: DEBUG_EVENT_TYPES.TWILIO_STREAM_STOPPED,
          source: "twilioMediaWs",
          level: "info",
          data: {},
        });

        updateSnapshot(callSid, (snap) => ({
          ...(snap || {}),
          call: {
            ...(snap?.call || {}),
            twilio_call_status: snap?.call?.twilio_call_status || "completed",
          },
          conversationLog: Array.isArray(snap?.conversationLog) ? snap.conversationLog : [],
          lead: snap?.lead || {},
        }));
        if (gemini?.markTwilioTerminal) gemini.markTwilioTerminal({ status: "completed", endedAt: new Date().toISOString() });
        if (!stopped && gemini) {
          stopped = true;
          gemini.endInput();
          gemini.stop();
        }
        return;
      }

      if (ev === "connected") {
        logger.info("Twilio WS event", {
          event: "connected",
          streamSid: null,
          callSid: null,
        });
      }
    });

    twilioWs.on("close", () => {
      logger.info("Twilio media WS closed", { streamSid, callSid });
      recordCallEvent({
        callSid,
        streamSid,
        category: DEBUG_EVENT_CATEGORIES.TRANSPORT,
        type: DEBUG_EVENT_TYPES.TWILIO_WS_CLOSED,
        source: "twilioMediaWs",
        level: "info",
        data: {},
      });
      if (gemini?.markTwilioTerminal) gemini.markTwilioTerminal({ status: "completed", endedAt: new Date().toISOString() });
      if (!stopped && gemini) {
        stopped = true;
        gemini.stop();
      }
    });

    twilioWs.on("error", (err) => {
      logger.error("Twilio media WS error", {
        streamSid,
        callSid,
        error: err.message,
      });
      recordCallEvent({
        callSid,
        streamSid,
        category: DEBUG_EVENT_CATEGORIES.ERROR,
        type: DEBUG_EVENT_TYPES.TWILIO_WS_ERROR,
        source: "twilioMediaWs",
        level: "error",
        data: { error: err.message },
      });
      if (gemini?.markTwilioTerminal) gemini.markTwilioTerminal({ status: "failed", endedAt: new Date().toISOString() });
      if (!stopped && gemini) {
        stopped = true;
        gemini.stop();
      }
    });
  });

  return wss;
}

module.exports = { installTwilioMediaWs };
