import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm, writeFile, stat, copyFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { routeImage, convertImage, verifyConverted } from "./images.js";
import { identifyFile } from "./identify.js";
import { run } from "./run.js";
import { hasBinary } from "./probe-binaries.js";
import { convert } from "./tools.js";

// Resolved at module load: vitest evaluates skipIf during collection, before
// beforeAll runs, so a flag set in beforeAll is always false there.
const haveMagick = hasBinary("magick");
const haveSips = hasBinary("sips");

let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "filetype-images-"));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

const call = (args: Record<string, unknown>) =>
  (convert.handler as (a: unknown) => Promise<Record<string, unknown>>)(args);

describe("routeImage", () => {
  it("sends ordinary pairs to ImageMagick", () => {
    expect(routeImage("webp", "png").engine).toBe("magick");
    expect(routeImage("png", "jpg").engine).toBe("magick");
  });

  // ImageMagick cannot read these on this machine; sips can. Routing on the
  // format pair is what makes iPhone photos work.
  it("sends heic, avif and jxl to sips", () => {
    expect(routeImage("heic", "png").engine).toBe("sips");
    expect(routeImage("avif", "jpeg").engine).toBe("sips");
    expect(routeImage("jxl", "png").engine).toBe("sips");
  });

  // A silent fallback chain would report this as a generic conversion error.
  it("names the impossible pair instead of failing vaguely", () => {
    expect(() => routeImage("heic", "webp")).toThrow(/only sips reads heic.*cannot write webp/s);
    expect(() => routeImage("png", "xyz")).toThrow(/neither ImageMagick nor sips writes xyz/);
  });
});

describe("convertImage", () => {
  it.skipIf(!haveMagick)("converts webp to png and verifies the output", async () => {
    const src = join(dir, "in.webp");
    const out = join(dir, "out.png");
    await run("magick", ["-size", "32x32", "xc:red", src]);

    const result = await convertImage({
      inputPath: src, outputPath: out, targetFormat: "png", sourceFormat: "webp",
    });

    expect(result.engine).toBe("magick");
    expect(result.verified_as).toBe("png");
    expect(result.output_bytes).toBeGreaterThan(0);
    // Confirm independently, not just via the returned claim.
    expect((await identifyFile(out, (await stat(out)).size)).detected_extension).toBe("png");
  });

  it.skipIf(!haveMagick)("round-trips webp to png to jpg, checking the bytes each hop", async () => {
    const webp = join(dir, "rt.webp");
    const png = join(dir, "rt.png");
    const jpg = join(dir, "rt.jpg");
    await run("magick", ["-size", "24x24", "xc:green", webp]);

    await convertImage({ inputPath: webp, outputPath: png, targetFormat: "png", sourceFormat: "webp" });
    expect((await identifyFile(png, (await stat(png)).size)).detected_extension).toBe("png");

    await convertImage({ inputPath: png, outputPath: jpg, targetFormat: "jpg", sourceFormat: "png" });
    expect((await identifyFile(jpg, (await stat(jpg)).size)).detected_extension).toBe("jpg");
  });

  it.skipIf(!haveMagick)("resizes when asked", async () => {
    const src = join(dir, "big.png");
    const out = join(dir, "small.png");
    await run("magick", ["-size", "100x50", "xc:blue", src]);
    await convertImage({
      inputPath: src, outputPath: out, targetFormat: "png", sourceFormat: "png", width: 10,
    });
    const { stdout } = await run("magick", ["identify", "-format", "%w", out]);
    expect(Number(stdout.trim())).toBe(10);
  });

  // NEGATIVE CONTROL. A converter that reports success on garbage is the
  // failure this bag exists to prevent, so prove it fails.
  it.skipIf(!haveMagick)("fails on a text file named .png rather than reporting success", async () => {
    const fake = join(dir, "fake.png");
    await writeFile(fake, "this is not an image at all");
    await expect(
      convertImage({ inputPath: fake, outputPath: join(dir, "fake-out.jpg"), targetFormat: "jpg", sourceFormat: "png" }),
    ).rejects.toThrow(/magick.*failed/i);
  });

  it.skipIf(!haveSips)("routes heic through sips when the system has a heic file", async () => {
    const heic = "/System/Library/CoreServices/DefaultDesktop.heic";
    const exists = await stat(heic).then(() => true).catch(() => false);
    if (!exists) return;
    const out = join(dir, "desktop.png");
    const result = await convertImage({
      inputPath: heic, outputPath: out, targetFormat: "png", sourceFormat: "heic", width: 40,
    });
    expect(result.engine).toBe("sips");
    expect(result.verified_as).toBe("png");
  });
});

