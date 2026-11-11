"use strict";

const $ = (id) => document.getElementById(id);
const NET_LABELS = {
  ipv4: "IPv4", ipv6: "IPv6", onion: "Tor (onion)",
  not_publicly_routable: "LAN など（非公開）", other: "その他",
};
let peers = [];
let sortKey = "id";
let sortDir = 1;

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

function fmtBytes(b) {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  while (b >= 1000 && i < units.length - 1) { b /= 1000; i++; }
  return `${b.toFixed(i && b < 10 ? 1 : 0)} ${units[i]}`;
}

function fmtSec(sec) {
  if (sec == null) return "—";
  if (sec < 60) return `${sec}秒`;
  if (sec < 3600) return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}時間${Math.floor(sec % 3600 / 60)}分`;
  return `${Math.floor(sec / 86400)}日${Math.floor(sec % 86400 / 3600)}時間`;
}

function kindOf(p) {
  return p.inbound ? "受信" : "送信";
}

function countTable(id, entries, limit) {
  const rows = entries.sort((a, b) => b[1] - a[1]).slice(0, limit || entries.length);
  $(id).innerHTML = rows.length
    ? rows.map(([k, n], i) => `<tr><td class="rank">${i + 1}</td><td>${esc(k)}</td><td class="num">${n}</td></tr>`).join("")
    : `<tr><td class="muted">なし</td></tr>`;
}

function tally(list, keyFn) {
  const m = new Map();
  for (const p of list) for (const k of [].concat(keyFn(p))) m.set(k, (m.get(k) || 0) + 1);
  return [...m.entries()];
}

function renderSummary() {
  $("count").textContent = peers.length;
  countTable("topVersions", tally(peers, (p) => p.subver || "（なし）"), 5);
  countTable("topServices", tally(peers, (p) => p.flags.map((f) => f.name)), 6);
  countTable("netTypes", tally(peers, (p) => NET_LABELS[p.network] || p.network));
  const conn = [
    ["受信", peers.filter((p) => p.inbound).length],
    ["送信", peers.filter((p) => !p.inbound).length],
    ["うち v2 暗号化", peers.filter((p) => p.v2).length],
    ["うち取引なし", peers.filter((p) => !p.relayTxes).length],
  ];
  $("connTypes").innerHTML = conn.map(([k, n], i) =>
    `<tr><td class="rank">${i < 2 ? i + 1 : ""}</td><td>${k}</td><td class="num">${n}</td></tr>`).join("");
}

function sortValue(p, key) {
  switch (key) {
    case "kind": return `${kindOf(p)}${p.syncNode ? 0 : 1}`;
    case "height": return p.currentHeight || p.startingHeight || 0;
    case "traffic": return p.bytesSent + p.bytesRecv;
    case "subver": case "addr": return String(p[key]).toLowerCase();
    default: return p[key] ?? -1;
  }
}

function renderRows() {
  const q = $("search").value.trim().toLowerCase();
  const list = peers.filter((p) => !q || [p.addr, p.subver, kindOf(p), NET_LABELS[p.network], ...p.flags.map((f) => f.name)]
    .join(" ").toLowerCase().includes(q));
  list.sort((a, b) => {
    const x = sortValue(a, sortKey), y = sortValue(b, sortKey);
    return (x < y ? -1 : x > y ? 1 : 0) * sortDir;
  });
  document.querySelectorAll("th[data-sort]").forEach((th) => {
    th.dataset.dir = th.dataset.sort === sortKey ? (sortDir > 0 ? "asc" : "desc") : "";
  });
  $("rows").innerHTML = list.map((p) => {
    const tags = [
      `<span class="tag ${p.inbound ? "in" : "out"}">${kindOf(p)}</span>`,
      p.syncNode ? `<span class="tag sync">同期元</span>` : "",
      p.v2 ? `<span class="tag">v2</span>` : "",
      p.relayTxes ? "" : `<span class="tag">取引なし</span>`,
    ].join("");
    const flags = p.flags.map((f) => `<span class="flag" title="${esc(f.name)}">${esc(f.short)}</span>`).join("");
    const height = p.currentHeight || p.startingHeight;
    return `<tr>
      <td class="muted">${p.id}</td>
      <td>${esc(p.subver) || "—"}</td>
      <td class="mono">${esc(p.addr)}<small>${esc(NET_LABELS[p.network] || p.network)}</small></td>
      <td><div class="flags">${flags || "—"}</div></td>
      <td><div class="flags">${tags}</div></td>
      <td class="num">${height ? height.toLocaleString("ja-JP") : "—"}</td>
      <td class="num">${p.pingMs != null ? `${p.pingMs} ms` : "—"}</td>
      <td class="num">${fmtBytes(p.bytesSent)} / ${fmtBytes(p.bytesRecv)}</td>
      <td class="num">${fmtSec(p.lastSendAgo)} / ${fmtSec(p.lastRecvAgo)}</td>
      <td class="num">${fmtSec(p.connectedFor)}</td>
    </tr>`;
  }).join("") || `<tr><td colspan="10" class="muted">${peers.length ? "一致するピアはありません" : "ピアはいません"}</td></tr>`;
}

async function refresh() {
  try {
    const r = await fetch("api/peers", { cache: "no-store" });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
    peers = data.peers;
    $("notice").hidden = true;
    $("updated").textContent = `${new Date().toLocaleTimeString("ja-JP")} 更新`;
    renderSummary();
    renderRows();
  } catch (e) {
    $("notice").hidden = false;
    $("notice").textContent = e.message;
  }
}

document.querySelectorAll("th[data-sort]").forEach((th) => th.addEventListener("click", () => {
  const key = th.dataset.sort;
  if (sortKey === key) sortDir = -sortDir;
  else { sortKey = key; sortDir = 1; }
  renderRows();
}));
$("search").addEventListener("input", renderRows);

refresh();
setInterval(refresh, 10000);
