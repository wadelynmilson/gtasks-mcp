const RETRYABLE_STATUS_CODES = new Set([429, 500, 502, 503]);
const MAX_RETRIES = 3;
const BASE_DELAY_MS = 1000;

/**
 * Wraps an async function with exponential backoff retry logic.
 * Only retries on transient errors (429, 500, 502, 503).
 * Permanent errors (400, 401, 403, 404) fail immediately.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  label: string = "API call",
): Promise<T> {
  let lastError: unknown;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await fn();
    } catch (error: any) {
      lastError = error;

      const statusCode = error?.code || error?.response?.status;

      if (!RETRYABLE_STATUS_CODES.has(statusCode)) {
        throw error;
      }

      if (attempt === MAX_RETRIES) {
        throw error;
      }

      // Check for Retry-After header on 429s
      let delayMs = BASE_DELAY_MS * Math.pow(2, attempt);
      const retryAfter = error?.response?.headers?.["retry-after"];
      if (retryAfter) {
        const retryAfterMs = parseInt(retryAfter, 10) * 1000;
        if (!isNaN(retryAfterMs)) {
          delayMs = retryAfterMs;
        }
      }

      console.error(
        `[retry] ${label} failed (${statusCode}), attempt ${attempt + 1}/${MAX_RETRIES}, retrying in ${delayMs}ms…`,
      );

      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  throw lastError;
}

/**
 * Formats a Google API error into a human-readable, agent-friendly message.
 * Returns an MCP error response with isError: true.
 */
export function formatApiError(error: any, accountName?: string): {
  content: { type: string; text: string }[];
  isError: true;
} {
  const statusCode = error?.code || error?.response?.status;
  const message = error?.message || String(error);

  let text: string;

  switch (statusCode) {
    case 401:
    case 403:
      text = accountName
        ? `Authentication failed for account "${accountName}". Token may have expired. Re-run: bun run start auth ${accountName}`
        : `Authentication failed. Token may have expired. Re-run the auth flow.`;
      break;
    case 404:
      text = `Not found. The task or task list may have been deleted. Use 'list' to see current tasks.`;
      break;
    case 429:
      text = `Rate limited by Google after ${MAX_RETRIES} retries. Wait a moment and try again.`;
      break;
    case 500:
    case 502:
    case 503:
      text = `Google Tasks API is temporarily unavailable (${statusCode}). Try again shortly.`;
      break;
    default:
      text = `Google Tasks API error: ${message}`;
  }

  return {
    content: [{ type: "text", text }],
    isError: true,
  };
}
