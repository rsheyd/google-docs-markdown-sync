const DEFAULT_GOOGLE_REQUEST_TIMEOUT_MS = 30_000;

export function googleRequestTimeoutMs(
  value = process.env.GOOGLE_DOCS_SYNC_REQUEST_TIMEOUT_MS,
) {
  if (value === undefined || value === "") {
    return DEFAULT_GOOGLE_REQUEST_TIMEOUT_MS;
  }
  const timeout = Number(value);
  if (!Number.isFinite(timeout) || timeout <= 0) {
    throw new Error(
      "GOOGLE_DOCS_SYNC_REQUEST_TIMEOUT_MS must be a positive number.",
    );
  }
  return timeout;
}

export { DEFAULT_GOOGLE_REQUEST_TIMEOUT_MS };
