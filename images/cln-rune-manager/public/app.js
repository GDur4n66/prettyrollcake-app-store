import { restrictionJa, expiredAt, isDangerous, splitAlt } from './describe.js';

const $ = (s, el = document) => el.querySelector(s);
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

async function api(path, opts = {}) {
  const res = await fetch(path, {
    method: opts.method || 'GET',
    headers: opts.body ? { 'Content-Type': 'application/json' } : {},
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (res.status === 401 && path !== '/api/login') {
    // 開いた直後 はまだログインしていないだけ。ログインした後に切れたときだけ知らせる
    showLogin(loggedIn ? 'ログインが切れました。もう一度ログインしてください' : '');
    loggedIn = false;
    throw new Error('ログインしてください');
  }
  if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
  return json;
}

let state = null;
let loggedIn = false;
let commands = [];
const selected = new Set();
let showBlacklisted = false;

// --- ログイン ---
function showLogin(msg = '') {
  $('#login').hidden = false;
  $('#app').hidden = true;
  $('#logout').hidden = true;
  $('#login-error').textContent = msg;
}
$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    await api('/api/login', { method: 'POST', body: { password: e.target.password.value } });
    e.target.reset();
    await start();
  } catch (err) {
    $('#login-error').textContent = err.message;
  }
});
$('#logout').addEventListener('click', async () => {
  await api('/api/logout', { method: 'POST' }).catch(() => {});
  loggedIn = false;
  showLogin();
});

// --- タブ ---
function showTab(name) {
  for (const v of document.querySelectorAll('.view')) v.hidden = v.id !== `view-${name}`;
  for (const a of document.querySelectorAll('.tabs a')) a.classList.toggle('active', a.dataset.tab === name);
}
window.addEventListener('hashchange', () => showTab(location.hash.slice(1) || 'list'));

async function start() {
  loggedIn = true;
  $('#login').hidden = true;
  $('#app').hidden = false;
  $('#logout').hidden = false;
  showTab(location.hash.slice(1) || 'list');
  await refresh();
  loadCommands();
}

async function refresh() {
  try {
    state = await api('/api/state');
    $('#global-error').textContent = '';
  } catch (e) {
    $('#global-error').textContent = e.message;
    return;
  }
  const n = state.node;
  $('#node').textContent = n ? `${n.alias || n.id.slice(0, 12)}（${n.version}${n.network && n.network !== 'bitcoin' ? ` / ${n.network}` : ''}）` : '';
  const w = $('#tls-warning');
  w.hidden = state.tls.mode !== 'none';
  if (!w.hidden) {
    w.innerHTML = `clnrest の証明書を確かめずにつないでいます。固定するには .env に <code>CLN_TLS_FINGERPRINT=${esc(state.tls.fingerprint ?? '')}</code> を書いてください（指紋が Umbrel の証明書と同じか確かめてから）。`;
  }
  renderList();
}

// --- 一覧 ---
function restrictionsOf(r) {
  return r.restrictions.map((x) => x.alternatives);
}

function renderList() {
  const el = $('#view-list');
  const runes = state.runes.filter((r) => showBlacklisted || !r.blacklisted);
  const hidden = state.runes.length - runes.length;
  el.innerHTML = `
    <div class="toolbar">
      <label class="inline"><input type="checkbox" id="show-bl" ${showBlacklisted ? 'checked' : ''}> 無効化したものも表示${hidden ? `（${hidden} 件）` : ''}</label>
      <a class="button primary" href="#create">新しい rune を作る</a>
    </div>
    ${runes.length ? '' : '<p class="empty">rune がありません</p>'}
    ${runes.map(runeCard).join('')}
    <p class="hint">一覧は CLN に保存されている rune です（createrune で作ったもの）。名前とメモはこのアプリにだけ保存されます。
    無効化は ID 単位なので、その rune に条件を足して作った rune も一緒に使えなくなります。</p>`;
  $('#show-bl').addEventListener('change', (e) => {
    showBlacklisted = e.target.checked;
    renderList();
  });
  for (const card of el.querySelectorAll('[data-id]')) bindCard(card);
}

