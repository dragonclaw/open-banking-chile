export const SCRAPE_CANCELLED_MESSAGE = "Scraping cancelado.";

export function createAbortError(message = SCRAPE_CANCELLED_MESSAGE): Error {
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}

export function assertNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw createAbortError();
  }
}

export function onAbort(signal: AbortSignal | undefined, handler: () => void): () => void {
  if (!signal) {
    return () => undefined;
  }

  signal.addEventListener("abort", handler, { once: true });

  return () => {
    signal.removeEventListener("abort", handler);
  };
}
