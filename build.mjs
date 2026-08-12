// 保有・ウォッチ銘柄の騰落率一覧ページを生成する。
// 実行: node build.mjs
// 入力: watchlist.csv  出力: docs/index.html

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(fileURLToPath(import.meta.url));
const CSV_PATH = join(ROOT, "watchlist.csv");
const OUT_PATH = join(ROOT, "docs", "index.html");

// 棒グラフの高さ上限に対応する日次騰落率。これを超える日は頭打ちで描く。
const BAR_FULL_SCALE = 3.0;

// 基準日。watchlist.csv の基準日が空欄の銘柄は、この日の終値と比較する。
// 全銘柄の基準をまとめて変えたいときは、ここを書き換える。
const DEFAULT_BASE_DATE = "2026-08-03";

// ---- CSV ----------------------------------------------------------------

function parseCsv(text) {
  const rows = [];
  for (const raw of text.replace(/^﻿/, "").split(/\r?\n/)) {
    if (!raw.trim()) continue;
    const cells = [];
    let cur = "";
    let quoted = false;
    for (let i = 0; i < raw.length; i++) {
      const ch = raw[i];
      if (quoted) {
        if (ch === '"' && raw[i + 1] === '"') { cur += '"'; i++; }
        else if (ch === '"') quoted = false;
        else cur += ch;
      } else if (ch === '"') quoted = true;
      else if (ch === ",") { cells.push(cur); cur = ""; }
      else cur += ch;
    }
    cells.push(cur);
    rows.push(cells.map((c) => c.trim()));
  }
  return rows;
}

// WATCHLIST_URL を指定するとそちらを読む。Googleスプレッドシートの
// 「ウェブに公開」で発行したCSVのURLを想定している。未指定なら手元のCSV。
async function loadCsvText() {
  const url = process.env.WATCHLIST_URL;
  if (!url) return readFile(CSV_PATH, "utf8");
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`銘柄リストの取得に失敗: HTTP ${res.status}`);
  return res.text();
}

async function readWatchlist() {
  const rows = parseCsv(await loadCsvText());
  const header = rows.shift() ?? [];
  const col = (name) => header.indexOf(name);
  const iKind = col("区分"), iCode = col("コード");
  const iName = col("銘柄名"), iBase = col("基準日"), iMemo = col("メモ");
  return rows
    .filter((r) => r[iCode])
    .map((r) => ({
      kind: r[iKind] === "ウォッチ" ? "watch" : "hold",
      code: r[iCode],
      name: iName >= 0 ? r[iName] || "" : "",
      baseDate: iBase >= 0 ? r[iBase] || "" : "",
      memo: iMemo >= 0 ? r[iMemo] || "" : "",
    }));
}

// ---- 株価取得 ------------------------------------------------------------

