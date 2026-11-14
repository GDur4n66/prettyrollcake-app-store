"use strict";

const $ = (id) => document.getElementById(id);
let last = null;
let formDirty = false;
let showPass = false;

function fmtInt(n) {
  return n == null ? "—" : Number(n).toLocaleString("ja-JP");
}

function fmtBytes(b) {
  if (b == null) return "計算中…";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  while (b >= 1000 && i < units.length - 1) { b /= 1000; i++; }
  return `${b.toFixed(i >= 3 ? 1 : 0)} ${units[i]}`;
}

function fmtAge(sec) {
  if (sec < 90) return `${Math.max(0, Math.round(sec))} 秒`;
  if (sec < 5400) return `${Math.round(sec / 60)} 分`;
  if (sec < 86400 * 2) return `${Math.round(sec / 3600)} 時間`;
  if (sec < 86400 * 365) return `${Math.round(sec / 86400)} 日`;
  return `${(sec / 86400 / 365).toFixed(1)} 年`;
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

function render(s) {
  last = s;
  const n = s.node;
  const c = s.connect;
  const netName = (k) => s.networks[k] || k;

  if (n) {
    const age = Date.now() / 1000 - n.bestBlockTime;
    const synced = age < 2 * 3600;
    if (s.busy) {
      $("state").textContent = "応答待ち";
      $("state").className = "state busy";
    } else {
      $("state").textContent = synced ? "同期済み" : "同期中";
      $("state").className = `state ${synced ? "ok" : "busy"}`;
    }
    // btcd reports 0.27.0 as 270000 (major*1000000 + minor*10000 + patch*100)
    const v = Number(n.version);
    $("version").textContent = `v${Math.floor(v / 1e6)}.${Math.floor(v / 1e4) % 100}.${Math.floor(v / 100) % 100}`;
    $("blocks").textContent = fmtInt(n.blocks);
    // btcd has no headers-first sync, so estimate from the block time
    const genesis = { mainnet: 1231006505, testnet3: 1296688602, testnet4: 1714777860, signet: 1598918400 }[n.chain] || 1231006505;
    const now = Date.now() / 1000;
    const pct = synced ? 100 : Math.max(0, Math.min(99.9, (n.bestBlockTime - genesis) / (now - genesis) * 100));
    $("bar").style.width = `${pct}%`;
    $("syncMeta").textContent = `最新ブロックは ${fmtAge(age)}前（${new Date(n.bestBlockTime * 1000).toLocaleString("ja-JP")}）` +
      (synced ? "" : ` ・ 時間で見た進み具合 ${pct.toFixed(1)}%`);
    $("chain").textContent = netName(s.applied?.network || s.settings.network);
    $("peers").textContent = fmtInt(n.peers);
    $("peersSub").textContent = `受信 ${n.inbound} ・ Tor ${n.onionPeers}`;
    $("uptime").textContent = fmtDuration(n.uptime);
  } else {
    $("state").textContent = "停止中";
    $("state").className = "state down";
    $("syncMeta").textContent = s.error || "btcd に接続できません";
  }
  $("size").textContent = fmtBytes(s.dataBytes);

  if (s.busy) {
    const when = s.nodeAt ? `（${new Date(s.nodeAt * 1000).toLocaleTimeString("ja-JP")} 時点の情報を表示中）` : "";
    setNotice(`btcd がブロックの処理中で、応答が遅れています${when}。同期中はよくあることで、止まってはいません。`, "warn");
  } else if (s.pendingRestart) {
    setNotice("保存した設定はまだ反映されていません。「保存して再起動」で反映されます。", "warn");
  } else if (!n && s.error) {
    setNotice(s.error, "");
  } else {
    setNotice("");
  }

  $("rpcAddr").textContent = `${c.host}:${c.rpcPort}`;
  $("rpcUser").textContent = c.rpcUser;
  $("rpcPass").textContent = showPass ? c.rpcPass : "••••••••";
  $("p2pAddr").textContent = `${c.host}:${c.p2pPort}`;
  $("onion").textContent = c.onion ? `${c.onion}:${c.onionPort}` : "まだありません（Tor の初回起動後、アプリの再起動で表示されます）";
  $("internal").textContent = c.internalIp ? `${c.internalIp}:8334（RPC）・ ${c.internalIp}:8333（P2P）` : "—";
  const net = s.applied?.network || s.settings.network;
  const netFlag = { mainnet: "", testnet: " --testnet", testnet4: " --testnet4", signet: " --signet" }[net] || "";
  $("btcctl").textContent = `btcctl${netFlag} --rpcserver=${c.host}:${c.rpcPort} \\\n  --rpcuser=${c.rpcUser} --rpcpass='<パスワード>' \\\n  --rpccert=btcd-rpc.cert getblockchaininfo`;

  if (!formDirty) fillForm(s);
}

function fillForm(s) {
  const sel = $("network");
  if (!sel.options.length) {
    for (const [k, label] of Object.entries(s.networks)) sel.add(new Option(label, k));
    $("utxoCacheMiB").min = s.utxoCacheRange[0];
    $("utxoCacheMiB").max = s.utxoCacheRange[1];
  }
  sel.value = s.settings.network;
  $("utxoCacheMiB").value = s.settings.utxoCacheMiB;
  for (const k of ["torOnly", "txindex", "addrindex"]) $(k).checked = s.settings[k];
  syncIndexBoxes();
}

function syncIndexBoxes() {
  if ($("addrindex").checked) $("txindex").checked = true;
  $("txindex").disabled = $("addrindex").checked;
}

async function refresh() {
  try {
    const r = await fetch("api/status", { cache: "no-store" });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    render(await r.json());
  } catch (e) {
    $("state").textContent = "画面のサーバに接続できません";
    $("state").className = "state down";
  }
}

$("settings").addEventListener("input", () => { formDirty = true; syncIndexBoxes(); });
$("settings").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const settings = {
    network: $("network").value,
    utxoCacheMiB: parseInt($("utxoCacheMiB").value, 10),
    torOnly: $("torOnly").checked,
    txindex: $("txindex").checked,
    addrindex: $("addrindex").checked,
  };
  const changedNet = last && last.applied && settings.network !== last.applied.network;
  if (changedNet && !confirm(`ネットワークを「${last.networks[settings.network]}」に切り替えます。ブロックデータはネットワークごとに別々に保存され、消えません。よろしいですか？`)) return;
  const msg = $("formMsg");
  msg.textContent = "保存中…";
  try {
    const r = await fetch("api/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ settings, restart: true }),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
    msg.textContent = "保存しました。btcd を再起動しています…";
    formDirty = false;
    setTimeout(() => { msg.textContent = ""; }, 8000);
  } catch (e) {
    msg.textContent = e.message;
  }
  refresh();
});

