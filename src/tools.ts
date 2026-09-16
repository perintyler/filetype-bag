import { defineTool } from "@barry-rocks/tools";
import { z } from "zod";
import { stat } from "node:fs/promises";
import { extname, join, dirname, basename } from "node:path";
import { identifyFile } from "./identify.js";
import { convertImage, imageInfo } from "./images.js";
import { transcode, probe } from "./media.js";
import { convertDocument, pdfToImages, pdfText, pdfInfo } from "./documents.js";
import { isInstalled } from "./run.js";

const IMAGE_KINDS = new Set(["png", "jpg", "jpeg", "webp", "gif", "tif", "tiff", "bmp", "ico", "heic", "heif", "avif", "jxl", "psd"]);
const AV_KINDS = new Set(["mp4", "mov", "mkv", "avi", "webm", "mp3", "wav", "flac", "ogg", "m4a", "aac"]);

async function sizeOf(filePath: string): Promise<number> {
  try {
    return (await stat(filePath)).size;
  } catch {
    throw new Error(`No such file: ${filePath}`);
  }
}

/** Default output path: same directory and basename, new extension. */
function defaultOutput(inputPath: string, targetFormat: string): string {
  const stem = basename(inputPath, extname(inputPath));
  return join(dirname(inputPath), `${stem}.${targetFormat.replace(/^\./, "").toLowerCase()}`);
}

export const identify = defineTool({
  namespace: "filetype",
  access: "read",
  name: "identify",
  description:
    "Identify a file's real type from its content (magic bytes), not its extension. " +
    "Flags when a file's name claims a format its bytes contradict — e.g. a webp saved as .png.",
  schema: {
    file_path: z.string().describe("Path to the file to identify"),
  },
  handler: async ({ file_path }) => {
    const size = await sizeOf(file_path);
    return await identifyFile(file_path, size);
  },
});

export const convert = defineTool({
  namespace: "filetype",
  access: "write",
  name: "convert",
  description:
    "Convert an image to another format (png, jpg, webp, gif, tiff, bmp, ico; reads heic/avif/jxl/RAW too), " +
    "optionally resizing. The source format is detected from content, so a mislabeled file still converts " +
    "correctly. Verifies the output really is the requested format before reporting success. " +
    "For documents use convert_document; for audio/video use transcode.",
  schema: {
    input_path: z.string().describe("Path to the image to convert"),
    to: z.string().describe("Target format, e.g. 'png', 'jpg', 'webp'"),
    output_path: z.string().optional().describe("Output path (default: same name with the new extension)"),
    width: z.number().int().positive().optional().describe("Resize width in pixels (aspect preserved unless height is also given)"),
    height: z.number().int().positive().optional().describe("Resize height in pixels"),
    quality: z.number().int().min(1).max(100).optional().describe("Quality 1-100 for lossy formats like jpg and webp"),
  },
  handler: async ({ input_path, to, output_path, width, height, quality }) => {
    const size = await sizeOf(input_path);
    const identified = await identifyFile(input_path, size);
    const sourceFormat = identified.detected_extension ?? extname(input_path).slice(1).toLowerCase();

    if (!sourceFormat) {
      throw new Error(`Could not determine the type of ${input_path}: no known signature and no extension.`);
    }
    if (!IMAGE_KINDS.has(sourceFormat)) {
      const hint = AV_KINDS.has(sourceFormat)
        ? " Use `transcode` for audio and video."
        : sourceFormat === "pdf"
          ? " Use `pdf_to_images` to rasterize a PDF."
          : " Use `convert_document` for documents.";
      throw new Error(`${input_path} is ${sourceFormat}, which is not an image.${hint}`);
    }

    const outPath = output_path ?? defaultOutput(input_path, to);
    const result = await convertImage({
      inputPath: input_path,
      outputPath: outPath,
      targetFormat: to,
      sourceFormat,
      width,
      height,
      quality,
    });

    return {
      action: "convert",
      input_path,
      output_path: outPath,
      source_format: sourceFormat,
      target_format: to.replace(/^\./, "").toLowerCase(),
      ...result,
      ...(identified.extension_mismatch
        ? { note: `Input was named .${identified.extension_on_disk} but was actually ${sourceFormat}; converted from its real type.` }
        : {}),
    };
  },
});

