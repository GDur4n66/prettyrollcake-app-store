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
  macaroon: ['macaroon', 'generate: macaroon を作る（管理者と同じ）/ write: グループ（ID）の削除'],
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

const state = {
  ids: [], files: null, filesDir: '', ownId: null, methods: {}, perms: [], selected: new Set(), uris: new Set(),
  view: null, groupId: null, bakeId: null, draft: null, newGroupOpen: false, save: { enabled: false, dir: null, reason: '' },
};

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

/** 作る画面のお知らせ（読み込んだ権限のうち、廃止されたものを外したこと） */
function showRemovedNotice(removed) {
  const el = $('#bake-notice');
  el.replaceChildren();
  el.hidden = removed.length === 0;
  if (removed.length) {
    el.append(`前回の権限のうち、今の LND に無いもの（廃止された権限・RPC）を外しました: `, ...removed.map((k) => h('code', {}, k)));
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
  if (set.has('macaroon:write')) return ['warn', 'グループ（ID）を削除できます（ほかの macaroon をまとめて無効にできます）'];
  return null;
}

// ---------- グループ（＝ルートキー ID） ----------
const findGroup = (id) => state.ids.find((g) => g.rootKeyId === String(id));
const groupName = (g) => g?.name || (g?.rootKeyId === '0' ? 'LND 標準' : '（名前なし）');
const groupLabel = (g) => `「${groupName(g)}」（ID ${g.rootKeyId}）`;
/** このアプリで macaroon を作れるグループか（ID 0 と、このアプリ自身のグループは作らない） */
const canBake = (g) => !!g && !g.isDefault && !g.isOwn && (g.status === 'active' || g.status === 'unused');
const canDelete = (g) => !!g && !g.isDefault && !g.isOwn && g.status !== 'deleted';

function statusBadge(g) {
  switch (g.status) {
    case 'active': return h('span', { class: 'badge ok' }, '有効');
    case 'unused': return h('span', { class: 'badge' }, 'まだ macaroon なし');
    case 'missing': return h('span', { class: 'badge danger' }, 'LND から消えています');
    default: return h('span', { class: 'badge danger' }, `削除済み ${fmtDate(g.deletedAt)}`);
  }
}

function groupLabels(g) {
  return [
    g.isDefault && h('span', { class: 'badge' }, 'admin / readonly / invoice など'),
    g.isOwn && h('span', { class: 'badge' }, 'このアプリが使用中'),
  ];
}

function bakeCountText(g) {
  if (g.bakes.length) return `macaroon ${g.bakes.length} 個（最新 ${fmtDate(g.bakes[0].created_at)}）`;
  if (g.isDefault) return 'LND が最初から持っている macaroon';
  if (g.status === 'active') return 'このアプリで作った記録なし（lncli などで作成）';
  return '';
}

// ---------- 画面の切り替え（URL の # で決める） ----------
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
  route();
  loadFiles();
}

function go(hash) {
  if (location.hash === hash) route();
  else location.hash = hash;
}

function showView(view, tab) {
  for (const v of document.querySelectorAll('.view')) v.hidden = v.id !== `view-${view}`;
  for (const a of document.querySelectorAll('.tabs a')) a.classList.toggle('active', a.dataset.tab === tab);
  $('#global-error').textContent = '';
  state.view = view;
  window.scrollTo(0, 0);
}

