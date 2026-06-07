import express from "express";
import puppeteer from "puppeteer";
import { rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const minify = process.argv[3] === "--minify";
const outputPath = resolve(root, process.argv[2] || "cache.json");

await rm(outputPath, { force: true });

const app = express();
app.use("/convert", express.static(resolve(root, "dist")));
const server = await new Promise((resolveListen, reject) => {
  const listening = app.listen(0, "127.0.0.1", () => resolveListen(listening));
  listening.on("error", reject);
});

const address = server.address();
if (!address || typeof address === "string") throw new Error("Could not start cache-build server");

const browser = await puppeteer.launch({
  headless: true,
  executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
  args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
});

try {
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${address.port}/convert/index.html`, {
    waitUntil: "domcontentloaded",
    timeout: 120_000,
  });
  await page.waitForFunction(
    () => {
      const popup = document.getElementById("popup");
      return typeof window.printSupportedFormatCache === "function" && !!popup && popup.style.display === "none";
    },
    { timeout: 300_000 },
  );
  const cacheJson = await page.evaluate((compact) => {
    const json = window.printSupportedFormatCache();
    return compact ? JSON.stringify(JSON.parse(json)) : json;
  }, minify);
  await writeFile(outputPath, cacheJson);
} finally {
  await browser.close();
  await new Promise((resolveClose) => server.close(resolveClose));
}
