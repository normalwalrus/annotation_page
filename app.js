(() => {
  "use strict";

  const cfg = window.APP_CONFIG || {};
  const DONE_KEY = "annotation_done_v1"; // clip ids this browser has finished (saved or skipped)
  const NAME_KEY = "annotator_name_v1";
  const WAVE_BUCKETS = 220;
  const AMBER = "#f5a623";
  const AMBER_DIM = "#4a4336";

  // ── DOM ────────────────────────────────────────────────────────────────────
  const $ = (id) => document.getElementById(id);
  const els = {
    loading: $("loading"),
    error: $("error"),
    errorMessage: $("error-message"),
    retryBtn: $("retry-btn"),
    done: $("done"),
    annotator: $("annotator"),
    nameGate: $("name-gate"),
    nameForm: $("name-form"),
    nameInput: $("name-input"),
    nameChip: $("name-chip"),
    nameChipValue: $("name-chip-value"),
    changeNameBtn: $("change-name-btn"),
    clipName: $("clip-name"),
    playBtn: $("play-btn"),
    wave: $("waveform"),
    lcdStatus: $("lcd-status"),
    time: $("time"),
    speed: $("speed"),
    loop: $("loop"),
    text: $("transcription"),
    skipBtn: $("skip-btn"),
    submitBtn: $("submit-btn"),
    hint: $("hint"),
    toast: $("toast"),
    sessionCount: $("session-count"),
  };

  // ── State ──────────────────────────────────────────────────────────────────
  let clips = [];
  let current = null;
  let hasPlayed = false;
  let sessionCount = 0;
  let submitting = false;
  let peaks = flatPeaks();
  let objectUrl = null;
  let aborter = null;
  let rafId = null;
  const audio = new Audio();
  audio.preload = "auto";

  // ── Helpers ────────────────────────────────────────────────────────────────
  const loadDone = () => {
    try {
      return new Set(JSON.parse(localStorage.getItem(DONE_KEY) || "[]"));
    } catch {
      return new Set();
    }
  };
  const saveDone = (set) => localStorage.setItem(DONE_KEY, JSON.stringify([...set]));

  const getName = () => (localStorage.getItem(NAME_KEY) || "").trim();
  const setName = (name) => localStorage.setItem(NAME_KEY, name);
  const refreshNameChip = () => {
    const name = getName();
    els.nameChipValue.textContent = name;
    els.nameChip.classList.toggle("hidden", !name);
  };

  const audioUrl = (clip) => encodeURI(clip.src || `audio/${clip.name}`);

  const fmtTime = (s) => {
    if (!isFinite(s)) return "0:00";
    const m = Math.floor(s / 60);
    return `${m}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
  };

  const show = (section) => {
    for (const s of [els.loading, els.error, els.done, els.nameGate, els.annotator]) {
      s.classList.toggle("hidden", s !== section);
    }
  };

  let toastTimer;
  const toast = (msg, isError = false) => {
    els.toast.textContent = msg;
    els.toast.classList.toggle("error", isError);
    els.toast.classList.remove("hidden");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => els.toast.classList.add("hidden"), 2500);
  };

  const fail = (msg) => {
    els.errorMessage.textContent = msg;
    show(els.error);
  };

  // ── Waveform ───────────────────────────────────────────────────────────────
  function flatPeaks() {
    return new Array(WAVE_BUCKETS).fill(0.12);
  }

  function computePeaks(buffer) {
    const ch = buffer.getChannelData(0);
    const step = Math.max(1, Math.floor(ch.length / WAVE_BUCKETS));
    const out = [];
    for (let i = 0; i < WAVE_BUCKETS; i++) {
      let max = 0;
      const start = i * step;
      const end = Math.min(start + step, ch.length);
      for (let j = start; j < end; j += 8) {
        const v = Math.abs(ch[j]);
        if (v > max) max = v;
      }
      out.push(max);
    }
    const top = Math.max(0.01, ...out);
    return out.map((v) => Math.max(0.06, v / top));
  }

  function sizeCanvas() {
    const dpr = window.devicePixelRatio || 1;
    els.wave.width = els.wave.clientWidth * dpr;
    els.wave.height = els.wave.clientHeight * dpr;
  }

  function drawWave() {
    const ctx = els.wave.getContext("2d");
    const w = els.wave.width;
    const h = els.wave.height;
    ctx.clearRect(0, 0, w, h);
    const progress = audio.duration ? audio.currentTime / audio.duration : 0;
    const n = peaks.length;
    const slot = w / n;
    const barW = Math.max(1, slot * 0.65);
    for (let i = 0; i < n; i++) {
      const bh = Math.max(2, peaks[i] * h * 0.92);
      ctx.fillStyle = (i + 0.5) / n <= progress ? AMBER : AMBER_DIM;
      ctx.fillRect(i * slot + (slot - barW) / 2, (h - bh) / 2, barW, bh);
    }
  }

  function animate() {
    drawWave();
    rafId = audio.paused ? null : requestAnimationFrame(animate);
  }

  function seekFromEvent(e) {
    if (!audio.duration) return;
    const rect = els.wave.getBoundingClientRect();
    const x = Math.min(Math.max(e.clientX - rect.left, 0), rect.width);
    audio.currentTime = (x / rect.width) * audio.duration;
    drawWave();
  }

  let scrubbing = false;
  els.wave.addEventListener("pointerdown", (e) => {
    scrubbing = true;
    els.wave.setPointerCapture(e.pointerId);
    seekFromEvent(e);
  });
  els.wave.addEventListener("pointermove", (e) => scrubbing && seekFromEvent(e));
  els.wave.addEventListener("pointerup", () => (scrubbing = false));
  window.addEventListener("resize", () => {
    sizeCanvas();
    drawWave();
  });

  // ── Clip loading ───────────────────────────────────────────────────────────
  async function init() {
    show(els.loading);
    if (!cfg.SHEETS_ENDPOINT || cfg.SHEETS_ENDPOINT.startsWith("PASTE_")) {
      return fail("Setup incomplete: SHEETS_ENDPOINT is not set in config.js.");
    }
    if (!getName()) {
      show(els.nameGate);
      els.nameInput.value = "";
      els.nameInput.focus();
      return;
    }
    refreshNameChip();
    try {
      const res = await fetch("manifest.json", { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const manifest = await res.json();
      clips = manifest.clips || [];
    } catch (e) {
      return fail(`The clip list didn't load (${e.message}). Check your connection and try again.`);
    }
    if (clips.length === 0) {
      return fail("The clip list is empty. Run tools/generate_manifest.mjs and commit the result.");
    }
    nextClip();
  }

  async function loadAudio(clip) {
    if (aborter) aborter.abort();
    aborter = new AbortController();
    peaks = flatPeaks();
    drawWave();
    try {
      const res = await fetch(audioUrl(clip), { signal: aborter.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = await res.arrayBuffer();
      if (clip !== current) return; // user already advanced
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      objectUrl = URL.createObjectURL(new Blob([buf]));
      audio.src = objectUrl;
      audio.playbackRate = currentSpeed(); // some browsers reset the rate on a new source
      try {
        const Ctx = window.AudioContext || window.webkitAudioContext;
        const actx = new Ctx();
        const decoded = await actx.decodeAudioData(buf.slice(0));
        actx.close();
        if (clip === current) peaks = computePeaks(decoded);
      } catch {
        /* undecodable in this browser — keep flat bars, playback still works */
      }
    } catch (e) {
      if (e.name === "AbortError") return;
      audio.src = audioUrl(clip); // fall back to plain streaming
      audio.playbackRate = currentSpeed();
    }
    drawWave();
  }

  function nextClip() {
    const done = loadDone();
    const remaining = clips.filter((c) => !done.has(c.id));
    if (remaining.length === 0) {
      show(els.done);
      return;
    }
    current = remaining[Math.floor(Math.random() * remaining.length)];
    hasPlayed = false;
    submitting = false;
    els.text.value = "";
    els.clipName.textContent = `REC ${current.name} · ${remaining.length} left on this device`;
    els.time.textContent = "0:00 / 0:00";
    show(els.annotator);
    sizeCanvas();
    loadAudio(current);
    audio.playbackRate = currentSpeed();
    updateSubmitState();
    els.text.focus();
  }

  function markDone(clipId) {
    const done = loadDone();
    done.add(clipId);
    saveDone(done);
  }

  // ── Player ─────────────────────────────────────────────────────────────────
  function togglePlay() {
    if (!current) return;
    if (audio.paused) {
      audio.play().catch(() => toast("Playback failed — check your connection, then press play again.", true));
    } else {
      audio.pause();
    }
  }

  audio.addEventListener("play", () => {
    hasPlayed = true;
    els.playBtn.classList.add("playing");
    els.playBtn.setAttribute("aria-label", "Pause");
    els.lcdStatus.textContent = "PLAYING";
    els.lcdStatus.classList.add("on");
    if (!rafId) rafId = requestAnimationFrame(animate);
    updateSubmitState();
  });
  audio.addEventListener("pause", () => {
    els.playBtn.classList.remove("playing");
    els.playBtn.setAttribute("aria-label", "Play");
    els.lcdStatus.textContent = "STANDBY";
    els.lcdStatus.classList.remove("on");
  });
  audio.addEventListener("ended", () => {
    if (els.loop.getAttribute("aria-pressed") === "true") {
      audio.currentTime = 0;
      audio.play().catch(() => {});
    }
  });
  audio.addEventListener("timeupdate", () => {
    els.time.textContent = `${fmtTime(audio.currentTime)} / ${fmtTime(audio.duration)}`;
    if (audio.paused) drawWave();
  });
  audio.addEventListener("loadedmetadata", () => {
    els.time.textContent = `0:00 / ${fmtTime(audio.duration)}`;
  });
  audio.addEventListener("error", () => {
    if (current) toast("This clip didn't load. Skip it, or reload the page.", true);
  });

  els.playBtn.addEventListener("click", togglePlay);

  const currentSpeed = () =>
    parseFloat(els.speed.querySelector(".active")?.dataset.speed || "1");

  els.speed.addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-speed]");
    if (!btn) return;
    els.speed.querySelectorAll("button").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    audio.playbackRate = parseFloat(btn.dataset.speed);
  });

  els.loop.addEventListener("click", () => {
    const on = els.loop.getAttribute("aria-pressed") === "true";
    els.loop.setAttribute("aria-pressed", String(!on));
  });

  // ── Saving ─────────────────────────────────────────────────────────────────
  function updateSubmitState() {
    const ok = hasPlayed && els.text.value.trim().length > 0 && !submitting;
    els.submitBtn.disabled = !ok;
    els.hint.textContent = submitting
      ? "Saving…"
      : !hasPlayed
        ? "Play the clip once, then type what you hear."
        : els.text.value.trim().length === 0
          ? "Type the transcript, or choose “Can't make it out”."
          : "Ctrl+Enter saves and loads the next clip.";
  }
  els.text.addEventListener("input", updateSubmitState);

  async function record(skipped) {
    if (!current || submitting) return;
    if (!getName()) {
      // localStorage cleared mid-session — re-gate instead of saving anonymously
      audio.pause();
      init();
      return;
    }
    const text = els.text.value.trim();
    if (!skipped && (!hasPlayed || !text)) return;

    submitting = true;
    els.skipBtn.disabled = true;
    updateSubmitState();

    const payload = {
      timestamp: new Date().toISOString(),
      clip_id: current.id,
      clip_name: current.name,
      text: skipped ? "" : text,
      skipped: skipped,
      annotator: getName(),
    };

    try {
      // Plain-text body keeps this a CORS "simple request", which Apps Script accepts.
      const res = await fetch(cfg.SHEETS_ENDPOINT, {
        method: "POST",
        body: JSON.stringify(payload),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const out = await res.json().catch(() => ({}));
      if (out.status && out.status !== "ok") throw new Error(out.message || "endpoint error");

      audio.pause();
      markDone(current.id);
      sessionCount += 1;
      els.sessionCount.textContent = sessionCount;
      toast(skipped ? "Logged as unclear" : "Saved");
      nextClip();
    } catch (e) {
      toast(`Save failed (${e.message}). Your text is still here — press Save again.`, true);
      submitting = false;
      updateSubmitState();
    } finally {
      els.skipBtn.disabled = false;
    }
  }

  els.submitBtn.addEventListener("click", () => record(false));
  els.skipBtn.addEventListener("click", () => record(true));
  els.retryBtn.addEventListener("click", init);

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

  // ── Keyboard shortcuts (work while typing in the textarea) ─────────────────
  document.addEventListener("keydown", (e) => {
    if (!e.ctrlKey && !e.metaKey) return;
    if (e.code === "Space") {
      e.preventDefault();
      togglePlay();
    } else if (e.key === "Enter") {
      e.preventDefault();
      record(false);
    } else if (e.key === "ArrowLeft") {
      e.preventDefault();
      audio.currentTime = 0;
      if (audio.paused) togglePlay();
    }
  });

  init();
})();
