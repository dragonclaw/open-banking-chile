import type { ScrapeResult, ScraperOptions } from "../types.js";
import { logout } from "../utils.js";
import { launchBrowser, type BrowserOptions, type BrowserSession } from "./browser.js";

const SCRAPE_CANCELLED_MESSAGE = "Sincronización cancelada por el usuario.";

export type ScrapeFn = (
  session: BrowserSession,
  options: ScraperOptions,
) => Promise<ScrapeResult>;

/**
 * Wraps the full scraper lifecycle:
 * 1. Validate credentials
 * 2. Find Chrome
 * 3. Launch browser
 * 4. Run bank-specific scrapeFn
 * 5. Logout + close browser
 * 6. Catch errors → return ScrapeResult
 */
export async function runScraper(
  bankId: string,
  options: ScraperOptions,
  browserOptions: Partial<BrowserOptions>,
  scrapeFn: ScrapeFn,
): Promise<ScrapeResult> {
  const { rut, password, chromePath, saveScreenshots, headful, onDebug, signal } = options;

  if (!rut || !password) {
    return {
      success: false,
      bank: bankId,
      accounts: [],
      error: "Debes proveer RUT y clave.",
    };
  }

  if (signal?.aborted) {
    return buildCancelledScrapeResult(bankId);
  }

  let session: BrowserSession | undefined;
  const closeBrowserOnAbort = (): void => {
    if (session?.browser) {
      void session.browser.close().catch(() => {});
    }
  };

  try {
    session = await launchBrowser(
      { chromePath, headful, onDebug, ...browserOptions },
      !!saveScreenshots,
    );
    signal?.addEventListener("abort", closeBrowserOnAbort, { once: true });

    if (signal?.aborted) {
      closeBrowserOnAbort();
      return buildCancelledScrapeResult(bankId);
    }

    const result = await scrapeFn(session, options);

    return signal?.aborted
      ? buildCancelledScrapeResult(bankId, session.debugLog)
      : result;
  } catch (error) {
    if (signal?.aborted) {
      return buildCancelledScrapeResult(bankId, session?.debugLog);
    }

    return {
      success: false,
      bank: bankId,
      accounts: [],
      error: `Error del scraper: ${error instanceof Error ? error.message : String(error)}`,
      debug: session?.debugLog.join("\n"),
    };
  } finally {
    signal?.removeEventListener("abort", closeBrowserOnAbort);

    if (session?.browser) {
      try {
        const pages = await session.browser.pages();
        if (pages.length > 0) await logout(pages[pages.length - 1], session.debugLog);
      } catch { /* best effort */ }
      await session.browser.close().catch(() => {});
    }
  }
}

function buildCancelledScrapeResult(
  bankId: string,
  debugLog: string[] = [],
): ScrapeResult {
  return {
    success: false,
    bank: bankId,
    accounts: [],
    error: SCRAPE_CANCELLED_MESSAGE,
    debug: debugLog.join("\n"),
  };
}
