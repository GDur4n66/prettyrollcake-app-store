"use strict";

const $ = (id) => document.getElementById(id);

const PHASES = {
  starting: ["起動中", "busy"],
  "waiting-node": ["ノードの同期待ち", "busy"],
  indexing: ["索引作り中", "busy"],
  ready: ["稼働中", "ok"],
  stopped: ["停止", "down"],
};
const BACKEND = {
  connected: "正常",
  "partly disconnected": "一部切断",
  disconnected: "切断",
};

function fmtInt(n) {
  return n == null ? "—" : Number(n).toLocaleString("ja-JP");
}

function fmtRounded(n) {
  return n == null ? "10 未満" : `約 ${fmtInt(n)}`;
}

function fmtDuration(sec) {
  if (sec == null) return "—";
  const d = Math.floor(sec / 86400), h = Math.floor(sec % 86400 / 3600), m = Math.floor(sec % 3600 / 60);
  if (d) return `${d}日 ${h}時間`;
  if (h) return `${h}時間 ${m}分`;
  return `${m}分`;
}

function setNotice(text, kind) {
  const el = $("notice");
  el.hidden = !text;
  el.textContent = text || "";
  el.className = `notice ${kind || ""}`;
}

function copyButton(text) {
  const b = document.createElement("button");
  b.className = "link";
  b.type = "button";
  b.textContent = "コピー";
  b.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // http pages may not get the clipboard API
      const t = document.createElement("textarea");
      t.value = text;
      document.body.append(t);
      t.select();
      document.execCommand("copy");
      t.remove();
    }
    b.textContent = "コピーしました";
    setTimeout(() => { b.textContent = "コピー"; }, 1500);
  });
  return b;
}

let endpointsKey = "";
function renderEndpoints(s) {
  const hosts = [];
  if (s.host) hosts.push(["Umbrel の名前", s.host]);
  const here = location.hostname;
  if (here && here !== s.host) hosts.push(["この画面のアドレス", here.includes(":") ? `[${here}]` : here]);
  const key = JSON.stringify([hosts, s.electrumPort]);
  if (key === endpointsKey) return;
  endpointsKey = key;
  const dl = $("endpoints");
  dl.replaceChildren();
  for (const [label, host] of hosts) {
    const addr = `${host}:${s.electrumPort}`;
    const dt = document.createElement("dt");
    dt.textContent = label;
    const dd = document.createElement("dd");
    const code = document.createElement("code");
    code.textContent = addr;
    dd.append(code, " ", copyButton(addr));
    dl.append(dt, dd);
  }
}

function renderSync(s) {
  const h = s.info && s.info.health;
  const p = s.progress;
  let height = null, unit = "ブロック", pct = 0, meta = "", label = "索引";

  if (s.phase === "ready" && h && h.indexHeight != null) {
    height = h.indexHeight;
    pct = h.tipHeight ? Math.min(100, 100 * h.indexHeight / h.tipHeight) : 100;
    meta = h.tipHeight == null ? "" : h.indexHeight === h.tipHeight
      ? `ノードの先頭（${fmtInt(h.tipHeight)}）まで索引済みです。`
      : `ノードの先頭は ${fmtInt(h.tipHeight)}。追いついているところです。`;
  } else if (s.phase === "indexing" && p) {
    height = p.height;
    pct = p.percent;
    label = "索引作り";
    meta = `${fmtInt(p.done)} / ${fmtInt(p.total)} ブロック（${p.percent.toFixed(1)}%）。` +
      "初回は Taproot 有効化（709,632）からノードの先頭まで読みます。数時間〜数日かかります。";
  } else if (s.phase === "waiting-node") {
    unit = "";
    meta = "Bitcoin ノードの初回同期が終わるのを待っています。";
  } else if (s.phase === "stopped") {
    unit = "";
    meta = `Frigate が止まりました（終了コード ${s.exitCode}）。下のログを見てください。`;
  } else {
    unit = "";
    meta = p ? "索引を読み終えました。サーバを開いています。" : "Frigate を起動しています。";
  }
  $("syncLabel").textContent = label;
  $("height").textContent = height == null ? "—" : fmtInt(height);
  $("heightUnit").textContent = height == null ? "" : unit;
  $("bar").style.width = `${pct}%`;
  $("syncMeta").textContent = meta;
}

function render(s) {
  const [stateText, stateKind] = PHASES[s.phase] || [s.phase, ""];
  $("state").textContent = stateText;
  $("state").className = `state ${stateKind}`;
  $("version").textContent = s.version ? `v${s.version}` : "";
  $("network").textContent = s.networkLabel;
  $("compute").textContent = s.compute || "—";
  $("uptime").textContent = fmtDuration(s.info ? s.info.uptimeSeconds : Date.now() / 1000 - s.startedAt);

  const info = s.info;
  const h = info && info.health;
  $("backend").textContent = h && h.backend ? (BACKEND[h.backend] || h.backend) : "—";
  const u = info && info.usage;
  $("sessions").textContent = u ? fmtRounded(u.sessions) : "—";
  $("ips").textContent = u ? fmtRounded(u.ips) : "—";
  $("subs").textContent = u ? fmtRounded(u.scriptHashSubscriptions) : "—";
  $("spSubs").textContent = u ? fmtRounded(u.silentPaymentsSubscriptions) : "—";
  $("mempool").textContent = h && h.mempoolSize != null ? `${fmtInt(h.mempoolSize)} 件` : "—";

  renderEndpoints(s);
  renderSync(s);

  if (s.infoError) setNotice(`状態を読めませんでした: ${s.infoError}`, "warn");
  else setNotice("");

  const pre = $("log");
  const atBottom = pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 8;
  pre.textContent = s.log.length ? s.log.join("\n") : "（まだ出力はありません）";
  if (atBottom) pre.scrollTop = pre.scrollHeight;
}

async function refresh() {
  try {
    const res = await fetch("api/status", { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    render(await res.json());
  } catch (e) {
    $("state").textContent = "応答なし";
    $("state").className = "state down";
    setNotice(`画面のサーバに届きません: ${e.message}`, "warn");
  }
}

refresh();
setInterval(refresh, 5000);