function runeCard(r) {
  const rs = restrictionsOf(r);
  const expired = expiredAt(rs);
  const badges = [
    r.isOwn && '<span class="badge warn">このアプリが使用中</span>',
    r.blacklisted && '<span class="badge danger">無効化済み</span>',
    !r.blacklisted && expired && '<span class="badge danger">期限切れ</span>',
    !rs.length && '<span class="badge danger">制限なし（全権限）</span>',
    !r.blacklisted && !expired && rs.length > 0 && '<span class="badge ok">有効</span>',
  ].filter(Boolean);
  const used = r.lastUsed ? `最後に使われた日時: ${new Date(r.lastUsed).toLocaleString()}` : 'まだ使われていません';
  const relist = r.blacklisted && state.relistSupported !== false;
  return `
  <div class="card rune-card ${r.blacklisted ? 'deleted' : ''}" data-id="${esc(r.uniqueId)}">
    <div class="head">
      <p class="name">${r.name ? esc(r.name) : '<span class="muted">名前なし</span>'}</p>
      <span class="id">ID ${esc(r.uniqueId)}</span>
      ${badges.join('')}
    </div>
    ${r.memo ? `<p class="memo">${esc(r.memo)}</p>` : ''}
    <ul class="restrictions">${rs.length ? rs.map((a) => `<li>${esc(restrictionJa(a))}</li>`).join('') : '<li>何でもできます</li>'}</ul>
    <p class="hint">${used}</p>
    <div class="rune-box" hidden></div>
    <form class="edit" hidden>
      <label>名前<input name="name" maxlength="100" value="${esc(r.name)}"></label>
      <label>メモ<textarea name="memo" rows="2" maxlength="2000">${esc(r.memo)}</textarea></label>
      <div class="actions"><button type="submit" class="primary">保存</button><button type="button" data-act="cancel">やめる</button></div>
    </form>
    <div class="actions">
      <button data-act="show">rune を表示</button>
      <button data-act="edit">名前・メモ</button>
      ${!r.blacklisted && !r.isOwn ? '<button data-act="blacklist" class="danger">無効化</button>' : ''}
      ${relist ? '<button data-act="relist">無効化を取り消す</button>' : ''}
    </div>
    <p class="error"></p>
  </div>`;
}

function bindCard(card) {
  const id = card.dataset.id;
  const r = state.runes.find((x) => x.uniqueId === id);
  const err = card.querySelector('.error');
  const form = card.querySelector('form.edit');
  card.addEventListener('click', async (e) => {
    const act = e.target.dataset?.act;
    if (!act) return;
    err.textContent = '';
    try {
      if (act === 'show') {
        const box = card.querySelector('.rune-box');
        if (!box.hidden) {
          box.hidden = true;
          box.innerHTML = '';
          e.target.textContent = 'rune を表示';
          return;
        }
        const { rune } = await api(`/api/runes/${id}/rune`);
        box.innerHTML = runeBlock(rune);
        bindCopy(box);
        box.hidden = false;
        e.target.textContent = 'rune を隠す';
      } else if (act === 'edit') {
        form.hidden = false;
      } else if (act === 'cancel') {
        form.hidden = true;
      } else if (act === 'blacklist') {
        if (!confirm(`「${r.name || `ID ${id}`}」を無効化します。この rune（と、これに条件を足して作った rune）は使えなくなります。${state.relistSupported ? '' : '\nこの CLN では取り消せません。'}`)) return;
        await api(`/api/runes/${id}/blacklist`, { method: 'POST' });
        await refresh();
      } else if (act === 'relist') {
        if (!confirm(`「${r.name || `ID ${id}`}」をもう一度使えるようにします。`)) return;
        await api(`/api/runes/${id}/relist`, { method: 'POST' });
        await refresh();
      }
    } catch (ex) {
      err.textContent = ex.message;
    }
  });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api(`/api/runes/${id}`, { method: 'PATCH', body: { name: form.name.value, memo: form.memo.value } });
      await refresh();
    } catch (ex) {
      err.textContent = ex.message;
    }
  });
}

function runeBlock(rune) {
  const url = state?.restUrl || 'https://<CLN のアドレス>:2107';
  return `
    <code class="rune-text">${esc(rune)}</code>
    <div class="copy-row"><button type="button" data-copy="${esc(rune)}">コピー</button></div>
    <p class="hint">使い方の例: <code>curl -k -X POST ${esc(url)}/v1/getinfo -H "Rune: ${esc(rune)}"</code></p>`;
}

function bindCopy(el) {
  for (const b of el.querySelectorAll('[data-copy]')) {
    b.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(b.dataset.copy);
        b.textContent = 'コピーしました';
      } catch {
        b.textContent = 'コピーできません（選択してコピーしてください）';
      }
      setTimeout(() => (b.textContent = 'コピー'), 2000);
    });
  }
}

