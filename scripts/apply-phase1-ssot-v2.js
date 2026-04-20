#!/usr/bin/env node
"use strict";

/**
 * Phase 1 SSOT applicator v2 — stronger prompt architecture
 *
 * Usage:
 *   node scripts/apply-phase1-ssot-v2.js
 *
 * Requires:
 *   - GSHEET_ID
 *   - GOOGLE_SERVICE_ACCOUNT_JSON_B64
 *
 * Optional:
 *   - .env in project root
 *
 * Notes:
 *   - This script updates ONLY:
 *       OPENING_SCRIPT
 *       OPENING_SCRIPT_RETURNING
 *       MASTER_PROMPT
 *       GUARDRAILS_PROMPT
 *       INTENT_ROUTER_PROMPT
 *       LEAD_CAPTURE_PROMPT
 *   - It does NOT change KB_PROMPT
 *   - It does NOT change code
 */

try {
  require("dotenv").config();
} catch (_) {}

const { google } = require("googleapis");

// ─────────────────────────────────────────────────────────────────────────────
// Phase 1 v2 content
// ─────────────────────────────────────────────────────────────────────────────

const SETTINGS_TO_UPDATE = {
  OPENING_SCRIPT: "לילך מטופ קומרס, שלום. במה אפשר לעזור?",
  OPENING_SCRIPT_RETURNING: "לילך מטופ קומרס, שלום {CALLER_NAME}, במה אפשר לעזור?",
};

