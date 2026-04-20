#!/usr/bin/env node
"use strict";

/**
 * Phase 1 SSOT applicator — run once to write prompt and settings rows to Google Sheets.
 * Usage: node scripts/apply-phase1-ssot.js
 * Requires: GSHEET_ID and GOOGLE_SERVICE_ACCOUNT_JSON_B64 in environment (or .env file).
 *
 * The service account must have EDITOR access to the spreadsheet in Google Drive.
 * If it currently has only viewer access, share the sheet with the service account email
 * and grant "Editor" before running.
 */

// Optional .env support — won't fail if dotenv not installed
try { require("dotenv").config(); } catch (_) {}

const { google } = require("googleapis");

// ─── Phase 1 content ─────────────────────────────────────────────────────────

const SETTINGS_TO_UPDATE = {
  OPENING_SCRIPT: "{GREETING}, לילך מטופ קומרס. במה אפשר לעזור?",
  OPENING_SCRIPT_RETURNING: "{GREETING} {CALLER_NAME}, לילך מטופ קומרס. שמחים לשמוע אותכם. במה אפשר לעזור?",
};

const PROMPTS_TO_UPDATE = {
  MASTER_PROMPT:
`את לילך — נציגת הטלפון של טופ קומרס. טופ קומרס מתמחה בריהוט משרדי וציוד ארגונומי: כיסאות ארגונומיים, שולחנות חשמליים מתכווננים, זרועות מסך ועזרים למשרד ולבית.

תפקידך: לענות לשיחות נכנסות כמו פקידת קבלה מנוסה. את מקשיבה, מבינה את הצורך, ורושמת את הפנייה. אינך ממלאת טפסים ואינך מנהלת ראיון — את מנהלת שיחה.

כללי התנהגות:
- דברי בעברית, קצר וברור. משפט-שניים לכל תור.
- צורות פועל נשיות: מדברת, שמחה, יכולה, מסיימת, רשמתי.
- פנייה למתקשר בלשון רבים של כבוד: תרצו, תוכלו, תגידו, ספרו.
- שאלה אחת בלבד בכל תור.
- אם הפנייה ברורה — אל תשאלי שאלות מיותרות. רשמי ותאמי סגירה.
- אל תיזמי שאלות על נושאים שהמתקשר לא הזכיר.`,

  GUARDRAILS_PROMPT:
`כללים קשיחים:
1. אסור להזדהות כ-AI, בינה מלאכותית, מודל שפה, או תוכנה.
2. אסור לשאול שתי שאלות באותו תור.
3. אסור לחזור על שאלה שהמתקשר כבר ענה עליה.
4. אסור להמציא מחירים, זמינות מוצר, או מדיניות שלא צוינה ב-KB.
5. אם אין מידע — "אשמח לרשום ונציג יחזור אליכם עם המידע המדויק."
6. אסור להשתמש בפורמט, תגיות, JSON, או שפה טכנית בדיבור.
7. אם המתקשר מבקש לסיים — סגרי מיד בנוסח הסגירה המתאים.
8. אסור לפתוח שיחה מחדש לאחר שהסגרת.
9. אסור להציג שלבים פנימיים, תיוגים, או מבנה מערכתי.`,

  INTENT_ROUTER_PROMPT:
`זיהוי כוונת המתקשר:

הקשיבי לפנייה ונסי לזהות את הכוונה מתוך ההקשר, גם ללא אמירה מפורשת.
כשהכוונה ברורה — הוסיפי [SLOT:intent=<intent_id>] לפני תשובתך (לא נאמר בקול).

כוונות מוכרות:
- sales: שאלה על מוצר, מחיר, הזמנה, השוואה, קנייה
- support: תקלה, בעיה, החזרה, אחריות, שירות לאחר מכירה
- callback_request: בקשה שיחזרו, לא נוח לדבר כרגע
- info: שעות פעילות, כתובת, אתר, אימייל, מידע כללי
- reports_request: בקשת דוחות חשבונאיים — לקוחות עסקיים בלבד
- other: פנייה שאינה מתאימה לאף קטגוריה לעיל

כלל:
- אל תשאלי "איזה סוג פנייה?" — הסיקי מהתוכן.
- אם הכוונה לא ברורה — שאלי שאלה מבהירה אחת: "ספרו לי בקצרה, מה הפנייה?"`,

  LEAD_CAPTURE_PROMPT:
`איסוף פרטים לרישום הפנייה:

שם המתקשר:
- אם השם לא ידוע — שאלי לאחר שהמתקשר הציג את הנושא: "ובשביל הרישום, עם מי אני מדברת?"
- אם ענה — [SLOT:name=<שם>] ולאחר מכן "תודה, <שם>."
- אם השם ידוע מהמערכת — אל תשאלי שוב.
- מקסימום 2 ניסיונות. אחרי 2 ניסיונות כושלים — המשיכי ללא שם.

נושא הפנייה:
- אם לא ברור מהפתיחה — שאלי: "ספרו לי בקצרה, מה הפנייה?"
- תשובה קצרה מספיקה — אל תדרשי פירוט.

סגירה:
- כאשר יש נושא + ניסיון שם → סגרי בנוסח הסגירה המתאים ל-intent.
- אם intent לא ידוע → השתמשי ב-CLOSING_other.
- לאחר 8 תורות — סגרי בכל מקרה עם המידע שנאסף.
- לאחר הסגירה — אל תפתחי שוב. אם המתקשר מוסיף — "רשמתי, תודה. להתראות."`,
};