export const inspectImage = defineTool({
  namespace: "filetype",
  access: "read",
  name: "inspect_image",
  description: "Get an image's real dimensions, format and colorspace, read from the file itself.",
  schema: {
    file_path: z.string().describe("Path to the image"),
  },
  handler: async ({ file_path }) => {
    await sizeOf(file_path);
    return { action: "inspect_image", ...(await imageInfo(file_path)) };
  },
});

export const transcodeMedia = defineTool({
  namespace: "filetype",
  access: "write",
  name: "transcode",
  description:
    "Convert an audio or video file to another container/codec with ffmpeg — e.g. mov→mp4, wav→mp3, " +
    "or extract audio from a video. Verifies the output exists and probes it before reporting success.",
  schema: {
    input_path: z.string().describe("Path to the audio or video file"),
    to: z.string().describe("Target container extension, e.g. 'mp4', 'mp3', 'wav'"),
    output_path: z.string().optional().describe("Output path (default: same name with the new extension)"),
    video_codec: z.string().optional().describe("Video codec, e.g. 'libx264', or 'copy' to remux without re-encoding"),
    audio_codec: z.string().optional().describe("Audio codec, e.g. 'aac', 'libmp3lame'"),
    bitrate: z.string().optional().describe("Audio bitrate, e.g. '192k'"),
    audio_only: z.boolean().optional().describe("Drop the video stream, keeping audio only"),
    start_seconds: z.number().min(0).optional().describe("Trim: start offset in seconds"),
    duration_seconds: z.number().positive().optional().describe("Trim: duration in seconds"),
  },
  handler: async ({ input_path, to, output_path, video_codec, audio_codec, bitrate, audio_only, start_seconds, duration_seconds }) => {
    await sizeOf(input_path);
    const outPath = output_path ?? defaultOutput(input_path, to);
    const result = await transcode({
      inputPath: input_path,
      outputPath: outPath,
      videoCodec: video_codec,
      audioCodec: audio_codec,
      bitrate,
      audioOnly: audio_only,
      startSeconds: start_seconds,
      durationSeconds: duration_seconds,
    });
    return { action: "transcode", input_path, output_path: outPath, ...result };
  },
});

export const inspectMedia = defineTool({
  namespace: "filetype",
  access: "read",
  name: "inspect_media",
  description: "Probe an audio or video file for real duration, container, bitrate and per-stream codecs (ffprobe).",
  schema: {
    file_path: z.string().describe("Path to the audio or video file"),
  },
  handler: async ({ file_path }) => {
    await sizeOf(file_path);
    return { action: "inspect_media", file_path, ...(await probe(file_path)) };
  },
});

export const convertDocumentTool = defineTool({
  namespace: "filetype",
  access: "write",
  name: "convert_document",
  description:
    "Convert a document between formats — docx, odt, html, rst, epub, markdown, txt via pandoc, " +
    "and office formats to PDF via LibreOffice. " +
    "Markdown to PDF is NOT handled here: use the markdown bag's md_to_pdf.generate_pdf, which applies themes.",
  schema: {
    input_path: z.string().describe("Path to the document"),
    to: z.string().describe("Target format, e.g. 'docx', 'html', 'md', 'pdf'"),
    output_path: z.string().optional().describe("Output path (default: same name with the new extension)"),
  },
  handler: async ({ input_path, to, output_path }) => {
    await sizeOf(input_path);
    const sourceFormat = extname(input_path).slice(1).toLowerCase();
    if (!sourceFormat) throw new Error(`Cannot determine the source format of ${input_path}: it has no extension.`);
    const outPath = output_path ?? defaultOutput(input_path, to);
    const result = await convertDocument(input_path, outPath, sourceFormat, to);
    return { action: "convert_document", input_path, output_path: outPath, ...result };
  },
});

