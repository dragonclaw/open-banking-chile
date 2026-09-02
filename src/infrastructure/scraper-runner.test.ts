import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ScrapeResult, ScraperOptions } from "../types.js";
import type { BrowserSession } from "./browser.js";

const { launchBrowserMock, logoutMock } = vi.hoisted(() => ({
  launchBrowserMock: vi.fn(),
  logoutMock: vi.fn(),
}));

vi.mock("./browser.js", () => ({
  launchBrowser: launchBrowserMock,
}));

vi.mock("../utils.js", () => ({
  logout: logoutMock,
}));

import { runScraper } from "./scraper-runner.js";

describe("runScraper cancellation", () => {
  beforeEach(() => {
    launchBrowserMock.mockReset();
    logoutMock.mockReset();
  });

  it("does not launch Chrome when the signal is already aborted", async () => {
    const abortController = new AbortController();
    abortController.abort();

    const result = await runScraper(
      "test-bank",
      {
        password: "secret",
        rut: "11111111-1",
        signal: abortController.signal,
      },
      {},
      vi.fn(),
    );

    expect(result).toEqual(
      expect.objectContaining({
        error: "Sincronización cancelada por el usuario.",
        success: false,
      }),
    );
    expect(launchBrowserMock).not.toHaveBeenCalled();
  });

  it("closes Chrome and returns a cancelled result when aborted during scraping", async () => {
    const close = vi.fn().mockResolvedValue(undefined);
    const abortController = new AbortController();
    launchBrowserMock.mockResolvedValue({
      browser: {
        close,
        pages: vi.fn().mockResolvedValue([]),
      },
      debugLog: [],
      page: {},
      screenshot: vi.fn(),
    });
    const scrapeFn = vi.fn(
      (_session: BrowserSession, options: ScraperOptions) =>
        new Promise<ScrapeResult>((resolve) => {
          options.signal?.addEventListener(
            "abort",
            () => resolve({ success: true, bank: "test-bank", accounts: [] }),
            { once: true },
          );
        }),
    );
    const runPromise = runScraper(
      "test-bank",
      {
        password: "secret",
        rut: "11111111-1",
        signal: abortController.signal,
      },
      {},
      scrapeFn,
    );

    while (scrapeFn.mock.calls.length === 0) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    abortController.abort();
    const result = await runPromise;

    expect(close).toHaveBeenCalled();
    expect(result).toEqual(
      expect.objectContaining({
        error: "Sincronización cancelada por el usuario.",
        success: false,
      }),
    );
  });
});
