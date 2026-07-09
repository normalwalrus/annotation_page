/**
 * Google Apps Script backend: appends one row per annotation to the Sheet
 * this script is bound to.
 *
 * Agreement check: each submission is compared against all previous
 * non-skipped annotations of the same clip_id using word-level WER
 * (edit distance / longer annotation length, after lowercasing and
 * stripping punctuation). If any pair agrees with WER < 20%, the
 * "confident" column is set TRUE on both rows.
 *
 * The sheet has 8 columns (A-H): timestamp, clip_id, clip_name, text,
 * skipped, received_at, confident, annotator.
 *
 * GET ?action=leaderboard returns per-annotator totals (non-skipped
 * annotations and confident count), ranked for the leaderboard page.
 *
 * Setup (see README.md for the full walkthrough):
 *   1. Create a Google Sheet.
 *   2. Extensions → Apps Script, paste this file, save, then run setup()
 *      once — it writes the 8-column header row and triggers authorization.
 *   3. Deploy → New deployment → type "Web app"
 *        Execute as: Me
 *        Who has access: Anyone
 *   4. Copy the /exec URL into SHEETS_ENDPOINT in config.js.
 *
 * Note: after editing this script you must create a NEW deployment version
 * for changes to take effect on the /exec URL.
 */

/**
 * Run this ONCE from the Apps Script editor (select "setup" then click Run).
 * It writes the header row and triggers the authorization prompt.
 */
function setup() {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheets()[0];
  sheet
    .getRange(1, 1, 1, 8)
    .setValues([["timestamp", "clip_id", "clip_name", "text", "skipped", "received_at", "confident", "annotator"]])
    .setFontWeight("bold");
}

var CONFIDENT_WER_THRESHOLD = 0.2;

// Column positions (1-based): A=timestamp, B=clip_id, C=clip_name, D=text,
// E=skipped, F=received_at, G=confident
var COL_CLIP_ID = 2;
var COL_TEXT = 4;
var COL_SKIPPED = 5;
var COL_CONFIDENT = 7;
var COL_ANNOTATOR = 8;

function normalizeWords(text) {
  return String(text)
    .toLowerCase()
    .replace(/[^a-z0-9À-￿']+/g, " ")
    .split(" ")
    .filter(String);
}

// Word-level edit distance, normalized by the longer annotation so the
// measure is symmetric. 0 = identical, 1 = nothing in common.
function wer(aWords, bWords) {
  var m = aWords.length;
  var n = bWords.length;
  if (m === 0 && n === 0) return 0;
  if (m === 0 || n === 0) return 1;
  var prev = [];
  var cur = [];
  for (var j = 0; j <= n; j++) prev[j] = j;
  for (var i = 1; i <= m; i++) {
    cur[0] = i;
    for (var k = 1; k <= n; k++) {
      cur[k] = Math.min(
        prev[k] + 1,
        cur[k - 1] + 1,
        prev[k - 1] + (aWords[i - 1] === bWords[k - 1] ? 0 : 1)
      );
    }
    var tmp = prev;
    prev = cur;
    cur = tmp;
  }
  return prev[n] / Math.max(m, n);
}

function doPost(e) {
  var lock = LockService.getScriptLock();
  lock.waitLock(10000); // serialize concurrent submissions

  try {
    var data = JSON.parse(e.postData.contents);

    // Basic shape check — reject junk that isn't from the app.
    if (typeof data.clip_id !== "string" || typeof data.clip_name !== "string") {
      return respond({ status: "error", message: "bad payload" });
    }

    var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheets()[0];
    var text = (data.text || "").toString().slice(0, 5000);
    var skipped = data.skipped === true;
    var annotator = String(data.annotator || "").trim().slice(0, 80);

    // Agreement check against earlier annotations of the same clip.
    var confident = false;
    if (!skipped && text.trim()) {
      var newWords = normalizeWords(text);
      var values = sheet.getDataRange().getValues();
      for (var r = 1; r < values.length; r++) {
        var row = values[r];
        if (row[COL_CLIP_ID - 1] !== data.clip_id) continue;
        if (row[COL_SKIPPED - 1] === true) continue;
        var otherText = String(row[COL_TEXT - 1]);
        if (!otherText.trim()) continue;
        if (wer(newWords, normalizeWords(otherText)) < CONFIDENT_WER_THRESHOLD) {
          confident = true;
          sheet.getRange(r + 1, COL_CONFIDENT).setValue(true); // mark the agreeing earlier row too
        }
      }
    }

    sheet.appendRow([
      data.timestamp || "",
      data.clip_id,
      data.clip_name,
      text,
      skipped,
      new Date().toISOString(),
      confident,
      annotator,
    ]);

    CacheService.getScriptCache().remove("leaderboard_v1");
    return respond({ status: "ok", confident: confident });
  } catch (err) {
    return respond({ status: "error", message: String(err) });
  } finally {
    lock.releaseLock();
  }
}

// GET ?action=leaderboard returns the standings; a bare GET is a liveness ping.
function doGet(e) {
  try {
    var action = e && e.parameter ? e.parameter.action : "";
    if (action === "leaderboard") return respond(getLeaderboard());
    return respond({ status: "ok", message: "Annotation endpoint is live. POST to submit." });
  } catch (err) {
    return respond({ status: "error", message: String(err) });
  }
}

function getLeaderboard() {
  var cache = CacheService.getScriptCache();
  var cached = cache.get("leaderboard_v1");
  if (cached) return JSON.parse(cached);

  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheets()[0];
  var values = sheet.getDataRange().getValues();
  var byKey = {};
  for (var r = 1; r < values.length; r++) {
    var row = values[r];
    var name = String(row[COL_ANNOTATOR - 1] || "").trim();
    if (!name) continue; // legacy anonymous rows excluded
    if (row[COL_SKIPPED - 1] === true) continue; // skips don't count toward totals
    var key = name.toLowerCase(); // "Ian" and "ian" are one person
    var entry = byKey[key] || (byKey[key] = { name: name, total: 0, confident: 0 });
    entry.total += 1;
    if (row[COL_CONFIDENT - 1] === true) entry.confident += 1;
  }
  var rows = Object.keys(byKey).map(function (k) {
    return byKey[k];
  });
  rows.sort(function (a, b) {
    return b.total - a.total || b.confident - a.confident || a.name.localeCompare(b.name);
  });
  var result = { status: "ok", generated_at: new Date().toISOString(), leaderboard: rows };
  cache.put("leaderboard_v1", JSON.stringify(result), 60); // 60s cache
  return result;
}

function respond(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(
    ContentService.MimeType.JSON
  );
}
