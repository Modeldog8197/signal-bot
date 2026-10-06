import { generateDemo, parseCSV, toCSV } from "./engine.js";
const $ = (id) => document.getElementById(id);
const number = (v, d = 0) =>
  v === null
    ? "—"
    : new Intl.NumberFormat("en-IN", { maximumFractionDigits: d }).format(v);
const pct = (v) => (v === null ? "—" : `${(v * 100).toFixed(2)}%`);
const escape = (s) =>
  String(s).replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
let dataset = generateDemo(),
  report,
  runDataset,
  pendingDataset,
  requestId = 0;
const worker = new Worker("./research-worker.js", { type: "module" });
function download(name, content, type = "text/csv") {
  const url = URL.createObjectURL(new Blob([content], { type })),
    a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function csv(rows) {
  return (
    rows
      .map((row) =>
        row
          .map((cell) => '"' + String(cell ?? "").replaceAll('"', '""') + '"')
          .join(","),
      )
      .join("\n") + "\n"
  );
}
function config() {
  return {
    capital: Number($("capital").value),
    feeBps: Number($("fee").value),
    slippageBps: Number($("slip").value),
    rsiEntry: Number($("entry").value),
    trendPeriod: Number($("trend").value),
    volumeFactor: Number($("volume-factor").value),
    maxHolding: Number($("holding").value),
    selection: $("selection").value,
    useTrend: $("use-trend").checked,
    useVolume: $("use-volume").checked,
  };
}
function showError(message) {
  $("error").textContent = message;
  $("error").hidden = false;
}
function busy(active) {
  $("run").disabled = active;
  for (const id of [
    "export-json",
    "export-ledger",
    "export-equity",
    "export-data",
  ])
    $(id).disabled = active || !report;
}
function run() {
  $("error").hidden = true;
  busy(true);
  $("run-status").textContent =
    "Computing features, evaluation, ablations and cost sensitivity…";
  const id = ++requestId;
  pendingDataset = dataset;
  worker.postMessage({ id, dataset, config: config() });
}
function plot() {
  const a = report.result.equity,
    b = report.benchmark.equity,
    capital = report.selectedConfig.capital;
  const W = 980,
    H = 310,
    L = 72,
    R = 18,
    T = 16,
    B = 35,
    values = [capital, ...a.map((p) => p.value), ...b.map((p) => p.value)],
    low = Math.min(...values) * 0.98,
    high = Math.max(...values) * 1.02;
  const x = (i) => L + (i / (a.length - 1)) * (W - L - R),
    y = (v) => T + ((high - v) / (high - low)) * (H - T - B);
  const line = (points) =>
    points
      .map(
        (p, i) => `${i ? "L" : "M"}${x(i).toFixed(2)},${y(p.value).toFixed(2)}`,
      )
      .join(" ");
  let grid = "";
  for (let i = 0; i < 5; i++) {
    const value = low + ((high - low) * i) / 4;
    grid += `<line x1="${L}" x2="${W - R}" y1="${y(value)}" y2="${y(value)}" stroke="#334155"/><text x="${L - 10}" y="${y(value) + 4}" text-anchor="end">${number(value)}</text>`;
  }
  const ticks = [0, Math.floor((a.length - 1) / 2), a.length - 1]
    .map(
      (i) =>
        `<text x="${x(i)}" y="${H - 7}" text-anchor="${i === a.length - 1 ? "end" : "middle"}">${a[i].date}</text>`,
    )
    .join("");
  $("equity-chart").innerHTML =
    `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Later-period equity comparison: rule ${pct(report.result.metrics.totalReturn)}, buy and hold ${pct(report.benchmark.metrics.totalReturn)}. Download equity CSV for every value."><title>Net portfolio equity at daily close</title>${grid}<line x1="${L}" x2="${W - R}" y1="${y(capital)}" y2="${y(capital)}" stroke="#909caf" stroke-dasharray="4 5"/><path d="${line(b)}" fill="none" stroke="#7dbaaa" stroke-width="2"/><path d="${line(a)}" fill="none" stroke="#85a8fc" stroke-width="2.5"/>${ticks}</svg>`;
}
function render() {
  const { result, benchmark, selectedConfig: c, dataset: d, split } = report,
    m = result.metrics,
    b = benchmark.metrics;
  $("source-banner").innerHTML =
    d.kind === "synthetic"
      ? `<strong>Synthetic fixture</strong><span>Fictional assets, seed ${d.seed}. These results are software demonstrations, not historical stock-market performance.</span>`
      : `<strong>Imported daily bars</strong><span>${escape(d.source)} · OHLC adjustment declared by the uploader; not independently verified.</span>`;
  $("mode").textContent = d.kind.toUpperCase();
  $("window").textContent =
    `${split.evaluationStart} → ${split.evaluationEnd} · ${split.evaluationSessions} sessions · ${d.symbols.length} assets`;
  $("stats").innerHTML = [
    ["Net return", pct(m.totalReturn), `Buy & hold ${pct(b.totalReturn)}`],
    [
      "Maximum drawdown",
      pct(m.maxDrawdown),
      `Buy & hold ${pct(b.maxDrawdown)}`,
    ],
    ["Closed trades", number(m.closedTrades), `Win rate ${pct(m.winRate)}`],
    [
      "Trading friction",
      number(m.totalFees + m.totalSlippage),
      `Fees + estimated slippage · ${d.currency}`,
    ],
  ]
    .map(
      ([label, value, caption]) =>
        `<div class="stat"><small>${label}</small><strong>${value}</strong><p>${caption}</p></div>`,
    )
    .join("");
  $("equity-caption").textContent =
    `${d.currency} · ${number(c.capital)} initial cash · ${c.feeBps} bps fee + ${c.slippageBps} bps slippage per side`;
  const gap = m.totalReturn - b.totalReturn;
  $("finding").innerHTML =
    `<strong>The rule ${gap >= 0 ? "leads" : "trails"} buy & hold by ${Math.abs(gap * 100).toFixed(2)} percentage points.</strong><p>Average market exposure: ${pct(m.averageExposure)}. ${m.closedTrades < 20 ? "Fewer than 20 closed trades: this is a small sample. " : ""}Compare exposure and drawdown before interpreting return. ${d.kind === "synthetic" ? "The fixture cannot establish a real-market edge." : "The supplied asset set may introduce selection and survivorship bias."} Sharpe (${number(m.sharpe, 2)}) assumes a zero risk-free rate; no significance claim is made.</p>`;
  $("ablation-rows").innerHTML = report.ablations
    .map(
      (r) =>
        `<tr><td>${escape(r.label)}</td><td>${pct(r.totalReturn)}</td><td>${pct(r.maxDrawdown)}</td><td>${r.closedTrades}</td></tr>`,
    )
    .join("");
  $("cost-rows").innerHTML = report.sensitivity
    .map(
      (r) =>
        `<tr><td>${r.bps} bps / side</td><td>${pct(r.totalReturn)}</td><td>${number(r.totalFees + r.totalSlippage, 2)}</td></tr>`,
    )
    .join("");
  $("ledger-count").textContent = `${result.ledger.length} fills`;
  $("ledger-rows").innerHTML =
    result.ledger
      .slice(0, 100)
      .map(
        (t) =>
          `<tr><td>${t.signalDate ?? "—"}</td><td>${t.date}</td><td>${escape(t.symbol)}</td><td><span class="${t.side}">${t.side.toUpperCase()}</span></td><td>${t.quantity}</td><td>${number(t.rawOpen, 2)} → ${number(t.fillPrice, 2)}</td><td>${number(t.fee, 2)}</td><td>${escape(t.reason)}</td></tr>`,
      )
      .join("") ||
    '<tr><td colspan="8">No executions under this rule. A zero-trade result is retained.</td></tr>';
  $("ledger-note").textContent =
    `Showing the first ${Math.min(100, result.ledger.length)} executions. The CSV and JSON include the complete ledger, including cash after each fill.`;
  $("open-positions").textContent = result.openPositions.length
    ? result.openPositions
        .map(
          (p) =>
            `${p.symbol}: ${p.quantity} shares, marked at ${number(p.mark, 2)}; unrealized net P&L ${number(p.unrealizedPnl, 2)}`,
        )
        .join(" · ")
    : "No positions remain open at the final close.";
  $("trade-rows").innerHTML =
    result.trades
      .map(
        (t) =>
          `<tr><td>${escape(t.symbol)}</td><td>${t.entryDate}</td><td>${t.exitDate}</td><td>${t.holdingSessions}</td><td>${number(t.pnl, 2)}</td></tr>`,
      )
      .join("") || '<tr><td colspan="5">No closed trades.</td></tr>';
  $("development-copy").textContent =
    `Validation window ${split.validationStart} → ${split.developmentEnd}. ${c.selection === "development" ? "The pair with the highest net validation return was selected; ties use declared candidate order." : "Candidate outcomes are diagnostic only; your declared pair remains fixed."} Selected: RSI recovery ${c.rsiEntry}, trend ${c.trendPeriod} sessions. Re-running after viewing the later period makes that evidence exploratory.`;
  $("candidate-rows").innerHTML = report.candidates
    .map(
      (r) =>
        `<tr><td>${r.rsiEntry}</td><td>${r.trendPeriod}</td><td>${pct(r.return)}</td><td>${r.closedTrades}</td><td>${r.rsiEntry === c.rsiEntry && r.trendPeriod === c.trendPeriod ? "Selected" : "—"}</td></tr>`,
    )
    .join("");
  $("provenance").innerHTML = [
    ["Engine", `v${report.version}`],
    ["Source", d.source],
    ["Data window", `${d.start} → ${d.end} · ${d.bars} sessions per asset`],
    ["Assets", d.symbols.join(", ")],
    ["Content SHA-256", d.sha256],
    ["Selection", c.selection],
    ["Execution", report.assumptions.execution],
    ["Cost omissions", report.assumptions.costs],
    ["Annualization", report.assumptions.annualization],
  ]
    .map(([label, value]) => `<dt>${label}</dt><dd>${escape(value)}</dd>`)
    .join("");
  plot();
  $("run-status").textContent =
    `Complete · ${result.ledger.length} executions · engine v${report.version}`;
}
worker.onmessage = ({ data }) => {
  if (data.id !== requestId) return;
  if (data.error) {
    showError(data.error);
    $("run-status").textContent =
      "Experiment failed; previous exports remain unchanged.";
    busy(false);
    return;
  }
  report = data.report;
  runDataset = pendingDataset;
  render();
  busy(false);
};
worker.onerror = () => {
  showError(
    "The research worker failed. Reload the page and serve this folder over HTTP.",
  );
  busy(false);
};
$("config-form").addEventListener("submit", (e) => {
  e.preventDefault();
  run();
});
$("selection").addEventListener("change", () => {
  const selected = $("selection").value === "development";
  $("entry").disabled = selected;
  $("trend").disabled = selected;
});
$("reset-demo").addEventListener("click", () => {
  try {
    dataset = generateDemo(Number($("demo-seed").value));
    $("csv-file").value = "";
    run();
  } catch (error) {
    showError(error.message);
  }
});
$("sample-csv").addEventListener("click", () =>
  download("synthetic-ohlcv-example.csv", toCSV(generateDemo())),
);
$("csv-file").addEventListener("change", async () => {
  const file = $("csv-file").files[0];
  if (!file) return;
  if (!$("adjusted").checked || !$("data-source").value.trim()) {
    showError(
      "Add source / adjustment notes and confirm the OHLC adjustment basis before importing.",
    );
    $("csv-file").value = "";
    return;
  }
  if (file.size > 15000000) {
    showError("Use a CSV smaller than 15 MB.");
    return;
  }
  try {
    dataset = parseCSV(await file.text(), {
      source: $("data-source").value.trim(),
    });
    run();
  } catch (error) {
    showError(error.message);
    $("csv-file").value = "";
  }
});
$("export-json").addEventListener("click", () =>
  download(
    "signal-bot-experiment.json",
    JSON.stringify(report, null, 2),
    "application/json",
  ),
);
$("export-data").addEventListener("click", () =>
  download("signal-bot-dataset.csv", toCSV(runDataset)),
);
$("export-ledger").addEventListener("click", () => {
  const keys = [
    "signalDate",
    "date",
    "symbol",
    "side",
    "quantity",
    "rawOpen",
    "fillPrice",
    "fee",
    "slippage",
    "cashAfter",
    "reason",
  ];
  download(
    "signal-bot-executions.csv",
    csv([keys, ...report.result.ledger.map((t) => keys.map((k) => t[k]))]),
  );
});
$("export-equity").addEventListener("click", () =>
  download(
    "signal-bot-equity.csv",
    csv([
      ["date", "rule_equity", "buy_hold_equity", "cash_baseline", "rule_cash"],
      ...report.result.equity.map((p, i) => [
        p.date,
        p.value,
        report.benchmark.equity[i].value,
        report.selectedConfig.capital,
        p.cash,
      ]),
    ]),
  ),
);
run();
