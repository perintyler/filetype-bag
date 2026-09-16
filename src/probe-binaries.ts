import { execFileSync } from "node:child_process";

/**
 * Whether a binary is on PATH, resolved SYNCHRONOUSLY at module load.
 *
 * Tests must not use the async `isInstalled` for `it.skipIf`: vitest evaluates
 * skip conditions while collecting the file, which happens BEFORE `beforeAll`
 * runs. A flag assigned in `beforeAll` is therefore still `false` at collection
 * time and every gated test skips on a machine that has the binary — a suite
 * that passes without running anything. That happened here: 12 tests, the
 * negative controls among them, skipped on a machine with all six engines.
 */
export function hasBinary(bin: string): boolean {
  try {
    execFileSync("/usr/bin/which", [bin], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}
