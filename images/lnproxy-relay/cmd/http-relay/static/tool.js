// Status page tool: wrap an invoice or a Lightning Address invoice and watch
// its events. Pure helpers are exported for node tests (static/tool_test.js).
(function (root) {
  "use strict";

  // ---- bech32 (BOLT 11 has no 90-character limit) ----
  var CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";

  function polymod(values) {
    var gen = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
    var chk = 1;
    for (var i = 0; i < values.length; i++) {
      var top = chk >>> 25;
      chk = ((chk & 0x1ffffff) << 5) ^ values[i];
      for (var j = 0; j < 5; j++) if ((top >>> j) & 1) chk ^= gen[j];
    }
    return chk >>> 0;
  }

  function hrpExpand(hrp) {
    var out = [];
    for (var i = 0; i < hrp.length; i++) out.push(hrp.charCodeAt(i) >> 5);
    out.push(0);
    for (i = 0; i < hrp.length; i++) out.push(hrp.charCodeAt(i) & 31);
    return out;
  }

  function bech32Decode(str) {
    var s = str.toLowerCase();
    var pos = s.lastIndexOf("1");
    if (pos < 1 || pos + 7 > s.length) throw new Error("bech32 の形式ではありません");
    var hrp = s.slice(0, pos);
    var words = [];
    for (var i = pos + 1; i < s.length; i++) {
      var v = CHARSET.indexOf(s.charAt(i));
      if (v < 0) throw new Error("使えない文字が入っています");
      words.push(v);
    }
    if (polymod(hrpExpand(hrp).concat(words)) !== 1) throw new Error("チェックサムが合いません（どこかが欠けているか違います）");
    return { hrp: hrp, words: words.slice(0, -6) };
  }

  function wordsToBytes(words) {
    var acc = 0, bits = 0, out = [];
    for (var i = 0; i < words.length; i++) {
      acc = (acc << 5) | words[i];
      bits += 5;
      while (bits >= 8) {
        bits -= 8;
        out.push((acc >> bits) & 0xff);
      }
      acc &= (1 << bits) - 1;
    }
    return out;
  }

  function wordsToInt(words) {
    var n = 0;
    for (var i = 0; i < words.length; i++) n = n * 32 + words[i];
    return n;
  }

  function hex(bytes) {
    var s = "";
    for (var i = 0; i < bytes.length; i++) s += (bytes[i] < 16 ? "0" : "") + bytes[i].toString(16);
    return s;
  }

  function utf8Decode(bytes) {
    try {
      return decodeURIComponent(bytes.map(function (b) { return "%" + (b < 16 ? "0" : "") + b.toString(16); }).join(""));
    } catch (e) {
      return String.fromCharCode.apply(null, bytes);
    }
  }

  var NETWORKS = { bc: "mainnet", tb: "testnet", tbs: "signet", bcrt: "regtest", sb: "simnet" };
  // msat per unit of the amount in the human-readable part
  var MULTIPLIER_MSAT = { "": 100000000000, m: 100000000, u: 100000, n: 100 };

  function decodeInvoice(input) {
    var str = String(input || "").trim().replace(/^lightning:/i, "");
    var decoded = bech32Decode(str);
    var m = /^ln(bcrt|bc|tbs|tb|sb)(\d+)?([munp])?$/.exec(decoded.hrp);
    if (!m) throw new Error("ライトニングのインボイスではありません");
    var amountMsat = null;
    if (m[2]) {
      var units = Number(m[2]);
      if (m[3] === "p") {
        // pico-bitcoin: 10 p = 1 msat; anything finer cannot be paid
        if (units % 10 !== 0) throw new Error("金額が msat 単位になっていません");
        amountMsat = units / 10;
      } else {
        amountMsat = units * MULTIPLIER_MSAT[m[3] || ""];
      }
      if (!Number.isSafeInteger(amountMsat)) throw new Error("金額が読めません");
    }
    var words = decoded.words.slice(0, -104); // drop the 65-byte signature
    var result = {
      network: NETWORKS[m[1]],
      amountMsat: amountMsat,
      timestamp: wordsToInt(words.slice(0, 7)),
      expiry: 3600,
      paymentHash: null,
      description: null,
      descriptionHash: null
    };
    var i = 7;
    while (i + 3 <= words.length) {
      var type = words[i], len = words[i + 1] * 32 + words[i + 2];
      var data = words.slice(i + 3, i + 3 + len);
      i += 3 + len;
      if (type === 1 && len === 52) result.paymentHash = hex(wordsToBytes(data));
      else if (type === 13) result.description = utf8Decode(wordsToBytes(data));
      else if (type === 23 && len === 52) result.descriptionHash = hex(wordsToBytes(data));
      else if (type === 6) result.expiry = wordsToInt(data);
    }
    if (!result.paymentHash) throw new Error("payment hash が見つかりません");
    return result;
  }

  // ---- SHA-256 (crypto.subtle is unavailable over plain HTTP) ----
  var K = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
  ];

  function utf8Encode(str) {
    return Array.prototype.map.call(unescape(encodeURIComponent(str)), function (c) { return c.charCodeAt(0); });
  }

  function sha256Hex(str) {
    var bytes = utf8Encode(str);
    var bitLen = bytes.length * 8;
    bytes.push(0x80);
    while (bytes.length % 64 !== 56) bytes.push(0);
    for (var s = 7; s >= 0; s--) bytes.push(s >= 4 ? 0 : (bitLen >>> (s * 8)) & 0xff);
    var h = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
    var w = new Array(64);
    function rotr(x, n) { return (x >>> n) | (x << (32 - n)); }
    for (var off = 0; off < bytes.length; off += 64) {
      for (var t = 0; t < 16; t++) {
        w[t] = (bytes[off + 4 * t] << 24) | (bytes[off + 4 * t + 1] << 16) | (bytes[off + 4 * t + 2] << 8) | bytes[off + 4 * t + 3];
      }
      for (t = 16; t < 64; t++) {
        var s0 = rotr(w[t - 15], 7) ^ rotr(w[t - 15], 18) ^ (w[t - 15] >>> 3);
        var s1 = rotr(w[t - 2], 17) ^ rotr(w[t - 2], 19) ^ (w[t - 2] >>> 10);
        w[t] = (w[t - 16] + s0 + w[t - 7] + s1) | 0;
      }
      var a = h[0], b = h[1], c = h[2], d = h[3], e = h[4], f = h[5], g = h[6], k = h[7];
      for (t = 0; t < 64; t++) {
        var t1 = (k + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + K[t] + w[t]) | 0;
        var t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) | 0;
        k = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
      }
      h = [h[0] + a, h[1] + b, h[2] + c, h[3] + d, h[4] + e, h[5] + f, h[6] + g, h[7] + k].map(function (x) { return x | 0; });
    }
    return h.map(function (x) { return ("00000000" + (x >>> 0).toString(16)).slice(-8); }).join("");
  }

  // ---- Lightning Address (LUD-16), fetched by the browser, never by the relay ----
  function parseAddress(text) {
    var m = /^([a-z0-9\-_.+]+)@([a-z0-9\-.]+\.[a-z0-9\-]+)$/i.exec(String(text || "").trim());
    return m ? { user: m[1].toLowerCase(), domain: m[2].toLowerCase() } : null;
  }

  function metadataText(metadata) {
    try {
      var entries = JSON.parse(metadata);
      for (var i = 0; i < entries.length; i++) if (entries[i][0] === "text/plain") return entries[i][1];
    } catch (e) {}
    return null;
  }

  function getJSON(fetchFn, url, label) {
    return fetchFn(url, { headers: { Accept: "application/json" } }).then(function (response) {
      return response.json().catch(function () { throw new Error(label + "：JSON ではない応答（HTTP " + response.status + "）"); });
    }, function () {
      throw new Error(label + "に接続できません（相手がブラウザからの取得を許可していない可能性があります）");
    }).then(function (data) {
      if (data && String(data.status).toUpperCase() === "ERROR") throw new Error(label + "：" + (data.reason || "エラー"));
      return data;
    });
  }

  // Returns the recipient's invoice after the same checks as scripts/wrap_invoice.py.
  function invoiceFromAddress(fetchFn, address, amountMsat, comment) {
    var a = parseAddress(address);
    if (!a) return Promise.reject(new Error("ライトニングアドレスの形式ではありません"));
    var url = "https://" + a.domain + "/.well-known/lnurlp/" + encodeURIComponent(a.user);
    return getJSON(fetchFn, url, "ライトニングアドレス").then(function (pay) {
      if (pay.tag !== "payRequest" || !pay.callback) throw new Error("LNURL-pay の応答ではありません");
      if (amountMsat < pay.minSendable || amountMsat > pay.maxSendable) {
        throw new Error("金額は " + Math.ceil(pay.minSendable / 1000) + "〜" + Math.floor(pay.maxSendable / 1000) + " sats の範囲にしてください");
      }
      if (comment && !(pay.commentAllowed >= comment.length)) {
        throw new Error(pay.commentAllowed ? "メモは " + pay.commentAllowed + " 文字までです" : "この宛先はメモを受け付けません");
      }
      var callback = new URL(pay.callback);
      callback.searchParams.set("amount", String(amountMsat));
      if (comment) callback.searchParams.set("comment", comment);
      return getJSON(fetchFn, callback.toString(), "インボイスの取得").then(function (res) {
        if (!res.pr) throw new Error("インボイスが返ってきませんでした");
        var inv = decodeInvoice(res.pr);
        if (inv.amountMsat !== amountMsat) throw new Error("受け取ったインボイスの金額が指定と違います");
        if (inv.descriptionHash) {
          if (inv.descriptionHash !== sha256Hex(pay.metadata)) throw new Error("インボイスの description hash が LNURL のメタデータと合いません");
        } else {
          // Some services (e.g. Wallet of Satoshi) put a plain description instead.
          var expected = comment || metadataText(pay.metadata);
          if (inv.description !== expected) throw new Error("インボイスの説明がメモまたは LNURL のメタデータと合いません");
        }
        return res.pr;
      });
    });
  }

  function wrapInvoice(fetchFn, invoice, token, description) {
    var body = { invoice: invoice, token: token };
    if (description) body.description = description;
    return fetchFn("spec", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    }).then(function (response) { return response.json(); }).then(function (data) {
      if (!data.proxy_invoice) throw new Error("リレー：" + (data.reason || "ラップできませんでした"));
      var original = decodeInvoice(invoice), wrapped = decodeInvoice(data.proxy_invoice);
      if (wrapped.paymentHash !== original.paymentHash || wrapped.network !== original.network) {
        throw new Error("ラップしたインボイスの payment hash かネットワークが元と違います");
      }
      return { invoice: data.proxy_invoice, original: original, wrapped: wrapped };
    });
  }

  var STATE_LABELS = {
    OPEN: "支払い待ち",
    ACCEPTED: "受け取りを保留し、元のインボイスを支払い中",
    PREIMAGE_OBTAINED: "元のインボイスを支払いました",
    SETTLED_LOCAL: "完了",
    PAYMENT_FAILED: "元のインボイスの支払いに失敗",
    PAYMENT_UNKNOWN: "元のインボイスの支払い結果が不明",
    CANCELED: "取り消し",
    CANCELLATION_UNKNOWN: "取り消しの結果が不明",
    SETTLEMENT_UNKNOWN: "確定の結果が不明"
  };

  function sat(msat) {
    var s = (msat / 1000).toLocaleString("ja-JP", { maximumFractionDigits: 3 });
    return s + " sats";
  }

  var api = {
    bech32Decode: bech32Decode,
    decodeInvoice: decodeInvoice,
    sha256Hex: sha256Hex,
    parseAddress: parseAddress,
    invoiceFromAddress: invoiceFromAddress,
    wrapInvoice: wrapInvoice,
    STATE_LABELS: STATE_LABELS
  };
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
    return;
  }
  root.LnproxyTool = api;

  // ---- page ----
  function $(id) { return document.getElementById(id); }

  function storage(key, value) {
    try {
      if (value === undefined) return localStorage.getItem(key);
      localStorage.setItem(key, value);
    } catch (e) {}
    return null;
  }

  function newToken() {
    var bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    return hex(Array.prototype.slice.call(bytes));
  }

  function copyText(button, text, field) {
    function done() {
      var label = button.textContent;
      button.textContent = "コピーしました";
      setTimeout(function () { button.textContent = label; }, 1500);
    }
    function fallback() {
      // Umbrel is often opened over plain HTTP, where the Clipboard API is unavailable.
      if (!field) return;
      field.focus();
      field.select();
      try { if (document.execCommand("copy")) done(); } catch (e) {}
    }
    if (navigator.clipboard && window.isSecureContext) navigator.clipboard.writeText(text).then(done, fallback);
    else fallback();
  }

  document.addEventListener("DOMContentLoaded", function () {
    var origin = location.origin;
    var tokenInput = $("token");
    var token = storage("lnproxy-token");
    if (!token) {
      token = newToken();
      storage("lnproxy-token", token);
    }
    tokenInput.value = token;
    $("origin").textContent = origin;

    function renderExamples() {
      $("ex-events").textContent = 'curl -N "' + origin + "/events?token=" + token + '"';
      $("ex-spec").textContent =
        "curl -s -X POST " + origin + "/spec \\\n" +
        "  -H 'Content-Type: application/json' \\\n" +
        "  -d '{\"invoice\":\"<元のインボイス>\",\"token\":\"" + token + "\"}'";
    }

    // ---- events ----
    var current = null; // payment hash of the invoice wrapped on this page
    var source = null;
    var list = $("events");
    function setConnection(text, ok) {
      $("conn").textContent = text;
      $("conn").className = "conn" + (ok ? " ok" : "");
    }
    function addEvent(event) {
      var empty = $("events-empty");
      if (empty) empty.remove();
      var li = document.createElement("li");
      li.className = "ev" + (event.original_invoice_paid ? " paid" : "") + (event.payment_hash === current ? " current" : "");
      li.dataset.hash = event.payment_hash;
      var time = document.createElement("span");
      time.className = "ev-time";
      time.textContent = new Date().toLocaleTimeString("ja-JP");
      var hash = document.createElement("code");
      hash.textContent = event.payment_hash.slice(0, 8) + "…";
      hash.title = event.payment_hash;
      var state = document.createElement("span");
      state.className = "ev-state";
      state.textContent = (STATE_LABELS[event.state] || event.state) + "（" + event.state + "）";
      li.appendChild(time);
      li.appendChild(hash);
      li.appendChild(state);
      list.insertBefore(li, list.firstChild);
      if (event.payment_hash === current) showPaymentState(event);
    }
    function connect() {
      if (source) source.close();
      list.textContent = "";
      var li = document.createElement("li");
      li.id = "events-empty";
      li.className = "muted";
      li.textContent = "このトークンでラップしたインボイスの状態がここに出ます。";
      list.appendChild(li);
      setConnection("接続中…", false);
      source = new EventSource("events?token=" + encodeURIComponent(token));
      source.onopen = function () { setConnection("受信中", true); };
      source.onerror = function () { setConnection("再接続を待っています", false); };
      source.addEventListener("invoice_state", function (message) {
        try { addEvent(JSON.parse(message.data)); } catch (e) {}
      });
    }

    function showPaymentState(event) {
      var box = $("pay-state");
      box.hidden = false;
      box.className = "pay-state" + (event.original_invoice_paid ? " paid" : (/FAILED|CANCELED|UNKNOWN/.test(event.state) ? " failed" : ""));
      box.textContent = event.original_invoice_paid ? "元のインボイスは支払われました" : (STATE_LABELS[event.state] || event.state);
    }

    // ---- wrap form ----
    var target = $("target");
    function updateMode() {
      var isAddress = !!parseAddress(target.value);
      $("address-fields").hidden = !isAddress;
    }
    target.addEventListener("input", updateMode);

    $("wrap-form").addEventListener("submit", function (e) {
      e.preventDefault();
      var button = $("wrap-button");
      var error = $("wrap-error");
      error.hidden = true;
      $("result").hidden = true;
      button.disabled = true;
      button.textContent = "ラップしています…";
      var text = target.value.trim();
      var description = $("wrapped-memo").value.trim();
      var step;
      if (parseAddress(text)) {
        var amount = Number($("amount").value);
        if (!(amount > 0)) {
          step = Promise.reject(new Error("金額（sats）を入れてください"));
        } else {
          step = invoiceFromAddress(fetch.bind(window), text, Math.round(amount * 1000), $("comment").value.trim());
        }
      } else {
        step = Promise.resolve(text.replace(/^lightning:/i, ""));
      }
      step.then(function (invoice) {
        return wrapInvoice(fetch.bind(window), invoice, token, description);
      }).then(function (r) {
        current = r.wrapped.paymentHash;
        $("wrapped").value = r.invoice;
        $("open-wallet").href = "lightning:" + r.invoice;
        var qr = qrcode(0, "L");
        qr.addData(r.invoice.toUpperCase(), "Alphanumeric");
        qr.make();
        $("qr").src = qr.createDataURL(5, 4);
        $("amounts").textContent =
          "元：" + sat(r.original.amountMsat) + " → 支払う額：" + sat(r.wrapped.amountMsat) +
          "（上乗せ " + sat(r.wrapped.amountMsat - r.original.amountMsat) + "）";
        $("hash").textContent = r.wrapped.paymentHash;
        $("pay-state").hidden = true;
        $("result").hidden = false;
        Array.prototype.forEach.call(list.querySelectorAll(".ev"), function (li) {
          li.classList.toggle("current", li.dataset.hash === current);
        });
      }).catch(function (err) {
        error.textContent = err.message;
        error.hidden = false;
      }).then(function () {
        button.disabled = false;
        button.textContent = "ラップする";
      });
    });

    $("copy-wrapped").addEventListener("click", function (e) {
      copyText(e.currentTarget, $("wrapped").value, $("wrapped"));
    });
    $("copy-token").addEventListener("click", function (e) {
      copyText(e.currentTarget, token, tokenInput);
    });
    $("new-token").addEventListener("click", function () {
      token = newToken();
      storage("lnproxy-token", token);
      tokenInput.value = token;
      current = null;
      $("result").hidden = true;
      renderExamples();
      connect();
    });

    updateMode();
    renderExamples();
    connect();
  });
})(this);
