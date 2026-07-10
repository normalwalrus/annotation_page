#!/usr/bin/env node
/**
 * Syncs audio clips from a Google Drive folder into ./audio/ and regenerates
 * manifest.json with local paths. The published site serves the audio itself,
 * so no Drive API key ever reaches the browser.
 *
 * Each clip is transcoded to mono 48 kbps MP3 with ffmpeg — uncompressed
 * WAVs are ~5× bigger than annotators need for speech transcription.
 * audio/.sources.json remembers each source file's Drive size so unchanged
 * clips skip the download + transcode on reruns.
 *
 * Usage (requires ffmpeg on PATH; the GitHub runner has it preinstalled):
 *   node tools/sync_audio.mjs <DRIVE_FOLDER_ID> <API_KEY>
 * or with env vars (used by the GitHub Action):
 *   DRIVE_FOLDER_ID=... DRIVE_API_KEY=... node tools/sync_audio.mjs
 *
 * The folder must be shared as "Anyone with the link — Viewer".
 * Clip ids stay the Drive file ids, so existing sheet rows and per-device
 * done-tracking keep matching after a resync.
 */

import { writeFileSync, mkdirSync, readdirSync, unlinkSync, readFileSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const folderId = process.argv[2] || process.env.DRIVE_FOLDER_ID;
const apiKey = process.argv[3] || process.env.DRIVE_API_KEY;
if (!folderId || !apiKey) {
  console.error("Usage: node tools/sync_audio.mjs <DRIVE_FOLDER_ID> <API_KEY>");
  process.exit(1);
}

try {
  execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
} catch {
  console.error("ffmpeg not found on PATH — it's required to compress clips to MP3.");
  process.exit(1);
}

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const audioDir = join(root, "audio");
mkdirSync(audioDir, { recursive: true });

// Fetch with retry: Drive returns 403/429 when rate-limited on bursts of
// downloads — back off and try again instead of failing the whole sync.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function fetchWithRetry(url, label, tries = 6) {
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(url).catch((e) => ({ ok: false, status: 0, text: async () => String(e) }));
    if (res.ok) return res;
    const retryable = res.status === 0 || res.status === 403 || res.status === 429 || res.status >= 500;
    if (!retryable || attempt >= tries) {
      console.error(`${label}: HTTP ${res.status} after ${attempt} attempt(s): ${(await res.text()).slice(0, 200)}`);
      process.exit(1);
    }
    const wait = Math.min(60000, 1000 * 2 ** attempt) + Math.floor(Math.random() * 1000);
    console.log(`  … ${label}: HTTP ${res.status}, retrying in ${Math.round(wait / 1000)}s (attempt ${attempt}/${tries})`);
    await sleep(wait);
  }
}

// List every audio file in the folder
const clips = [];
let pageToken = "";
do {
  const params = new URLSearchParams({
    q: `'${folderId}' in parents and trashed = false and mimeType contains 'audio/'`,
    fields: "nextPageToken, files(id, name, size)",
    pageSize: "1000",
    key: apiKey,
  });
  if (pageToken) params.set("pageToken", pageToken);
  const res = await fetchWithRetry(`https://www.googleapis.com/drive/v3/files?${params}`, "list folder");
  const data = await res.json();
  clips.push(...(data.files ?? []));
  pageToken = data.nextPageToken ?? "";
} while (pageToken);

if (clips.length === 0) {
  console.error(
    "No audio files found. Check the folder ID, that files are audio types,\n" +
    "and that the folder is shared as 'Anyone with the link — Viewer'."
  );
  process.exit(1);
}

// Flatten names so they're safe as repo paths (no subdirs, no weird chars),
// and swap the extension for .mp3 — that's what we publish after transcoding.
const safeName = (name) => name.replace(/[^\w.\- ]+/g, "_");
const mp3Name = (name) => safeName(name).replace(/\.[^.]*$/, "") + ".mp3";

// The transcoded file's size no longer matches Drive's, so .sources.json
// records the source size each MP3 was made from. A matching entry plus an
// existing output means the clip is up to date; reruns and interrupted syncs
// only process what's new.
const SOURCES_FILE = ".sources.json";
const sourcesPath = join(audioDir, SOURCES_FILE);
let sources = {};
try {
  sources = JSON.parse(readFileSync(sourcesPath, "utf8"));
} catch {
  /* first run with no cache — everything gets transcoded */
}

let downloaded = 0;
let skipped = 0;
for (const clip of clips) {
  clip.file = mp3Name(clip.name);
  const dest = join(audioDir, clip.file);
  try {
    if (clip.size && sources[clip.file] === Number(clip.size) && statSync(dest).size > 0) {
      skipped++;
      continue;
    }
  } catch {
    /* not transcoded yet */
  }
  const res = await fetchWithRetry(
    `https://www.googleapis.com/drive/v3/files/${clip.id}?alt=media&key=${apiKey}`,
    `download ${clip.name}`
  );
  const tmp = join(tmpdir(), `sync_${clip.id}_${safeName(clip.name)}`);
  writeFileSync(tmp, Buffer.from(await res.arrayBuffer()));
  try {
    // Mono 48 kbps is transparent for speech and ~5× smaller than WAV.
    execFileSync("ffmpeg", [
      "-y", "-hide_banner", "-loglevel", "error",
      "-i", tmp,
      "-ac", "1", "-b:a", "48k", "-map_metadata", "-1",
      dest,
    ]);
  } finally {
    unlinkSync(tmp);
  }
  sources[clip.file] = Number(clip.size) || 0;
  writeFileSync(sourcesPath, JSON.stringify(sources, null, 2) + "\n"); // resume point for interrupted syncs
  downloaded++;
  console.log(`  ↓ ${clip.file}`);
}
if (skipped) console.log(`  = ${skipped} already up to date, ${downloaded} transcoded`);

// Remove local files that no longer exist in Drive
const wanted = new Set(clips.map((c) => c.file));
for (const existing of readdirSync(audioDir)) {
  if (existing === SOURCES_FILE) continue;
  if (!wanted.has(existing)) {
    unlinkSync(join(audioDir, existing));
    delete sources[existing];
    console.log(`  ✕ removed ${existing} (no longer in Drive)`);
  }
}
for (const cachedName of Object.keys(sources)) {
  if (!wanted.has(cachedName)) delete sources[cachedName];
}
writeFileSync(sourcesPath, JSON.stringify(sources, null, 2) + "\n");

clips.sort((a, b) => a.name.localeCompare(b.name));
const newClips = clips.map((c) => ({ id: c.id, name: c.name, src: `audio/${c.file}` }));

// Keep the old "generated" timestamp when nothing changed, so a no-op sync
// produces no diff (and the GitHub Action makes no commit).
let generated = new Date().toISOString();
try {
  const old = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8"));
  if (JSON.stringify(old.clips) === JSON.stringify(newClips) && old.generated) {
    generated = old.generated;
  }
} catch {
  /* no previous manifest */
}

const manifest = { generated, folder: folderId, clips: newClips };
writeFileSync(join(root, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
console.log(`Synced ${clips.length} clips into audio/ and updated manifest.json`);
