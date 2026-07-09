#!/usr/bin/env node
/**
 * Regenerates manifest.json from a public Google Drive folder.
 *
 * Usage:
 *   node tools/generate_manifest.mjs <DRIVE_FOLDER_ID> <API_KEY>
 *
 * The folder must be shared as "Anyone with the link — Viewer".
 * Lists every audio file in the folder (recursion into subfolders not included).
 * Run this whenever you add/remove clips, then commit manifest.json.
 */

import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const [folderId, apiKey] = process.argv.slice(2);
if (!folderId || !apiKey) {
  console.error("Usage: node tools/generate_manifest.mjs <DRIVE_FOLDER_ID> <API_KEY>");
  process.exit(1);
}

const clips = [];
let pageToken = "";

do {
  const params = new URLSearchParams({
    q: `'${folderId}' in parents and trashed = false and mimeType contains 'audio/'`,
    fields: "nextPageToken, files(id, name, mimeType)",
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
  for (const f of data.files ?? []) {
    clips.push({ id: f.id, name: f.name });
  }
  pageToken = data.nextPageToken ?? "";
} while (pageToken);

if (clips.length === 0) {
  console.error(
    "No audio files found. Check the folder ID, that files are audio types (mp3/wav/etc.),\n" +
    "and that the folder is shared as 'Anyone with the link — Viewer'."
  );
  process.exit(1);
}

clips.sort((a, b) => a.name.localeCompare(b.name));

const manifest = {
  generated: new Date().toISOString(),
  folder: folderId,
  clips,
};

const out = join(dirname(fileURLToPath(import.meta.url)), "..", "manifest.json");
writeFileSync(out, JSON.stringify(manifest, null, 2) + "\n");
console.log(`Wrote ${clips.length} clips to ${out}`);