// ─── Auth ─────────────────────────────────────────────────────────────────────

function stripOuterQuotes(s) {
  if (typeof s !== "string") return s;
  const t = s.trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) return t.slice(1, -1);
  return t;
}

function getServiceAccount() {
  const b64 = stripOuterQuotes(process.env.GOOGLE_SERVICE_ACCOUNT_JSON_B64 || "");
  if (!b64) throw new Error("Missing GOOGLE_SERVICE_ACCOUNT_JSON_B64 in environment");
  return JSON.parse(Buffer.from(b64, "base64").toString("utf8"));
}

function getSheetId() {
  const id = (process.env.GSHEET_ID || "").trim();
  if (!id) throw new Error("Missing GSHEET_ID in environment");
  return id;
}

async function getSheetsClient() {
  const sa = getServiceAccount();
  const sheetId = getSheetId();
  const auth = new google.auth.JWT({
    email: sa.client_email,
    key: sa.private_key,
    // Read+write scope required for updates
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
  const sheets = google.sheets({ version: "v4", auth });
  return { sheets, sheetId };
}

// ─── Sheet helpers ─────────────────────────────────────────────────────────────

function normalizeCell(v) {
  return v === undefined || v === null ? "" : String(v).trim();
}

async function readSheet(sheets, sheetId, range) {
  const resp = await sheets.spreadsheets.values.get({ spreadsheetId: sheetId, range });
  return resp?.data?.values || [];
}

/**
 * Find the 1-based row index where column A matches `key`.
 * Returns null if not found.
 */
function findRowIndex(values, key) {
  for (let i = 0; i < values.length; i++) {
    if (normalizeCell(values[i]?.[0]) === key) return i + 1; // 1-based
  }
  return null;
}

/**
 * Update a single cell. range e.g. "SETTINGS!B5"
 */
async function updateCell(sheets, sheetId, range, value) {
  await sheets.spreadsheets.values.update({
    spreadsheetId: sheetId,
    range,
    valueInputOption: "RAW",
    requestBody: { values: [[value]] },
  });
}

/**
 * Append a new row [key, value] to the sheet.
 */
async function appendRow(sheets, sheetId, sheetName, keyCol, valueCol) {
  await sheets.spreadsheets.values.append({
    spreadsheetId: sheetId,
    range: `${sheetName}!A:B`,
    valueInputOption: "RAW",
    insertDataOption: "INSERT_ROWS",
    requestBody: { values: [[keyCol, valueCol]] },
  });
}

// ─── Apply logic ──────────────────────────────────────────────────────────────

async function applySettings(sheets, sheetId, updates) {
  const values = await readSheet(sheets, sheetId, "SETTINGS!A:B");
  const results = [];

  for (const [key, value] of Object.entries(updates)) {
    const rowIdx = findRowIndex(values, key);
    if (rowIdx !== null) {
      const range = `SETTINGS!B${rowIdx}`;
      await updateCell(sheets, sheetId, range, value);
      results.push({ action: "updated", sheet: "SETTINGS", key, range });
    } else {
      await appendRow(sheets, sheetId, "SETTINGS", key, value);
      results.push({ action: "appended", sheet: "SETTINGS", key });
    }
  }

  return results;
}

async function applyPrompts(sheets, sheetId, updates) {
  // PROMPTS sheet: column A = PromptId, column B = Content
  const values = await readSheet(sheets, sheetId, "PROMPTS!A:B");
  const results = [];

  for (const [promptId, content] of Object.entries(updates)) {
    const rowIdx = findRowIndex(values, promptId);
    if (rowIdx !== null) {
      const range = `PROMPTS!B${rowIdx}`;
      await updateCell(sheets, sheetId, range, content);
      results.push({ action: "updated", sheet: "PROMPTS", key: promptId, range });
    } else {
      await appendRow(sheets, sheetId, "PROMPTS", promptId, content);
      results.push({ action: "appended", sheet: "PROMPTS", key: promptId });
    }
  }

  return results;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log("Phase 1 SSOT applicator starting...\n");

  const { sheets, sheetId } = await getSheetsClient();
  console.log(`Sheet ID: ${sheetId}\n`);

  const settingsResults = await applySettings(sheets, sheetId, SETTINGS_TO_UPDATE);
  const promptsResults = await applyPrompts(sheets, sheetId, PROMPTS_TO_UPDATE);

  const allResults = [...settingsResults, ...promptsResults];

  console.log("─── Results ───────────────────────────────────────────────");
  for (const r of allResults) {
    const loc = r.range ? `at ${r.range}` : "(appended as new row)";
    console.log(`  [${r.action.toUpperCase()}] ${r.sheet} / ${r.key} ${loc}`);
  }

  console.log("\n─── Summary ───────────────────────────────────────────────");
  console.log(`  Total rows changed: ${allResults.length}`);
  console.log("  SSOT reload needed: YES — trigger POST /admin/reload-sheets or wait 60s TTL");
  console.log("  Phase 1 ready for live validation: YES (after reload)\n");
  console.log("Done.");
}

main().catch((err) => {
  console.error("\nFATAL:", err.message || err);
  if (err.message?.includes("403") || err.message?.includes("insufficient")) {
    console.error("\nHint: The service account lacks editor access to this sheet.");
    console.error("Share the Google Sheet with the service account email and grant 'Editor' access.");
  }
  process.exit(1);
});
