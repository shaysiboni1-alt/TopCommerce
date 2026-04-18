Top Commerce telephony stabilization upgrade

Included in this revision:
- Compact SSOT-grounded system instruction to reduce Gemini setup/prompt overhead and improve opening latency.
- Stronger caller-memory enforcement so a known caller name is not re-asked unless corrected.
- More conservative first silence prompt with post-opening grace for real phone pauses.
- Stronger Hebrew recovery for fragmented product phrases such as "כיס אות" -> "כיסאות" and related splits.
- Low-confidence override for salvageable business turns so valid product/contact/price intents are not discarded too early.
- Updated SSOT fallback defaults to match the new runtime behavior.
