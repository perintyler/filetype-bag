import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run, runAllowingFailure, isInstalled, assertProduced } from "./run.js";

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "filetype-run-"));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("run", () => {
  it("returns stdout on success", async () => {
    const { stdout, code } = await run("/bin/echo", ["hello"]);
    expect(code).toBe(0);
    expect(stdout.trim()).toBe("hello");
  });

  it("throws on non-zero exit, carrying the tool's own stderr", async () => {
    await expect(run("/bin/sh", ["-c", "echo detail-here >&2; exit 3"])).rejects.toThrow(/exit 3.*detail-here/s);
  });

  // ffmpeg prints a version banner and its whole build configuration before
  // any real message. Taking the first lines reported compiler flags and hid
  // "Output file does not contain any stream" — the only line that mattered.
  it("surfaces the real error, not a version banner", async () => {
    const noisy = [
      "ffmpeg version 8.1.2 Copyright (c) 2000-2026 the FFmpeg developers",
      "  built with Apple clang version 17.0.0",
      "  configuration: --prefix=/opt/homebrew --enable-gpl",
      "  libavutil      60. 26.102 / 60. 26.102",
      "Output file does not contain any stream",
    ].join("\n");
    await expect(run("/bin/sh", ["-c", `cat >&2 <<'EOF'\n${noisy}\nEOF\nexit 1`])).rejects.toThrow(
      /does not contain any stream/,
    );
    await expect(run("/bin/sh", ["-c", `cat >&2 <<'EOF'\n${noisy}\nEOF\nexit 1`])).rejects.not.toThrow(
      /configuration:/,
    );
  });

  it("reports a missing binary as not installed rather than a generic failure", async () => {
    await expect(run("definitely-not-a-real-binary-xyz", [])).rejects.toThrow(/not installed or not on PATH/);
  });

  // Arguments are passed as an array, so shell metacharacters stay data.
  it("does not interpret shell metacharacters in arguments", async () => {
    const { stdout } = await run("/bin/echo", ["a; rm -rf /tmp/nothing", "b"]);
    expect(stdout.trim()).toBe("a; rm -rf /tmp/nothing b");
  });

  it("runAllowingFailure reports the code without throwing", async () => {
    const { code } = await runAllowingFailure("/bin/sh", ["-c", "exit 7"]);
    expect(code).toBe(7);
  });
});

describe("isInstalled", () => {
  it("finds a binary that exists", async () => {
    expect(await isInstalled("echo")).toBe(true);
  });
  it("does not find one that does not", async () => {
    expect(await isInstalled("definitely-not-a-real-binary-xyz")).toBe(false);
  });
});

describe("assertProduced", () => {
  it("returns the size of a real file", async () => {
    const p = join(dir, "real.txt");
    await writeFile(p, "content");
    expect(await assertProduced(p, "test")).toBe(7);
  });

  // An engine exiting 0 while writing nothing is a failure, not a success.
  it("throws when the file is absent", async () => {
    await expect(assertProduced(join(dir, "missing.txt"), "test")).rejects.toThrow(/wrote no file/);
  });

  it("throws when the file is empty", async () => {
    const p = join(dir, "empty.txt");
    await writeFile(p, "");
    await expect(assertProduced(p, "test")).rejects.toThrow(/empty file/);
  });
});
