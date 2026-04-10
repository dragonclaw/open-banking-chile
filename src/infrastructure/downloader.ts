import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { Page } from "puppeteer-core";
import { delay } from "../utils.js";

/**
 * Creates an isolated temp directory for a bank's file downloads.
 * Uses os.tmpdir() → /tmp on Linux/macOS, %TEMP% on Windows.
 */
export function createTempDownloadDir(bankId: string): string {
  const dir = path.join(os.tmpdir(), `obc-${bankId}-${Date.now()}`);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

/**
 * Configures the browser so that downloads land in downloadDir.
 *
 * Strategy (in order):
 * 1. Browser.setDownloadBehavior via the browser's internal connection (puppeteer v20+).
 *    This is the modern approach and works in both headless and headed mode.
 * 2. Page.setDownloadBehavior as fallback (deprecated but still functional).
 *
 * NOTE: The CDP session must NOT be detached while downloads are pending.
 * We return the session so callers can detach it after the download finishes.
 */
export async function setupPageDownload(page: Page, downloadDir: string): Promise<void> {
  const absPath = path.resolve(downloadDir);

  // Attempt 1: Browser-level CDP via internal connection (puppeteer v20+)
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const connection = (page.browser() as any)._connection;
    if (connection) {
      await connection.send("Browser.setDownloadBehavior", {
        behavior: "allow",
        downloadPath: absPath,
        eventsEnabled: false,
      });
      return;
    }
  } catch { /* fall through */ }

  // Attempt 2: Page-level CDP (deprecated, but still works in Chrome < 130)
  const client = await page.createCDPSession();
  await client.send("Page.setDownloadBehavior", {
    behavior: "allow",
    downloadPath: absPath,
  });
  // Do NOT detach — keep alive so the behavior persists during download
}

/** Returns the current set of filenames in a directory (for diffing later). */
export function snapshotDir(dir: string): Set<string> {
  try {
    return new Set(fs.readdirSync(dir));
  } catch {
    return new Set();
  }
}

/**
 * Waits for a new file with the given extension to appear in any of the given directories.
 * Each dir is paired with its corresponding beforeFiles snapshot.
 * Ignores partial download artifacts (.crdownload, .part).
 *
 * When a file is found:
 *   - If it is in targetDir: returns its path directly.
 *   - If it is in another dir (e.g. ~/Downloads): moves it to targetDir first.
 *
 * Returns the final file path in targetDir, or null on timeout.
 */
export async function waitForDownloadedFile(
  targetDir: string,
  beforeFiles: Set<string>,
  ext: string,
  timeoutMs = 30000,
  extraDirs: Array<{ dir: string; before: Set<string> }> = [],
): Promise<string | null> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    await delay(500);

    // Check primary target directory
    try {
      for (const file of fs.readdirSync(targetDir)) {
        if (isCompleteDownload(file, ext) && !beforeFiles.has(file)) {
          return path.join(targetDir, file);
        }
      }
    } catch { return null; }

    // Check extra directories (e.g. ~/Downloads when CDP redirect fails)
    for (const { dir, before } of extraDirs) {
      try {
        for (const file of fs.readdirSync(dir)) {
          if (isCompleteDownload(file, ext) && !before.has(file)) {
            const src = path.join(dir, file);
            const dest = path.join(targetDir, file);
            try {
              fs.renameSync(src, dest);
              return dest;
            } catch {
              // If rename fails (cross-device), copy + delete
              fs.copyFileSync(src, dest);
              fs.unlinkSync(src);
              return dest;
            }
          }
        }
      } catch { /* ignore inaccessible dirs */ }
    }
  }

  return null;
}

function isCompleteDownload(filename: string, ext: string): boolean {
  return (
    filename.toLowerCase().endsWith(ext) &&
    !filename.endsWith(".crdownload") &&
    !filename.endsWith(".part") &&
    !filename.startsWith(".")
  );
}

/** Removes the temp download directory and all its contents. */
export function cleanupTempDir(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch { /* best-effort */ }
}
