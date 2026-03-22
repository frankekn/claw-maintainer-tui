import { afterEach, describe, expect, it, vi } from "vitest";
import { runCli } from "./cli.js";

describe("runCli", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("prints usage to stdout and exits 0 for help", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const code = await runCli(["--help"]);

    expect(code).toBe(0);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("Usage:"));
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("prints usage to stderr and exits 1 for an invalid command", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const code = await runCli(["wat"]);

    expect(code).toBe(1);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("Usage:"));
    expect(logSpy).not.toHaveBeenCalled();
  });

  it("rejects inherited prototype command keys", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const code = await runCli(["toString"]);

    expect(code).toBe(1);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("Usage:"));
    expect(logSpy).not.toHaveBeenCalled();
  });
});
