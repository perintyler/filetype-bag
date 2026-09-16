# filetype

Converts files between formats, and reports what a file actually is rather than
what its name claims.

```ts
// webp → png, in one call; the output is read back to confirm it really is a png
await convert.handler({ input_path: "~/Downloads/logo.webp", to: "png" });

// the file says .png; its bytes say otherwise
await identify.handler({ file_path: "~/Downloads/logo.png" });
// → { detected_extension: "webp", extension_mismatch: true, warning: "…" }
```

Start with `identify` when something is behaving oddly, and `status` when a
conversion fails — it names which engines are installed and what each enables.
`convert` is images only; `transcode` is audio/video and `convert_document` is
documents, and each refuses the others' inputs with a pointer to the right tool.

## Installing

```bash
git clone <this repo> ~/repos/bags/filetype
cd ~/repos/bags/filetype && pnpm install
barry install ~/repos/bags/filetype --as filetype
barry pack filetype
```

**The bag must live at `~/repos/bags/filetype`, with `~/repos/barry` as a
sibling.** `package.json` links `@barry-rocks/tools` by relative path; anywhere
else it fails to typecheck while the tests still pass, so confirm with
`npx tsc --noEmit` rather than `pnpm test`.

Engines are checked at call time, not load time, so a machine missing
LibreOffice still gets working image conversion. `barry bag show filetype`
renders ✓/✗ per binary; `status` explains what each missing one costs.

## What is worth knowing before changing anything here

**Two image engines, routed by format pair — never a fallback chain.**
ImageMagick cannot read HEIC, AVIF or JXL on macOS (`magick -list format` has
no entry for them); `sips` reads all three but writes far fewer formats. Since
HEIC is the default iPhone photo format, neither engine alone is enough.
`routeImage` picks on the (from, to) pair and raises a named error when no
engine spans it. Do not replace this with "try magick, fall back to sips": that
makes a corrupt file and an unsupported codec produce the same message, and the
second engine's failure would mask the first's diagnosis.

**Every conversion reads its output back.** Exit code alone accepts an engine
that copied the input through untouched — exactly how a "converted" webp stays
a webp with a `.png` name. `verifyConverted` re-sniffs the written file and
throws if it is not the requested format. It is exported specifically so a test
can drive it against a file the engine never rewrote; the happy path cannot
exercise it, because a working ImageMagick always agrees. Commenting the check
out left the whole suite green until that test existed.

**Type detection reads bytes, never the extension.** `identify.ts` carries the
signature table. Extension is consulted only to *disagree* with. Note the
ambiguous containers: RIFF (webp/wav/avi) is separated by the tag at offset 8,
and ISO-BMFF (heic/avif/mp4/mov) by the `ftyp` brand — matching the first four
bytes alone would call an AVIF an MP4. ZIP-based office formats are refined via
`file(1)`, but the mismatch verdict always comes from the table, so the answer
does not depend on a binary that may be absent.

**markdown → PDF is refused on purpose.** The `markdown` bag owns it through
`md_to_pdf.generate_pdf`, with themes and pagination this bag does not
implement. `routeDocument` raises an error naming that tool. Adding a pandoc
path here would produce a worse PDF from the same input and split one
capability across two bags. The same reasoning keeps SVG→PNG in `svg` and
`.pages` export in `macos-pages`.

**Errors quote the engine, but not its banner.** ffmpeg prints a version header
and full build configuration before anything useful, so taking the first lines
of stderr reported compiler flags while hiding "Output file does not contain
any stream". `errorDetail` filters the banner and prefers the last error-ish
lines, since tools put their conclusion at the end.

**`it.skipIf` cannot use an async probe.** Vitest evaluates skip conditions at
collection time, before `beforeAll` runs, so a flag assigned there is still
`false` and every gated test skips on a machine that has the binary. That
shipped here first time: 12 tests, the negative controls among them, skipped
silently on a machine with all six engines. `probe-binaries.ts` resolves
synchronously at module load; use it for any new gate.

## Layout

| Path | What it holds |
|---|---|
| `src/tools.ts` | tool definitions; thin, delegating to the modules below |
| `src/identify.ts` | magic-byte signature table and mismatch detection |
| `src/images.ts` | magick/sips routing, conversion, output verification |
| `src/media.ts` | ffmpeg transcoding and ffprobe metadata |
| `src/documents.ts` | pandoc, LibreOffice and poppler |
| `src/run.ts` | spawn wrapper, failure detail, output assertions |
| `src/probe-binaries.ts` | synchronous PATH check, for test skip gates |

## Tests and QA

```bash
pnpm test          # 62 tests, no committed fixtures — images and audio are synthesized
npx tsc --noEmit   # also proves the checkout is in the right place
```

Tests generate what they need at runtime and skip with a reason when an engine
is absent. The guards are covered by tests that fail when the guard is removed;
`QA.md` walks through breaking each one on purpose.