function route() {
  const hash = location.hash || '#groups';
  // 作った macaroon の表示は、画面を離れたら消す
  if (!hash.endsWith('/bake')) clearBakeResult();
  let m;
  if ((m = hash.match(/^#group\/(\d+)\/bake$/))) {
    showView('bake', 'groups');
    openBake(m[1]);
  } else if ((m = hash.match(/^#group\/(\d+)$/))) {
    showView('group', 'groups');
    state.groupId = m[1];
    renderGroup();
  } else if (hash === '#inspect') {
    showView('inspect', 'inspect');
  } else if (hash === '#files') {
    showView('files', 'files');
    loadFiles();
  } else {
    showView('groups', 'groups');
    renderList();
  }
}

/** 一覧を読み直したあと、今の画面を描き直す（作成フォームは入力中なので見出しだけ） */
function rerender() {
  if (state.view === 'groups') renderList();
  else if (state.view === 'group') renderGroup();
  else if (state.view === 'bake') renderBakeHead();
}

async function loadState() {
  try {
    const s = await api('GET', '/api/state');
    state.ids = s.ids;
    state.ownId = s.ownId;
    state.save = s.save ?? state.save;
    $('#node').textContent = s.node ? `${s.node.alias}（LND ${s.node.version.split(' ')[0]}）` : 'LND に接続できません';
    rerender();
  } catch (e) {
    $('#global-error').textContent = e.message;
  }
}

// ---------- グループ一覧 ----------
function renderList() {
  const root = $('#view-groups');
  const groups = state.ids.filter((g) => !g.isDefault && g.status !== 'deleted');
  const standard = state.ids.find((g) => g.isDefault);
  const deleted = state.ids.filter((g) => g.status === 'deleted');
  root.replaceChildren(...[
    h('p', { class: 'hint' },
      'グループは「まとめて止める単位」です。同じグループの macaroon は権限が違っても全部同時に有効で、1 個だけ止めることはできません。グループを削除すると、その中の macaroon がすべて使えなくなります。渡す相手（アプリ・人）ごとにグループを分けておくと、あとで相手ごとに止められます。'),
    h('div', { class: 'toolbar' },
      h('button', { class: 'primary', type: 'button', onclick: () => toggleNewGroup(true) }, '＋ グループを作る')),
    newGroupForm(),
    groups.length === 0 && h('p', { class: 'empty' }, 'まだグループがありません'),
    ...groups.map(groupCard),
    standard && h('h2', { class: 'section' }, 'LND 標準'),
    standard && groupCard(standard),
    deleted.length > 0 && h('details', {}, h('summary', {}, `削除したグループ（${deleted.length}）`), ...deleted.map(groupCard)),
  ].filter(Boolean));
}

function groupCard(g) {
  const files = filesOf(g.rootKeyId);
  return h('a', { class: `card group-card${g.status === 'deleted' ? ' deleted' : ''}`, href: `#group/${g.rootKeyId}` },
    h('div', { class: 'head' },
      h('span', { class: 'name' }, groupName(g)),
      h('span', { class: 'id' }, `ID ${g.rootKeyId}`),
      statusBadge(g), groupLabels(g)),
    g.memo && h('p', { class: 'muted memo' }, g.memo),
    h('p', { class: 'hint' },
      [bakeCountText(g), files.length > 0 && `LND のフォルダにファイル ${files.length} 個`].filter(Boolean).join(' ・ ')),
  );
}

function newGroupForm() {
  const form = h('form', { class: 'card', id: 'new-group', hidden: !state.newGroupOpen, onsubmit: submitNewGroup },
    h('h2', {}, '新しいグループ'),
    h('label', {}, '名前', h('input', { name: 'name', maxlength: '100', required: true, placeholder: '例: スマホのウォレット・POS レジ・LNbits' })),
    h('label', {}, 'メモ（任意）', h('textarea', { name: 'memo', rows: '2', maxlength: '2000', placeholder: '例: 誰に渡したか・どこで使うか' })),
    h('label', {}, '番号（ID・任意）', h('input', { name: 'rootKeyId', inputmode: 'numeric', pattern: '[1-9][0-9]*', placeholder: '空欄なら自動（これまでの最大 + 1）' })),
    h('p', { class: 'hint' }, 'LND には、最初の macaroon を作った時にこの番号でできます。0・使用中・削除した番号は使えません。'),
    h('div', { class: 'copy-row' },
      h('button', { type: 'submit', class: 'primary' }, '作る'),
      h('button', { type: 'button', onclick: () => toggleNewGroup(false) }, 'やめる')),
    h('p', { class: 'error', id: 'new-group-error' }));
  return form;
}

function toggleNewGroup(open) {
  state.newGroupOpen = open;
  const form = $('#new-group');
  if (!form) return;
  form.hidden = !open;
  if (open) form.name.focus();
}

async function submitNewGroup(ev) {
  ev.preventDefault();
  const form = ev.target;
  try {
    const r = await api('POST', '/api/ids', { name: form.name.value, memo: form.memo.value, rootKeyId: form.rootKeyId.value });
    state.newGroupOpen = false;
    await loadState();
    go(`#group/${r.rootKeyId}`);
  } catch (e) {
    $('#new-group-error').textContent = e.message;
  }
}

// ---------- グループの詳細 ----------
function statusNotice(g) {
  if (g.isDefault) {
    return [
      h('div', { class: 'notice' },
        'LND が最初から持っているグループです（admin / readonly / invoice.macaroon など）。LND が削除を拒否するので、ここに作った macaroon は止められません。そのため、このアプリではこのグループに macaroon を作りません。漏れたときは、LND のパスワード変更と一緒に鍵を作り直します（',
        h('code', {}, 'lncli changepassword --new_mac_root_key'), '）。'),
      g.isOwn && h('div', { class: 'notice warn' },
        'このアプリも ID 0 の macaroon で LND につないでいます。漏れても止められないので、別の番号で作り直すのがおすすめです（README の「アプリ自身の macaroon」）。Umbrel 版は admin.macaroon を使うため対象外です。'),
    ];
  }
  if (g.isOwn) {
    return h('div', { class: 'notice' }, 'このアプリが LND につなぐのに使っているグループです。削除するとアプリが動かなくなるので、ここからは削除できず、macaroon も作りません。');
  }
  switch (g.status) {
    case 'unused':
      return h('div', { class: 'notice' }, `まだ macaroon がありません。最初の macaroon を作った時に、LND にこのグループ（ID ${g.rootKeyId}）ができます。`);
    case 'missing':
      return h('div', { class: 'notice danger' },
        'このグループは LND から消えています。lncli で削除されたか、LND の macaroon がすべてリセットされた可能性があります。このグループで作った macaroon はもう使えません。同じ番号では作り直せないので、新しいグループを作ってください。');
    case 'deleted':
      return h('div', { class: 'notice danger' }, `${fmtDate(g.deletedAt)} に削除しました。このグループの macaroon はもう使えません。`);
    default:
      return null;
  }
}

function renderGroup() {
  const root = $('#view-group');
  const g = findGroup(state.groupId);
  const back = h('a', { href: '#groups', class: 'back' }, '← グループ一覧');
  if (!g) {
    root.replaceChildren(back, h('p', { class: 'empty' }, `ID ${state.groupId} のグループはありません`));
    return;
  }
  const files = filesOf(g.rootKeyId);
  const actions = h('div', { class: 'actions' },
    canBake(g) && h('a', { class: 'button primary', href: `#group/${g.rootKeyId}/bake` }, 'このグループに macaroon を作る'),
    g.status !== 'deleted' && h('button', { type: 'button', onclick: () => editGroup(g) }, '名前・メモを編集'),
    canDelete(g) && h('button', { type: 'button', class: 'danger', onclick: () => deleteGroup(g) },
      g.status === 'active' ? 'グループを削除（中の macaroon をすべて無効化）' : g.status === 'missing' ? '削除済みにする' : 'グループを削除'),
  );
  root.replaceChildren(...[
    back,
    h('div', { class: 'card group-detail' },
      h('div', { class: 'head' },
        h('h2', { class: 'name' }, groupName(g)),
        h('span', { class: 'id' }, `ID ${g.rootKeyId}`),
        statusBadge(g), groupLabels(g)),
      g.memo && h('p', { class: 'memo' }, g.memo),
      statusNotice(g),
      canBake(g) && h('p', { class: 'hint' },
        'このグループの macaroon は 1 個ずつは止められません。別々に止めたい相手には、別のグループを作ってください。'),
      canBake(g) && state.save.enabled && h('p', { class: 'hint' },
        'LND のフォルダに置くときの場所: ', h('span', { class: 'mono' }, `${state.save.dir}/macaroon-id-${g.rootKeyId}/`),
        '（グループを削除すると、ここにあるこの ID の macaroon も消します）'),
      actions),
    files.length > 0 && h('h2', { class: 'section' }, `LND のフォルダにあるファイル（${files.length}）`),
    files.length > 0 && h('div', { class: 'card' },
      h('ul', { class: 'plain' }, files.map((f) => h('li', {},
        h('button', { class: 'link file-link', type: 'button', onclick: () => showFileDetail(f) }, f.name),
        h('span', { class: 'hint' }, f.path))))),
    h('h2', { class: 'section' }, `このグループの macaroon（${g.bakes.length}）`),
    g.bakes.length > 0 && h('p', { class: 'hint' }, 'macaroon の本体は保存していません（作った直後に一度だけ表示）。ここにあるのは記録だけです。'),
    g.bakes.length === 0 && h('p', { class: 'empty' },
      g.isDefault ? 'このアプリでは作りません'
        : g.status === 'active' ? 'このアプリで作った記録はありません。lncli などで作られたグループで、中にいくつ macaroon があるかは LND も覚えていません'
          : 'まだありません'),
    ...g.bakes.map((b) => bakeCard(g, b)),
  ].filter(Boolean));
}

function bakeCard(g, b) {
  const risk = riskText(b.permissions);
  return h('div', { class: 'card bake-card' },
    h('div', { class: 'head' },
      h('span', { class: 'name' }, b.note || '（名前なし）'),
      h('span', { class: 'muted' }, fmtDate(b.created_at)),
      risk && h('span', { class: `badge ${risk[0]}`, title: risk[1] }, risk[0] === 'danger' ? '強い権限' : '注意')),
    h('div', {}, permBadges(b.permissions), caveatBadges(b.caveats)),
    h('p', { class: 'hint' }, '署名の先頭 ', h('span', { class: 'mono', title: '確かめるタブで照合に使います' }, b.fingerprint)),
    b.saved_path && h('p', { class: 'hint' }, '置いた場所 ', h('span', { class: 'mono' }, b.saved_path)),
    canBake(g) && h('div', { class: 'actions' },
      h('button', { type: 'button', onclick: () => startBake(g.rootKeyId, { perms: b.permissions }) }, 'この権限をもとに作る')),
  );
}

async function editGroup(g) {
  const name = prompt(`${groupLabel(g)} の名前`, g.name);
  if (name === null) return;
  const memo = prompt(`${groupLabel(g)} のメモ`, g.memo);
  if (memo === null) return;
  try {
    await api('PATCH', `/api/ids/${encodeURIComponent(g.rootKeyId)}`, { name, memo });
    await loadState();
  } catch (e) {
    $('#global-error').textContent = e.message;
  }
}

/** グループを削除する。消したら true */
async function deleteGroup(g) {
  const dirNote = state.save.enabled ? `\n\nLND のフォルダの macaroon-id-${g.rootKeyId}/ にある、この ID の macaroon ファイルも消します。` : '';
  if (g.status === 'active') {
    const count = g.bakes.length ? `このアプリで作った ${g.bakes.length} 個を含め、` : '';
    const typed = prompt(`${groupLabel(g)} を LND から削除します。\n\n${count}このグループの macaroon はすべて、すぐに使えなくなります。元に戻せません。${dirNote}\n\n確認のため ID の番号（${g.rootKeyId}）を入力してください。`);
    if (typed === null) return false;
    if (typed.trim() !== g.rootKeyId) {
      alert('番号が一致しないため、削除しませんでした');
      return false;
    }
  } else if (g.status === 'missing') {
    if (!confirm(`${groupLabel(g)} は LND にもうありません。削除済みにしますか？（記録は残ります）${dirNote}`)) return false;
  } else if (!confirm(`空のグループ ${groupLabel(g)} を消しますか？`)) {
    return false;
  }
  try {
    const r = await api('DELETE', `/api/ids/${encodeURIComponent(g.rootKeyId)}`);
    await loadState();
    loadFiles();
    const c = r.cleanup;
    if (c?.error) {
      alert(`グループは削除しましたが、macaroon-id-${g.rootKeyId}/ を片付けられませんでした: ${c.error}`);
    } else if (c?.dir && (c.removed.length || c.kept.length)) {
      const lines = [
        c.removed.length && `消したファイル: ${c.removed.join('、')}`,
        c.kept.length && `残したもの:\n${c.kept.map((k) => `・${k.name}（${k.reason}）`).join('\n')}`,
        c.dirRemoved ? 'ディレクトリも消しました。' : `${c.dir} は残っています。`,
      ].filter(Boolean);
      alert(`${groupLabel(g)} を削除しました。\n\n${lines.join('\n\n')}`);
    }
    return true;
  } catch (e) {
    $('#global-error').textContent = e.message;
    return false;
  }
}

// ---------- グループに macaroon を作る ----------
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

/** 作る画面を開く。perms: 最初に選んでおく権限 */
function startBake(id, draft = {}) {
  state.draft = { id: String(id), ...draft };
  go(`#group/${id}/bake`);
}

function openBake(id) {
  const draft = state.draft?.id === id ? state.draft : { id };
  state.draft = null;
  state.bakeId = id;
  $('#bake-error').textContent = '';
  setPerms(draft.perms ?? []);
  const removed = pruneRemoved();
  showRemovedNotice(removed);
  renderBakeHead();
}

function renderBakeHead() {
  const g = findGroup(state.bakeId);
  const head = $('#bake-head');
  const form = $('#bake-form');
  if (!canBake(g)) {
    form.hidden = true;
    head.replaceChildren(
      h('a', { href: g ? `#group/${g.rootKeyId}` : '#groups', class: 'back' }, '← 戻る'),
      h('p', { class: 'empty' }, g ? `${groupLabel(g)} には macaroon を作れません` : `ID ${state.bakeId} のグループはありません`));
    return;
  }
  // 作った直後（結果を表示中）はフォームと案内を隠す
  const showingResult = !$('#bake-result').hidden;
  form.hidden = showingResult;
  head.replaceChildren(...[
    h('a', { href: `#group/${g.rootKeyId}`, class: 'back' }, `← ${groupName(g)}`),
    h('h2', { class: 'page-title' }, `${groupLabel(g)} に macaroon を作る`),
    !showingResult && h('p', { class: 'hint' },
      g.status === 'unused'
        ? 'このグループで最初の macaroon です。作ると LND にこのグループができます。'
        : 'macaroon は作ったあと変えられません。権限を足すときは、ここで作り直します。前に作ったものも有効のままです。'),
    !showingResult && g.bakes.length > 0 && h('div', { class: 'copy-row' },
      h('button', { type: 'button', onclick: () => { setPerms(g.bakes[0].permissions); showRemovedNotice(pruneRemoved()); } }, '前回と同じ権限を読み込む')),
  ].filter(Boolean));
}

function setPerms(perms) {
  state.selected = new Set(perms.filter((p) => p.entity !== 'uri').map((p) => `${p.entity}:${p.action}`));
  state.uris = new Set(perms.filter((p) => p.entity === 'uri').map((p) => p.action));
  renderPermGrid();
  renderUriList();
  updateSummary();
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

function expiryValue(form) {
  const v = form.expiry.value;
  if (!v) return null;
  if (v === 'custom') {
    if (!form.expiryCustom.value) throw new Error('期限の日時を入力してください');
    return new Date(form.expiryCustom.value).toISOString();
  }
  return new Date(Date.now() + Number(v) * 86400 * 1000).toISOString();
}

async function submitBake(ev) {
  ev.preventDefault();
  const form = ev.target;
  $('#bake-error').textContent = '';
  const btn = form.querySelector('button[type=submit]');
  try {
    const perms = selectedPerms();
    if (!perms.length) throw new Error('権限を1つ以上選んでください');
    const risk = riskText(perms);
    if (risk?.[0] === 'danger' && !confirm(`${risk[1]}。\nこの権限で作りますか？`)) return;
    btn.disabled = true;
    const r = await api('POST', '/api/bake', {
      rootKeyId: state.bakeId,
      note: form.note.value,
      permissions: perms,
      expiresAt: expiryValue(form),
      ipAddress: form.ipAddress.value,
      ipRange: form.ipRange.value,
    });
    const name = form.note.value.trim();
    form.note.value = '';
    await loadState();
    showBakeResult(r, name);
  } catch (e) {
    $('#bake-error').textContent = e.message;
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

function clearBakeResult() {
  const box = $('#bake-result');
  box.hidden = true;
  box.replaceChildren();
  $('#bake-form').hidden = false;
}

/** LND のフォルダの macaroon-id-<ID>/ に置く欄 */
function saveToDirBox(r, name) {
  const box = h('div', { class: 'save-box' });
  if (!state.save.enabled) {
    box.append(h('p', { class: 'hint' }, `LND のフォルダには置けません（${state.save.reason}）`));
    return box;
  }
  const dir = `${state.save.dir}/macaroon-id-${r.rootKeyId}/`;
  const input = h('input', { value: `${cleanName(name) || stamp()}.macaroon`, spellcheck: 'false', 'aria-label': 'ファイル名' });
  const msg = h('div');
  const send = async (overwrite) => {
    msg.replaceChildren();
    try {
      const res = await api('POST', '/api/save', { rootKeyId: r.rootKeyId, fileName: input.value, macaroon: r.macaroonHex, overwrite });
      msg.append(h('div', { class: 'notice ok' }, `${res.replaced ? '置き換えました' : '置きました'}: `, h('span', { class: 'mono' }, res.path), '（600）'));
      loadState();
      loadFiles();
    } catch (e) {
      if (!overwrite && /もうあります/.test(e.message)) {
        if (confirm(`${dir}${input.value} はもうあります。置き換えますか？\n（前のファイルの macaroon も、同じグループなので有効のままです）`)) send(true);
        return;
      }
      msg.append(h('p', { class: 'error' }, e.message));
    }
  };
  box.append(
    h('label', {}, 'LND のフォルダに置く', h('span', { class: 'hint save-dir' }, dir)),
    h('div', { class: 'save-row' }, input, h('button', { type: 'button', onclick: () => send(false) }, '置く')),
    msg);
  return box;
}

const cleanName = (t) => String(t ?? '').replace(/[^\p{L}\p{N}_-]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 40);
function stamp() {
  const d = new Date();
  const p2 = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}`;
}

/** 保存するファイル名: グループ名_macaroon の名前（名前がなければ作成日時） */
function macaroonFileName(g, rootKeyId, name) {
  return `${cleanName(g?.name) || `id${rootKeyId}`}_${cleanName(name) || stamp()}.macaroon`;
}

function showBakeResult(r, name = '') {
  const g = findGroup(r.rootKeyId);
  const box = $('#bake-result');
  box.replaceChildren(
    h('h2', {}, `${g ? groupLabel(g) : `ID ${r.rootKeyId}`} に${name ? `「${name}」を` : ''}作りました`),
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
      downloadButton(r.macaroonHex, macaroonFileName(g, r.rootKeyId, name))),
    saveToDirBox(r, name),
    h('div', { class: 'copy-row' },
      h('a', { class: 'button', href: `#group/${r.rootKeyId}` }, 'グループに戻る（表示を消去）')),
  );
  box.hidden = false;
  renderBakeHead();
  window.scrollTo(0, 0);
}

// ---------- LND のファイル ----------
function filesOf(id) {
  return (state.files || []).filter((f) => f.rootKeyId === id);
}

async function loadFiles() {
  const root = $('#view-files');
  if (!state.files) root.replaceChildren(h('p', { class: 'empty' }, '読み込み中…'));
  try {
    const r = await api('GET', '/api/files');
    state.files = r.files;
    state.filesDir = r.dir;
    renderFiles();
    if (state.view === 'groups') renderList();
    else if (state.view === 'group') renderGroup();
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

/** macaroon が入っているグループへのリンク */
function groupLink(rootKeyId) {
  const g = findGroup(rootKeyId);
  return g
    ? h('a', { href: `#group/${rootKeyId}` }, `グループ${groupLabel(g)}`)
    : h('span', {}, `ID ${rootKeyId}（このノードにないグループ）`);
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
  return h('div', { class: 'card group-card' },
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
          h('div', {}, groupLink(f.rootKeyId), h('span', { class: 'muted' }, ` ・ 呼べる RPC ${f.methods.length} / ${f.methodCount}`)),
          h('div', {}, permBadges(perms), caveatBadges(f.caveats)),
          v === false && h('p', { class: 'hint' }, f.check.reason),
          f.sameAs?.length > 0 && h('p', { class: 'hint' }, `中身が同じファイル: ${f.sameAs.join('、')}`),
          h('div', { class: 'actions' }, h('button', { type: 'button', onclick: () => showFileDetail(f) }, '詳しく見る'))),
  );
}

function renderFiles() {
  const root = $('#view-files');
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
  go('#inspect');
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
  const g = findGroup(r.rootKeyId);
  const validity = v === true
    ? h('div', { class: 'notice ok' }, 'LND で使える macaroon です')
    : v === false
      ? h('div', { class: 'notice danger' }, `使えません: ${r.check.reason}`)
      : h('div', { class: 'notice warn' }, r.check.reason || '有効かどうか確かめられませんでした');
  box.replaceChildren(...[
    h('h2', {}, file ? file.name : 'macaroon の中身'),
    file && h('p', { class: 'hint' }, h('span', { class: 'mono' }, file.path), ` ・ 権限 ${file.mode} ・ 更新 ${fmtDate(file.mtime)}`, file.standard && ` ・ ${file.standard}`),
    ...(file ? fileWarnings(file).map(([k, t]) => h('div', { class: `notice ${k}` }, t)) : []),
    validity,
    risk && h('div', { class: `notice ${risk[0]}` }, risk[1]),
    h('dl', {},
      h('dt', {}, 'グループ'), h('dd', {}, groupLink(r.rootKeyId), g && ' ', g && statusBadge(g)),
      g?.memo && h('dt', {}, 'グループのメモ'), g?.memo && h('dd', {}, g.memo),
      h('dt', {}, '権限'), h('dd', {}, perms.length ? permBadges(perms) : 'なし'),
      h('dt', {}, '制限'), h('dd', {}, r.caveats.length ? caveatBadges(r.caveats) : 'なし'),
      r.bake?.note && h('dt', {}, '名前'), r.bake?.note && h('dd', {}, r.bake.note),
      h('dt', {}, '作成記録'), h('dd', {}, r.bake ? `${fmtDate(r.bake.created_at)} にこのアプリで作成` : 'このアプリの記録にはありません'),
      h('dt', {}, '署名の先頭'), h('dd', {}, h('span', { class: 'mono' }, r.fingerprint)),
    ),
    h('details', {},
      h('summary', {}, `呼べる RPC（${r.methods.length} / ${r.methodCount}）`),
      h('ul', { class: 'methods' }, r.methods.map((m) => h('li', {}, m)))),
    h('div', { class: 'actions copy-row' },
      canBake(g) && h('button', { type: 'button', onclick: () => startBake(g.rootKeyId, { perms }) }, 'この権限をもとに、同じグループで作る'),
      g && h('a', { class: 'button', href: `#group/${g.rootKeyId}` }, 'グループを開く')),
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
window.addEventListener('hashchange', () => {
  if (!$('#app').hidden) route();
});
for (const [label, kind] of PRESETS) {
  $('#presets').append(h('button', { type: 'button', onclick: () => applyPreset(kind) }, label));
}
$('#bake-form select[name=expiry]').addEventListener('change', (ev) => {
  $('#expiry-custom-label').hidden = ev.target.value !== 'custom';
});
$('#uri-search').addEventListener('input', renderUriList);
$('#bake-form').addEventListener('submit', submitBake);
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
