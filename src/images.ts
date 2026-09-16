import { stat } from "node:fs/promises";
import { run, assertProduced, isInstalled } from "./run.js";
import { identifyFile } from "./identify.js";

/**
 * Formats ImageMagick on this machine cannot read.
 *
 * Measured, not assumed: `magick -list format` has no HEIC, AVIF or JXL entry,
 * while `sips --formats` lists public.heic, public.avif and public.jpeg-xl.
 * HEIC is the default iPhone photo format, so routing between the two engines
 * is what makes this bag work on real photos rather than only on test fixtures.
 */
const SIPS_ONLY_READ = new Set(["heic", "heif", "hif", "avif", "jxl", "heics"]);

/** Formats sips can write. `sips --formats` marks only these Writable. */
const SIPS_WRITE = new Set(["png", "jpeg", "jpg", "tiff", "tif", "gif", "bmp", "heic", "jp2"]);

/** Formats ImageMagick writes here, and the extensions we accept for them. */
const MAGICK_WRITE = new Set([
  "png", "jpg", "jpeg", "gif", "webp", "tif", "tiff", "bmp", "ico", "pdf", "ppm", "pgm", "tga",
]);

export type Engine = "magick" | "sips";

export interface Route {
  engine: Engine;
  reason: string;
}

const normalize = (fmt: string): string => fmt.replace(/^\./, "").toLowerCase();

/**
 * Choose the engine for a conversion, or explain why neither can do it.
 *
 * Deliberately not a fallback chain. Trying magick and falling back to sips on
 * any error makes "this file is corrupt" and "this codec is unsupported"
 * indistinguishable — both would surface as the second engine's error. Routing
 * on the format pair means a failure is always the failure of the engine that
 * was supposed to handle it.
 */
export function routeImage(sourceFormat: string, targetFormat: string): Route {
  const from = normalize(sourceFormat);
  const to = normalize(targetFormat);

  if (SIPS_ONLY_READ.has(from)) {
    if (!SIPS_WRITE.has(to)) {
      throw new Error(
        `Cannot convert ${from} to ${to}: only sips reads ${from} on this machine, and sips cannot write ${to}. ` +
          `Convert to one of ${[...SIPS_WRITE].join(", ")} first, then to ${to}.`,
      );
    }
    return { engine: "sips", reason: `ImageMagick cannot read ${from}; sips can` };
  }

  if (!MAGICK_WRITE.has(to)) {
    if (SIPS_WRITE.has(to)) return { engine: "sips", reason: `ImageMagick cannot write ${to}; sips can` };
    throw new Error(
      `Cannot convert ${from} to ${to}: neither ImageMagick nor sips writes ${to} on this machine.`,
    );
  }

  return { engine: "magick", reason: "ImageMagick handles this format pair" };
}

export interface ConvertImageOptions {
  inputPath: string;
  outputPath: string;
  targetFormat: string;
  sourceFormat: string;
  width?: number;
  height?: number;
  quality?: number;
}

export interface ConvertImageResult {
  engine: Engine;
  routing_reason: string;
  output_bytes: number;
  verified_as: string | null;
}

/** Extensions that legitimately spell the same target format. */
function acceptableFor(target: string): Set<string> {
  const to = normalize(target);
  const acceptable = new Set([to]);
  if (to === "jpg") acceptable.add("jpeg");
  if (to === "jpeg") acceptable.add("jpg");
  if (to === "tif") acceptable.add("tiff");
  if (to === "tiff") acceptable.add("tif");
  return acceptable;
}

/**
 * Read the produced file back and confirm it really is the requested format.
 *
 * Exit code alone would accept an engine that copied the input through
 * untouched — precisely how a "converted" webp keeps being a webp with a .png
 * name. Exported so a test can drive it against a file the engine never
 * rewrote; the happy path cannot exercise it, because a working ImageMagick
 * always agrees.
 */
export async function verifyConverted(
  outputPath: string,
  targetFormat: string,
  engine: string,
): Promise<string | null> {
  const to = normalize(targetFormat);
  const { size } = await stat(outputPath);
  const identified = await identifyFile(outputPath, size);
  if (identified.detected_extension && !acceptableFor(to).has(identified.detected_extension)) {
    throw new Error(
      `${engine} reported success but ${outputPath} is ${identified.detected_extension}, not ${to}. ` +
        `The file was not converted.`,
    );
  }
  return identified.detected_extension;
}

/**
 * Convert an image, then verify the result is actually the requested format.
 *
 * The verification is the point. Exit code alone would accept an engine that
 * copied the input through untouched, which is precisely how a "converted"
 * webp keeps being a webp with a .png name.
 */
export async function convertImage(options: ConvertImageOptions): Promise<ConvertImageResult> {
  const { inputPath, outputPath, targetFormat, sourceFormat, width, height, quality } = options;
  const route = routeImage(sourceFormat, targetFormat);
  const to = normalize(targetFormat);

  if (!(await isInstalled(route.engine))) {
    throw new Error(
      `\`${route.engine}\` is required for ${normalize(sourceFormat)} → ${to} but is not on PATH.`,
    );
  }

  if (route.engine === "magick") {
    const args = [inputPath];
    if (width || height) args.push("-resize", `${width ?? ""}x${height ?? ""}`);
    if (quality !== undefined) args.push("-quality", String(quality));
    args.push(`${to}:${outputPath}`);
    await run("magick", args);
  } else {
    const format = to === "jpg" ? "jpeg" : to === "tif" ? "tiff" : to;
    const args = ["-s", "format", format];
    if (quality !== undefined) {
      // sips takes a named formatOption, not a 0-100 scale.
      const named = quality >= 85 ? "best" : quality >= 60 ? "high" : quality >= 35 ? "normal" : "low";
      args.push("-s", "formatOptions", named);
    }
    if (width && height) args.push("-z", String(height), String(width));
    else if (width) args.push("--resampleWidth", String(width));
    else if (height) args.push("--resampleHeight", String(height));
    args.push(inputPath, "--out", outputPath);
    await run("sips", args);
  }

  const bytes = await assertProduced(outputPath, route.engine);
  const verifiedAs = await verifyConverted(outputPath, to, route.engine);

  return {
    engine: route.engine,
    routing_reason: route.reason,
    output_bytes: bytes,
    verified_as: verifiedAs,
  };
}

/** Dimensions and format for an image, via ImageMagick or sips. */
export async function imageInfo(filePath: string): Promise<Record<string, unknown>> {
  const size = (await stat(filePath)).size;
  const identified = await identifyFile(filePath, size);
  const from = identified.detected_extension ?? "";

  if (!SIPS_ONLY_READ.has(from) && (await isInstalled("magick"))) {
    const { stdout } = await run("magick", ["identify", "-format", "%w %h %m %[colorspace]", `${filePath}[0]`]);
    const [w, h, format, colorspace] = stdout.trim().split(/\s+/);
    return { ...identified, width: Number(w), height: Number(h), format, colorspace };
  }

  const { stdout } = await run("sips", ["-g", "pixelWidth", "-g", "pixelHeight", "-g", "format", filePath]);
  const value = (key: string): string | undefined =>
    stdout.split("\n").find((l) => l.includes(`${key}:`))?.split(":")[1]?.trim();
  return {
    ...identified,
    width: Number(value("pixelWidth")),
    height: Number(value("pixelHeight")),
    format: value("format"),
  };
}
