# Context

The annotation app at `/home/digitalhub/Desktop/ian_projects/PASSIONS/some_app` is a static vanilla-JS single-page app (no framework, no build step, hosted on GitHub Pages, served locally with `python3 -m http.server 8000`). What the team refers to as "the Excel sheet" is actually a **Google Sheet**: each annotation is POSTed to a Google Apps Script web app (`apps_script/Code.gs`) which appends a row.

We want a **leaderboard** so annotators can see how many annotations each person has done and how many are "confident". Requirements confirmed with the user:

- **Name capture is required**: before annotating, the user enters a unique name once; it's remembered on the device (localStorage) and attached to every saved annotation. (Currently annotations are anonymous — no user identity exists anywhere.)
- **Leaderboard is a separate static page** `leaderboard.html`, linked from the annotation page, showing a **full ranked table**: rank, name, total annotations, confident count. Typing your name highlights your row.
- **Ranking**: total annotations descending; confident count as tie-breaker.
- **Skipped submissions do NOT count** toward totals (prevents rank inflation by skipping; skips can never be confident).
- Legacy rows (saved before this feature, with no annotator) are **excluded** from the leaderboard.

## Current architecture facts (verified)

- Files: `index.html` (UI; loads `config.js` then `app.js` at the bottom), `app.js` (all client logic in an IIFE), `config.js` (`GDRIVE_API_KEY` + `SHEETS_ENDPOINT`), `style.css`, `manifest.json` (clip list, NOT a PWA manifest), `apps_script/Code.gs`, `apps_script/appsscript.json`, `tools/generate_manifest.mjs`, `README.md`.
- Sheet columns A–G: `timestamp, clip_id, clip_name, text, skipped, received_at, confident`. Column constants in `Code.gs:40-43`: `COL_CLIP_ID=2, COL_TEXT=4, COL_SKIPPED=5, COL_CONFIDENT=7`.
- `doPost` (`Code.gs:79-129`) appends one row per submission under a script lock. `confident` (col G) is computed server-side: the new text is compared to earlier annotations of the same clip via word-level WER; if `WER < 0.2` the new row saves `confident=true` and the earlier matching row is flipped TRUE (`Code.gs:108`).
- `doGet` (`Code.gs:132-134`) currently only returns a liveness ping via `respond()` (`Code.gs:136-140`, ContentService JSON).
- Client POST (`app.js:319-332`): payload `{timestamp, clip_id, clip_name, text, skipped}`; deliberately **no Content-Type header** so the request stays a CORS "simple request" — preserve this.
- Per-device state: `localStorage["annotation_done_v1"]` (done clip IDs), in-memory `sessionCount`. `show()` at `app.js:66-70` toggles the four `<section>` states (`loading`, `error`, `done`, `annotator`).
- `setup()` in `Code.gs` (~line 32) writes ONLY the header row — safe to re-run on a live sheet.

# Implementation

## 1. `apps_script/Code.gs`

