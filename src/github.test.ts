import { describe, expect, it, vi } from "vitest";
import { ghApiJsonWithRetry, isRetryableGhApiError } from "./github.js";
import { collectLinkedIssuesFromPrText } from "./lib/pull-request-facts.js";

describe("clawlens github retry", () => {
  it("retries transient gh api failures before succeeding", async () => {
    const runner = vi
      .fn<(_: string) => Promise<string>>()
      .mockRejectedValueOnce(new Error("read tcp 1.2.3.4:443: read: connection reset by peer"))
      .mockRejectedValueOnce(new Error("HTTP 503 Service Unavailable"))
      .mockResolvedValue('{"ok":true,"count":2}');
    const sleepFn = vi.fn<(_: number) => Promise<void>>().mockResolvedValue();

    const result = await ghApiJsonWithRetry<{ ok: boolean; count: number }>("repos/x/y/pulls", {
      runner,
      attempts: 4,
      backoffMs: 25,
      sleepFn,
    });

    expect(result).toEqual({ ok: true, count: 2 });
    expect(runner).toHaveBeenCalledTimes(3);
    expect(sleepFn).toHaveBeenCalledTimes(2);
    expect(sleepFn).toHaveBeenNthCalledWith(1, 25);
    expect(sleepFn).toHaveBeenNthCalledWith(2, 50);
  });

  it("does not retry non-transient gh api failures", async () => {
    const runner = vi
      .fn<(_: string) => Promise<string>>()
      .mockRejectedValue(new Error("HTTP 404 Not Found"));
    const sleepFn = vi.fn<(_: number) => Promise<void>>().mockResolvedValue();

    await expect(
      ghApiJsonWithRetry("repos/x/y/pulls", {
        runner,
        attempts: 4,
        sleepFn,
      }),
    ).rejects.toThrow("HTTP 404 Not Found");

    expect(runner).toHaveBeenCalledTimes(1);
    expect(sleepFn).not.toHaveBeenCalled();
  });

  it("recognizes retryable transport and rate-limit errors", () => {
    expect(isRetryableGhApiError(new Error("connection reset by peer"))).toBe(true);
    expect(isRetryableGhApiError(new Error("HTTP 429 Too Many Requests"))).toBe(true);
    expect(isRetryableGhApiError(new Error("HTTP 503 Service Unavailable"))).toBe(true);
    expect(isRetryableGhApiError(new Error("HTTP 404 Not Found"))).toBe(false);
  });

  it("collects all issue refs from closing-reference lists", () => {
    expect(
      collectLinkedIssuesFromPrText(
        "",
        "Fixes #12, #34 and #56\nSource Issue #78\n[issue #90]",
      ).map((issue) => issue.issueNumber),
    ).toEqual([12, 34, 56, 78]);
  });
});
