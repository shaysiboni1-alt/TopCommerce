# Top Commerce upgrade notes

Implemented a production-safe architectural upgrade inspired by LiveKit Agents patterns without changing Twilio transport or Gemini runtime.

## Added
- `src/runtime/activeResponseHandle.js`
- `src/runtime/responseCoordinator.js`

## Upgraded
- `src/runtime/turnManager.js`
- `src/runtime/conversationRuntime.js`
- `src/provider/geminiSessionAdapter.js`
- `src/ws/twilioMediaWs.js`

## What changed
- Introduced an explicit active response lifecycle (`queued -> speaking -> interrupted/completed/cancelled`).
- Added a response coordinator as a single authority for response state.
- Strengthened turn state with response IDs, turn IDs, interruption-pending state, playback timestamps, and chunk counters.
- Wired Twilio media transport to a real Gemini session adapter rather than directly to the provider implementation.
- Synced runtime turn/response/interruption state into the call snapshot.
- Synced terminal Twilio states back into runtime state.

## What did not change
- Twilio Media Streams transport
- Gemini realtime provider path
- SSOT-driven prompts/behavior
- Finalization/webhook pipeline


## 2026-04-17 follow-up fixes
- Removed non-SSOT hardcoded silence prompts such as "קחו רגע..."; silence prompts now come only from SSOT/ENV.
- Added deterministic SSOT-based follow-up prompts for key intents (existing/new/business/private/product interest) so the call flow advances even when the provider does not generate the next question.
- Callback question is now triggered immediately for known callers after a meaningful need/product-interest turn, matching the returning-customer flow more closely.