// --- 作る ---
const PRESETS = [
  { label: '受け取り（請求書を作る）', methods: ['getinfo', 'invoice', 'listinvoices', 'waitinvoice', 'waitanyinvoice'] },
  { label: '支払い', methods: ['getinfo', 'pay', 'xpay', 'decode', 'listpays', 'listsendpays'] },
  { label: '残高を見る', methods: ['getinfo', 'listfunds', 'listpeerchannels'] },
  { label: 'BOLT12 オファー', methods: ['getinfo', 'offer', 'listoffers', 'disableoffer', 'fetchinvoice'] },
  { label: 'ウォレットアプリ用', methods: ['getinfo', 'invoice', 'listinvoices', 'waitanyinvoice', 'pay', 'xpay', 'decode', 'listpays', 'listfunds', 'listpeerchannels'] },
];

const form = $('#create-form');
$('#presets').innerHTML =
  PRESETS.map((p, i) => `<button type="button" data-preset="${i}">${esc(p.label)}</button>`).join('') +
  '<button type="button" data-preset="clear">選択を消す</button>';
$('#presets').addEventListener('click', (e) => {
  const p = e.target.dataset.preset;
  if (p === undefined) return;
  if (p === 'clear') {
    selected.clear();
    form.readonly.checked = false;
  } else for (const m of PRESETS[p].methods) selected.add(m);
  renderCommands();
  updatePreview();
});

async function loadCommands() {
  try {
    commands = (await api('/api/commands')).commands;
  } catch (e) {
    $('#cmd-list').innerHTML = `<p class="error">コマンドの一覧を取れません: ${esc(e.message)}</p>`;
    return;
  }
  $('#cmd-datalist').innerHTML = commands.map((c) => `<option value="${esc(c)}">`).join('');
  renderCommands();
}

function renderCommands() {
  const q = $('#cmd-search').value.trim().toLowerCase();
  // 一覧にないもの（プリセットで足したが、このノードに無いコマンド）も表示する
  const all = [...new Set([...commands, ...selected])].sort();
  $('#cmd-list').innerHTML = all
    .filter((c) => !q || c.includes(q) || selected.has(c))
    .map((c) => {
      const missing = commands.length && !commands.includes(c);
      return `<label><input type="checkbox" value="${esc(c)}" ${selected.has(c) ? 'checked' : ''}> ${esc(c)}
        ${isDangerous(c) ? '<span class="badge danger">注意</span>' : ''}${missing ? '<span class="badge warn">このノードにない</span>' : ''}</label>`;
    })
    .join('');
  $('#cmd-count').textContent = selected.size;
}
$('#cmd-search').addEventListener('input', renderCommands);
$('#cmd-list').addEventListener('change', (e) => {
  if (e.target.type !== 'checkbox') return;
  if (e.target.checked) selected.add(e.target.value);
  else selected.delete(e.target.value);
  $('#cmd-count').textContent = selected.size;
  updatePreview();
});

function expiryValue() {
  const v = form.expiry.value;
  if (!v) return null;
  if (v === 'custom') return form.expiryCustom.value ? new Date(form.expiryCustom.value).toISOString() : null;
  return new Date(Date.now() + Number(v) * 86400 * 1000).toISOString();
}

function formInput() {
  return {
    name: form.name.value,
    memo: form.memo.value,
    allowAll: form.allowAll.checked,
    readonly: !form.allowAll.checked && form.readonly.checked,
    methods: form.allowAll.checked ? [] : [...selected],
    expiresAt: expiryValue(),
    rate: form.rate.value,
    per: form.per.value,
    extra: form.extra.value,
  };
}

/** 画面用の見積もり（正式な組み立てとチェックはサーバーで行う） */
function previewRestrictions(i) {
  const out = [];
  if (!i.allowAll) {
    const alts = [...(i.readonly ? ['method^list', 'method^get', 'method=summary'] : []), ...[...i.methods].sort().map((m) => `method=${m}`)];
    if (alts.length) out.push(alts);
    if (i.readonly) out.push(['method/listdatastore']);
  }
  if (i.expiresAt) out.push([`time<${Math.floor(new Date(i.expiresAt).getTime() / 1000)}`]);
  if (i.rate) out.push([`rate=${i.rate}`]);
  if (i.per) out.push([`per=${i.per}`]);
  for (const line of i.extra.split('\n').map((l) => l.trim()).filter(Boolean)) {
    out.push(line.split(/(?<!\\)\|/).map((a) => a.replace(/\\\|/g, '|').trim()).filter(Boolean));
  }
  return out;
}

