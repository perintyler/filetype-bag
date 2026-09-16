import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";

/**
 * Result of a command that was allowed to fail. Callers that treat a non-zero
 * exit as an error must say so themselves — see `run`.
 */
export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Cap child output so a pathological `identify -verbose` cannot exhaust memory. */
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

/**
 * Run a binary with an argument array — never a shell string, so a path
 * containing spaces, quotes or `;` is data rather than syntax.
 */
export function runAllowingFailure(
  bin: string,
  args: string[],
  timeoutMs = 120_000,
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    execFile(
      bin,
      args,
      { timeout: timeoutMs, maxBuffer: MAX_OUTPUT_BYTES, encoding: "utf8" },
      (error, stdout, stderr) => {
        if (error && (error as NodeJS.ErrnoException).code === "ENOENT") {
          reject(new Error(`\`${bin}\` is not installed or not on PATH.`));
          return;
        }
        if (error && (error as { killed?: boolean }).killed) {
          reject(new Error(`\`${bin}\` timed out after ${timeoutMs}ms.`));
          return;
        }
        const code = typeof (error as { code?: unknown })?.code === "number"
          ? ((error as { code: number }).code)
          : error
            ? 1
            : 0;
        resolve({ code, stdout, stderr });
      },
    );
  });
}

/**
 * Run a binary and throw unless it exits zero.
 *
 * The message carries the tool's own stderr: `magick`'s "improper image
 * header" says far more about what went wrong than "exit 1" ever could.
 */
export async function run(bin: string, args: string[], timeoutMs?: number): Promise<CommandResult> {
  const result = await runAllowingFailure(bin, args, timeoutMs);
  if (result.code !== 0) {
    throw new Error(`\`${bin}\` failed (exit ${result.code})${errorDetail(result)}`);
  }
  return result;
}

/**
 * Pull the actual cause out of a failed command's output.
 *
 * ffmpeg prints a version banner and its full build configuration before any
 * real message, so taking the first few lines reports the compiler flags and
 * buries "Output file does not contain any stream". Prefer lines that look
 * like errors, and fall back to the LAST lines rather than the first — tools
 * put their conclusion at the end.
 */
function errorDetail(result: CommandResult): string {
  const lines = (result.stderr || result.stdout)
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .filter((l) => !/^(ffmpeg|ffprobe) version |^\s*(built with|configuration:|lib[a-z]+\s+\d)/i.test(l));

  const errors = lines.filter((l) => /error|invalid|unable|cannot|no such|not contain|improper|unsupported|failed/i.test(l));
  const chosen = (errors.length > 0 ? errors : lines).slice(-3);
  return chosen.length > 0 ? `: ${chosen.join("; ")}` : ".";
}

/** Whether a binary is on PATH. Used to skip tests and to report dependencies. */
export async function isInstalled(bin: string): Promise<boolean> {
  const { code } = await runAllowingFailure("/usr/bin/which", [bin], 5_000);
  return code === 0;
}

/**
 * Assert a command actually produced a file.
 *
 * A converter that reports success without looking at what it wrote is a check
 * that cannot fail: every engine here can exit non-zero *and* every engine can
 * in principle leave a zero-byte file behind. Both are failures, and the caller
 * gets told which.
 */
export async function assertProduced(outputPath: string, bin: string): Promise<number> {
  let bytes: number;
  try {
    bytes = (await stat(outputPath)).size;
  } catch {
    throw new Error(
      `\`${bin}\` exited 0 but wrote no file at ${outputPath}. Treating this as a failure.`,
    );
  }
  if (bytes === 0) {
    throw new Error(`\`${bin}\` exited 0 but wrote an empty file at ${outputPath}.`);
  }
  return bytes;
}
