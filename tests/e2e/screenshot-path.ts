import { mkdirSync } from "node:fs";
import path from "node:path";
import type { TestInfo } from "@playwright/test";

/** Use isolated Playwright output unless the runner explicitly collects shots elsewhere. */
export function screenshotPath(testInfo: TestInfo, name: string): string {
  const directory = process.env.CDOS_E2E_SHOTS_DIR;
  const destination = directory ? path.join(directory, name) : testInfo.outputPath(name);
  mkdirSync(path.dirname(destination), { recursive: true });
  return destination;
}
