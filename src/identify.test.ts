import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm, writeFile, copyFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sniff, extensionAgrees, identifyFile } from "./identify.js";
import { run } from "./run.js";
import { hasBinary } from "./probe-binaries.js";

const haveMagick = hasBinary("magick");

let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "filetype-identify-"));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

const sized = async (p: string) => (await import("node:fs/promises")).stat(p).then((s) => s.size);

describe("sniff", () => {
  it("recognizes a PNG by signature", () => {
    const head = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
    expect(sniff(head)?.ext).toBe("png");
  });

  // RIFF containers all start "RIFF"; only the tag at offset 8 separates them.
  it("separates webp from wav from avi, which share RIFF magic", () => {
    const riff = (tag: string) => Buffer.concat([
      Buffer.from("RIFF"), Buffer.from([0, 0, 0, 0]), Buffer.from(tag),
    ]);
    expect(sniff(riff("WEBP"))?.ext).toBe("webp");
    expect(sniff(riff("WAVE"))?.ext).toBe("wav");
    expect(sniff(riff("AVI "))?.ext).toBe("avi");
  });

  // ISO-BMFF: heic, avif and mp4 differ only by the brand at offset 8.
  it("separates heic from avif from mp4 by ftyp brand", () => {
    const ftyp = (brand: string) => Buffer.concat([
      Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftyp"), Buffer.from(brand), Buffer.alloc(8),
    ]);
    expect(sniff(ftyp("heic"))?.ext).toBe("heic");
    expect(sniff(ftyp("avif"))?.ext).toBe("avif");
    expect(sniff(ftyp("isom"))?.ext).toBe("mp4");
  });

  it("returns undefined for content matching nothing", () => {
    expect(sniff(Buffer.from("just some plain text here"))).toBeUndefined();
  });
});

describe("extensionAgrees", () => {
  it("accepts known aliases", () => {
    expect(extensionAgrees("jpg", "jpeg")).toBe(true);
    expect(extensionAgrees("tif", "tiff")).toBe(true);
    expect(extensionAgrees("heic", "heif")).toBe(true);
  });

  it("rejects a different format", () => {
    expect(extensionAgrees("webp", "png")).toBe(false);
  });

  it("rejects a missing extension", () => {
    expect(extensionAgrees("png", "")).toBe(false);
  });
});

describe("identifyFile", () => {
  it.skipIf(!haveMagick)("reports the true type of a correctly named file", async () => {
    const png = join(dir, "real.png");
    await run("magick", ["-size", "8x8", "xc:red", png]);
    const result = await identifyFile(png, await sized(png));
    expect(result.detected_extension).toBe("png");
    expect(result.extension_mismatch).toBe(false);
    expect(result.warning).toBeUndefined();
  });

  // The case that motivated this bag: a webp saved with a .png name. The
  // `media` bag reads the extension alone and would call this a PNG.
  it.skipIf(!haveMagick)("flags a webp that is named .png", async () => {
    const webp = join(dir, "truth.webp");
    await run("magick", ["-size", "8x8", "xc:blue", webp]);
    const lying = join(dir, "liar.png");
    await copyFile(webp, lying);

    const result = await identifyFile(lying, await sized(lying));
    expect(result.detected_extension).toBe("webp");
    expect(result.extension_on_disk).toBe("png");
    expect(result.extension_mismatch).toBe(true);
    expect(result.warning).toContain("webp");
  });

  it("reports text as text rather than guessing a binary format", async () => {
    const txt = join(dir, "notes.txt");
    await writeFile(txt, "plain words, nothing binary here\n");
    const result = await identifyFile(txt, await sized(txt));
    expect(result.detected_extension).toBeNull();
    expect(result.kind).toBe("text");
  });

  it("does not flag a mismatch when nothing was detected", async () => {
    const odd = join(dir, "mystery.xyz");
    await writeFile(odd, "some text\n");
    const result = await identifyFile(odd, await sized(odd));
    expect(result.extension_mismatch).toBe(false);
  });
});
