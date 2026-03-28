import { describe, expect, test } from "bun:test";
import { normalizeDueDate } from "./Tasks.js";
import { withRetry, formatApiError } from "./retry.js";

describe("normalizeDueDate", () => {
  test("ISO date only: returns midnight UTC", () => {
    expect(normalizeDueDate("2025-03-19")).toBe("2025-03-19T00:00:00.000Z");
  });

  test("ISO datetime without timezone: returns date portion at midnight UTC", () => {
    expect(normalizeDueDate("2025-03-19T21:00:00")).toBe("2025-03-19T00:00:00.000Z");
  });

  test("ISO datetime with Z: returns date portion at midnight UTC", () => {
    expect(normalizeDueDate("2025-03-19T21:00:00Z")).toBe("2025-03-19T00:00:00.000Z");
  });

  test("ISO datetime with offset: returns UTC date portion at midnight", () => {
    expect(normalizeDueDate("2025-03-19T21:00:00+05:00")).toBe("2025-03-19T00:00:00.000Z");
  });

  test("invalid string throws error", () => {
    expect(() => normalizeDueDate("not-a-date")).toThrow("Invalid due date");
  });

  test("undefined returns undefined", () => {
    expect(normalizeDueDate(undefined)).toBeUndefined();
  });
});

describe("withRetry", () => {
  test("returns result on first success", async () => {
    const result = await withRetry(() => Promise.resolve("ok"), "test");
    expect(result).toBe("ok");
  });

  test("does not retry on 400 (permanent error)", async () => {
    let attempts = 0;
    const fn = () => {
      attempts++;
      const error: any = new Error("Bad request");
      error.code = 400;
      return Promise.reject(error);
    };
    await expect(withRetry(fn, "test")).rejects.toThrow("Bad request");
    expect(attempts).toBe(1);
  });

  test("does not retry on 404 (permanent error)", async () => {
    let attempts = 0;
    const fn = () => {
      attempts++;
      const error: any = new Error("Not found");
      error.code = 404;
      return Promise.reject(error);
    };
    await expect(withRetry(fn, "test")).rejects.toThrow("Not found");
    expect(attempts).toBe(1);
  });

  test("retries on 429 then succeeds", async () => {
    let attempts = 0;
    const fn = () => {
      attempts++;
      if (attempts < 2) {
        const error: any = new Error("Rate limited");
        error.code = 429;
        return Promise.reject(error);
      }
      return Promise.resolve("ok");
    };
    const result = await withRetry(fn, "test");
    expect(result).toBe("ok");
    expect(attempts).toBe(2);
  });

  test("retries on 500 then succeeds", async () => {
    let attempts = 0;
    const fn = () => {
      attempts++;
      if (attempts < 2) {
        const error: any = new Error("Server error");
        error.code = 500;
        return Promise.reject(error);
      }
      return Promise.resolve("ok");
    };
    const result = await withRetry(fn, "test");
    expect(result).toBe("ok");
    expect(attempts).toBe(2);
  });
});

describe("formatApiError", () => {
  test("401 suggests re-auth with account name", () => {
    const error: any = new Error("Unauthorized");
    error.code = 401;
    const result = formatApiError(error, "popwheels");
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("popwheels");
    expect(result.content[0].text).toContain("auth");
  });

  test("404 suggests using list", () => {
    const error: any = new Error("Not found");
    error.code = 404;
    const result = formatApiError(error);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("list");
  });

  test("429 mentions rate limit", () => {
    const error: any = new Error("Too many requests");
    error.code = 429;
    const result = formatApiError(error);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Rate limited");
  });

  test("500 mentions temporary unavailability", () => {
    const error: any = new Error("Internal server error");
    error.code = 500;
    const result = formatApiError(error);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("temporarily unavailable");
  });

  test("unknown error includes message", () => {
    const error = new Error("Something weird happened");
    const result = formatApiError(error);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Something weird happened");
  });
});
