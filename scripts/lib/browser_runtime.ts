import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import * as esbuild from "esbuild";
import { chromium, type Page } from "playwright";

import { ensureParentDir } from "./io.js";

const scriptsRoot = path.resolve(new URL("..", import.meta.url).pathname);
const runtimeDir = path.join(scriptsRoot, "runtime");
const libDir = path.join(scriptsRoot, "lib");
const browserRunnerSourcePath = path.join(runtimeDir, "browser_runner.ts");
const browserRunnerBundlePath = path.join(runtimeDir, "browser_runner.bundle.js");
const browserShellPath = path.join(runtimeDir, "browser_shell.html");

const getMTime = async (filePath: string): Promise<number> => {
  const stats = await fs.stat(filePath);
  return stats.mtimeMs;
};

const collectSourceFiles = async (directory: string): Promise<string[]> => {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const nextPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      return collectSourceFiles(nextPath);
    }
    return nextPath.endsWith(".ts") ? [nextPath] : [];
  }));
  return nested.flat();
};

const getLatestSourceMTime = async (): Promise<number> => {
  const sourceFiles = [
    ...(await collectSourceFiles(runtimeDir)),
    ...(await collectSourceFiles(libDir)),
  ];
  const mtimes = await Promise.all(sourceFiles.map((filePath) => getMTime(filePath)));
  return Math.max(...mtimes, 0);
};

export const ensureBrowserBundle = async (): Promise<void> => {
  const [sourceMTime, bundleMTime] = await Promise.all([
    getLatestSourceMTime(),
    getMTime(browserRunnerBundlePath).catch(() => 0),
  ]);

  if (bundleMTime >= sourceMTime) {
    return;
  }

  await esbuild.build({
    entryPoints: [browserRunnerSourcePath],
    outfile: browserRunnerBundlePath,
    bundle: true,
    platform: "browser",
    format: "iife",
    globalName: "ExcalidrawBrowserRunnerBundle",
    logLevel: "silent",
  });
};

const withBrowser = async <T>(fn: (page: Page) => Promise<T>): Promise<T> => {
  await ensureBrowserBundle();
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({
      viewport: { width: 1600, height: 1200 },
      deviceScaleFactor: 1,
    });
    await page.goto(pathToFileURL(browserShellPath).href);
    await page.waitForFunction(() => typeof window.__excalidrawRunner === "object");
    return await fn(page);
  } finally {
    await browser.close();
  }
};

export const runBrowserOperation = async <T>(operation: string, payload: unknown): Promise<T> => {
  return withBrowser(async (page) => {
    return page.evaluate(async ({ operationName, operationPayload }) => {
      const runner = window.__excalidrawRunner as Record<string, (payload: unknown) => unknown>;
      if (!runner || typeof runner[operationName] !== "function") {
        throw new Error(`Missing browser runner operation: ${operationName}`);
      }
      return runner[operationName](operationPayload);
    }, { operationName: operation, operationPayload: payload }) as Promise<T>;
  });
};

export const captureSvgScreenshot = async (
  svgText: string,
  outputPath: string,
  options?: { backgroundColor?: string },
): Promise<{ width: number; height: number }> => {
  await ensureParentDir(outputPath);
  return withBrowser(async (page) => {
    const backgroundColor = options?.backgroundColor ?? "#ffffff";
    await page.setContent(`
      <!doctype html>
      <html>
        <head>
          <meta charset="utf-8" />
          <style>
            html, body {
              margin: 0;
              padding: 0;
              background: ${backgroundColor};
            }

            body {
              padding: 24px;
              display: inline-block;
            }

            #preview {
              display: inline-block;
            }
          </style>
        </head>
        <body>
          <div id="preview">${svgText}</div>
        </body>
      </html>
    `);
    const svgLocator = page.locator("#preview svg");
    await svgLocator.waitFor();
    const box = await svgLocator.boundingBox();
    await svgLocator.screenshot({ path: outputPath });
    return {
      width: Math.round(box?.width ?? 0),
      height: Math.round(box?.height ?? 0),
    };
  });
};
