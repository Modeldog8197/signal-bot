import { test, expect } from "@playwright/test";
for (const width of [1440, 390])
  test(`workbench is usable at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1000 });
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto("/");
    await expect(page.locator("#run-status")).toContainText("Complete");
    await expect(page.locator("#source-banner")).toContainText(
      "not historical stock-market performance",
    );
    await expect(page.locator("#ledger-rows tr")).toHaveCount(8);
    await expect(page.locator("#finding")).toContainText("trails");
    await expect(page.locator("#ablation-rows tr")).toHaveCount(3);
    await page.locator("#selection").selectOption("development");
    await page.locator("#run").click();
    await expect(page.locator("#run-status")).toContainText("Complete");
    await expect(page.locator("#development-copy")).toContainText(
      "RSI recovery 45",
    );
    const promise = page.waitForEvent("download");
    await page.locator("#export-json").click();
    const file = await promise;
    const stream = await file.createReadStream(),
      chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    const report = JSON.parse(Buffer.concat(chunks));
    expect(report.selectedConfig.rsiEntry).toBe(45);
    expect(report.dataset.sha256).toHaveLength(64);
    expect(
      report.result.ledger.every((t) => t.signalDate < t.date),
    ).toBeTruthy();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBeTruthy();
    expect(errors).toEqual([]);
  });
test("imports a reproducible dataset and rejects malformed CSV", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.locator("#run-status")).toContainText("Complete");
  const promise = page.waitForEvent("download");
  await page.locator("#export-data").click();
  const file = await promise;
  const stream = await file.createReadStream(),
    chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  const data = Buffer.concat(chunks);
  await page.locator(".import-panel").first().locator("summary").click();
  await page.locator("#data-source").fill("Deterministic fixture, test import");
  await page.locator("#adjusted").check();
  await page
    .locator("#csv-file")
    .setInputFiles({ name: "fixture.csv", mimeType: "text/csv", buffer: data });
  await expect(page.locator("#mode")).toHaveText("IMPORTED");
  await expect(page.locator("#run-status")).toContainText("Complete");
  await page.locator("#csv-file").setInputFiles({
    name: "bad.csv",
    mimeType: "text/csv",
    buffer: Buffer.from("date,close\n2024-01-01,100"),
  });
  await expect(page.locator("#error")).toContainText("Required columns");
});