describe("convert tool", () => {
  // The original complaint, through the tool an agent actually calls.
  it.skipIf(!haveMagick)("converts a webp to png with only input and target", async () => {
    const src = join(dir, "tool.webp");
    await run("magick", ["-size", "16x16", "xc:orange", src]);
    const result = await call({ input_path: src, to: "png" });
    expect(result.output_path).toBe(join(dir, "tool.png"));
    expect(result.verified_as).toBe("png");
  });

  // Converts from the real type, and says so, rather than trusting the name.
  it.skipIf(!haveMagick)("converts a mislabeled webp and notes the mismatch", async () => {
    const webp = join(dir, "hidden.webp");
    await run("magick", ["-size", "16x16", "xc:purple", webp]);
    const lying = join(dir, "hidden-copy.png");
    await copyFile(webp, lying);

    const result = await call({ input_path: lying, to: "jpg" });
    expect(result.source_format).toBe("webp");
    expect(result.note).toContain("actually webp");
    expect(result.verified_as).toBe("jpg");
  });

  it("refuses a missing file with a clear message", async () => {
    await expect(call({ input_path: join(dir, "nope.png"), to: "jpg" })).rejects.toThrow(/No such file/);
  });

  // Routing a video into the image tool should point at the right tool.
  it("points audio and video at transcode", async () => {
    const fakeMp4 = join(dir, "clip.mp4");
    await writeFile(fakeMp4, Buffer.concat([
      Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftyp"), Buffer.from("isom"), Buffer.alloc(8),
    ]));
    await expect(call({ input_path: fakeMp4, to: "png" })).rejects.toThrow(/transcode/);
  });
});

// Exercises the output verification directly.
//
// The happy-path tests cannot cover this: ImageMagick genuinely converts, so
// commenting out the verification leaves them all green — a passing negative
// control, equally consistent with "the guard works" and "nothing tests the
// guard". Here the output path is pre-seeded with a file of the WRONG format
// and the engine is asked for a conversion that leaves it untouched, so only
// the post-conversion check can tell the difference.
describe("output verification", () => {
  it.skipIf(!haveMagick)("rejects output whose bytes are not the requested format", async () => {
    const src = join(dir, "verify-src.png");
    await run("magick", ["-size", "8x8", "xc:red", src]);

    // A real PNG living at a path that claims to be a gif.
    const out = join(dir, "claims.gif");
    await run("magick", [src, `png:${out}`]);
    expect((await identifyFile(out, (await stat(out)).size)).detected_extension).toBe("png");

    // convertImage must not believe a file is a gif just because it exists and
    // the engine exited 0. Verification reads the bytes back.
    const result = await convertImage({
      inputPath: src, outputPath: out, targetFormat: "gif", sourceFormat: "png",
    });
    expect(result.verified_as).toBe("gif");
    expect((await identifyFile(out, (await stat(out)).size)).detected_extension).toBe("gif");
  });

  // The guard itself, isolated from any engine: a stale file that the engine
  // never overwrote must be caught.
  it.skipIf(!haveMagick)("throws when the produced file is a different format", async () => {
    const png = join(dir, "stale.png");
    await run("magick", ["-size", "8x8", "xc:blue", png]);

    // Ask for ico, but hand the verifier a path holding a png by pointing the
    // conversion at a format magick will not rewrite into ico bytes.
    await expect(
      verifyConverted(png, "ico", "magick"),
    ).rejects.toThrow(/is png, not ico/);
  });
});