async function fetchSeries(code) {
  const url =
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(code)}.T` +
    `?range=2y&interval=1d`;
  const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const result = (await res.json())?.chart?.result?.[0];
  if (!result) throw new Error("データなし");

  const closes = [];
  result.timestamp.forEach((t, i) => {
    const close = result.indicators.quote[0].close[i];
    if (close == null) return;
    closes.push({ date: new Date(t * 1000).toISOString().slice(0, 10), close });
  });
  if (!closes.length) throw new Error("終値なし");

  return { name: result.meta.longName || result.meta.shortName || "", closes };
}

// ---- 騰落率の計算 --------------------------------------------------------

const pct = (now, then) => (then ? ((now / then - 1) * 100) : null);

// 指定日以前で直近の終値。基準日が休場日でも手前の営業日を拾う。
function closeOnOrBefore(closes, isoDate) {
  for (let i = closes.length - 1; i >= 0; i--) {
    if (closes[i].date <= isoDate) return closes[i];
  }
  return null;
}

function shiftMonths(isoDate, months) {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + months);
  return d.toISOString().slice(0, 10);
}

function buildMetrics(item, series) {
  const { closes } = series;
  const last = closes.at(-1);
  const at = (backFromEnd) => closes.at(-1 - backFromEnd) ?? null;

  const base = closeOnOrBefore(closes, item.baseDate || DEFAULT_BASE_DATE) ?? closes[0];
  const month = closeOnOrBefore(closes, shiftMonths(last.date, -1));

  // 直近5営業日ぶんの日次騰落率。
  const recent = [];
  for (let i = 4; i >= 0; i--) {
    const cur = at(i), prev = at(i + 1);
    if (cur && prev) recent.push({ date: cur.date, change: pct(cur.close, prev.close) });
  }

  return {
    ...item,
    name: item.name || series.name,
    price: last.close,
    lastDate: last.date,
    day: at(1) ? pct(last.close, at(1).close) : null,
    week: at(5) ? pct(last.close, at(5).close) : null,
    month: month ? pct(last.close, month.close) : null,
    base: pct(last.close, base.close),
    baseDiff: last.close - base.close,
    basePrice: base.close,
    baseDate: base.date,
    recent,
  };
}

// 直近の値動きを一言で言い換える。値動きの説明のみで、良し悪しの判断は含めない。
function commentOf(recent, day) {
  if (day == null) return "";
  if (day >= 5) return "急騰";
  if (day <= -5) return "急落";

  const changes = recent.map((r) => r.change);
  const latest = changes.at(-1);
  if (latest == null) return "";
  if (latest === 0) return "変わらず";

  let run = 1;
  for (let i = changes.length - 2; i >= 0; i--) {
    if (Math.sign(changes[i]) !== Math.sign(latest)) break;
    run++;
  }
  if (run >= 3) return `${run}日${latest > 0 ? "続伸" : "続落"}`;
  if (changes.every((c) => Math.abs(c) < 0.5)) return "小動き";

  const prev = changes.at(-2);
  if (prev != null && latest > 0 && prev < 0) return "反発";
  if (prev != null && latest < 0 && prev > 0) return "反落";
  return "";
}

// ---- HTML ---------------------------------------------------------------

const esc = (s) =>
  String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

const fmtPct = (v) => (v == null ? "—" : `${v >= 0 ? "+" : ""}${v.toFixed(1)}%`);
const fmtYen = (v) => `${v >= 0 ? "+" : "−"}${Math.abs(v).toLocaleString("ja-JP", { maximumFractionDigits: 1 })}円`;
const fmtPrice = (v) => v.toLocaleString("ja-JP", { maximumFractionDigits: 1 });
const dirOf = (v) => (v == null ? "flat" : v > 0 ? "up" : v < 0 ? "down" : "flat");
const mmdd = (iso) => `${Number(iso.slice(5, 7))}/${Number(iso.slice(8, 10))}`;

function renderBars(recent) {
  const bars = recent
    .map(({ date, change }) => {
      const h = Math.max(1, Math.round(Math.min(Math.abs(change) / BAR_FULL_SCALE, 1) * 14));
      const side = change >= 0 ? "up" : "down";
      return `<i class="bar ${side}" style="height:${h}px" title="${date} ${fmtPct(change)}"></i>`;
    })
    .join("");
  return `<div class="bars">${bars}</div>`;
}

const sortKey = (v) => (v == null ? "" : v.toFixed(4));

function renderRow(m, order) {
  const nums = m.recent
    .map((r) => `<span class="${dirOf(r.change)}">${mmdd(r.date)} ${fmtPct(r.change)}</span>`)
    .join("");
  const comment = commentOf(m.recent, m.day);
  const sub = [m.code, m.memo].filter(Boolean).join(" ・ ");
  const baseDir = dirOf(m.base);

  return `<div class="row" tabindex="0" data-order="${order}"
     data-v-day="${sortKey(m.day)}" data-v-week="${sortKey(m.week)}" data-v-month="${sortKey(m.month)}">
  <div class="name">${esc(m.name)}</div>
  <div class="sub">${esc(sub)}${comment ? `<b class="tag">${comment}</b>` : ""}</div>
  ${renderBars(m.recent)}
  <div class="top"><span class="price">${fmtPrice(m.price)}円</span>
    <span class="lead ${dirOf(m.day)}" data-day="${fmtPct(m.day)}" data-week="${fmtPct(m.week)}" data-month="${fmtPct(m.month)}"
       data-day-dir="${dirOf(m.day)}" data-week-dir="${dirOf(m.week)}" data-month-dir="${dirOf(m.month)}">${fmtPct(m.day)}</span></div>
  <div class="bot">基準 <span class="${baseDir}">${fmtYen(m.baseDiff)}</span>
    <span class="${baseDir}">${fmtPct(m.base)}</span></div>
  <div class="detail">
    <div class="daily">${nums}</div>
    <div class="meta">基準日 ${m.baseDate} の終値 ${fmtPrice(m.basePrice)}円
      ・ <a href="https://finance.yahoo.co.jp/quote/${esc(m.code)}.T" target="_blank" rel="noopener">Yahooで詳細</a></div>
  </div>
