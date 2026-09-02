import { describe, expect, it, vi } from "vitest";
import { assertNotAborted, createAbortError, onAbort, SCRAPE_CANCELLED_MESSAGE } from "./abort.js";

describe("abort helpers", () => {
  it("creates an AbortError with the cancelled message", () => {
    const error = createAbortError();

    expect(error.name).toBe("AbortError");
    expect(error.message).toBe(SCRAPE_CANCELLED_MESSAGE);
  });

  it("throws when the signal is already aborted", () => {
    const controller = new AbortController();
    controller.abort();

    expect(() => assertNotAborted(controller.signal)).toThrow(SCRAPE_CANCELLED_MESSAGE);
  });

  it("does nothing when the signal is missing or still open", () => {
    expect(() => assertNotAborted()).not.toThrow();
    expect(() => assertNotAborted(new AbortController().signal)).not.toThrow();
  });

  it("invokes the handler once when the signal aborts", () => {
    const controller = new AbortController();
    const handler = vi.fn();
    const detach = onAbort(controller.signal, handler);

    controller.abort();
    controller.abort();
    detach();

    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("returns a no-op cleanup when there is no signal", () => {
    const detach = onAbort(undefined, () => undefined);

    expect(() => detach()).not.toThrow();
  });
});
