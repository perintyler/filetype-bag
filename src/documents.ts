import { dirname, join, basename, extname } from "node:path";
import { readdir, rename } from "node:fs/promises";
import { run, assertProduced, isInstalled } from "./run.js";

/** Formats pandoc handles here. Deliberately excludes pdf as a *target*. */
const PANDOC_FORMATS = new Set([
  "md", "markdown", "docx", "odt", "html", "htm", "rst", "epub", "txt", "tex", "rtf", "org", "adoc",
]);

/** Office formats only LibreOffice converts. */
const SOFFICE_INPUTS = new Set(["docx", "doc", "xlsx", "xls", "pptx", "ppt", "odt", "ods", "odp", "rtf"]);

const normalize = (f: string): string => f.replace(/^\./, "").toLowerCase();
const isMarkdown = (f: string): boolean => f === "md" || f === "markdown";

export type DocumentEngine = "pandoc" | "soffice";

export interface DocumentRoute {
  engine: DocumentEngine;
  reason: string;
}

/**
 * Choose a document engine, or refuse.
 *
 * markdown → PDF is refused on purpose: the `markdown` bag owns it via
 * `md_to_pdf.generate_pdf`, which applies real CSS themes and pagination.
 * Reimplementing it here with pandoc would produce a worse PDF from the same
 * input and split ownership of one capability across two bags.
 */
export function routeDocument(sourceFormat: string, targetFormat: string): DocumentRoute {
  const from = normalize(sourceFormat);
  const to = normalize(targetFormat);

  if (isMarkdown(from) && to === "pdf") {
    throw new Error(
      "markdown → PDF belongs to the `markdown` bag: use md_to_pdf.generate_pdf, " +
        "which applies themes and pagination this bag does not implement.",
    );
  }

  if (to === "pdf") {
    if (!SOFFICE_INPUTS.has(from)) {
      throw new Error(
        `Cannot convert ${from} to pdf: LibreOffice handles ${[...SOFFICE_INPUTS].join(", ")}. ` +
          `Convert ${from} to one of those first.`,
      );
    }
    return { engine: "soffice", reason: "LibreOffice is the PDF writer for office formats" };
  }

  if (!PANDOC_FORMATS.has(from) || !PANDOC_FORMATS.has(to)) {
    const unsupported = !PANDOC_FORMATS.has(from) ? from : to;
    throw new Error(
      `Cannot convert ${from} to ${to}: pandoc on this machine does not handle ${unsupported}. ` +
        `Supported: ${[...PANDOC_FORMATS].join(", ")}.`,
    );
  }

  return { engine: "pandoc", reason: "pandoc handles this format pair" };
}

export interface ConvertDocumentResult {
  engine: DocumentEngine;
  routing_reason: string;
  output_bytes: number;
}

export async function convertDocument(
  inputPath: string,
  outputPath: string,
  sourceFormat: string,
  targetFormat: string,
): Promise<ConvertDocumentResult> {
  const route = routeDocument(sourceFormat, targetFormat);

  if (!(await isInstalled(route.engine))) {
    throw new Error(
      `\`${route.engine}\` is required for this conversion but is not on PATH. ` +
        (route.engine === "pandoc" ? "Install it with `brew install pandoc`." : "Install LibreOffice."),
    );
  }

  if (route.engine === "pandoc") {
    await run("pandoc", [inputPath, "-o", outputPath], 300_000);
  } else {
    // soffice names the output itself, in --outdir, as <basename>.<ext>.
    const outDir = dirname(outputPath);
    await run(
      "soffice",
      ["--headless", "--convert-to", normalize(targetFormat), "--outdir", outDir, inputPath],
      300_000,
    );
    const produced = join(outDir, `${basename(inputPath, extname(inputPath))}.${normalize(targetFormat)}`);
    if (produced !== outputPath) {
      const written = await readdir(outDir);
      if (!written.includes(basename(produced))) {
        throw new Error(`soffice exited 0 but produced no ${normalize(targetFormat)} in ${outDir}.`);
      }
      await rename(produced, outputPath);
    }
  }

  const bytes = await assertProduced(outputPath, route.engine);
  return { engine: route.engine, routing_reason: route.reason, output_bytes: bytes };
}

async function requirePoppler(bin: string): Promise<void> {
  if (!(await isInstalled(bin))) {
    throw new Error(`\`${bin}\` is not on PATH. Install it with \`brew install poppler\`.`);
  }
}

export interface PdfPageImages {
  page_count: number;
  images: string[];
}

/** Rasterize PDF pages. `pdftoppm` appends `-<page>.<ext>` to the prefix. */
export async function pdfToImages(
  inputPath: string,
  outputPrefix: string,
  format: "png" | "jpeg" = "png",
  dpi = 150,
  firstPage?: number,
  lastPage?: number,
): Promise<PdfPageImages> {
  await requirePoppler("pdftoppm");
  const args = [format === "png" ? "-png" : "-jpeg", "-r", String(dpi)];
  if (firstPage !== undefined) args.push("-f", String(firstPage));
  if (lastPage !== undefined) args.push("-l", String(lastPage));
  args.push(inputPath, outputPrefix);
  await run("pdftoppm", args, 300_000);

  const dir = dirname(outputPrefix);
  const prefix = basename(outputPrefix);
  const images = (await readdir(dir))
    .filter((f) => f.startsWith(`${prefix}-`) && (f.endsWith(".png") || f.endsWith(".jpg")))
    .sort()
    .map((f) => join(dir, f));

  if (images.length === 0) {
    throw new Error(`pdftoppm exited 0 but wrote no images for prefix ${outputPrefix}.`);
  }
  return { page_count: images.length, images };
}

export async function pdfText(inputPath: string, firstPage?: number, lastPage?: number): Promise<string> {
  await requirePoppler("pdftotext");
  const args: string[] = [];
  if (firstPage !== undefined) args.push("-f", String(firstPage));
  if (lastPage !== undefined) args.push("-l", String(lastPage));
  args.push(inputPath, "-");
  const { stdout } = await run("pdftotext", args, 120_000);
  return stdout;
}

export async function pdfInfo(inputPath: string): Promise<Record<string, string>> {
  await requirePoppler("pdfinfo");
  const { stdout } = await run("pdfinfo", [inputPath], 60_000);
  const info: Record<string, string> = {};
  for (const line of stdout.split("\n")) {
    const idx = line.indexOf(":");
    if (idx > 0) info[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  return info;
}