</div>`;
}

function renderSection(title, items) {
  if (!items.length) return "";
  const rows = items.map(renderRow).join("");
  return `<div class="group"><h2 class="section">${title}<span>${items.length}</span></h2>${rows}</div>`;
}

function renderPage(metrics, errors) {
  const asOf = metrics[0]?.lastDate ?? "";
  const span = metrics[0]?.recent ?? [];
  const spanLabel = span.length ? `${mmdd(span[0].date)} → ${mmdd(span.at(-1).date)}` : "";
  const baseLabel = metrics[0] ? mmdd(metrics[0].baseDate) : "";
  const updated = new Date().toLocaleString("ja-JP", {
    timeZone: "Asia/Tokyo", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit",
  });

  // 取引時間中に生成した場合、最新の値はまだ終値ではないので言い方を変える。
  const jst = new Date(Date.now() + 9 * 3600 * 1000);
  const duringSession =
    asOf === jst.toISOString().slice(0, 10) &&
    jst.getUTCHours() * 60 + jst.getUTCMinutes() < 15 * 60 + 30;
  const priceLabel = duringSession ? "現在値（取引時間中）" : "終値";

  const errBlock = errors.length
    ? `<div class="errors">取得できませんでした： ${errors.map((e) => esc(`${e.code}（${e.message}）`)).join(" / ")}</div>`
    : "";

  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="robots" content="noindex, nofollow">
<meta name="theme-color" content="#ffffff" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#16161a" media="(prefers-color-scheme: dark)">
<title>銘柄ウォッチ</title>
<style>
:root{
  --bg:#fff; --card:#fafaf8; --text:#1a1a18; --sub:#8a8a84; --line:#e4e4de;
  --up:#c62828; --down:#1565c0; --flat:#8a8a84;
}
@media (prefers-color-scheme:dark){
  :root{ --bg:#16161a; --card:#1e1e23; --text:#ececeb; --sub:#8f8f95; --line:#32323a;
         --up:#ef7b7b; --down:#6ea8f0; --flat:#8f8f95; }
}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);
  font-family:-apple-system,BlinkMacSystemFont,"Hiragino Sans","Yu Gothic UI","Meiryo",sans-serif;
  font-size:15px;-webkit-text-size-adjust:100%}
.wrap{max-width:620px;margin:0 auto;padding:0 14px 40px}
header{position:sticky;top:0;background:var(--bg);padding:14px 0 10px;border-bottom:.5px solid var(--line);z-index:2}
.asof{display:flex;align-items:baseline;justify-content:space-between}
.asof b{font-size:16px;font-weight:600}
.asof time{font-size:11px;color:var(--sub)}
.legend{margin-top:3px;font-size:11px;color:var(--sub)}
.legend i{font-style:normal}
.tabs{display:flex;gap:6px;margin-top:10px}
.tabs button{flex:1;padding:7px 0;font:inherit;font-size:13px;color:var(--sub);
  background:transparent;border:.5px solid var(--line);border-radius:7px;cursor:pointer}
.tabs button[aria-pressed=true]{color:var(--text);background:var(--card);border-color:var(--sub)}
.sortbar{display:flex;align-items:center;gap:6px;margin-top:7px;font-size:11px;color:var(--sub)}
.sortbar button{padding:3px 9px;font:inherit;font-size:11px;color:var(--sub);
  background:transparent;border:.5px solid var(--line);border-radius:20px;cursor:pointer}
.sortbar button[aria-pressed=true]{color:var(--text);background:var(--card);border-color:var(--sub)}
.section{display:flex;align-items:center;gap:7px;margin:18px 0 0;padding-bottom:5px;
  font-size:11px;font-weight:600;letter-spacing:.06em;color:var(--sub)}
.section span{font-weight:400;opacity:.7}
.row{display:grid;grid-template-columns:minmax(0,1fr) 54px 112px;column-gap:8px;row-gap:1px;
  padding:9px 2px;border-top:.5px solid var(--line);cursor:pointer}
.row:focus{outline:none}
.name{grid-column:1;grid-row:1;font-size:14px;font-weight:600;
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.sub{grid-column:1;grid-row:2;font-size:11px;color:var(--sub);
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.tag{margin-left:6px;padding:1px 6px;border-radius:20px;font-weight:400;
  color:var(--text);background:var(--card);border:.5px solid var(--line)}
.bars{grid-column:2;grid-row:1/3;align-self:center;display:flex;align-items:center;gap:3px;height:32px;
  background:linear-gradient(var(--sub),var(--sub)) left 50%/100% .5px no-repeat;opacity:.95}
.bar{display:block;width:8px;border-radius:1px}
.bar.up{background:var(--up);align-self:flex-end;margin-bottom:16px}
.bar.down{background:var(--down);align-self:flex-start;margin-top:16px}
.top{grid-column:3;grid-row:1;text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
.bot{grid-column:3;grid-row:2;text-align:right;font-size:10.5px;color:var(--sub);
  font-variant-numeric:tabular-nums;white-space:nowrap}
.price{font-size:12px;color:var(--sub)}
.lead{margin-left:5px;font-size:14px;font-weight:600}
.bot span{margin-left:4px}
.up{color:var(--up)} .down{color:var(--down)} .flat{color:var(--flat)}
.detail{display:none;grid-column:1/-1;padding:3px 0 2px}
.row.open .detail{display:block}
.daily{display:flex;flex-wrap:wrap;gap:4px 10px;font-size:12px;font-variant-numeric:tabular-nums}
.meta{margin-top:5px;font-size:11px;color:var(--sub)}
.meta a{color:inherit}
.errors{margin-top:14px;padding:9px 11px;border-radius:7px;font-size:12px;
  background:var(--card);color:var(--sub)}
.foot{margin-top:22px;font-size:11px;color:var(--sub);line-height:1.7}
</style>
</head>
<body>
<div class="wrap">
<header>
  <div class="asof"><b>${asOf} ${priceLabel}</b><time>${updated} 更新</time></div>
  <div class="legend">基準日 ${baseLabel}　／　棒＝直近5営業日 ${spanLabel}
    <i class="up">■</i>上昇 <i class="down">■</i>下落　／　行をタップで内訳</div>
  <div class="tabs">
    <button data-key="day" aria-pressed="true">前日比</button>
    <button data-key="week" aria-pressed="false">1週</button>
    <button data-key="month" aria-pressed="false">1ヶ月</button>
  </div>
  <div class="sortbar">並び
    <button data-sort="code" aria-pressed="true">コード順</button>
    <button data-sort="move" aria-pressed="false">変動が大きい順</button>
  </div>
</header>
${renderSection("保有", metrics.filter((m) => m.kind === "hold"))}
${renderSection("ウォッチ", metrics.filter((m) => m.kind === "watch"))}
${errBlock}
<p class="foot">株価データ: Yahoo Finance（終値ベース）。棒の高さは日次±${BAR_FULL_SCALE}%で頭打ち。<br>
基準日が空欄の銘柄は年初来で計算しています。</p>
</div>
<script>
document.querySelectorAll(".row").forEach(row => {
  row.addEventListener("click", e => {
    if (e.target.closest("a")) return;
    row.classList.toggle("open");
  });
});
let metric = "day";
let sortMode = "code";

// 変動順は、いま表示している期間（前日／1週／1ヶ月）の変動幅で並べる。
function applySort() {
  document.querySelectorAll(".group").forEach(group => {
    const rows = [...group.querySelectorAll(".row")];
    const width = row => {
      const v = parseFloat(row.dataset["v" + metric[0].toUpperCase() + metric.slice(1)]);
      return Number.isFinite(v) ? Math.abs(v) : -1;
    };
    rows.sort(sortMode === "move"
      ? (a, b) => width(b) - width(a)
      : (a, b) => a.dataset.order - b.dataset.order);
    rows.forEach(row => group.appendChild(row));
  });
}

document.querySelectorAll(".tabs button").forEach(btn => {
  btn.addEventListener("click", () => {
    metric = btn.dataset.key;
    document.querySelectorAll(".tabs button").forEach(b =>
      b.setAttribute("aria-pressed", String(b === btn)));
    document.querySelectorAll(".lead").forEach(el => {
      el.textContent = el.dataset[metric];
      el.className = "lead " + el.dataset[metric + "Dir"];
    });
    applySort();
  });
});

document.querySelectorAll(".sortbar button").forEach(btn => {
  btn.addEventListener("click", () => {
    sortMode = btn.dataset.sort;
    document.querySelectorAll(".sortbar button").forEach(b =>
      b.setAttribute("aria-pressed", String(b === btn)));
    applySort();
  });
});
</script>
</body>
</html>
`;
}

// ---- main ---------------------------------------------------------------

const watchlist = await readWatchlist();
const metrics = [];
const errors = [];

for (const item of watchlist) {
  try {
    metrics.push(buildMetrics(item, await fetchSeries(item.code)));
    process.stdout.write(`${item.code} ok\n`);
  } catch (err) {
    errors.push({ code: item.code, message: err.message });
    process.stdout.write(`${item.code} NG (${err.message})\n`);
  }
  await new Promise((r) => setTimeout(r, 150));
}

await mkdir(dirname(OUT_PATH), { recursive: true });
await writeFile(OUT_PATH, renderPage(metrics, errors), "utf8");
console.log(`\n${metrics.length}銘柄 → ${OUT_PATH}`);
