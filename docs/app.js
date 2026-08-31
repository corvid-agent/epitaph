/* EPITAPH — dead-man's switch board. Reads the app's global state from the
   TestNet indexer once appId > 0 in deploy.json. Live first; on feed failure
   falls back to the last good snapshot (STALE) rather than guessing.
   TestNet only. Read-only. No wallet. No keys. */
(() => {
  const INDEXER = "https://testnet-idx.algonode.cloud";
  const ALGOD = "https://testnet-api.algonode.cloud";
  const EXPLORER = "https://testnet.explorer.perawallet.app/application/";
  const CONTRACT_SRC =
    "https://github.com/corvid-agent/epitaph/blob/main/smart_contracts/epitaph/contract.py";
  const DEFAULT_KEEPER = 769891898;
  const ROUND_SEC = 2.8;
  const REFRESH_MS = 30000;
  const SNAPSHOT_KEY = "epitaph:snapshot";

  function b64utf8(b64) {
    try { return atob(b64); } catch { return ""; }
  }

  function b64ToHex(b64) {
    try {
      const bin = atob(b64);
      let hex = "";
      for (let i = 0; i < bin.length; i++) {
        hex += bin.charCodeAt(i).toString(16).padStart(2, "0");
      }
      return hex;
    } catch {
      return "";
    }
  }

  function readGlobal(state, name) {
    if (!Array.isArray(state)) return null;
    for (const kv of state) {
      if (b64utf8(kv.key) !== name) continue;
      if (kv.value && kv.value.type === 2) return { kind: "uint", v: kv.value.uint };
      if (kv.value && kv.value.type === 1) return { kind: "bytes", v: kv.value.bytes };
      return null;
    }
    return null;
  }

  async function fetchJson(url, noStore) {
    const opts = { headers: { Accept: "application/json" } };
    if (noStore) opts.cache = "no-store";
    const res = await fetch(url, opts);
    if (!res.ok) throw new Error(url + " " + res.status);
    return res.json();
  }

  function flaps(el, text) {
    el.replaceChildren();
    for (const ch of String(text)) {
      const d = document.createElement("span");
      d.className = "flap" + (ch === " " ? " blank" : "");
      d.textContent = ch === " " ? " " : ch;
      el.appendChild(d);
    }
  }

  function setStatus(word, cls, subHtml) {
    const el = document.getElementById("status");
    el.className = "flaps big " + cls;
    flaps(el, word.toUpperCase());
    document.getElementById("subhead").innerHTML = subHtml;
    document.title = "EPITAPH — " + word.toUpperCase();
  }

  const STAT_IDS = [
    "stat-expiry", "stat-left", "stat-checkin", "stat-timeout",
    "stat-commit", "stat-revealed", "stat-round", "stat-keeper",
  ];

  function fillStats(map) {
    for (const id of STAT_IDS) {
      flaps(document.getElementById(id), map[id] || "—");
    }
  }

  function spanLabel(rounds) {
    const sec = Math.abs(rounds) * ROUND_SEC;
    if (sec < 90) return rounds + "r";
    if (sec < 3600) return "~" + Math.round(sec / 60) + "m";
    if (sec < 86400) return "~" + (sec / 3600).toFixed(1) + "h";
    return "~" + (sec / 86400).toFixed(1) + "d";
  }

  function shortHex(hex) {
    if (!hex) return "—";
    return hex.length > 18 ? hex.slice(0, 8) + "…" + hex.slice(-8) : hex;
  }

  function saveSnapshot(snap) {
    try {
      localStorage.setItem(SNAPSHOT_KEY, JSON.stringify(snap));
    } catch { /* storage unavailable; live-only then */ }
  }

  function loadSnapshot() {
    try {
      const raw = localStorage.getItem(SNAPSHOT_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }

  function renderSnapshot(snap) {
    const ageMin = Math.max(0, Math.round((Date.now() - snap.ts) / 60000));
    setStatus("STALE", "gate",
      "feed unreachable · last good read " + ageMin + " min ago: " +
      snap.word + (snap.subText ? " · " + snap.subText : ""));
    fillStats(snap.stats || {});
  }

  let cfgPromise = null;
  function loadConfig() {
    if (!cfgPromise) {
      cfgPromise = fetchJson("./deploy.json", true).then((c) => ({
        appId: Number(c.appId) || 0,
        keeper: Number(c.keeperAppId) || DEFAULT_KEEPER,
        network: c.network || "testnet",
        notes: c.notes || "",
      }));
    }
    return cfgPromise;
  }

  async function tick() {
    let cfg;
    try {
      cfg = await loadConfig();
    } catch (e) {
      setStatus("FEED DOWN", "down",
        "deploy.json unreadable · showing nothing rather than guessing");
      fillStats({});
      return;
    }
    document.getElementById("keeper-meta").textContent =
      cfg.network + " · Arcron keeper " + cfg.keeper;

    if (cfg.appId <= 0) {
      setStatus("NOT DEPLOYED", "gate",
        'contract exists as <a href="' + CONTRACT_SRC + '">source</a> only' +
        " · lights up after TestNet deploy + set_keeper + arm + Arcron registration");
      fillStats({ "stat-keeper": String(cfg.keeper) });
      return;
    }

    let round, gs;
    try {
      const status = await fetchJson(ALGOD + "/v2/status");
      round = status["last-round"];
      const app = await fetchJson(INDEXER + "/v2/applications/" + cfg.appId);
      const params = (app.application && app.application.params) || app.params || {};
      gs = params["global-state"];
    } catch (e) {
      const snap = loadSnapshot();
      if (snap && snap.appId === cfg.appId) {
        renderSnapshot(snap);
      } else {
        setStatus("FEED DOWN", "down",
          "indexer unreachable · no prior snapshot · showing nothing rather than guessing");
        fillStats({ "stat-keeper": String(cfg.keeper) });
      }
      return;
    }

    const keeperApp = readGlobal(gs, "keeper_app");
    const lastCheckin = readGlobal(gs, "last_checkin_round");
    const timeout = readGlobal(gs, "timeout_rounds");
    const published = readGlobal(gs, "published");
    const revealed = readGlobal(gs, "revealed_round");
    const commitment = readGlobal(gs, "commitment");

    const nTimeout = timeout && timeout.kind === "uint" ? timeout.v : 0;
    const nCheckin = lastCheckin && lastCheckin.kind === "uint" ? lastCheckin.v : 0;
    const nPublished = published && published.kind === "uint" ? published.v : 0;
    const nRevealed = revealed && revealed.kind === "uint" ? revealed.v : 0;
    const commitHex = commitment && commitment.kind === "bytes"
      ? b64ToHex(commitment.v) : "";
    const expiry = nCheckin + nTimeout;
    const left = nTimeout > 0 ? Math.max(0, expiry - round) : 0;

    const stats = {
      "stat-expiry": nTimeout > 0 ? String(expiry) : "—",
      "stat-left": nTimeout > 0 ? String(left) + " (" + spanLabel(left) + ")" : "—",
      "stat-checkin": nCheckin > 0 ? String(nCheckin) : "—",
      "stat-timeout": nTimeout > 0 ? String(nTimeout) : "—",
      "stat-commit": commitHex ? shortHex(commitHex) : "—",
      "stat-revealed": nRevealed > 0 ? String(nRevealed) : "—",
      "stat-round": String(round),
      "stat-keeper": keeperApp ? String(keeperApp.v) : "—",
    };
    fillStats(stats);

    const appLink = 'app <a href="' + EXPLORER + cfg.appId + '">' + cfg.appId + "</a>";
    let word, cls, subText;
    if (!keeperApp || keeperApp.v === 0) {
      word = "NO KEEPER"; cls = "gate";
      subText = appLink + " is live but set_keeper has not run yet";
    } else if (nPublished === 1) {
      word = "PUBLISHED"; cls = "spoken";
      subText = appLink + " spoke at round " + nRevealed +
        " · the commitment in state verifies the farewell";
    } else if (nTimeout === 0) {
      word = "NOT ARMED"; cls = "gate";
      subText = appLink + " keeper wired · owner has not armed the switch yet";
    } else if (round >= expiry) {
      word = "EXPIRED"; cls = "down";
      subText = appLink + " silent since round " + nCheckin +
        " · " + spanLabel(round - expiry) + " past the deadline" +
        " · the next keeper call publishes";
    } else {
      word = "ARMED"; cls = "live";
      subText = appLink + " expires at round " + expiry +
        " · " + spanLabel(left) + " of silence left";
    }
    setStatus(word, cls, subText);

    saveSnapshot({
      appId: cfg.appId,
      ts: Date.now(),
      word: word,
      subText: subText.replace(/<[^>]*>/g, ""),
      stats: stats,
    });
  }

  tick();
  setInterval(tick, REFRESH_MS);
})();