function updatePreview() {
  const i = formInput();
  $('#method-box').hidden = i.allowAll;
  $('#expiry-custom-label').hidden = form.expiry.value !== 'custom';
  const rs = previewRestrictions(i);
  const hasMethod = i.allowAll || i.readonly || i.methods.length;
  $('#preview').innerHTML = !hasMethod
    ? '<li class="muted">コマンドを選んでください</li>'
    : rs.length
      ? rs.map((a) => `<li>${esc(restrictionJa(a))}</li>`).join('')
      : '<li class="danger-text">何でもできます（全権限）</li>';
  const danger = i.allowAll ? ['全部のコマンド'] : i.methods.filter(isDangerous);
  const n = $('#danger-notice');
  n.hidden = !danger.length;
  n.textContent = danger.length
    ? `注意: ${danger.join(', ')} を許可しています。お金が動く・権限が広がるコマンドです。渡す相手を限り、期限や回数の制限も付けてください。`
    : '';
  // 期限だけ付けて全権限は危ない（CLN の説明より）
  if (i.allowAll && rs.length && rs.every((a) => a.every((x) => splitAlt(x).fieldname !== 'method'))) {
    n.textContent += ' 期限や回数を付けても、コマンドを絞らない限り何でもできます。';
  }
}
form.addEventListener('input', updatePreview);
form.addEventListener('change', updatePreview);

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  $('#create-error').textContent = '';
  const body = formInput();
  if (body.allowAll) {
    if (!confirm('コマンドを絞らない rune は、ノードのお金を全部動かせます。本当に作りますか？')) return;
    body.confirmUnrestricted = true;
  }
  try {
    const r = await api('/api/runes', { method: 'POST', body });
    const box = $('#create-result');
    box.innerHTML = `
      <h2>「${esc(body.name)}」を作りました（ID ${esc(r.uniqueId)}）</h2>
      ${r.unrestricted ? '<div class="notice danger">制限のない rune です。扱いに注意してください。</div>' : ''}
      ${runeBlock(r.rune)}
      <p class="hint">rune は「一覧」からいつでも表示できます。</p>
      <div class="actions"><a class="button" href="#list">一覧へ</a></div>`;
    bindCopy(box);
    box.hidden = false;
    form.reset();
    selected.clear();
    renderCommands();
    updatePreview();
    box.scrollIntoView({ behavior: 'smooth' });
    refresh();
  } catch (err) {
    $('#create-error').textContent = err.message;
  }
});

// --- 確かめる ---
$('#inspect-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  $('#inspect-error').textContent = '';
  const box = $('#inspect-result');
  box.hidden = true;
  try {
    const r = await api('/api/inspect', { method: 'POST', body: { rune: f.rune.value, method: f.method.value, params: f.params.value } });
    const rs = restrictionsOf(r);
    let status;
    if (!r.ours) status = '<span class="badge danger">このノードの rune ではありません</span>';
    else if (r.blacklisted) status = '<span class="badge danger">無効化済み</span>';
    else if (expiredAt(rs)) status = '<span class="badge danger">期限切れ</span>';
    else status = '<span class="badge ok">このノードの rune</span>';
    const check = r.check
      ? r.check.valid
        ? `<div class="notice ok">${esc(r.check.method)} は使えます</div>`
        : `<div class="notice danger">${esc(r.check.method)} は使えません: ${esc(r.check.reason)}</div>`
      : '';
    box.innerHTML = `
      <h2>${r.record?.name ? esc(r.record.name) : 'rune の中身'}</h2>
      ${check}
      <dl>
        <dt>ID</dt><dd>${esc(r.uniqueId)} ${status} ${r.isOwn ? '<span class="badge warn">このアプリが使用中</span>' : ''}</dd>
        <dt>CLN に保存</dt><dd>${r.stored ? 'あり（一覧に出ます）' : 'なし（別の rune に条件を足したもの、または古い作り方）'}</dd>
        ${r.record?.memo ? `<dt>メモ</dt><dd>${esc(r.record.memo)}</dd>` : ''}
        <dt>できること</dt><dd><ul class="restrictions">${rs.length ? rs.map((a) => `<li>${esc(restrictionJa(a))}</li>`).join('') : '<li>何でもできます（全権限）</li>'}</ul></dd>
        ${r.lastUsed ? `<dt>最後に使われた日時</dt><dd>${new Date(r.lastUsed).toLocaleString()}</dd>` : ''}
      </dl>`;
    box.hidden = false;
  } catch (err) {
    $('#inspect-error').textContent = err.message;
  }
});

// --- 起動 ---
updatePreview();
api('/api/state')
  .then(() => start())
  .catch((e) => {
    // 401 ならログイン画面はもう出ている。CLN につながらないだけなら画面を出してエラーを見せる
    if (e.message !== 'ログインしてください') start();
  });
