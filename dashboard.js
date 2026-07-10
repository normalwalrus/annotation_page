(() => {
  "use strict";

  const cfg = window.APP_CONFIG || {};
  const NAME_KEY = "annotator_name_v1"; // must match app.js
  const $ = (id) => document.getElementById(id);
  const SVG_NS = "http://www.w3.org/2000/svg";

  // Chart palette — validated against the fixed-dark LCD surface (#14171b):
  // amber marks 8.9:1, axis text 8.8:1 (see style.css tokens).
  const AMBER = "#f5a623";
  const GRID = "rgba(255, 255, 255, 0.07)";
  const AXIS_TEXT = "#aeb6be";
  const LABEL_TEXT = "#cfd6dd";

  let stats = null;
  let manifest = null;

  const STATES = ["dash-loading", "dash-error", "dash-content"];
  const showState = (id) => STATES.forEach((s) => $(s).classList.toggle("hidden", s !== id));
  const fail = (msg) => {
    $("dash-error-message").textContent = msg;
    showState("dash-error");
  };

  const fmt = (n) => (n >= 10000 ? `${(n / 1000).toFixed(1)}K` : n.toLocaleString());

  async function load() {
    showState("dash-loading");
    if (!cfg.SHEETS_ENDPOINT || cfg.SHEETS_ENDPOINT.startsWith("PASTE_")) {
      return fail("Setup incomplete: SHEETS_ENDPOINT is not set in config.js.");
    }
    try {
      const [mRes, sRes] = await Promise.all([
        fetch("manifest.json", { cache: "no-store" }),
        fetch(`${cfg.SHEETS_ENDPOINT}?action=stats`, { cache: "no-store" }),
      ]);
      if (!mRes.ok) throw new Error(`clip list HTTP ${mRes.status}`);
      if (!sRes.ok) throw new Error(`stats HTTP ${sRes.status}`);
      manifest = await mRes.json();
      stats = await sRes.json();
      if (stats.status !== "ok") throw new Error(stats.message || "endpoint error");
      if (!stats.totals) {
        throw new Error(
          "the stats endpoint isn't live yet — redeploy the Apps Script (Deploy → Manage deployments → Edit → New version)"
        );
      }
      render();
    } catch (e) {
      fail(`The dashboard didn't load (${e.message}).`);
    }
  }

  function render() {
    const clips = manifest.clips || [];
    const agg = stats.clips || {};
    let transcribed = 0;
    let confident = 0;
    for (const c of clips) {
      const a = agg[c.id];
      if (a && a[0] > 0) transcribed++;
      if (a && a[1] > 0) confident++;
    }

    setGauge("gauge-transcribed", transcribed, clips.length);
    setGauge("gauge-confident", confident, clips.length);

    $("kpi-clips").textContent = fmt(clips.length);
    $("kpi-transcriptions").textContent = fmt(stats.totals.transcriptions);
    $("kpi-skips").textContent = fmt(stats.totals.skips);
    $("kpi-annotators").textContent = fmt((stats.leaderboard || []).length);

    $("dash-updated").textContent = stats.generated_at
      ? `UPDATED ${new Date(stats.generated_at).toLocaleString()} · refreshes at most once a minute`
      : "";

    renderChart();
    renderActivityTable();
    renderLeaderboard();
    showState("dash-content");
  }

  function setGauge(id, value, total) {
    const gauge = $(id);
    const pct = total ? (value / total) * 100 : 0;
    gauge.querySelector(".gauge-fill").style.width = `${pct}%`;
    gauge.querySelector(".gauge-value").textContent =
      `${Math.round(pct)}% · ${fmt(value)}/${fmt(total)}`;
    gauge.setAttribute("role", "meter");
    gauge.setAttribute("aria-valuemin", "0");
    gauge.setAttribute("aria-valuemax", String(total));
    gauge.setAttribute("aria-valuenow", String(value));
  }

  // ── Activity series ────────────────────────────────────────────────────────
  const DAY_MS = 86400000;
  const dayKey = (d) => d.toISOString().slice(0, 10);
  const shortDate = (key) => {
    const d = new Date(`${key}T00:00:00Z`);
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" });
  };

  // Every day from the first submission through today (UTC), zero-filled —
  // skipping empty days would misstate the timeline. Past ~16 weeks the bars
  // get too thin to read, so the series folds into per-week buckets.
  function buildSeries() {
    const perDay = stats.per_day || {};
    const keys = Object.keys(perDay).sort();
    if (keys.length === 0) return { points: [], weekly: false };
    const start = new Date(`${keys[0]}T00:00:00Z`);
    const end = new Date(`${dayKey(new Date())}T00:00:00Z`);
    const days = [];
    for (let t = start.getTime(); t <= end.getTime(); t += DAY_MS) {
      const key = dayKey(new Date(t));
      days.push({ key, label: shortDate(key), count: perDay[key] || 0 });
    }
    if (days.length <= 112) return { points: days, weekly: false };
    const weeks = [];
    for (let i = 0; i < days.length; i += 7) {
      const chunk = days.slice(i, i + 7);
      weeks.push({
        key: chunk[0].key,
        label: `wk of ${chunk[0].label}`,
        count: chunk.reduce((sum, d) => sum + d.count, 0),
      });
    }
    return { points: weeks, weekly: true };
  }

  function tickStep(maxValue) {
    const raw = Math.max(1, maxValue / 4);
    const power = 10 ** Math.floor(Math.log10(raw));
    for (const mult of [1, 2, 5, 10]) {
      if (mult * power >= raw) return mult * power;
    }
  }

  const svgEl = (tag, attrs) => {
    const el = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
    return el;
  };

  // Bar with a 4px-rounded data end and a square baseline.
  function barPath(x, y, w, h) {
    const r = Math.min(4, h, w / 2);
    return `M${x},${y + h} V${y + r} Q${x},${y} ${x + r},${y} H${x + w - r} Q${x + w},${y} ${x + w},${y + r} V${y + h} Z`;
  }

  function renderChart() {
    const host = $("activity-chart");
    host.textContent = "";
    const { points, weekly } = buildSeries();
    $("activity-title").textContent = weekly
      ? "Activity — submissions per week"
      : "Activity — submissions per day";
    if (points.length === 0) {
      const empty = document.createElement("p");
      empty.className = "chart-empty";
      empty.textContent = "NO SIGNAL — no submissions yet.";
      host.appendChild(empty);
      return;
    }

    const W = Math.max(280, host.clientWidth || 560);
    const H = 180;
    const pad = { left: 34, right: 10, top: 20, bottom: 24 };
    const plotW = W - pad.left - pad.right;
    const plotH = H - pad.top - pad.bottom;
    const maxCount = Math.max(1, ...points.map((p) => p.count));
    const step = tickStep(maxCount);
    const yMax = Math.ceil(maxCount / step) * step;
    const y = (v) => pad.top + plotH - (v / yMax) * plotH;

    const svg = svgEl("svg", {
      width: W,
      height: H,
      viewBox: `0 0 ${W} ${H}`,
      role: "img",
      "aria-label": `Submissions per ${weekly ? "week" : "day"}, ${points[0].label} to ${points[points.length - 1].label}. Peak ${maxCount}. Full values in the table below.`,
    });

    // Gridlines + y ticks: hairline, recessive; clean numbers.
    for (let v = 0; v <= yMax; v += step) {
      svg.appendChild(
        svgEl("line", { x1: pad.left, x2: W - pad.right, y1: y(v), y2: y(v), stroke: GRID, "stroke-width": 1 })
      );
      const tick = svgEl("text", {
        x: pad.left - 6, y: y(v) + 3, "text-anchor": "end",
        fill: AXIS_TEXT, "font-size": 10, "font-family": "IBM Plex Mono, monospace",
      });
      tick.textContent = v.toLocaleString();
      svg.appendChild(tick);
    }

    const slot = plotW / points.length;
    const barW = Math.min(24, Math.max(2, slot - 2)); // ≤24px thick, ≥2px surface gap
    const peak = points.reduce((best, p, i) => (p.count > points[best].count ? i : best), 0);

    // Sparse x labels — roughly six across the range.
    const labelEvery = Math.max(1, Math.ceil(points.length / 6));
    points.forEach((p, i) => {
      const cx = pad.left + i * slot + slot / 2;
      if (p.count > 0) {
        svg.appendChild(
          svgEl("path", { d: barPath(cx - barW / 2, y(p.count), barW, y(0) - y(p.count)), fill: AMBER })
        );
      }
      if (i % labelEvery === 0) {
        const xl = svgEl("text", {
          x: cx, y: H - 8, "text-anchor": "middle",
          fill: AXIS_TEXT, "font-size": 10, "font-family": "IBM Plex Mono, monospace",
        });
        xl.textContent = p.label;
        svg.appendChild(xl);
      }
    });

    // Selective direct label: the peak only; the tooltip and table carry the rest.
    if (points[peak].count > 0) {
      const lx = pad.left + peak * slot + slot / 2;
      const peakLabel = svgEl("text", {
        x: Math.min(Math.max(lx, pad.left + 8), W - pad.right - 8),
        y: y(points[peak].count) - 5, "text-anchor": "middle",
        fill: LABEL_TEXT, "font-size": 11, "font-weight": 600, "font-family": "IBM Plex Mono, monospace",
      });
      peakLabel.textContent = points[peak].count.toLocaleString();
      svg.appendChild(peakLabel);
    }

    // Hover layer: full-height hit column per point (bigger than the mark).
    const tooltip = document.createElement("div");
    tooltip.className = "chart-tooltip hidden";
    points.forEach((p, i) => {
      const hit = svgEl("rect", {
        x: pad.left + i * slot, y: pad.top, width: slot, height: plotH,
        fill: "transparent",
      });
      hit.addEventListener("mouseenter", () => {
        tooltip.textContent = `${p.label} · ${p.count.toLocaleString()} submission${p.count === 1 ? "" : "s"}`;
        tooltip.classList.remove("hidden");
        const cx = pad.left + i * slot + slot / 2;
        tooltip.style.left = `${cx}px`;
        tooltip.style.top = `${y(p.count) - 8}px`;
      });
      hit.addEventListener("mouseleave", () => tooltip.classList.add("hidden"));
      svg.appendChild(hit);
    });

    host.appendChild(svg);
    host.appendChild(tooltip);
  }

  function renderActivityTable() {
    const body = $("activity-table-body");
    body.textContent = "";
    const perDay = stats.per_day || {};
    for (const key of Object.keys(perDay).sort()) {
      const tr = document.createElement("tr");
      for (const v of [shortDate(key), perDay[key].toLocaleString()]) {
        const td = document.createElement("td");
        td.textContent = v;
        tr.appendChild(td);
      }
      body.appendChild(tr);
    }
  }

  function renderLeaderboard() {
    const rows = stats.leaderboard || [];
    $("lb-empty").classList.toggle("hidden", rows.length > 0);
    $("lb-table").classList.toggle("hidden", rows.length === 0);
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
  }

  let resizeRaf = null;
  window.addEventListener("resize", () => {
    if (!stats || resizeRaf) return;
    resizeRaf = requestAnimationFrame(() => {
      resizeRaf = null;
      renderChart();
    });
  });

  $("highlight-input").value = localStorage.getItem(NAME_KEY) || "";
  $("highlight-input").addEventListener("input", () => stats && renderLeaderboard());
  $("refresh-btn").addEventListener("click", load);
  $("dash-retry-btn").addEventListener("click", load);
  load();
})();
