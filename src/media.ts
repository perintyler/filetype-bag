import { run, assertProduced, isInstalled } from "./run.js";

async function requireFfmpeg(bin: "ffmpeg" | "ffprobe"): Promise<void> {
  if (!(await isInstalled(bin))) {
    throw new Error(`\`${bin}\` is not on PATH. Install it with \`brew install ffmpeg\`.`);
  }
}

export interface TranscodeOptions {
  inputPath: string;
  outputPath: string;
  videoCodec?: string;
  audioCodec?: string;
  bitrate?: string;
  /** Strip video, keeping audio — the mp4→mp3 case. */
  audioOnly?: boolean;
  startSeconds?: number;
  durationSeconds?: number;
}

export interface TranscodeResult {
  output_bytes: number;
  duration_seconds: number | null;
  streams: string[];
}

/**
 * Transcode an audio/video file.
 *
 * `-y` overwrites, because ffmpeg otherwise blocks forever on an interactive
 * prompt no agent can answer — a hang is a worse failure than a clobber the
 * caller asked for by naming an existing output.
 */
export async function transcode(options: TranscodeOptions): Promise<TranscodeResult> {
  await requireFfmpeg("ffmpeg");
  const { inputPath, outputPath, videoCodec, audioCodec, bitrate, audioOnly, startSeconds, durationSeconds } = options;

  const args = ["-nostdin", "-y"];
  if (startSeconds !== undefined) args.push("-ss", String(startSeconds));
  args.push("-i", inputPath);
  if (durationSeconds !== undefined) args.push("-t", String(durationSeconds));
  if (audioOnly) args.push("-vn");
  if (videoCodec) args.push("-c:v", videoCodec);
  if (audioCodec) args.push("-c:a", audioCodec);
  if (bitrate) args.push("-b:a", bitrate);
  args.push(outputPath);

  await run("ffmpeg", args, 600_000);
  const bytes = await assertProduced(outputPath, "ffmpeg");
  const probed = await probe(outputPath);

  return {
    output_bytes: bytes,
    duration_seconds: probed.duration_seconds,
    streams: probed.streams.map((s) => `${s.codec_type}: ${s.codec_name}`),
  };
}

export interface ProbeStream {
  codec_type: string;
  codec_name: string;
  width?: number;
  height?: number;
}

export interface ProbeResult {
  duration_seconds: number | null;
  format_name: string | null;
  bit_rate: number | null;
  streams: ProbeStream[];
}

/** Real container/codec metadata, read from the file rather than its name. */
export async function probe(filePath: string): Promise<ProbeResult> {
  await requireFfmpeg("ffprobe");
  const { stdout } = await run("ffprobe", [
    "-v", "error",
    "-show_entries", "format=duration,format_name,bit_rate",
    "-show_entries", "stream=codec_type,codec_name,width,height",
    "-of", "json",
    filePath,
  ]);

  const parsed = JSON.parse(stdout) as {
    format?: { duration?: string; format_name?: string; bit_rate?: string };
    streams?: ProbeStream[];
  };

  const duration = parsed.format?.duration ? Number(parsed.format.duration) : null;
  return {
    duration_seconds: duration !== null && Number.isFinite(duration) ? duration : null,
    format_name: parsed.format?.format_name ?? null,
    bit_rate: parsed.format?.bit_rate ? Number(parsed.format.bit_rate) : null,
    streams: parsed.streams ?? [],
  };
}
