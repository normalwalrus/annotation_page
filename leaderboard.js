(() => {
  "use strict";
  const cfg = window.APP_CONFIG || {};
  const NAME_KEY = "annotator_name_v1"; // must match app.js
  const $ = (id) => document.getElementById(id);
  let rows = [];

  const STATES = ["lb-loading", "lb-error", "lb-empty", "lb-table"];
  const showState = (id) => STATES.forEach((s) => $(s).classList.toggle("hidden", s !== id));
  const fail = (msg) => {
    $("lb-error-message").textContent = msg;
    showState("lb-error");
  };

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