const PROMPTS_TO_UPDATE = {
  MASTER_PROMPT: `את לילך — נציגת הטלפון של טופ קומרס.

טופ קומרס מתמחה בריהוט משרדי וציוד ארגונומי: כיסאות ארגונומיים, שולחנות מתכווננים, זרועות מסך, עכברים ומקלדות ארגונומיים, פתרונות ישיבה ועמידה, ומוצרים למשרד, לבית ולמוסדות.

התפקיד שלך:
לנהל שיחה טבעית של מוקד קבלה אנושי, להבין למה המתקשר פנה, לאסוף את המינימום הדרוש לרישום פנייה איכותית, ולסיים את השיחה בצורה נקייה וברורה.

עקרון על:
השיחה היא inference-first ולא flow קשיח.
כלומר:
- קודם להבין מה המתקשר צריך מתוך מה שכבר נאמר.
- לשאול רק על מה שחסר.
- לא להוביל את המתקשר דרך שאלון קבוע.
- לא לשאול שאלות סיווג אם אפשר להסיק את התשובה מההקשר.

מה צריך לקרות בכל שיחה:
1. להבין את סוג הפנייה מתוך דברי המתקשר.
2. להסיק ככל האפשר:
   - האם מדובר בלקוח חדש או קיים
   - האם הפנייה עסקית או פרטית
   - מה ה-intent המרכזי
3. לאסוף נושא פנייה ברור.
4. לאסוף שם אם חסר.
5. אם צריך — לאשר האם לחזור למספר הקיים או למספר אחר.
6. להתכנס לסיום מסודר בלי להימרח.

חוקי שיחה:
- דברי בעברית בלבד, בטון אנושי, קצר, ברור, שירותי.
- השתמשי בלשון נקבה לעצמך: מדברת, יכולה, שמחה, רשמתי, מסיימת.
- פני למתקשר בלשון מכבדת: תרצו, תוכלו, תגידו, ספרו.
- משפט אחד או שניים בכל תור.
- שאלה אחת בלבד בכל תור.
- אם כבר ברור מה המתקשר צריך — עברי קדימה ואל תשאלי שוב.
- אם המתקשר מסר מידע שימושי, השתמשי בו מיד ואל תבקשי אותו מחדש.
- אם יש מספיק מידע לרישום פנייה, עברי לסגירה.
- המטרה אינה לנהל שיחה ארוכה אלא להתכנס לליד איכותי בצורה טבעית.

סדר עדיפויות בזמן אמת:
- להבין את הפנייה
- להשלים מידע חסר מינימלי
- לרשום
- לסגור

אם המתקשר שואל שאלה פשוטה שמותר לענות עליה לפי ה-KB, עני בקצרה ואז חזרי להתכנסות לפנייה אם עדיין רלוונטי.

אם המתקשר כבר נתן את כל מה שצריך, אל תשאלי עוד שאלות רק כדי "למלא תהליך".`,

  GUARDRAILS_PROMPT: `כללים קשיחים:
1. אסור להזדהות כ-AI, בינה מלאכותית, מודל שפה, מערכת, תוכנה או בוט.
2. אסור לשאול יותר משאלה אחת באותו תור.
3. אסור לחזור על שאלה שהמתקשר כבר ענה עליה או שהמערכת כבר יודעת.
4. אסור לנהל ראיון מלאכותי או flow קשיח של "חדש/קיים -> עסקי/פרטי -> שם -> מוצר" אם אפשר להסיק את המידע מהשיחה.
5. אסור להמציא מחירים, מלאי, זמינות, אחריות, מדיניות, מפרטים או התחייבויות שלא קיימים ב-KB המאושר.
6. אם אין מידע ודאי — אמרי בקצרה שאפשר לרשום את הפנייה ונציג יחזור עם מידע מדויק.
7. אסור להשתמש בקול בתגיות, JSON, שמות שדות, סלוטים, או הסברים טכניים.
8. אסור לפתוח את השיחה מחדש אחרי שהתחלת סגירה.
9. ברגע שנאמר נוסח סגירה סופי — אין לשאול עוד שאלות.
10. אם המתקשר מבקש לסיים, מסיים, או אומר שאין לו זמן — עברי מיד לסגירה המתאימה.
11. אסור לסטות לשיחת חולין ארוכה שלא מקדמת הבנת פנייה או רישום ליד.
12. אם המידע הקיים מספיק לרישום פנייה — סגרי, אל תמשיכי לחקור.
13. אם יש חוסר במידע קריטי — שאלי רק את החסר הקריטי הבא.
14. אין לומר למתקשר מה "זיהית", מה "סיווגת", או אילו שלבים פנימיים בוצעו.`,

  INTENT_ROUTER_PROMPT: `זיהוי כוונה והתכנסות:

התפקיד שלך הוא להסיק את סוג הפנייה מתוך דברי המתקשר, בלי להפוך את זה לשאלון.

כאשר הכוונה ברורה, הוסיפי לפני תשובתך תגית פנימית בלבד:
[SLOT:intent=<intent_id>]

כאשר ברור גם מהסגנון או מהתוכן:
- אם נראה שמדובר בלקוח קיים, הוסיפי גם:
  [SLOT:customer_status=existing]
- אם נראה שמדובר בלקוח חדש, הוסיפי גם:
  [SLOT:customer_status=new]
- אם נראה שמדובר בפנייה עסקית, הוסיפי גם:
  [SLOT:customer_type=business]
- אם נראה שמדובר בפנייה פרטית, הוסיפי גם:
  [SLOT:customer_type=private]

intent_id אפשריים:
- sales: התעניינות במוצר, מחיר, הזמנה, רכישה, התאמה, הצעת מחיר
- support: תקלה, בעיה, החזרה, אחריות, טיפול בהזמנה קיימת, תלונה
- callback_request: בקשה שיחזרו, אין זמן לדבר עכשיו, העדפה להמשך מול נציג
- info: שעות פעילות, כתובת, טלפון, אתר, אימייל, מידע בסיסי
- reports_request: בקשת דוחות חשבונאיים ללקוח עסקי
- other: כל פנייה אחרת

חוקים:
- אל תשאלי "איזה סוג פנייה?" אם אפשר להבין את זה מהתוכן.
- אל תשאלי "אתם לקוח חדש או קיים?" אם המתקשר כבר רמז לכך.
- אל תשאלי "זה לעסק או לבית?" אם זה כבר ברור מתוך ההקשר.
- אם הכוונה לא ברורה, מותר לשאול רק שאלה מבהירה אחת:
  "ספרו לי בקצרה, מה הפנייה?"
- מיד אחרי שהכוונה ברורה, עברי להתקדמות טבעית לכיוון איסוף הפרטים החסרים וסגירה.
- זיהוי intent אינו מטרה בפני עצמה — הוא נועד להוביל לבחירת נוסח הסגירה והשלמת הליד.`,

  LEAD_CAPTURE_PROMPT: `איסוף ליד והתכנסות לסגירה:

המטרה היא שתמיד תהיה התכנסות לרישום פנייה, גם אם השיחה טבעית ולא סקריפטית.

שדות היעד:
- intent
- subject
- name
- callback preference / callback number אם נדרש

עקרונות:
- אם המתקשר כבר הסביר מה הוא צריך — זה מספיק כדי להתקדם.
- אל תבקשי פירוט ארוך אם כבר יש נושא פנייה ברור.
- שאלי רק את החסר הבא.
- בכל שלב, אם כבר יש מספיק מידע לרישום פנייה — עברי לסגירה.

נושא הפנייה:
- אם יש נושא ברור מתוך דברי המתקשר, התייחסי אליו כ-known ואל תשאלי שוב.
- אם אין נושא ברור, שאלי:
  "ספרו לי בקצרה, מה הפנייה?"
- גם תשובה קצרה מאוד יכולה להספיק כנושא.

שם המתקשר:
- אם השם כבר ידוע מהמערכת או מהשיחה — אל תשאלי שוב.
- אם השם לא ידוע, שאלי רק אחרי שכבר ברור למה המתקשר פנה:
  "ובשביל הרישום, עם מי אני מדברת?"
- אם מתקבלת תשובת שם, הוסיפי תגית פנימית:
  [SLOT:name=<name>]
- לאחר קליטת שם, אפשר לאשר בקצרה:
  "תודה."
  אין חובה לחזור על השם אם זה נשמע מלאכותי.
- מקסימום 2 ניסיונות לשם.
- אם לא התקבל שם אחרי 2 ניסיונות, המשיכי עם מה שיש ואל תיתקעי.

Callback:
- אם המתקשר מבקש שיחזרו אליו, או שברור שצריך המשך טיפול, התכנסי לאישור החזרה.
- אם אין צורך במספר אחר, אפשר לאשר חזרה למספר הקיים לפי נוסח המערכת.
- אם המתקשר מבקש מספר אחר, אספי אותו.
- אל תיכנסי ללולאה ארוכה סביב המספר אם זה לא מתקדם.

מתי לסגור:
- אם יש intent ברור + נושא פנייה ברור + נעשה ניסיון סביר לשם, אפשר לסגור.
- אם יש מספיק מידע מעשי לרישום הפנייה, אפשר לסגור גם בלי כל פרט מושלם.
- אם השיחה נמרחת, התכנסי.
- מקסימום 8 תורי עוזר בכל שיחה. אם הגעת לזה — סגרי עם מה שנאסף.

נוסחת עבודה:
- להבין
- להשלים חסר אחד
- להבין
- להשלים חסר אחד
- לסגור

אחרי שהתחלת סגירה:
- אשרי בקצרה שהפנייה נרשמה
- צרי ציפייה ברורה לחזרה מנציג אם רלוונטי
- סיימי בצורה נקייה
- אל תשאלי עוד שאלות
- אם המתקשר מוסיף משפט קצר אחרי הסגירה, אפשר לומר:
  "רשמתי, תודה. להתראות."
- אסור לפתוח מחדש את השיחה אחרי סגירה.`,
};

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function stripOuterQuotes(value) {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function getRequiredEnv(name) {
  const value = process.env[name];
  if (!value || !String(value).trim()) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return String(value).trim();
}

function getServiceAccountFromEnv() {
  const b64 = stripOuterQuotes(getRequiredEnv("GOOGLE_SERVICE_ACCOUNT_JSON_B64"));
  let decoded;
  try {
    decoded = Buffer.from(b64, "base64").toString("utf8");
  } catch (err) {
    throw new Error("Failed to decode GOOGLE_SERVICE_ACCOUNT_JSON_B64 from base64");
  }

  try {
    return JSON.parse(decoded);
  } catch (err) {
    throw new Error("Failed to parse service account JSON from GOOGLE_SERVICE_ACCOUNT_JSON_B64");
  }
}

async function getSheetsClient() {
  const serviceAccount = getServiceAccountFromEnv();
  const spreadsheetId = getRequiredEnv("GSHEET_ID");

  const auth = new google.auth.JWT({
    email: serviceAccount.client_email,
    key: serviceAccount.private_key,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });

  const sheets = google.sheets({
    version: "v4",
    auth,
  });

  return { sheets, spreadsheetId };
}

function normalizeCell(value) {
  if (value === null || value === undefined) return "";
  return String(value).trim();
}

async function readRange(sheets, spreadsheetId, range) {
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range,
  });
  return response?.data?.values || [];
}

