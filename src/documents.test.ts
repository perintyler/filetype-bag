import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { routeDocument, convertDocument } from "./documents.js";
import { hasBinary } from "./probe-binaries.js";

const havePandoc = hasBinary("pandoc");

let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "filetype-docs-"));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("routeDocument", () => {
  it("sends document pairs to pandoc", () => {
    expect(routeDocument("md", "html").engine).toBe("pandoc");
    expect(routeDocument("docx", "md").engine).toBe("pandoc");
  });

  it("sends office-to-pdf to LibreOffice", () => {
    expect(routeDocument("docx", "pdf").engine).toBe("soffice");
    expect(routeDocument("xlsx", "pdf").engine).toBe("soffice");
  });

  // The `markdown` bag owns this with themes and pagination. Reimplementing it
  // here would split one capability across two bags and produce worse output.
  it("refuses markdown to PDF and names the bag that owns it", () => {
    expect(() => routeDocument("md", "pdf")).toThrow(/md_to_pdf\.generate_pdf/);
    expect(() => routeDocument("markdown", "pdf")).toThrow(/markdown` bag/);
  });

  it("names the unsupported format rather than failing vaguely", () => {
    expect(() => routeDocument("xyz", "html")).toThrow(/does not handle xyz/);
    expect(() => routeDocument("png", "pdf")).toThrow(/LibreOffice handles/);
  });
});

describe("convertDocument", () => {
  it.skipIf(!havePandoc)("converts markdown to html and writes a real file", async () => {
    const md = join(dir, "note.md");
    const html = join(dir, "note.html");
    await writeFile(md, "# Title\n\nSome **bold** text.\n");

    const result = await convertDocument(md, html, "md", "html");
    expect(result.engine).toBe("pandoc");
    expect(result.output_bytes).toBeGreaterThan(0);

    const content = await (await import("node:fs/promises")).readFile(html, "utf8");
    expect(content).toContain("<h1");
    expect(content).toContain("<strong>bold</strong>");
  });

  it.skipIf(!havePandoc)("round-trips markdown to docx and back", async () => {
    const md = join(dir, "rt.md");
    const docx = join(dir, "rt.docx");
    const back = join(dir, "rt-back.md");
    await writeFile(md, "# Heading\n\nA paragraph.\n");

    await convertDocument(md, docx, "md", "docx");
    expect((await stat(docx)).size).toBeGreaterThan(0);

    await convertDocument(docx, back, "docx", "md");
    const text = await (await import("node:fs/promises")).readFile(back, "utf8");
    expect(text).toContain("Heading");
  });

  it.skipIf(!havePandoc)("fails on a .md that is actually binary garbage", async () => {
    const bad = join(dir, "bad.docx");
    await writeFile(bad, "not a real docx");
    await expect(convertDocument(bad, join(dir, "bad.md"), "docx", "md")).rejects.toThrow(/pandoc.*failed/i);
  });
});
