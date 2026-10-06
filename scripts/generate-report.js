import { writeFileSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { generateDemo, runExperiment, toCSV } from "../engine.js";
const data = generateDemo(),
  report = runExperiment(data);
report.dataset.sha256 = createHash("sha256")
  .update(JSON.stringify(data.series))
  .digest("hex");
mkdirSync("examples", { recursive: true });
writeFileSync(
  "examples/synthetic-experiment.json",
  JSON.stringify(report, null, 2) + "\n",
);
writeFileSync("examples/synthetic-dataset.csv", toCSV(data));
console.log(
  `Synthetic example: ${report.result.metrics.closedTrades} closed trades, ${(report.result.metrics.totalReturn * 100).toFixed(2)}% return; benchmark ${(report.benchmark.metrics.totalReturn * 100).toFixed(2)}%.`,
);