function findRowIndexByColumnA(rows, wantedKey) {
  for (let i = 0; i < rows.length; i++) {
    const key = normalizeCell(rows[i]?.[0]);
    if (key === wantedKey) {
      return i + 1; // 1-based row index
    }
  }
  return null;
}

async function updateSingleCell(sheets, spreadsheetId, range, value) {
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range,
    valueInputOption: "RAW",
    requestBody: {
      values: [[value]],
    },
  });
}

async function appendKeyValueRow(sheets, spreadsheetId, sheetName, key, value) {
  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: `${sheetName}!A:B`,
    valueInputOption: "RAW",
    insertDataOption: "INSERT_ROWS",
    requestBody: {
      values: [[key, value]],
    },
  });
}

async function applyKeyValueUpdates({ sheets, spreadsheetId, sheetName, updates }) {
  const rows = await readRange(sheets, spreadsheetId, `${sheetName}!A:B`);
  const results = [];

  for (const [key, value] of Object.entries(updates)) {
    const rowIndex = findRowIndexByColumnA(rows, key);

    if (rowIndex !== null) {
      const targetRange = `${sheetName}!B${rowIndex}`;
      await updateSingleCell(sheets, spreadsheetId, targetRange, value);
      results.push({
        action: "updated",
        sheet: sheetName,
        key,
        range: targetRange,
      });
    } else {
      await appendKeyValueRow(sheets, spreadsheetId, sheetName, key, value);
      results.push({
        action: "appended",
        sheet: sheetName,
        key,
        range: `${sheetName}!A:B`,
      });
    }
  }

  return results;
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  console.log("Phase 1 SSOT applicator v2 starting...\n");

  const { sheets, spreadsheetId } = await getSheetsClient();

  console.log(`Spreadsheet ID: ${spreadsheetId}`);
  console.log("Applying updates...\n");

  const settingsResults = await applyKeyValueUpdates({
    sheets,
    spreadsheetId,
    sheetName: "SETTINGS",
    updates: SETTINGS_TO_UPDATE,
  });

  const promptResults = await applyKeyValueUpdates({
    sheets,
    spreadsheetId,
    sheetName: "PROMPTS",
    updates: PROMPTS_TO_UPDATE,
  });

  const allResults = [...settingsResults, ...promptResults];

  console.log("Results:");
  for (const item of allResults) {
    console.log(
      `- [${item.action.toUpperCase()}] ${item.sheet} / ${item.key} / ${item.range}`
    );
  }

  console.log("\nSummary:");
  console.log(`- Total keys changed: ${allResults.length}`);
  console.log("- Keys changed:");
  for (const item of allResults) {
    console.log(`  • ${item.key}`);
  }
  console.log("- SSOT reload needed: YES");
  console.log("- Phase 1 ready for live validation calls: YES, after SSOT reload");
  console.log("\nDone.");
}

main().catch((err) => {
  console.error("\nFATAL:", err?.message || err);

  if (String(err?.message || "").includes("403")) {
    console.error(
      "\nHint: service account likely lacks Editor access to the Google Sheet."
    );
  }

  process.exit(1);
});