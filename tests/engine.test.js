import test from "node:test";
import assert from "node:assert/strict";
import {
  generateDemo,
  validateDataset,
  parseCSV,
  toCSV,
  backtest,
  runExperiment,
  features,
  entrySignal,
  sma,
  ema,
  rsi,
  DEFAULTS,
  checksum,
} from "../engine.js";
const demo = generateDemo();
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-7, `${a} ≠ ${b}`);
function fixture(closes, opens = closes) {
  const rows = closes.map((close, i) => ({
    date: `2024-01-${String(i + 1).padStart(2, "0")}`,
    open: opens[i],
    high: Math.max(close, opens[i]) + 1,
    low: Math.min(close, opens[i]) - 1,
    close,
    volume: 100,
  }));
  return validateDataset(
    { series: { TEST: rows }, kind: "synthetic" },
    { minimum: 1 },
  );
}
test("deterministic fixture, distinct seeds, CSV round-trip", () => {
  assert.deepEqual(generateDemo(), demo);
  assert.notEqual(generateDemo(8).checksum, demo.checksum);
  const parsed = parseCSV(toCSV(demo), { source: "test round-trip" });
  assert.deepEqual(parsed.series, demo.series);
  assert.equal(parsed.checksum, demo.checksum);
});
test("CSV rejects missing fields, empty numeric cells, invalid dates and OHLC", () => {
  assert.throws(() => parseCSV("date,close\n2024-01-01,100"), /Required/);
  const csv = toCSV(demo);
  assert.throws(
    () => parseCSV(csv.replace(/,\d[^,]*,/, ",,")),
    /missing|invalid/,
  );
  assert.throws(
    () => parseCSV(csv.replace("2023-01-02", "2023-02-30")),
    /date/,
  );
  const changed = structuredClone(demo);
  changed.series.DEMO_A[0].high = 1;
  assert.throws(() => validateDataset(changed), /geometry/);
});
test("duplicate and misaligned calendars are rejected", () => {
  const duplicate = structuredClone(demo);
  duplicate.series.DEMO_A[1].date = duplicate.series.DEMO_A[0].date;
  assert.throws(() => validateDataset(duplicate), /duplicate/);
  const shifted = structuredClone(demo);
  shifted.series.DEMO_A.at(-1).date = "2025-08-11";
  assert.throws(() => validateDataset(shifted), /same dates/);
});
test("validation sorts a copy, not user input", () => {
  const changed = structuredClone(demo);
  changed.series.DEMO_A.reverse();
  const before = JSON.stringify(changed);
  assert.deepEqual(validateDataset(changed).series, demo.series);
  assert.equal(JSON.stringify(changed), before);
});
test("indicator warmup and conventional values", () => {
  assert.deepEqual(sma([1, 2, 3, 4], 3), [null, null, 2, 3]);
  assert.deepEqual(ema([1, 2, 3, 4], 3), [null, null, 2, 3]);
  assert.equal(rsi(Array(30).fill(100))[14], 50);
  assert.equal(rsi(Array.from({ length: 30 }, (_, i) => i + 1))[14], 100);
  const f = features(demo.series.DEMO_A, DEFAULTS);
  assert.equal(
    f.pastVolume[20],
    demo.series.DEMO_A.slice(0, 20).reduce((s, r) => s + r.volume, 0) / 20,
  );
});
test("appending future bars cannot change earlier features or signals", () => {
  const rows = demo.series.DEMO_A,
    cut = 500,
    f1 = features(rows.slice(0, cut), DEFAULTS),
    f2 = features(rows, DEFAULTS);
  for (const key of Object.keys(f1))
    assert.deepEqual(f1[key], f2[key].slice(0, cut));
  for (let i = 0; i < cut; i++)
    assert.equal(
      entrySignal(rows.slice(0, cut), f1, i, DEFAULTS),
      entrySignal(rows, f2, i, DEFAULTS),
    );
});
test("signals execute at the next open and final positions remain marked", () => {
  const data = fixture([100, 110, 130], [100, 120, 125]);
  const result = backtest(
    data,
    { capital: 1000, feeBps: 0, slippageBps: 0, useTrend: false },
    { signalProvider: (_, i) => i === 0 },
  );
  assert.equal(result.ledger.length, 1);
  assert.equal(result.ledger[0].signalDate, "2024-01-01");
  assert.equal(result.ledger[0].date, "2024-01-02");
  assert.equal(result.ledger[0].fillPrice, 120);
  assert.equal(result.ledger[0].quantity, 8);
  near(result.metrics.endEquity, 1080);
  assert.equal(result.openPositions.length, 1);
  assert.equal(result.metrics.winRate, null);
});
test("hand-calculated entry costs, cash and mark-to-market reconcile", () => {
  const data = fixture([100, 110], [100, 100]);
  const result = backtest(
    data,
    { capital: 1000, feeBps: 100, slippageBps: 100 },
    { benchmark: true },
  );
  const shares = 9,
    fill = 101,
    fee = 9.09,
    cash = 1000 - shares * fill - fee;
  near(result.ledger[0].cashAfter, cash);
  near(result.metrics.endEquity, cash + shares * 110);
  near(result.metrics.totalFees, fee);
  near(result.metrics.totalSlippage, 9);
  near(result.openPositions[0].unrealizedPnl, 71.91);
});
test("exit costs and closed trade P&L reconcile with equity", () => {
  const data = fixture(Array.from({ length: 10 }, (_, i) => 100 + i));
  const c = {
    capital: 1000,
    feeBps: 100,
    slippageBps: 100,
    useTrend: false,
    maxHolding: 5,
  };
  const result = backtest(data, c, { signalProvider: (_, i) => i === 0 });
  assert.equal(result.trades.length, 1);
  const t = result.trades[0];
  near(result.metrics.endEquity - c.capital, t.pnl);
  assert.ok(t.fees > 0 && t.slippage > 0);
  assert.equal(t.holdingSessions, 6);
  assert.ok(result.ledger.every((t) => t.cashAfter >= 0));
});
test("no signals means cash, no invented wins or Sharpe", () => {
  const result = backtest(
    demo,
    {},
    { start: 510, signalProvider: () => false },
  );
  assert.equal(result.metrics.totalReturn, 0);
  assert.equal(result.metrics.maxDrawdown, 0);
  assert.equal(result.metrics.winRate, null);
  assert.equal(result.metrics.sharpe, null);
  assert.equal(result.metrics.closedTrades, 0);
});
test("development selection is unchanged by evaluation-period data", () => {
  const config = { selection: "development" },
    original = runExperiment(demo, config),
    changed = structuredClone(demo);
  for (const rows of Object.values(changed.series))
    for (let i = 510; i < rows.length; i++)
      for (const key of ["open", "high", "low", "close"]) rows[i][key] *= 5;
  changed.checksum = checksum(changed.series);
  const other = runExperiment(changed, config);
  assert.deepEqual(original.candidates, other.candidates);
  assert.deepEqual(original.selectedConfig, other.selectedConfig);
});
test("full experiment is reproducible and not coupled to config mutation", () => {
  const config = { ...DEFAULTS };
  const a = runExperiment(demo, config),
    b = runExperiment(demo, config);
  assert.deepEqual(a, b);
  assert.deepEqual(config, DEFAULTS);
  assert.equal(a.result.equity.length, 170);
  for (const fill of a.result.ledger) assert.ok(fill.signalDate < fill.date);
  assert.equal(a.ablations[0].totalReturn, a.result.metrics.totalReturn);
});
test("invalid sizing, costs, evaluation windows and seed fail", () => {
  assert.throws(() => backtest(demo, { capital: NaN }));
  assert.throws(() => backtest(demo, { feeBps: -1 }));
  assert.throws(() => backtest(demo, {}, { start: 100, end: 10 }));
  assert.throws(() => generateDemo(-1));
});

test("entry-filter ablations retain the same trend exit", () => {
  const closes = Array.from({ length: 24 }, (_, i) =>
    i === 21 ? 95 : i > 21 ? 93 : 100 + (i % 2 ? 1 : -1),
  );
  const result = backtest(
    fixture(closes),
    {
      capital: 1000,
      feeBps: 0,
      slippageBps: 0,
      useTrend: false,
      trendPeriod: 20,
    },
    { signalProvider: (_, i) => i === 20 },
  );
  assert.equal(result.ledger[1].reason, "Trend exit");
  assert.equal(result.ledger[1].date, "2024-01-23");
});
