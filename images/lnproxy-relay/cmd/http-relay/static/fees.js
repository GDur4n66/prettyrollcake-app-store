// Status page: show and change the relay's fees through /fees.
// Pure helpers are exported for node tests (fees.test.js).
(function (root) {
  "use strict";

  // "1.5" with places 3 -> 1500. Exact: no floating point.
  function parseDecimal(text, places) {
    var s = String(text).trim();
    var m = /^(\d+)(?:\.(\d*))?$/.exec(s);
    if (!m) throw new Error("数字で入れてください");
    var frac = (m[2] || "").replace(/0+$/, "");
    if (frac.length > places) throw new Error("小数点以下は " + places + " 桁までです");
    var whole = m[1].replace(/^0+(?=\d)/, "");
    var n = BigInt(whole + frac.padEnd(places, "0"));
    if (n > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("大きすぎます");
    return Number(n);
  }

  // 1500 with places 3 -> "1.5"; grouping adds thousands separators.
  function formatDecimal(n, places, grouping) {
    var scale = Math.pow(10, places);
    var whole = String(Math.floor(n / scale));
    if (grouping) whole = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    var frac = String(n % scale).padStart(places, "0").replace(/0+$/, "");
    return frac ? whole + "." + frac : whole;
  }

  function sat(msat) { return formatDecimal(msat, 3, true); }
  function percent(ppm) { return formatDecimal(ppm, 4, true); }

  // The same integer arithmetic as relay.wrap (amounts in msat).
  function example(fees, amountMsat, estimateMsat) {
    var B = BigInt, M = B(1000000);
    var relayFee = B(fees.routing_fee_base_msat) + B(amountMsat) * B(fees.routing_fee_ppm) / M;
    var budget = B(estimateMsat) + B(fees.routing_budget_alpha_msat) + B(estimateMsat) * B(fees.routing_budget_beta_ppm) / M;
    return {
      relayFeeMsat: Number(relayFee),
      budgetMsat: Number(budget),
      totalMsat: Number(B(amountMsat) + relayFee + budget),
    };
  }

  // Form fields: id, JSON name, decimal places of the shown unit (sat = 3, % = 4),
  // and the relay's upper limit (relay.MaxFeeMsat, MaxFeePPM, MaxBetaPPM).
  var FIELDS = [
    ["fee-base", "routing_fee_base_msat", 3, 100000000],
    ["fee-ppm", "routing_fee_ppm", 4, 1000000],
    ["fee-alpha", "routing_budget_alpha_msat", 3, 100000000],
    ["fee-beta", "routing_budget_beta_ppm", 4, 100000000],
  ];

  // One field's text to its integer value, checked against the limit.
  function parseField(field, text) {
    var n = parseDecimal(text, field[2]);
    if (n > field[3]) {
      throw new Error(formatDecimal(field[3], field[2], true) + (field[2] === 3 ? " sat" : "%") + " までです");
    }
    return n;
  }

  function describe(fees) {
    return {
      relay: sat(fees.routing_fee_base_msat) + " sat ＋ 支払い金額の " + percent(fees.routing_fee_ppm) + "%",
      margin: "ノード見積額 × " + percent(fees.routing_budget_beta_ppm) + "% ＋ " +
        sat(fees.routing_budget_alpha_msat) + " sat",
    };
  }

  var ERRORS = {
    "wrong admin token": "管理用トークンが違います",
    "admin token is not set (LNPROXY_ADMIN_TOKEN)": "管理用トークンが設定されていないので変えられません",
    "unable to save": "保存できませんでした（リレーのログを見てください）",
  };

  function postFees(fetchFn, body) {
    return fetchFn("fees", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      cache: "no-store",
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        if (!res.ok) {
          var reason = data && data.reason;
          if (res.status === 401 && !reason) reason = "ログインが切れています。ページを読み込み直してください";
          throw new Error(ERRORS[reason] || reason || ("失敗しました（HTTP " + res.status + "）"));
        }
        return data;
      });
    });
  }

  var api = { parseDecimal: parseDecimal, parseField: parseField, formatDecimal: formatDecimal, example: example, describe: describe, postFees: postFees, FIELDS: FIELDS };
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
    return;
  }
  root.lnproxyFees = api;

  document.addEventListener("DOMContentLoaded", function () {
    var $ = function (id) { return document.getElementById(id); };
    var form = $("fee-form");
    if (!form) return;
    var message = $("fee-message");
    var state = null;

    function show(text, isError) {
      message.textContent = text;
      message.className = isError ? "error" : "note";
      message.hidden = !text;
    }

    function readForm() {
      var fees = {};
      FIELDS.forEach(function (f) {
        try {
          fees[f[1]] = parseField(f, $(f[0]).value);
        } catch (e) {
          var label = $(f[0]).closest("label").querySelector("span").textContent;
          throw new Error(label + "：" + e.message);
        }
      });
      // Not on the page (only for clients that send routing_msat): kept as is.
      fees.min_fee_budget_msat = state ? state.fees.min_fee_budget_msat : 1000;
      return fees;
    }

    function fillForm(fees) {
      FIELDS.forEach(function (f) { $(f[0]).value = formatDecimal(fees[f[1]], f[2], false); });
    }

    function updateExample() {
      var out = $("fee-example");
      try {
        var fees = readForm();
        var amount = parseDecimal($("ex-amount").value, 3);
        var estimate = parseDecimal($("ex-estimate").value, 3);
        var r = example(fees, amount, estimate);
        out.textContent = "リレー利用料 " + sat(r.relayFeeMsat) + " sat ＋ ルーティング手数料の予算 " + sat(r.budgetMsat) +
          " sat（ノード見積額 " + sat(estimate) + " ＋ マージン " + sat(r.budgetMsat - estimate) + "）→ 支払う額 " +
          sat(r.totalMsat) + " sat（上乗せ " + sat(r.relayFeeMsat + r.budgetMsat) + " sat）";
      } catch (e) {
        out.textContent = e.message;
      }
    }

    function render(data) {
      state = data;
      var d = describe(data.fees);
      $("fee-relay").textContent = d.relay;
      $("fee-margin").textContent = d.margin;
      $("fee-source").textContent = data.saved ? "このページで保存した値" : "起動時の値（環境変数・フラグか既定値）";
      var def = describe(data.defaults);
      $("fee-defaults").textContent = "起動時の値：リレー利用料 " + def.relay + "、マージン " + def.margin;
      fillForm(data.fees);
      setButtons();
      $("fee-no-admin").hidden = data.admin_token_set;
      updateExample();
    }

    function setButtons() {
      $("fee-reset").disabled = !state || !state.saved || !state.admin_token_set;
      $("fee-save").disabled = !state || !state.admin_token_set;
    }

    function submit(body, button, done) {
      var token = $("fee-admin").value.trim();
      if (!token) { show("管理用トークンを入れてください", true); return; }
      body.admin_token = token;
      var label = button.textContent;
      button.disabled = true;
      button.textContent = "送っています…";
      show("", false);
      postFees(fetch.bind(window), body).then(function (data) {
        render(data);
        show(done, false);
      }).catch(function (e) {
        show(e.message, true);
      }).then(function () {
        button.textContent = label;
        setButtons();
      });
    }

    form.addEventListener("input", updateExample);
    form.addEventListener("submit", function (e) {
      e.preventDefault();
      var fees;
      try { fees = readForm(); } catch (err) { show(err.message, true); return; }
      submit({ fees: fees }, $("fee-save"), "保存しました。これからラップするインボイスに使います。");
    });
    $("fee-reset").addEventListener("click", function () {
      submit({ reset: true }, $("fee-reset"), "起動時の値に戻しました。");
    });

    fetch("fees", { cache: "no-store" }).then(function (res) {
      if (!res.ok) throw new Error("HTTP " + res.status);
      return res.json();
    }).then(render).catch(function (e) {
      show("今の手数料を読めませんでした（" + e.message + "）", true);
    });
  });
})(this);
