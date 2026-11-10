// 画面の処理（ライブラリなし）
const $ = (sel, root = document) => root.querySelector(sel);

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

const ENTITY = {
  info: ['ノード情報', 'GetInfo など。write は署名鍵の再生成など'],
  invoices: ['請求書', 'read: 請求書の一覧・確認 / write: 請求書を作る'],
  offchain: ['ライトニング', 'read: チャネル・支払い履歴 / write: 支払い・チャネルの開閉'],
  onchain: ['オンチェーン', 'read: 残高・取引 / write: 送金'],
  address: ['アドレス', 'read: アドレス一覧 / write: 新しいアドレスを作る'],
  message: ['メッセージ', 'read: 署名の検証 / write: ノード鍵で署名'],
  peers: ['ピア', 'read: 一覧 / write: 接続・切断'],
  signer: ['署名器', 'generate: 任意の鍵で署名（危険）'],
  macaroon: ['macaroon', 'generate: macaroon を作る（管理者と同じ）/ write: ID の削除'],
};
const ACTION = { read: '読み取り', write: '書き込み', generate: '生成' };
// このアプリが説明・危険度を知っている権限（LND 0.21 時点）。これ以外は「新しい権限」として扱う
const KNOWN_TO_APP = new Set([
  'address:read', 'address:write', 'info:read', 'info:write', 'invoices:read', 'invoices:write',
  'macaroon:generate', 'macaroon:read', 'macaroon:write', 'message:read', 'message:write',
  'offchain:read', 'offchain:write', 'onchain:read', 'onchain:write', 'peers:read', 'peers:write',
  'signer:generate', 'signer:read',
]);
const DANGER = new Set(['offchain:write', 'onchain:write', 'macaroon:generate', 'signer:generate', 'macaroon:write']);

const PRESETS = [
  ['読み取りのみ', 'readonly'],
  ['請求書の発行', 'invoice'],
  ['受け取り＋支払い（LNURL 等）', 'pay'],
  ['管理者と同じ', 'admin'],
  ['すべて外す', 'none'],
];

const state = { ids: [], files: null, filesDir: '', ownId: null, methods: {}, perms: [], selected: new Set(), uris: new Set() };

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && path !== '/api/login') {
    showLogin();
    throw new Error(data.error || 'ログインしてください');
  }
  if (!res.ok) throw new Error(data.error || `エラー (${res.status})`);
  return data;
}

function fmtDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleString('ja-JP', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function permLabel(p) {
  if (p.entity === 'uri') return p.action.replace(/^\/[^/]+\./, '');
  return `${ENTITY[p.entity]?.[0] ?? p.entity}:${ACTION[p.action] ?? p.action}`;
}

/** 今の LND にある権限か（一覧をまだ読んでいなければ true） */
function inLndNow(p) {
  if (!Object.keys(state.methods).length) return true;
  if (p.entity === 'uri') return Object.hasOwn(state.methods, p.action);
  return state.perms.some((q) => q.entity === p.entity && q.action === p.action);
}

const isNewToApp = (p) => p.entity !== 'uri' && !KNOWN_TO_APP.has(`${p.entity}:${p.action}`);

function permBadges(perms) {
  return perms.map((p) => {
    const key = `${p.entity}:${p.action}`;
    if (!inLndNow(p)) {
      return h('span', { class: 'badge removed', title: `${key}（今の LND にはありません）` }, `${permLabel(p)}（廃止）`);
    }
    const cls = DANGER.has(key) ? ' danger' : isNewToApp(p) ? ' warn' : '';
    return h('span', { class: `badge${cls}`, title: isNewToApp(p) ? `${key}（このアプリが説明を持たない新しい権限）` : key }, permLabel(p));
  });
}

/** 選択中の権限から、今の LND に無いものを外して返す */
function pruneRemoved() {
  const removed = [];
  for (const k of [...state.selected]) {
    const [entity, action] = k.split(':');
    if (!inLndNow({ entity, action })) {
      state.selected.delete(k);
      removed.push(k);
    }
  }
  for (const m of [...state.uris]) {
    if (!inLndNow({ entity: 'uri', action: m })) {
      state.uris.delete(m);
      removed.push(`uri:${m}`);
    }
  }
  return removed;
}

function showRemovedNotice(removed) {
  const el = $('#create-notice');
  el.replaceChildren();
  el.hidden = removed.length === 0;
  if (removed.length) {
    el.append(`前回の権限のうち、今の LND に無いもの（廃止された権限・RPC）を外しました: `, ...removed.map((k) => h('code', {}, k)), ' ');
  }
}

function caveatBadges(caveats) {
  return caveats.map((c) => {
    if (c.kind === 'expiry') return h('span', { class: `badge ${c.expired ? 'danger' : 'warn'}` }, `${c.expired ? '期限切れ' : '期限'} ${fmtDate(c.expiresAt)}`);
    if (c.kind === 'ip') return h('span', { class: 'badge warn' }, `IP ${c.ip}`);
    if (c.kind === 'iprange') return h('span', { class: 'badge warn' }, `IP 範囲 ${c.range}`);
    return h('span', { class: 'badge' }, c.condition);
  });
}

function opsToPerms(ops) {
  return ops.flatMap((o) => o.actions.map((a) => ({ entity: o.entity, action: a })));
}

function riskText(perms) {
  const set = new Set(perms.map((p) => `${p.entity}:${p.action}`));
  if (set.has('macaroon:generate')) return ['danger', 'macaroon を作れるため、管理者と同じ強さです（どんな権限の macaroon でも作れます）'];
  if (set.has('signer:generate')) return ['danger', '任意の鍵で署名できるため、資金を動かせる可能性があります'];
  if (set.has('offchain:write') || set.has('onchain:write')) return ['danger', '資金を送れます'];
  if (set.has('macaroon:write')) return ['warn', 'macaroon の ID を削除できます（他の macaroon を無効にできます）'];
  return null;
}

// ---------- 画面切り替え ----------
function showLogin() {
  $('#login').hidden = false;
  $('#app').hidden = true;
  $('#logout').hidden = true;
}

async function showApp() {
  $('#login').hidden = true;
  $('#app').hidden = false;
  $('#logout').hidden = false;
  await Promise.all([loadState(), loadPermissions()]);
  loadFiles();
}

function switchTab(name) {
  for (const b of document.querySelectorAll('.tabs button')) b.classList.toggle('active', b.dataset.tab === name);
  for (const t of document.querySelectorAll('.tab')) t.hidden = t.id !== `tab-${name}`;
  $('#global-error').textContent = '';
  window.scrollTo(0, 0);
}

// ---------- 一覧 ----------
async function loadState() {
  try {
    const s = await api('GET', '/api/state');
    state.ids = s.ids;
    state.ownId = s.ownId;
    $('#node').textContent = s.node ? `${s.node.alias}（LND ${s.node.version.split(' ')[0]}）` : 'LND に接続できません';
    renderList();
    renderIdSelect();
  } catch (e) {
    $('#global-error').textContent = e.message;
  }
}

function renderList() {
  const root = $('#tab-list');
  root.replaceChildren();
  const active = state.ids.filter((i) => !i.deletedAt);
  const deleted = state.ids.filter((i) => i.deletedAt);
  root.append(
    h('p', { class: 'hint' },
      'LND は作った macaroon 自体を覚えていません。ここでは「ルートキー ID」ごとに名前と作成記録を残します。ID を削除すると、その ID で作った macaroon はすべて使えなくなります。'),
  );
  if (!active.length) root.append(h('p', { class: 'empty' }, 'ID がありません'));
  for (const item of active) root.append(idCard(item));
  if (deleted.length) {
    root.append(h('details', {}, h('summary', {}, `削除済みの ID（${deleted.length}）`), ...deleted.map(idCard)));
  }
}

function idCard(item) {
  const status = item.deletedAt
    ? h('span', { class: 'badge danger' }, `削除済み ${fmtDate(item.deletedAt)}`)
    : item.inLnd
      ? h('span', { class: 'badge ok' }, '有効')
      : h('span', { class: 'badge danger' }, 'LND にありません');
  const labels = [
    item.isDefault && h('span', { class: 'badge' }, 'LND 標準（admin.macaroon など・削除不可）'),
    item.isOwn && h('span', { class: 'badge' }, 'このアプリが使用中'),
  ];
  const latest = item.bakes[0];
  const card = h('div', { class: `card id-card${item.deletedAt ? ' deleted' : ''}` },
    h('div', { class: 'head' },
      h('span', { class: 'id' }, `ID ${item.rootKeyId}`),
      h('span', { class: 'name' }, item.name || (item.isDefault ? '標準' : '（名前なし）')),
      status, labels),
    item.memo && h('p', { class: 'muted' }, item.memo),
    filesOf(item.rootKeyId).length > 0 &&
      h('div', {}, h('span', { class: 'muted' }, 'LND のフォルダにあるファイル: '),
        filesOf(item.rootKeyId).map((f) => h('button', { class: 'link file-link', type: 'button', onclick: () => showFileDetail(f) }, f.name))),
    latest
      ? h('div', {}, h('span', { class: 'muted' }, '最新の権限: '), permBadges(latest.permissions), caveatBadges(latest.caveats))
      : !item.isDefault && h('p', { class: 'hint' }, 'このアプリで作った記録はありません（lncli などで作られた ID）'),
    item.bakes.length > 0 &&
      h('details', { class: 'bakes' },
        h('summary', {}, `作成記録（${item.bakes.length} 件）`),
        h('ul', {}, item.bakes.map((b) =>
          h('li', {},
            h('div', {}, fmtDate(b.created_at), ' ', h('span', { class: 'mono', title: '署名の先頭（確かめるタブで照合に使います）' }, b.fingerprint), b.note && ` — ${b.note}`),
            h('div', {}, permBadges(b.permissions), caveatBadges(b.caveats)))))),
  );
  if (!item.deletedAt) {
    const actions = h('div', { class: 'actions' });
    actions.append(h('button', { onclick: () => editName(item) }, '名前・メモを編集'));
    if (item.inLnd && !item.isDefault) {
      actions.append(h('button', { onclick: () => startCreate(item.rootKeyId, latest?.permissions ?? []) }, 'この ID で作る・権限を足す'));
    }
    if (!item.isDefault && !item.isOwn) {
      actions.append(h('button', { class: 'danger', onclick: () => deleteId(item) }, '削除（無効化）'));
    }
    card.append(actions);
  }
  return card;
}

async function editName(item) {
  const name = prompt(`ID ${item.rootKeyId} の名前`, item.name);
  if (name === null) return;
  const memo = prompt(`ID ${item.rootKeyId} のメモ`, item.memo);
  if (memo === null) return;
  try {
    await api('PATCH', `/api/ids/${encodeURIComponent(item.rootKeyId)}`, { name, memo });
    await loadState();
  } catch (e) {
    $('#global-error').textContent = e.message;
  }
}

async function deleteId(item) {
  const label = item.name ? `「${item.name}」（ID ${item.rootKeyId}）` : `ID ${item.rootKeyId}`;
  const msg = `${label}を LND から削除します。\n\nこの ID で作った macaroon はすべて、すぐに使えなくなります。元に戻せません。\n\n確認のため ID の番号を入力してください。`;
  const typed = prompt(msg);
  if (typed === null) return;
  if (typed.trim() !== item.rootKeyId) {
    alert('番号が一致しないため、削除しませんでした');
    return;
  }
  try {
    await api('DELETE', `/api/ids/${encodeURIComponent(item.rootKeyId)}`);
    await loadState();
  } catch (e) {
    $('#global-error').textContent = e.message;
  }
}

// ---------- 作る ----------
async function loadPermissions() {
  try {
    const { methods } = await api('GET', '/api/permissions');
    state.methods = methods;
    const set = new Map();
    for (const v of Object.values(methods)) for (const p of v.permissions || []) set.set(`${p.entity}:${p.action}`, p);
    state.perms = [...set.values()];
    const removed = pruneRemoved();
    if (removed.length) showRemovedNotice(removed);
    renderPermGrid();
    renderUriList();
    updateSummary();
  } catch (e) {
    $('#global-error').textContent = e.message;
  }
}

function renderIdSelect() {
  const sel = $('#create-form select[name=rootKeyId]');
  const cur = sel.value;
  sel.replaceChildren(
    ...state.ids
      .filter((i) => i.inLnd && !i.deletedAt && !i.isDefault)
      .map((i) => h('option', { value: i.rootKeyId }, `ID ${i.rootKeyId}　${i.name || '（名前なし）'}`)),
  );
  if (cur) sel.value = cur;
  const radio = $('#create-form input[name=idmode][value=existing]');
  radio.disabled = sel.options.length === 0;
}

function renderPermGrid() {
  const table = $('#perm-grid');
  table.replaceChildren();
  const order = (e) => (ENTITY[e] ? Object.keys(ENTITY).indexOf(e) : 1000);
  const entities = [...new Set(state.perms.map((p) => p.entity))].sort((a, b) => order(a) - order(b) || a.localeCompare(b));
  for (const e of entities) {
    const actions = state.perms.filter((p) => p.entity === e).map((p) => p.action).sort((a, b) => ['read', 'write', 'generate'].indexOf(a) - ['read', 'write', 'generate'].indexOf(b));
    table.append(
      h('tr', {},
        h('th', {}, ENTITY[e]?.[0] ?? e, ' ', h('span', { class: 'mono' }, e),
          !ENTITY[e] && h('span', { class: 'badge warn' }, '新しい権限'),
          h('span', { class: 'entity-desc' }, ENTITY[e]?.[1] ?? 'このアプリには説明がありません（LND に新しく追加された権限です）。危険かどうかは LND のドキュメントで確認してください')),
        h('td', {}, actions.map((a) => {
          const key = `${e}:${a}`;
          return h('label', { class: 'inline' },
            h('input', { type: 'checkbox', 'data-perm': key, checked: state.selected.has(key), onchange: (ev) => {
              if (ev.target.checked) state.selected.add(key);
              else state.selected.delete(key);
              updateSummary();
            } }),
            h('span', { class: DANGER.has(key) ? 'error' : '' }, ACTION[a] ?? a),
            ENTITY[e] && isNewToApp({ entity: e, action: a }) && h('span', { class: 'badge warn' }, '新'));
        })),
      ),
    );
  }
}

function renderUriList() {
  const q = $('#uri-search').value.trim().toLowerCase();
  const list = $('#uri-list');
  list.replaceChildren();
  const names = Object.keys(state.methods).sort();
  const shown = names.filter((m) => !q || m.toLowerCase().includes(q) || state.uris.has(m)).slice(0, 300);
  for (const m of shown) {
    list.append(h('label', {},
      h('input', { type: 'checkbox', checked: state.uris.has(m), onchange: (ev) => {
        if (ev.target.checked) state.uris.add(m);
        else state.uris.delete(m);
        $('#uri-count').textContent = state.uris.size;
        updateSummary();
      } }),
      m));
  }
  $('#uri-count').textContent = state.uris.size;
}

function selectedPerms() {
  return [
    ...[...state.selected].map((k) => {
      const [entity, action] = k.split(':');
      return { entity, action };
    }),
    ...[...state.uris].map((m) => ({ entity: 'uri', action: m })),
  ];
}

function allowedCount(perms) {
  const granted = new Set(perms.filter((p) => p.entity !== 'uri').map((p) => `${p.entity}:${p.action}`));
  const uris = new Set(perms.filter((p) => p.entity === 'uri').map((p) => p.action));
  let n = 0;
  for (const [m, v] of Object.entries(state.methods)) {
    const ps = v.permissions || [];
    if ((ps.length && ps.every((p) => granted.has(`${p.entity}:${p.action}`))) || uris.has(m)) n++;
  }
  return n;
}

function updateSummary() {
  const perms = selectedPerms();
  const el = $('#perm-summary');
  el.replaceChildren();
  if (!perms.length) {
    el.append(h('span', { class: 'muted' }, '権限が選ばれていません'));
    return;
  }
  el.append(`呼べる RPC: ${allowedCount(perms)} / ${Object.keys(state.methods).length}`);
  const risk = riskText(perms);
  if (risk) el.append(h('div', { class: `notice ${risk[0]}` }, risk[1]));
  const unknown = perms.filter(isNewToApp);
  if (unknown.length) {
    el.append(h('div', { class: 'notice warn' },
      'このアプリが説明を持たない新しい権限が含まれています。危険かどうかは判定できません: ',
      ...unknown.map((p) => h('code', {}, `${p.entity}:${p.action}`))));
  }
}

function applyPreset(kind) {
  const all = state.perms.map((p) => `${p.entity}:${p.action}`);
  const pick = {
    readonly: all.filter((k) => k.endsWith(':read')),
    invoice: ['address:read', 'address:write', 'invoices:read', 'invoices:write', 'onchain:read'],
    pay: ['info:read', 'invoices:read', 'invoices:write', 'offchain:read', 'offchain:write'],
    admin: all,
    none: [],
  }[kind];
  state.selected = new Set(pick.filter((k) => all.includes(k)));
  if (kind === 'none') state.uris = new Set();
  renderPermGrid();
  renderUriList();
  updateSummary();
}

function setIdMode(mode, id) {
  const form = $('#create-form');
  form.querySelector(`input[name=idmode][value=${mode}]`).checked = true;
  const sel = form.querySelector('select[name=rootKeyId]');
  sel.disabled = mode !== 'existing';
  sel.hidden = mode !== 'existing';
  if (id) sel.value = id;
  updateIdHint();
}

function updateIdHint() {
  const form = $('#create-form');
  const existing = form.querySelector('input[name=idmode]:checked').value === 'existing';
  const nameInput = form.querySelector('input[name=keyName]');
  if (existing) {
    const item = state.ids.find((i) => i.rootKeyId === form.querySelector('select[name=rootKeyId]').value);
    nameInput.placeholder = item?.name ? `変更しない場合は空欄（今: ${item.name}）` : '例: スマホのウォレット';
    $('#id-hint').textContent =
      'macaroon は作ったあと変更できないため、「権限を足す」は同じ ID で新しい macaroon を作り直す形になります。前に作った macaroon も有効のままです。古いものを確実に止めたいときは、新しい ID で作ってから古い ID を削除してください。';
  } else {
    nameInput.placeholder = '例: スマホのウォレット';
    $('#id-hint').textContent = '新しい ID で作ると、あとでその ID を削除するだけで、この macaroon をまとめて無効にできます。';
  }
}

function startCreate(rootKeyId, perms) {
  switchTab('create');
  $('#create-result').hidden = true;
  $('#create-error').textContent = '';
  state.selected = new Set(perms.filter((p) => p.entity !== 'uri').map((p) => `${p.entity}:${p.action}`));
  state.uris = new Set(perms.filter((p) => p.entity === 'uri').map((p) => p.action));
  showRemovedNotice(pruneRemoved());
  if (rootKeyId) setIdMode('existing', rootKeyId);
  else setIdMode('new');
  renderPermGrid();
  renderUriList();
  updateSummary();
}

function expiryValue(form) {
  const v = form.expiry.value;
  if (!v) return null;
  if (v === 'custom') {
    if (!form.expiryCustom.value) throw new Error('期限の日時を入力してください');
    return new Date(form.expiryCustom.value).toISOString();
  }
  return new Date(Date.now() + Number(v) * 86400 * 1000).toISOString();
}

async function submitCreate(ev) {
  ev.preventDefault();
  const form = ev.target;
  $('#create-error').textContent = '';
  const btn = form.querySelector('button[type=submit]');
  try {
    const perms = selectedPerms();
    if (!perms.length) throw new Error('権限を1つ以上選んでください');
    const risk = riskText(perms);
    if (risk?.[0] === 'danger' && !confirm(`${risk[1]}。\nこの権限で作りますか？`)) return;
    const existing = form.idmode.value === 'existing';
    btn.disabled = true;
    const r = await api('POST', '/api/bake', {
      rootKeyId: existing ? form.rootKeyId.value : 'new',
      name: form.keyName.value,
      memo: form.memo.value,
      note: form.note.value,
      permissions: perms,
      expiresAt: expiryValue(form),
      ipAddress: form.ipAddress.value,
      ipRange: form.ipRange.value,
    });
    showCreateResult(r, form.keyName.value);
    form.keyName.value = '';
    form.memo.value = '';
    form.note.value = '';
    await loadState();
  } catch (e) {
    $('#create-error').textContent = e.message;
  } finally {
    btn.disabled = false;
  }
}

function copyButton(text, label) {
  return h('button', { type: 'button', onclick: async (ev) => {
    const b = ev.currentTarget;
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = h('textarea', {}, text);
      document.body.append(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    }
    const old = b.textContent;
    b.textContent = 'コピーしました';
    setTimeout(() => (b.textContent = old), 1500);
  } }, label);
}

function downloadButton(hex, filename) {
  return h('button', { type: 'button', onclick: () => {
    const bytes = new Uint8Array(hex.match(/../g).map((x) => parseInt(x, 16)));
    const url = URL.createObjectURL(new Blob([bytes], { type: 'application/octet-stream' }));
    const a = h('a', { href: url, download: filename });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } }, 'ファイルで保存');
}

function showCreateResult(r, name) {
  const box = $('#create-result');
  const safe = (name || `id${r.rootKeyId}`).replace(/[^\p{L}\p{N}_-]+/gu, '-').slice(0, 40);
  box.replaceChildren(
    h('h2', {}, `ID ${r.rootKeyId} で作りました`),
    h('div', { class: 'notice warn' }, 'macaroon 本体はこのアプリに保存していません。この画面を離れると二度と表示できないので、今コピーするかファイルで保存してください。'),
    h('dl', {},
      h('dt', {}, '権限'), h('dd', {}, permBadges(r.permissions)),
      h('dt', {}, '制限'), h('dd', {}, r.caveats.length ? caveatBadges(r.caveats) : 'なし'),
      h('dt', {}, '署名の先頭'), h('dd', {}, h('span', { class: 'mono' }, r.fingerprint)),
    ),
    h('label', {}, 'hex', h('textarea', { rows: 4, readonly: true, spellcheck: 'false' }, r.macaroonHex)),
    h('div', { class: 'copy-row' },
      copyButton(r.macaroonHex, 'hex をコピー'),
      copyButton(r.macaroonBase64, 'base64 をコピー'),
      downloadButton(r.macaroonHex, `${safe}.macaroon`),
      h('button', { type: 'button', onclick: () => { box.hidden = true; box.replaceChildren(); } }, '閉じる（消去）')),
  );
  box.hidden = false;
  box.scrollIntoView({ behavior: 'smooth' });
}

// ---------- LND のファイル ----------
function filesOf(id) {
  return (state.files || []).filter((f) => f.rootKeyId === id);
}

async function loadFiles() {
  const root = $('#tab-files');
  if (!state.files) root.replaceChildren(h('p', { class: 'empty' }, '読み込み中…'));
  try {
    const r = await api('GET', '/api/files');
    state.files = r.files;
    state.filesDir = r.dir;
    renderFiles();
    renderList();
  } catch (e) {
    root.replaceChildren(h('p', { class: 'error' }, e.message));
  }
}

function fileWarnings(f) {
  const w = [];
  const perms = f.ops ? opsToPerms(f.ops) : [];
  const risk = riskText(perms);
  if (f.otherReadable) {
    w.push(['danger', `ファイルの権限が ${f.mode} で、このマシンの誰でも読めます。${risk ? `この macaroon は「${risk[1]}」ので、chmod 600 にしてください。` : 'chmod 600 をおすすめします。'}`]);
  } else if (f.groupReadable) {
    w.push(['warn', `ファイルの権限が ${f.mode} で、同じグループのユーザーが読めます。`]);
  }
  return w;
}

function fileCard(f) {
  const perms = f.ops ? opsToPerms(f.ops) : [];
  const risk = riskText(perms);
  const v = f.check?.valid;
  const status = f.error
    ? h('span', { class: 'badge danger' }, '読めません')
    : v === true
      ? h('span', { class: 'badge ok' }, '有効')
      : v === false
        ? h('span', { class: 'badge danger' }, '使えません')
        : h('span', { class: 'badge warn' }, '確認できず');
  const idName = f.rootKeyId === undefined ? '' : f.record?.name || (f.rootKeyId === '0' ? '標準' : '名前なし');
  return h('div', { class: 'card id-card' },
    h('div', { class: 'head' },
      h('span', { class: 'name' }, f.name),
      status,
      h('span', { class: `badge${f.otherReadable ? ' danger' : f.groupReadable ? ' warn' : ''}`, title: 'ファイルの権限' }, f.mode),
      f.isOwn && h('span', { class: 'badge' }, 'このアプリが使用中'),
      risk && h('span', { class: `badge ${risk[0]}` }, risk[0] === 'danger' ? (perms.some((p) => p.entity === 'macaroon' && p.action === 'generate') ? '管理者相当' : '資金を動かせる') : '注意')),
    h('p', { class: 'hint' }, h('span', { class: 'mono' }, f.path), ` ・ 更新 ${fmtDate(f.mtime)}`, f.standard && ` ・ ${f.standard}`),
    fileWarnings(f).map(([k, t]) => h('div', { class: `notice ${k}` }, t)),
    f.error
      ? h('p', { class: 'error' }, f.error)
      : h('div', {},
          h('div', {}, h('span', { class: 'muted' }, `ID ${f.rootKeyId}（${idName}） ・ `), h('span', { class: 'muted' }, `呼べる RPC ${f.methods.length} / ${f.methodCount}`)),
          h('div', {}, permBadges(perms), caveatBadges(f.caveats)),
          v === false && h('p', { class: 'hint' }, f.check.reason),
          f.sameAs?.length > 0 && h('p', { class: 'hint' }, `中身が同じファイル: ${f.sameAs.join('、')}`),
          h('div', { class: 'actions' }, h('button', { type: 'button', onclick: () => showFileDetail(f) }, '詳しく見る'))),
  );
}

function renderFiles() {
  const root = $('#tab-files');
  const files = state.files || [];
  const warnCount = files.filter((f) => f.otherReadable).length;
  root.replaceChildren(...[
    h('p', { class: 'hint' },
      `${state.filesDir || 'LND のフォルダ'} の中の *.macaroon ファイルを読んで表示しています（ファイルの中身はブラウザに送りません）。`,
      h('button', { class: 'link', type: 'button', onclick: loadFiles }, ' 読み直す')),
    warnCount > 0 && h('div', { class: 'notice danger' }, `誰でも読めるファイルが ${warnCount} 個あります。`),
    files.length === 0 && h('p', { class: 'empty' }, 'macaroon ファイルが見つかりません'),
    ...files.map(fileCard),
  ].filter(Boolean));
}

function showFileDetail(f) {
  switchTab('inspect');
  $('#inspect-error').textContent = '';
  $('#inspect-form').macaroon.value = '';
  if (f.error) {
    $('#inspect-result').hidden = true;
    $('#inspect-error').textContent = `${f.path}: ${f.error}`;
    return;
  }
  renderInspect(f, f);
}

// ---------- 確かめる ----------
async function submitInspect(ev) {
  ev.preventDefault();
  $('#inspect-error').textContent = '';
  const box = $('#inspect-result');
  try {
    const r = await api('POST', '/api/inspect', { macaroon: ev.target.macaroon.value });
    renderInspect(r);
  } catch (e) {
    box.hidden = true;
    $('#inspect-error').textContent = e.message;
  }
}

function renderInspect(r, file = null) {
  const box = $('#inspect-result');
  const perms = opsToPerms(r.ops);
  const risk = riskText(perms);
  const v = r.check.valid;
  const validity = v === true
    ? h('div', { class: 'notice ok' }, 'LND で使える macaroon です')
    : v === false
      ? h('div', { class: 'notice danger' }, `使えません: ${r.check.reason}`)
      : h('div', { class: 'notice warn' }, r.check.reason || '有効かどうか確かめられませんでした');
  const name = r.record?.name || (r.rootKeyId === '0' ? 'LND 標準' : '（名前なし）');
  box.replaceChildren(...[
    h('h2', {}, file ? `${file.name}（ID ${r.rootKeyId}　${name}）` : `ID ${r.rootKeyId}　${name}`),
    file && h('p', { class: 'hint' }, h('span', { class: 'mono' }, file.path), ` ・ 権限 ${file.mode} ・ 更新 ${fmtDate(file.mtime)}`, file.standard && ` ・ ${file.standard}`),
    ...(file ? fileWarnings(file).map(([k, t]) => h('div', { class: `notice ${k}` }, t)) : []),
    validity,
    risk && h('div', { class: `notice ${risk[0]}` }, risk[1]),
    h('dl', {},
      h('dt', {}, '権限'), h('dd', {}, perms.length ? permBadges(perms) : 'なし'),
      h('dt', {}, '制限'), h('dd', {}, r.caveats.length ? caveatBadges(r.caveats) : 'なし'),
      h('dt', {}, 'ID のメモ'), h('dd', {}, r.record?.memo || '—'),
      h('dt', {}, '作成記録'), h('dd', {}, r.bake ? `${fmtDate(r.bake.created_at)} にこのアプリで作成${r.bake.note ? `（${r.bake.note}）` : ''}` : 'このアプリの記録にはありません'),
      h('dt', {}, '署名の先頭'), h('dd', {}, h('span', { class: 'mono' }, r.fingerprint)),
    ),
    h('details', {},
      h('summary', {}, `呼べる RPC（${r.methods.length} / ${r.methodCount}）`),
      h('ul', { class: 'methods' }, r.methods.map((m) => h('li', {}, m)))),
    h('div', { class: 'actions copy-row' },
      r.inLnd && r.rootKeyId !== '0' &&
        h('button', { type: 'button', onclick: () => startCreate(r.rootKeyId, perms) }, 'この権限に足して作り直す'),
      r.inLnd && r.rootKeyId !== '0' && r.rootKeyId !== state.ownId &&
        h('button', { type: 'button', class: 'danger', onclick: () => {
          const item = state.ids.find((i) => i.rootKeyId === r.rootKeyId) ?? { rootKeyId: r.rootKeyId, name: '' };
          deleteId(item).then(() => switchTab('list'));
        } }, 'この ID を削除（無効化）')),
  ].filter(Boolean));
  box.hidden = false;
}

// ---------- 起動 ----------
$('#login-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  $('#login-error').textContent = '';
  try {
    await api('POST', '/api/login', { password: ev.target.password.value });
    ev.target.password.value = '';
    await showApp();
  } catch (e) {
    $('#login-error').textContent = e.message;
  }
});
$('#logout').addEventListener('click', async () => {
  await api('POST', '/api/logout').catch(() => {});
  showLogin();
});
for (const b of document.querySelectorAll('.tabs button')) {
  b.addEventListener('click', () => {
    if (b.dataset.tab === 'create') startCreate(null, []);
    else switchTab(b.dataset.tab);
    if (b.dataset.tab === 'files') loadFiles();
  });
}
for (const [label, kind] of PRESETS) {
  $('#presets').append(h('button', { type: 'button', onclick: () => applyPreset(kind) }, label));
}
for (const r of document.querySelectorAll('#create-form input[name=idmode]')) {
  r.addEventListener('change', () => setIdMode(r.value));
}
$('#create-form select[name=rootKeyId]').addEventListener('change', () => {
  const item = state.ids.find((i) => i.rootKeyId === $('#create-form select[name=rootKeyId]').value);
  if (item) startCreate(item.rootKeyId, item.bakes[0]?.permissions ?? []);
});
$('#create-form select[name=expiry]').addEventListener('change', (ev) => {
  $('#expiry-custom-label').hidden = ev.target.value !== 'custom';
});
$('#uri-search').addEventListener('input', renderUriList);
$('#create-form').addEventListener('submit', submitCreate);
$('#inspect-form').addEventListener('submit', submitInspect);
$('#inspect-file').addEventListener('change', async (ev) => {
  const f = ev.target.files[0];
  if (!f) return;
  const buf = new Uint8Array(await f.arrayBuffer());
  const text = new TextDecoder().decode(buf).trim();
  // テキスト（hex/base64）のファイルならそのまま、バイナリなら hex にする
  $('#inspect-form').macaroon.value = buf[0] === 2 ? [...buf].map((b) => b.toString(16).padStart(2, '0')).join('') : text;
  ev.target.value = '';
});

api('GET', '/api/state')
  .then(() => showApp())
  .catch(() => showLogin());
