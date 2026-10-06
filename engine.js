/** Causal, daily-bar research engine. No market data or brokerage connection. */
export const VERSION = "2.0.0";
export const DEFAULTS = Object.freeze({
  capital: 100000,
  feeBps: 10,
  slippageBps: 5,
  rsiEntry: 40,
  rsiExit: 70,
  trendPeriod: 100,
  volumeFactor: 1.1,
  maxHolding: 25,
  useTrend: true,
  useVolume: true,
  selection: "fixed",
});
export const CANDIDATES = Object.freeze([
  { rsiEntry: 35, trendPeriod: 100 },
  { rsiEntry: 45, trendPeriod: 100 },
  { rsiEntry: 35, trendPeriod: 200 },
  { rsiEntry: 45, trendPeriod: 200 },
]);
export function validateConfig(input = {}) {
  const c = { ...DEFAULTS, ...input };
  for (const [key, min, max] of [
    ["capital", 1000, 100000000],
    ["feeBps", 0, 100],
    ["slippageBps", 0, 100],
    ["rsiEntry", 20, 60],
    ["rsiExit", 60, 90],
    ["trendPeriod", 20, 200],
    ["volumeFactor", 0.5, 3],
    ["maxHolding", 5, 120],
  ])
    if (!Number.isFinite(c[key]) || c[key] < min || c[key] > max)
      throw new Error(`${key} must be between ${min} and ${max}.`);
  for (const key of ["trendPeriod", "maxHolding"])
    if (!Number.isInteger(c[key]))
      throw new Error(`${key} must be a whole number.`);
  if (
    typeof c.useTrend !== "boolean" ||
    typeof c.useVolume !== "boolean" ||
    !["fixed", "development"].includes(c.selection)
  )
    throw new Error("Invalid rule or selection mode.");
  return c;
}
export function checksum(data) {
  let hash = 2166136261;
  for (const char of JSON.stringify(data)) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return `fnv1a-${hash.toString(16).padStart(8, "0")}`;
}
export function validateDataset(input, { minimum = 400 } = {}) {
  const symbols = Object.keys(input.series || {}).sort();
  if (!symbols.length || symbols.length > 12)
    throw new Error("Use 1–12 symbols.");
  let dates;
  const series = {};
  for (const symbol of symbols) {
    if (!/^[A-Za-z0-9_.-]{1,24}$/.test(symbol))
      throw new Error(`Invalid symbol: ${symbol}`);
    const rows = input.series[symbol]
      .map((r) => ({
        date: r.date,
        open: r.open,
        high: r.high,
        low: r.low,
        close: r.close,
        volume: r.volume,
      }))
      .sort((a, b) => a.date.localeCompare(b.date));
    if (rows.length < minimum || rows.length > 10000)
      throw new Error(`${symbol}: use ${minimum}–10,000 daily bars.`);
    rows.forEach((r, i) => {
      if (
        !/^\d{4}-\d{2}-\d{2}$/.test(r.date) ||
        !Number.isFinite(Date.parse(r.date)) ||
        new Date(r.date).toISOString().slice(0, 10) !== r.date
      )
        throw new Error(`${symbol}: invalid ISO date.`);
      if (i && r.date === rows[i - 1].date)
        throw new Error(`${symbol}: duplicate date ${r.date}.`);
      if (
        ["open", "high", "low", "close"].some(
          (k) => !Number.isFinite(r[k]) || r[k] <= 0,
        ) ||
        !Number.isFinite(r.volume) ||
        r.volume < 0
      )
        throw new Error(
          `${symbol}: prices must be positive and volume nonnegative.`,
        );
      if (
        r.high < Math.max(r.open, r.close, r.low) ||
        r.low > Math.min(r.open, r.close, r.high)
      )
        throw new Error(`${symbol}: OHLC geometry is invalid on ${r.date}.`);
    });
    const calendar = rows.map((r) => r.date);
    if (dates && JSON.stringify(calendar) !== JSON.stringify(dates))
      throw new Error(
        "Every symbol must have the same dates. Missing sessions are not forward-filled.",
      );
    dates = calendar;
    series[symbol] = rows;
  }
  return {
    series,
    symbols,
    dates,
    source: String(input.source || "Unspecified source").slice(0, 200),
    kind: input.kind === "imported" ? "imported" : "synthetic",
    currency: input.currency || "INR",
    checksum: checksum(series),
  };
}
function csvRows(text) {
  const rows = [];
  let row = [],
    cell = "",
    quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      if (quoted && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (!quoted && cell.length)
        throw new Error("Malformed CSV quotation.");
      else quoted = !quoted;
    } else if (!quoted && (c === "," || c === "\n" || c === "\r")) {
      row.push(cell);
      cell = "";
      if (c !== ",") {
        if (c === "\r" && text[i + 1] === "\n") i++;
        if (row.some((v) => v.trim())) rows.push(row);
        row = [];
      }
    } else cell += c;
  }
  if (quoted) throw new Error("Unclosed CSV quotation.");
  if (cell || row.length) {
    row.push(cell);
    if (row.some((v) => v.trim())) rows.push(row);
  }
  return rows;
}
export function parseCSV(text, { source, currency = "INR" } = {}) {
  if (typeof text !== "string" || text.length > 15000000)
    throw new Error("CSV must be smaller than 15 MB.");
  const rows = csvRows(text.replace(/^\uFEFF/, ""));
  if (rows.length < 2) throw new Error("The CSV is empty.");
  const header = rows.shift().map((v) => v.trim().toLowerCase());
  const required = ["symbol", "date", "open", "high", "low", "close", "volume"];
  if (
    new Set(header).size !== header.length ||
    required.some((k) => !header.includes(k))
  )
    throw new Error(`Required columns: ${required.join(", ")}.`);
  const series = {};
  rows.forEach((row, i) => {
    if (row.length !== header.length)
      throw new Error(`Row ${i + 2}: column count does not match.`);
    const values = Object.fromEntries(header.map((h, j) => [h, row[j].trim()]));
    const r = { date: values.date };
    for (const k of required.slice(2)) {
      if (!values[k]) throw new Error(`Row ${i + 2}: ${k} is missing.`);
      r[k] = Number(values[k]);
    }
    (series[values.symbol] ??= []).push(r);
  });
  return validateDataset({ series, kind: "imported", source, currency });
}
export function toCSV(dataset) {
  const rows = ["symbol,date,open,high,low,close,volume"];
  for (const symbol of dataset.symbols)
    for (const r of dataset.series[symbol])
      rows.push(
        [symbol, r.date, r.open, r.high, r.low, r.close, r.volume].join(","),
      );
  return rows.join("\n") + "\n";
}
export function generateDemo(seed = 8197, bars = 680) {
  if (!Number.isInteger(seed) || seed < 0 || seed > 4294967295)
    throw new Error("Use a 32-bit unsigned demo seed.");
  let state = seed;
  const random = () => {
    state = (Math.imul(1664525, state) + 1013904223) >>> 0;
    return (state + 0.5) / 4294967296;
  };
  const normal = () =>
    Math.sqrt(-2 * Math.log(random())) * Math.cos(2 * Math.PI * random());
  const dates = [];
  const date = new Date("2023-01-02T00:00:00Z");
  while (dates.length < bars) {
    if (![0, 6].includes(date.getUTCDay()))
      dates.push(date.toISOString().slice(0, 10));
    date.setUTCDate(date.getUTCDate() + 1);
  }
  const series = {};
  ["DEMO_A", "DEMO_B", "DEMO_C"].forEach((symbol, j) => {
    let previous = 150 + j * 80;
    series[symbol] = dates.map((date, i) => {
      const regime = i < 220 ? 0.0008 : i < 440 ? -0.0005 : 0.001;
      const open = previous * Math.exp(normal() * 0.004);
      const close =
        open *
        Math.exp(
          regime + Math.sin((i + j * 17) / 13) * 0.006 + normal() * 0.012,
        );
      const r = {
        date,
        open,
        close,
        high: Math.max(open, close) * (1 + random() * 0.012),
        low: Math.min(open, close) * (1 - random() * 0.012),
        volume: Math.round(
          80000 * (0.8 + random() * 0.8 + Math.abs(close / open - 1) * 15),
        ),
      };
      previous = close;
      return r;
    });
  });
  return {
    ...validateDataset({
      series,
      source: `Synthetic regime fixture · seed ${seed} · weekdays only, no exchange holiday calendar`,
      kind: "synthetic",
    }),
    seed,
  };
}
export function sma(values, period) {
  const result = Array(values.length).fill(null);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) result[i] = sum / period;
  }
  return result;
}
export function ema(values, period) {
  const result = Array(values.length).fill(null);
  const alpha = 2 / (period + 1);
  let sum = 0,
    count = 0,
    previous = null;
  for (let i = 0; i < values.length; i++) {
    if (values[i] === null) continue;
    if (previous === null) {
      sum += values[i];
      count++;
      if (count === period) {
        previous = sum / period;
        result[i] = previous;
      }
    } else {
      previous = values[i] * alpha + previous * (1 - alpha);
      result[i] = previous;
    }
  }
  return result;
}
export function rsi(values, period = 14) {
  const result = Array(values.length).fill(null);
  let gain = 0,
    loss = 0;
  for (let i = 1; i < values.length; i++) {
    const change = values[i] - values[i - 1],
      g = Math.max(change, 0),
      l = Math.max(-change, 0);
    if (i <= period) {
      gain += g / period;
      loss += l / period;
    } else {
      gain = (gain * (period - 1) + g) / period;
      loss = (loss * (period - 1) + l) / period;
    }
    if (i >= period)
      result[i] =
        !gain && !loss ? 50 : !loss ? 100 : 100 - 100 / (1 + gain / loss);
  }
  return result;
}
export function features(rows, c) {
  const prices = rows.map((r) => r.close),
    fast = ema(prices, 12),
    slow = ema(prices, 26);
  const macd = prices.map((_, i) =>
      fast[i] === null || slow[i] === null ? null : fast[i] - slow[i],
    ),
    signal = ema(macd, 9);
  return {
    rsi: rsi(prices),
    trend: sma(prices, c.trendPeriod),
    histogram: macd.map((v, i) =>
      v === null || signal[i] === null ? null : v - signal[i],
    ),
    pastVolume: rows.map((_, i) =>
      i < 20
        ? null
        : rows.slice(i - 20, i).reduce((s, r) => s + r.volume, 0) / 20,
    ),
  };
}
export function entrySignal(rows, f, i, c) {
  if (
    i < 20 ||
    f.rsi[i] === null ||
    f.histogram[i] === null ||
    f.histogram[i] <= 0
  )
    return false;
  const recovered =
    f.rsi[i] >= c.rsiEntry &&
    f.rsi
      .slice(Math.max(0, i - 10), i)
      .some((v) => v !== null && v < c.rsiEntry);
  return (
    recovered &&
    (!c.useTrend || (f.trend[i] !== null && rows[i].close > f.trend[i])) &&
    (!c.useVolume || rows[i].volume > f.pastVolume[i] * c.volumeFactor)
  );
}
export function performance(equity, capital, trades, costs, exposure) {
  let previous = capital,
    peak = capital,
    maxDrawdown = 0;
  const returns = [];
  for (const point of equity) {
    returns.push(point.value / previous - 1);
    previous = point.value;
    peak = Math.max(peak, point.value);
    maxDrawdown = Math.max(maxDrawdown, 1 - point.value / peak);
  }
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance =
    returns.length > 1
      ? returns.reduce((s, r) => s + (r - mean) ** 2, 0) / (returns.length - 1)
      : 0;
  const totalReturn = equity.at(-1).value / capital - 1;
  return {
    endEquity: equity.at(-1).value,
    totalReturn,
    cagr: (1 + totalReturn) ** (252 / equity.length) - 1,
    maxDrawdown,
    sharpe:
      variance > 1e-18 ? (mean / Math.sqrt(variance)) * Math.sqrt(252) : null,
    closedTrades: trades.length,
    winRate: trades.length
      ? trades.filter((t) => t.pnl > 0).length / trades.length
      : null,
    totalFees: costs.fees,
    totalSlippage: costs.slippage,
    averageExposure: exposure.reduce((a, b) => a + b, 0) / exposure.length,
    sessions: equity.length,
  };
}
export function backtest(
  dataset,
  input = {},
  {
    start = 0,
    end = dataset.dates.length,
    benchmark = false,
    signalProvider = null,
  } = {},
) {
  const c = validateConfig(input),
    symbols = dataset.symbols;
  if (
    !Number.isInteger(start) ||
    !Number.isInteger(end) ||
    start < 0 ||
    end > dataset.dates.length ||
    start >= end
  )
    throw new Error("Invalid evaluation window.");
  const indicators = Object.fromEntries(
    symbols.map((s) => [s, features(dataset.series[s], c)]),
  );
  const positions = {},
    ledger = [],
    trades = [],
    equity = [],
    exposure = [];
  let cash = c.capital;
  const costs = { fees: 0, slippage: 0 };
  const feeRate = c.feeBps / 10000,
    slip = c.slippageBps / 10000;
  function execute(symbol, i, side, reason) {
    const raw = dataset.series[symbol][i].open,
      price = raw * (side === "buy" ? 1 + slip : 1 - slip);
    if (side === "sell") {
      const p = positions[symbol],
        fee = p.quantity * price * feeRate,
        slippage = p.quantity * (raw - price);
      cash += p.quantity * price - fee;
      costs.fees += fee;
      costs.slippage += slippage;
      const pnl = p.quantity * (price - p.price) - p.fee - fee;
      trades.push({
        symbol,
        entryDate: p.date,
        exitDate: dataset.dates[i],
        quantity: p.quantity,
        entryPrice: p.price,
        exitPrice: price,
        pnl,
        return: pnl / (p.quantity * p.price + p.fee),
        holdingSessions: i - p.index,
        fees: p.fee + fee,
        slippage: p.slippage + slippage,
      });
      ledger.push({
        date: dataset.dates[i],
        signalDate: dataset.dates[i - 1] ?? null,
        symbol,
        side,
        reason,
        quantity: p.quantity,
        rawOpen: raw,
        fillPrice: price,
        fee,
        slippage,
        cashAfter: cash,
      });
      delete positions[symbol];
    } else {
      const openEquity =
        cash +
        Object.entries(positions).reduce(
          (sum, [s, p]) => sum + p.quantity * dataset.series[s][i].open,
          0,
        );
      const budget = Math.min(cash, openEquity / symbols.length),
        quantity = Math.floor(budget / (price * (1 + feeRate)));
      if (quantity <= 0) return;
      const fee = quantity * price * feeRate,
        slippage = quantity * (price - raw);
      cash -= quantity * price + fee;
      costs.fees += fee;
      costs.slippage += slippage;
      positions[symbol] = {
        quantity,
        price,
        fee,
        slippage,
        date: dataset.dates[i],
        index: i,
      };
      ledger.push({
        date: dataset.dates[i],
        signalDate: benchmark ? null : (dataset.dates[i - 1] ?? null),
        symbol,
        side,
        reason,
        quantity,
        rawOpen: raw,
        fillPrice: price,
        fee,
        slippage,
        cashAfter: cash,
      });
    }
  }
  for (let i = start; i < end; i++) {
    if (!benchmark && i > 0)
      for (const symbol of symbols) {
        const p = positions[symbol],
          f = indicators[symbol],
          rows = dataset.series[symbol];
        if (p) {
          const reason =
            i - 1 - p.index >= c.maxHolding
              ? "Maximum holding period"
              : f.rsi[i - 1] >= c.rsiExit
                ? "RSI exit"
                : f.trend[i - 1] !== null && rows[i - 1].close < f.trend[i - 1]
                  ? "Trend exit"
                  : null;
          if (reason) execute(symbol, i, "sell", reason);
        }
      }
    for (const symbol of symbols) {
      if (positions[symbol]) continue;
      const buy = benchmark
        ? i === start
        : i > 0 &&
          (signalProvider
            ? signalProvider(symbol, i - 1, indicators[symbol])
            : entrySignal(
                dataset.series[symbol],
                indicators[symbol],
                i - 1,
                c,
              ));
      if (
        buy &&
        !ledger.some(
          (t) =>
            t.date === dataset.dates[i] &&
            t.symbol === symbol &&
            t.side === "sell",
        )
      )
        execute(
          symbol,
          i,
          "buy",
          benchmark
            ? "Equal-weight buy and hold"
            : "RSI recovery + positive MACD histogram + enabled filters",
        );
    }
    const marketValue = Object.entries(positions).reduce(
      (s, [symbol, p]) => s + p.quantity * dataset.series[symbol][i].close,
      0,
    );
    const value = cash + marketValue;
    equity.push({ date: dataset.dates[i], value, cash });
    exposure.push(marketValue / value);
  }
  const openPositions = Object.entries(positions).map(([symbol, p]) => ({
    ...p,
    symbol,
    mark: dataset.series[symbol][end - 1].close,
    unrealizedPnl:
      p.quantity * (dataset.series[symbol][end - 1].close - p.price) - p.fee,
  }));
  return {
    metrics: performance(equity, c.capital, trades, costs, exposure),
    equity,
    ledger,
    trades,
    openPositions,
  };
}
export function runExperiment(dataset, input = {}) {
  const cfg = validateConfig(input),
    split = Math.floor(dataset.dates.length * 0.75),
    validationStart = Math.floor(split * 0.7);
  const candidates = CANDIDATES.map((candidate) => {
    const config = { ...cfg, ...candidate, selection: "fixed" };
    const result = backtest(dataset, config, {
      start: validationStart,
      end: split,
    });
    return {
      rsiEntry: config.rsiEntry,
      trendPeriod: config.trendPeriod,
      return: result.metrics.totalReturn,
      closedTrades: result.metrics.closedTrades,
    };
  });
  const winner = [...candidates].sort((a, b) => b.return - a.return)[0];
  const selected =
    cfg.selection === "development"
      ? { ...cfg, rsiEntry: winner.rsiEntry, trendPeriod: winner.trendPeriod }
      : cfg;
  const options = { start: split };
  const result = backtest(dataset, selected, options),
    benchmark = backtest(dataset, selected, { ...options, benchmark: true });
  const ablations = [
    ["Full rule", selected],
    ["Without volume filter", { ...selected, useVolume: false }],
    ["Without trend entry filter", { ...selected, useTrend: false }],
  ].map(([label, c]) => ({ label, ...backtest(dataset, c, options).metrics }));
  const sensitivity = [0, 5, 10, 25, 50].map((bps) => ({
    label: `${bps} bps fee + ${bps} bps slippage`,
    bps,
    ...backtest(
      dataset,
      { ...selected, feeBps: bps, slippageBps: bps },
      options,
    ).metrics,
  }));
  return {
    version: VERSION,
    dataset: {
      kind: dataset.kind,
      source: dataset.source,
      currency: dataset.currency,
      checksum: dataset.checksum,
      seed: dataset.seed ?? null,
      symbols: dataset.symbols,
      bars: dataset.dates.length,
      start: dataset.dates[0],
      end: dataset.dates.at(-1),
    },
    requestedConfig: cfg,
    selectedConfig: selected,
    split: {
      developmentStart: dataset.dates[0],
      validationStart: dataset.dates[validationStart],
      developmentEnd: dataset.dates[split - 1],
      evaluationStart: dataset.dates[split],
      evaluationEnd: dataset.dates.at(-1),
      evaluationSessions: dataset.dates.length - split,
    },
    candidates,
    result,
    benchmark,
    ablations,
    sensitivity,
    assumptions: {
      execution:
        "Signals at close; market orders at the next available daily open. Whole shares; equal maximum allocation per symbol; no leverage or shorting.",
      positions:
        "Open positions are marked at the last close, not forcibly liquidated. Win rate uses closed trades only.",
      costs:
        "Fees and slippage apply on both entries and exits. Taxes, market impact, liquidity constraints and corporate actions are not modelled.",
      evaluation:
        "Rule selection uses development validation only. Repeated manual inspection makes later-period results exploratory.",
      annualization:
        "252 sessions per year; Sharpe uses zero risk-free rate; no significance claim.",
    },
  };
}
