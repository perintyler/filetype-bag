import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { transcode, probe } from "./media.js";
import { run } from "./run.js";
import { hasBinary } from "./probe-binaries.js";

const haveFfmpeg = hasBinary("ffmpeg") && hasBinary("ffprobe");

let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "filetype-media-"));
  if (haveFfmpeg) {
    // Synthesized, so no binary fixtures are committed.
    await run("ffmpeg", ["-nostdin", "-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=1", join(dir, "tone.wav")]);
    await run("ffmpeg", [
      "-nostdin", "-y",
      "-f", "lavfi", "-i", "testsrc=duration=1:size=32x32:rate=10",
      "-f", "lavfi", "-i", "sine=frequency=440:duration=1",
      "-shortest", join(dir, "av.mov"),
    ]);
  }
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("transcode", () => {
  it.skipIf(!haveFfmpeg)("converts wav to mp3 and probes the result", async () => {
    const out = join(dir, "tone.mp3");
    const result = await transcode({ inputPath: join(dir, "tone.wav"), outputPath: out, bitrate: "64k" });
    expect(result.output_bytes).toBeGreaterThan(0);
    expect(result.streams.join()).toContain("mp3");
    expect(result.duration_seconds).toBeGreaterThan(0.5);
  });

  it.skipIf(!haveFfmpeg)("remuxes mov to mp4", async () => {
    const out = join(dir, "clip.mp4");
    const result = await transcode({ inputPath: join(dir, "av.mov"), outputPath: out, videoCodec: "libx264" });
    expect(result.streams.join()).toContain("h264");
  });

  it.skipIf(!haveFfmpeg)("extracts audio only, dropping the video stream", async () => {
    const out = join(dir, "extracted.mp3");
    const result = await transcode({ inputPath: join(dir, "av.mov"), outputPath: out, audioOnly: true });
    expect(result.streams.join()).not.toContain("video");
    expect(result.streams.join()).toContain("mp3");
  });

  it.skipIf(!haveFfmpeg)("trims with start and duration", async () => {
    const out = join(dir, "trimmed.wav");
    const result = await transcode({
      inputPath: join(dir, "tone.wav"), outputPath: out, startSeconds: 0.2, durationSeconds: 0.3,
    });
    expect(result.duration_seconds).toBeLessThan(0.6);
  });

  // NEGATIVE CONTROL: a non-media file must fail, not silently produce nothing.
  it.skipIf(!haveFfmpeg)("fails on a file that is not media", async () => {
    const fake = join(dir, "fake.mp4");
    await writeFile(fake, "definitely not a video");
    await expect(
      transcode({ inputPath: fake, outputPath: join(dir, "out.mp3") }),
    ).rejects.toThrow(/ffmpeg.*failed/i);
  });
});

describe("probe", () => {
  it.skipIf(!haveFfmpeg)("reports real container and codecs", async () => {
    const result = await probe(join(dir, "av.mov"));
    expect(result.format_name).toContain("mp4");
    expect(result.streams.map((s) => s.codec_type).sort()).toEqual(["audio", "video"]);
    expect(result.duration_seconds).toBeGreaterThan(0);
  });
});