$("showPass").addEventListener("click", () => {
  showPass = !showPass;
  $("showPass").textContent = showPass ? "隠す" : "表示";
  if (last) $("rpcPass").textContent = showPass ? last.connect.rpcPass : "••••••••";
});
$("copyPass").addEventListener("click", async () => {
  if (!last) return;
  try {
    await navigator.clipboard.writeText(last.connect.rpcPass);
    $("copyPass").textContent = "コピーしました";
  } catch {
    $("copyPass").textContent = "コピーできません";
  }
  setTimeout(() => { $("copyPass").textContent = "コピー"; }, 2000);
});

const SERVICE_HELP = {
  NETWORK: "全ブロックを提供",
  NETWORK_LIMITED: "直近のブロックを提供",
  BLOOM: "ブルームフィルタ（BIP37）",
  WITNESS: "SegWit",
  COMPACT_FILTERS: "コンパクトフィルタ（BIP157/158）",
  P2P_V2: "暗号化通信 v2（BIP324）",
};
const REACH_LABELS = [
  ["ipv4", "IPv4"], ["ipv6", "IPv6"], ["onion", "Tor"],
  ["not_publicly_routable", "Umbrel・LAN"], ["other", "その他"],
];

function escHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

function renderSelf(m) {
  $("selfAgent").textContent = m.userAgent;
  $("selfProto").textContent = m.protocolVersion ? `プロトコル ${m.protocolVersion}` : "";
  $("selfFlags").innerHTML = m.flags.map((f) =>
    `<span class="flag" title="${escHtml(SERVICE_HELP[f.name] || f.name)}">${escHtml(f.name)}</span>`).join("") || "なし";
  $("selfServices").textContent = `値 ${m.services}（0x${m.services.toString(16).padStart(3, "0")}）`;

  if (m.inbound) {
    const total = Object.values(m.inbound).reduce((a, b) => a + b, 0);
    const parts = REACH_LABELS.filter(([k]) => m.inbound[k]).map(([k, l]) => `${l} ${m.inbound[k]}`);
    const pub = (m.inbound.ipv4 || 0) + (m.inbound.ipv6 || 0) + (m.inbound.onion || 0);
    let text = `受信 ${total}` + (parts.length ? `（${parts.join(" ・ ")}）` : "") + ` ・ 送信 ${m.outbound}`;
    if (!pub) {
      text += m.torOnly
        ? " — インターネットからの受信はまだありません。Tor のアドレスが広まるまで時間がかかることがあります。"
        : " — インターネットからの受信はまだありません。ルーターでポート 48333 を開けるか、Tor のアドレスが広まるのを待つと受け付けられます。";
    }
    $("selfReach").textContent = text;
  } else {
    $("selfReach").textContent = "—";
  }

  const addrs = [];
  if (m.onion) addrs.push(`${m.onion}:${m.onionPort}`);
  $("selfAddr").textContent = (addrs.length ? addrs.join(" ・ ") : "Tor のアドレスはまだありません") +
    (m.torOnly ? "（Tor のみ）" : "（IP アドレスはルーターの外側のものになり、btcd からは分かりません）");

  if (m.relayFeeBtcPerKb != null) {
    const satVb = m.relayFeeBtcPerKb * 1e8 / 1000;
    $("selfRelay").textContent = `最低手数料 ${satVb.toLocaleString("ja-JP", { maximumFractionDigits: 3 })} sat/vB` +
      ` ・ ${m.proxy ? `Tor 経由（${m.proxy}）` : "直接"}`;
  }
  if (m.bytesRecv != null) {
    $("selfTraffic").textContent = `受信 ${fmtBytes(m.bytesRecv)} ・ 送信 ${fmtBytes(m.bytesSent)}（btcd の起動から）`;
  }
  if (m.mempoolTxs != null) {
    $("selfMempool").textContent = `${fmtInt(m.mempoolTxs)} 件 ・ ${fmtBytes(m.mempoolBytes)}`;
  }
  if (m.timeOffset != null) {
    const o = m.timeOffset;
    $("selfOffset").textContent = o === 0 ? "なし" : `${o > 0 ? "+" : ""}${o} 秒` +
      (Math.abs(o) >= 70 * 60 ? "（大きすぎます。時計を確認してください）" : "");
  }
  const notes = [...m.errors];
  if (m.warnings) notes.unshift(`btcd の警告: ${m.warnings}`);
  $("selfNote").hidden = !notes.length;
  $("selfNote").textContent = notes.join(" / ");
}

async function refreshSelf() {
  try {
    const r = await fetch("api/self", { cache: "no-store" });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    renderSelf(await r.json());
  } catch (e) {
    $("selfNote").hidden = false;
    $("selfNote").textContent = `自分のノードの情報を読めません（${e.message}）`;
  }
}

refresh();
setInterval(refresh, 10000);
refreshSelf();
setInterval(refreshSelf, 30000);
