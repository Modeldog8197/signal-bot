import { runExperiment } from "./engine.js";
self.onmessage = async ({ data }) => {
  try {
    const report = runExperiment(data.dataset, data.config);
    const canonical = JSON.stringify(data.dataset.series);
    const bytes = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(canonical),
    );
    report.dataset.sha256 = Array.from(new Uint8Array(bytes), (b) =>
      b.toString(16).padStart(2, "0"),
    ).join("");
    self.postMessage({ id: data.id, report });
  } catch (error) {
    self.postMessage({ id: data.id, error: error.message });
  }
};
