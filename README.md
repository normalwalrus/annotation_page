# Audio Transcription Tool

A static audio-annotation page for GitHub Pages. Annotators hear a random short
clip streamed from your Google Drive folder, type what they hear, and each
submission lands as a row in a Google Sheet you own.

```
Browser (GitHub Pages)
  ├─ manifest.json ............ list of clips (committed to this repo)
  ├─ Google Drive API ......... streams the audio (read-only, free API key)
  └─ Google Apps Script ....... appends each annotation to your Google Sheet
```

Features: random clip selection with no repeats per device (localStorage),
speed control, loop, keyboard shortcuts, must-listen + non-empty guardrails,
skip/can't-hear button, auto-advance with session counter.

---

## One-time setup

### 1. Google Drive — host the audio

1. Put your clips (mp3/wav/m4a/ogg) in one Drive folder.
2. Right-click the folder → **Share** → General access: **Anyone with the link — Viewer**.
3. Note the folder ID — the part after `/folders/` in the folder's URL.

### 2. Google Cloud — get a Drive API key

1. Go to <https://console.cloud.google.com/> → create a project (any name).
2. **APIs & Services → Library** → search **Google Drive API** → Enable.
3. **APIs & Services → Credentials → Create credentials → API key.**
4. Recommended: click the key → under **API restrictions** choose
   **Restrict key → Google Drive API**. (The key is visible in the page source,
   so restricting it means the worst anyone can do is read your public files.)
5. Paste the key into `DRIVE_API_KEY` in `config.js`.

### 3. Google Sheets — collect the results

1. Create a new Google Sheet. In row 1 type these headers:
   `timestamp | clip_id | clip_name | text | skipped | received_at | confident | annotator`
   (or run the `setup()` function from the Apps Script editor, which writes them for you)
2. **Extensions → Apps Script**, delete the boilerplate, paste in
   [`apps_script/Code.gs`](apps_script/Code.gs), save.
3. **Deploy → New deployment** → gear icon → type **Web app**:
   - Execute as: **Me**
   - Who has access: **Anyone**
4. Authorize when prompted, then copy the **Web app URL** (ends in `/exec`)
   into `SHEETS_ENDPOINT` in `config.js`.
5. Sanity check: open that URL in a browser — you should see
   `{"status":"ok",...}`.

> If you later edit the script, use **Deploy → Manage deployments → Edit →
> New version** — otherwise the `/exec` URL keeps serving the old code.

### 4. Generate the clip manifest

Requires Node 18+:

```bash
node tools/generate_manifest.mjs <DRIVE_FOLDER_ID> <API_KEY>
```

This overwrites `manifest.json` with every audio file in the folder.
**Rerun and commit whenever you add or remove clips.**

### 5. Publish on GitHub Pages

```bash
git init
git add .
git commit -m "Audio annotation tool"
# create a repo on github.com, then:
git remote add origin git@github.com:<you>/<repo>.git
git push -u origin main
```

On GitHub: **Settings → Pages → Source: Deploy from a branch → main / root**.
Your tool goes live at `https://<you>.github.io/<repo>/`.

---

## Testing locally

```bash
python3 -m http.server 8000
# open http://localhost:8000
```

(Opening `index.html` directly via `file://` won't work — `manifest.json` is
fetched, which requires a server.)

## Getting your data

Everything is in the Google Sheet, one row per submission:

| timestamp (client) | clip_id | clip_name | text | skipped | received_at (server) | confident | annotator |

Filter `skipped = TRUE` to find unintelligible clips. Multiple people may
annotate the same clip (the "no repeats" tracking is per browser).

**`confident`**: on every submission the script compares the new text against
all earlier non-skipped annotations of the same `clip_id` using word-level WER
(edit distance over the longer annotation, after lowercasing and stripping
punctuation). If any pair agrees with WER &lt; 20%, both rows get
`confident = TRUE`. Filter on it to get your high-agreement transcriptions;
the threshold is `CONFIDENT_WER_THRESHOLD` in `apps_script/Code.gs`.

## Leaderboard

`leaderboard.html` shows a full ranked table of annotators: rank, name, total
annotations, and confident count. It reads live data from the Apps Script
endpoint (`GET ?action=leaderboard`, cached server-side for 60 seconds).

- Ranking: total annotations descending; confident count breaks ties.
- **Skipped submissions don't count** toward totals (so skipping can't inflate
  a rank; skips can never be confident anyway).
- Names are grouped case-insensitively — "Ian" and "ian" are one person; the
  first-seen casing is displayed.
- Rows saved before the annotator feature existed (blank `annotator` column)
  keep their data but don't appear on the leaderboard.

Annotators are asked for their name once per device (stored in localStorage,
changeable via the "change" button in the header); it's attached to every
submission.

### Migrating an existing deployment to the leaderboard version

1. Paste the updated `apps_script/Code.gs` into the Apps Script editor, save.
2. Run `setup()` once — it rewrites only the header row (now 8 columns);
   data rows are untouched. (Or type `annotator` into cell H1 yourself.)
3. **Deploy → Manage deployments → pencil → Version: New version → Deploy.**
   Without this the `/exec` URL keeps serving the old code. The URL itself
   (and `SHEETS_ENDPOINT` in `config.js`) does not change.
4. Commit and push the static files.

## Notes & limits

- **"No repeats" is per device.** It lives in localStorage; clearing browser
  data resets it. There are no user accounts by design.
- **Drive quotas.** Fine for hundreds of short clips with modest traffic; if
  you ever scale to heavy traffic, move the audio to a real bucket
  (Cloudflare R2 / S3) — only `audioUrl()` in `app.js` needs to change.
- **Spam.** The endpoint is public (that's what makes it work without
  logins). The Apps Script rejects malformed payloads, but a determined
  troll could still post junk rows — acceptable for a small trusted-ish
  audience; add a shared passcode to the payload if it becomes a problem.