export const pdfToImagesTool = defineTool({
  namespace: "filetype",
  access: "write",
  name: "pdf_to_images",
  description: "Rasterize PDF pages to PNG or JPEG images, one file per page.",
  schema: {
    input_path: z.string().describe("Path to the PDF"),
    output_prefix: z.string().optional().describe("Path prefix for output images; each page becomes <prefix>-N.png"),
    format: z.enum(["png", "jpeg"]).default("png").describe("Image format to write"),
    dpi: z.number().int().min(24).max(600).default(150).describe("Resolution in DPI"),
    first_page: z.number().int().positive().optional().describe("First page to render (1-based)"),
    last_page: z.number().int().positive().optional().describe("Last page to render"),
  },
  handler: async ({ input_path, output_prefix, format, dpi, first_page, last_page }) => {
    await sizeOf(input_path);
    const prefix = output_prefix ?? join(dirname(input_path), basename(input_path, extname(input_path)));
    const result = await pdfToImages(input_path, prefix, format, dpi, first_page, last_page);
    return { action: "pdf_to_images", input_path, ...result };
  },
});

export const pdfTextTool = defineTool({
  namespace: "filetype",
  access: "read",
  name: "pdf_text",
  description: "Extract the text layer from a PDF. Returns nothing useful for a scanned PDF with no text layer.",
  schema: {
    file_path: z.string().describe("Path to the PDF"),
    first_page: z.number().int().positive().optional().describe("First page (1-based)"),
    last_page: z.number().int().positive().optional().describe("Last page"),
  },
  handler: async ({ file_path, first_page, last_page }) => {
    await sizeOf(file_path);
    const text = await pdfText(file_path, first_page, last_page);
    const info = await pdfInfo(file_path);
    return {
      action: "pdf_text",
      file_path,
      page_count: info.Pages ? Number(info.Pages) : null,
      characters: text.length,
      ...(text.trim().length === 0
        ? { warning: "No text layer found. This PDF is probably scanned images — rasterize it with pdf_to_images and OCR it." }
        : {}),
      text,
    };
  },
});

export const status = defineTool({
  namespace: "filetype",
  access: "read",
  name: "status",
  description: "Report which conversion engines are installed and what each one enables.",
  schema: {},
  handler: async () => {
    const engines = [
      { name: "magick", enables: "most image conversion (png/jpg/webp/gif/tiff/bmp/ico, RAW read)", install: "brew install imagemagick" },
      { name: "sips", enables: "heic/avif/jxl reading — ImageMagick cannot read these", install: "ships with macOS" },
      { name: "ffmpeg", enables: "audio/video transcoding", install: "brew install ffmpeg" },
      { name: "ffprobe", enables: "audio/video metadata", install: "brew install ffmpeg" },
      { name: "pandoc", enables: "document conversion (docx/odt/html/rst/epub/md)", install: "brew install pandoc" },
      { name: "soffice", enables: "office formats to PDF", install: "brew install --cask libreoffice" },
      { name: "pdftoppm", enables: "PDF to images", install: "brew install poppler" },
      { name: "pdftotext", enables: "PDF text extraction", install: "brew install poppler" },
    ];

    const checked = await Promise.all(
      engines.map(async (e) => ({ ...e, installed: await isInstalled(e.name) })),
    );
    const missing = checked.filter((e) => !e.installed);

    return {
      action: "status",
      status: missing.length === 0 ? "ok" : "degraded",
      engines: checked,
      ...(missing.length > 0
        ? { unavailable: missing.map((m) => `${m.name} — ${m.enables} (${m.install})`) }
        : {}),
    };
  },
  cliFormat: (r: unknown) => {
    const result = r as { status: string; unavailable?: string[] };
    return result.status === "ok"
      ? "ok — every conversion engine is installed"
      : `degraded — missing:\n  ${(result.unavailable ?? []).join("\n  ")}`;
  },
});
