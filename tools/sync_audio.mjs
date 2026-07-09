#!/usr/bin/env node
/**
 * Syncs audio clips from a Google Drive folder into ./audio/ and regenerates
 * manifest.json with local paths. The published site serves the audio itself,
 * so no Drive API key ever reaches the browser.
 *
 * Usage:
 *   node tools/sync_audio.mjs <DRIVE_FOLDER_ID> <API_KEY>
 * or with env vars (used by the GitHub Action):
 *   DRIVE_FOLDER_ID=... DRIVE_API_KEY=... node tools/sync_audio.mjs
 *
 * The folder must be shared as "Anyone with the link — Viewer".
 * Clip ids stay the Drive file ids, so existing sheet rows and per-device
 * done-tracking keep matching after a resync.
 */

import { writeFileSync, mkdirSync, readdirSync, unlinkSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const folderId = process.argv[2] || process.env.DRIVE_FOLDER_ID;
const apiKey = process.argv[3] || process.env.DRIVE_API_KEY;
if (!folderId || !apiKey) {
  console.error("Usage: node tools/sync_audio.mjs <DRIVE_FOLDER_ID> <API_KEY>");
  process.exit(1);
}

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const audioDir = join(root, "audio");
mkdirSync(audioDir, { recursive: true });

// List every audio file in the folder
const clips = [];
let pageToken = "";
do {
  const params = new URLSearchParams({
    q: `'${folderId}' in parents and trashed = false and mimeType contains 'audio/'`,
    fields: "nextPageToken, files(id, name)",
    pageSize: "1000",
    key: apiKey,
  });
  if (pageToken) params.set("pageToken", pageToken);
  const res = await fetch(`https://www.googleapis.com/drive/v3/files?${params}`);
  if (!res.ok) {
    console.error(`Drive API error ${res.status}: ${await res.text()}`);
    process.exit(1);
  }
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

// Flatten names so they're safe as repo paths (no subdirs, no weird chars)
const safeName = (name) => name.replace(/[^\w.\- ]+/g, "_");

// Download each clip
for (const clip of clips) {
  clip.file = safeName(clip.name);
  const res = await fetch(
    `https://www.googleapis.com/drive/v3/files/${clip.id}?alt=media&key=${apiKey}`
  );
  if (!res.ok) {
    console.error(`Download failed for ${clip.name}: HTTP ${res.status}`);
    process.exit(1);
  }
  writeFileSync(join(audioDir, clip.file), Buffer.from(await res.arrayBuffer()));
  console.log(`  ↓ ${clip.file}`);
}

// Remove local files that no longer exist in Drive
const wanted = new Set(clips.map((c) => c.file));
for (const existing of readdirSync(audioDir)) {
  if (!wanted.has(existing)) {
    unlinkSync(join(audioDir, existing));
    console.log(`  ✕ removed ${existing} (no longer in Drive)`);
  }
}

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
