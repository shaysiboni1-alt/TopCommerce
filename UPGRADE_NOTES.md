Top Commerce telephony stabilization upgrade

Included in this revision:
- Reworked low-confidence handling in early call stages so noisy/partial Hebrew turns are clarified instead of silently ignored.
- Added fuzzy classification recovery for noisy STT variants such as "לקוחות חדשי", "לקוח חדש", "קיים", "עסקי", and "פרטי".
- Shortened phone-facing script prompts in the synced SSOT workbook for noisy environments.
- Reduced compact Gemini system-instruction payload by truncating the business snapshot and limiting approved scripts in compact mode.
- Allowed one Gemini reconnect attempt even when a 1011 happens during the opening window.
- Preserved existing Twilio + Gemini architecture while improving telephone-flow resilience.
