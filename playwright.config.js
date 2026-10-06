import { defineConfig } from "@playwright/test";
const localArgs = process.env.LOCAL_BROWSER
  ? [
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--single-process",
      "--no-zygote",
    ]
  : [];
export default defineConfig({
  testDir: "./tests",
  testMatch: "**/*.spec.js",
  use: {
    baseURL: "http://127.0.0.1:4174",
    launchOptions: process.env.LOCAL_BROWSER
      ? { executablePath: process.env.LOCAL_BROWSER, args: localArgs }
      : {},
  },
  webServer: {
    command: "python3 -m http.server 4174 --bind 127.0.0.1",
    port: 4174,
    reuseExistingServer: !process.env.CI,
  },
});