1. **`setup()`**: widen header write from `getRange(1,1,1,7)` to `getRange(1,1,1,8)` and append `"annotator"` to the header array. Update the top-of-file doc comment (lines 11–18) to mention 8 columns and the leaderboard GET.
2. **Constants**: add `var COL_ANNOTATOR = 8;` next to the existing column constants.
3. **`doPost`**: after `var skipped = ...` add
   `var annotator = String(data.annotator || "").trim().slice(0, 80);`
   and append `annotator` as the 8th element of the `appendRow` array. Do NOT reject empty annotator (old cached clients keep working; their rows just don't appear on the leaderboard). Before the final `respond(...)`, add `CacheService.getScriptCache().remove("leaderboard_v1");` so fresh saves appear immediately.
4. **`doGet`**: replace with a dispatcher + aggregation:

```js
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
    if (!name) continue;                         // legacy anonymous rows excluded
    if (row[COL_SKIPPED - 1] === true) continue; // DECISION: skips don't count
    var key = name.toLowerCase();                // "Ian" and "ian" are one person
    var entry = byKey[key] || (byKey[key] = { name: name, total: 0, confident: 0 });
    entry.total += 1;
    if (row[COL_CONFIDENT - 1] === true) entry.confident += 1;
  }
  var rows = Object.keys(byKey).map(function (k) { return byKey[k]; });
  rows.sort(function (a, b) {
    return b.total - a.total || b.confident - a.confident || a.name.localeCompare(b.name);
  });
  var result = { status: "ok", generated_at: new Date().toISOString(), leaderboard: rows };
  cache.put("leaderboard_v1", JSON.stringify(result), 60); // 60s cache
  return result;
}
```

Notes: `respond()` already returns ContentService JSON, which works cross-origin for GETs (script.google.com 302-redirects to googleusercontent.com which serves `Access-Control-Allow-Origin: *`; `fetch` follows automatically). Boolean comparisons use `=== true`, matching the existing convention at `Code.gs:103`. Grouping key is `trim().toLowerCase()`; displayed name is first-seen casing.

## 2. `index.html`

1. In `<header class="masthead">` after the session chip (~lines 25–27):

```html
<p class="session-chip name-chip hidden" id="name-chip">
  ANNOTATOR&nbsp;·&nbsp;<span id="name-chip-value"></span>
  <button id="change-name-btn" class="chip-btn" type="button">change</button>
</p>
<p class="leaderboard-link"><a href="leaderboard.html">View the leaderboard →</a></p>
```

2. Name-gate section after the `#done` section (~line 54), before `#annotator`:

```html
<section id="name-gate" class="status-card hidden">
  <p class="done-mark">WHO'S ON TAPE?</p>
  <p>Enter your name once — it's attached to every transcript you save and shown on the leaderboard.</p>
  <form id="name-form" class="name-form">
    <input id="name-input" type="text" maxlength="80" autocomplete="name" placeholder="Your name" required />
    <button type="submit" class="btn btn-save">Start annotating</button>
  </form>
</section>
```

## 3. `app.js`

1. After `DONE_KEY` (line 5): `const NAME_KEY = "annotator_name_v1";`
2. Add to the `els` map: `nameGate: $("name-gate")`, `nameForm: $("name-form")`, `nameInput: $("name-input")`, `nameChip: $("name-chip")`, `nameChipValue: $("name-chip-value")`, `changeNameBtn: $("change-name-btn")`.
3. Helpers near `loadDone`/`saveDone` (~lines 48–55):

```js
const getName = () => (localStorage.getItem(NAME_KEY) || "").trim();
const setName = (name) => localStorage.setItem(NAME_KEY, name);
const refreshNameChip = () => {
  const name = getName();
  els.nameChipValue.textContent = name;
  els.nameChip.classList.toggle("hidden", !name);
};
```

4. Add `els.nameGate` to the section array in `show()` (~lines 66–70).
5. In `init()` (~lines 158–178), after the config checks and before the manifest fetch:

```js
if (!getName()) {
  show(els.nameGate);
  els.nameInput.value = "";
  els.nameInput.focus();
  return;
}
refreshNameChip();
```

6. Event handlers (near the other listeners, ~lines 352–354):

```js
els.nameForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const name = els.nameInput.value.trim();
  if (!name) return;
  setName(name);
  init();
});
els.changeNameBtn.addEventListener("click", () => {
  localStorage.removeItem(NAME_KEY);
  audio.pause();
  init();
});
```

7. In `record()` (~lines 319–325): add `annotator: getName(),` to the payload, and at the top of `record()` add a guard `if (!getName()) { init(); return; }` (covers localStorage cleared mid-session).

## 4. `leaderboard.html` (new)

Same `<head>` boilerplate as `index.html` (fonts, favicon, `style.css`); title "Leaderboard — Listen. Type. Next.". Body:

```html
<main class="container">
  <header class="masthead">
    <p class="eyebrow">Leaderboard</p>
    <h1>Top<br />Tapes.</h1>
    <p class="lede">Ranked by transcripts saved. Confident = transcripts that agree with another annotator.</p>
    <p class="leaderboard-link"><a href="index.html">← Back to annotating</a></p>
  </header>

  <div class="lb-controls">
    <input id="highlight-input" type="text" maxlength="80" placeholder="Type your name to find your row" />
    <button id="refresh-btn" class="btn">Refresh</button>
  </div>

  <section id="lb-loading" class="status-card"><p>Loading the standings…</p></section>
  <section id="lb-error" class="status-card hidden">
    <p id="lb-error-message"></p>
    <button id="lb-retry-btn" class="btn">Try again</button>
  </section>
  <section id="lb-empty" class="status-card hidden">
    <p>No named annotations yet. Be the first — go transcribe a clip.</p>
  </section>

  <table id="lb-table" class="lb-table hidden">
    <thead><tr><th>#</th><th>Name</th><th>Annotations</th><th>Confident</th></tr></thead>
    <tbody id="lb-body"></tbody>
  </table>
  <p id="lb-updated" class="hint"></p>
</main>
<script src="config.js"></script>
<script src="leaderboard.js"></script>
```

## 5. `leaderboard.js` (new)

IIFE matching `app.js` style:

```js
(() => {
  "use strict";
  const cfg = window.APP_CONFIG || {};
  const NAME_KEY = "annotator_name_v1"; // must match app.js
  const $ = (id) => document.getElementById(id);
  let rows = [];

  const STATES = ["lb-loading", "lb-error", "lb-empty", "lb-table"];
  const showState = (id) => STATES.forEach((s) => $(s).classList.toggle("hidden", s !== id));
  const fail = (msg) => { $("lb-error-message").textContent = msg; showState("lb-error"); };

  async function load() {
    showState("lb-loading");
    if (!cfg.SHEETS_ENDPOINT || cfg.SHEETS_ENDPOINT.startsWith("PASTE_")) {
      return fail("Setup incomplete: SHEETS_ENDPOINT is not set in config.js.");
    }
    try {
      // script.google.com 302-redirects GETs; fetch follows automatically.
      const res = await fetch(`${cfg.SHEETS_ENDPOINT}?action=leaderboard`, { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const out = await res.json();
      if (out.status !== "ok") throw new Error(out.message || "endpoint error");
      rows = out.leaderboard || [];
      $("lb-updated").textContent = out.generated_at
        ? `Updated ${new Date(out.generated_at).toLocaleString()} · refreshes at most once a minute`
        : "";
      render();
    } catch (e) {
      fail(`The leaderboard didn't load (${e.message}).`);
    }
  }

  function render() {
    if (rows.length === 0) return showState("lb-empty");
    const highlight = $("highlight-input").value.trim().toLowerCase();
    const body = $("lb-body");
    body.textContent = ""; // build with createElement/textContent — names are user input, no innerHTML (XSS)
    rows.forEach((r, i) => {
      const tr = document.createElement("tr");
      if (highlight && r.name.toLowerCase() === highlight) tr.classList.add("me");
      for (const v of [String(i + 1), r.name, String(r.total), String(r.confident)]) {
        const td = document.createElement("td");
        td.textContent = v;
        tr.appendChild(td);
      }
      body.appendChild(tr);
    });
    showState("lb-table");
    body.querySelector("tr.me")?.scrollIntoView({ block: "center", behavior: "smooth" });
  }

  $("highlight-input").value = localStorage.getItem(NAME_KEY) || "";
  $("highlight-input").addEventListener("input", () => rows.length && render());
  $("refresh-btn").addEventListener("click", load);
  $("lb-retry-btn").addEventListener("click", load);
  load();
})();
```

## 6. `style.css` additions (append at end, reuse existing tokens)

- `.name-form` — flex row, gap 0.5rem; input styled like the existing `textarea` (card background, `--line` border, `--mono` font); stack vertically inside the existing `@media (max-width: 480px)` block.
- `.chip-btn` — small inline text button (transparent background, `--signal` color, underline on hover).
- `.leaderboard-link a` — `--mono`, 0.75rem, `--ink-soft`, underline on hover.
- `.lb-controls` — flex row, gap, margin `1.5rem 0 1rem`; input flexes.
- `.lb-table` — `width:100%; border-collapse:collapse; background:var(--card); border:1px solid var(--line); border-radius:6px;` cells `padding:0.55rem 0.8rem; border-bottom:1px solid var(--line);` header row in `--mono`, uppercase, letter-spaced like `.transcript-label`; numeric columns right-aligned with `font-variant-numeric: tabular-nums`.
- `tr.me` — `outline: 2px solid var(--amber); background: rgba(245,166,35,.12);`.

## 7. `README.md`

- Section 3 step 1 (~line 41): header list becomes `timestamp | clip_id | clip_name | text | skipped | received_at | confident | annotator` (it currently also omits `confident` — fix that).
- "Getting your data" table (~line 96): add the `annotator` column.
- New "Leaderboard" section: what `leaderboard.html` shows, ranking rule (total desc, confident tie-break), skips excluded, legacy anonymous rows excluded, name grouping is case-insensitive.
- Migration note (checklist below).

# Migration + redeploy checklist (manual Google steps, in order)

1. Copy the updated `Code.gs` into the Apps Script editor bound to the Sheet (Extensions → Apps Script), save.
2. Run `setup()` once from the editor — it rewrites only row 1 as the 8-column header; data rows are untouched. (Alternative: type `annotator` into cell H1 by hand.)
3. **Deploy → Manage deployments → edit (pencil) → Version: New version → Deploy.** Mandatory — the `/exec` URL serves old code otherwise. `SHEETS_ENDPOINT` in `config.js` does not change.
4. Commit + push the static files (GitHub Pages).

Legacy rows keep their data; they're simply invisible to the leaderboard.

# Verification

Backend first (curl; `-L` matters because of the 302 redirect):

```bash
ENDPOINT="<SHEETS_ENDPOINT from config.js>"
curl -sL "$ENDPOINT"                     # liveness ping
curl -sL "$ENDPOINT?action=leaderboard"  # {"status":"ok",...,"leaderboard":[...]}
curl -sL -X POST "$ENDPOINT" -d '{"timestamp":"t","clip_id":"test_clip","clip_name":"test.mp3","text":"hello world test","skipped":false,"annotator":"Test User"}'
curl -sL "$ENDPOINT?action=leaderboard"  # Test User: total 1, confident 0
# POST same text again as "test user" (different case) -> one grouped row, total 2, confident 2 (WER agreement)
# POST {"skipped":true,"annotator":"Test User"} -> totals unchanged (skips excluded)
```

Delete the test rows from the Sheet afterwards.

Frontend (local): `python3 -m http.server 8000` in the project dir, then:

1. Open http://localhost:8000 in a private window (empty localStorage) → name gate appears; whitespace-only submit rejected; entering a name shows the annotator UI + name chip.
2. Transcribe a clip → Sheet gains a row with column H = your name.
3. Reload → no gate (name remembered). Click "change" → gate reappears.
4. Open http://localhost:8000/leaderboard.html → table renders; highlight input prefilled from localStorage and your row outlined; Refresh works; typing another name moves the highlight.
5. Error path: mangle `SHEETS_ENDPOINT` or go offline → error card with working "Try again".
6. Ctrl+Space / Ctrl+Enter shortcuts still work on index.
