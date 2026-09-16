<!-- tools: Bash,Read -->
# QA: filetype

What the unit tests cannot show: that the tools work through a real session,
against real files, with the engines this machine actually has.

Every check below has a **negative control** — a way to confirm it can fail.
A step that passes identically whether or not the code works is not a check.

## Requirements

- `pnpm install` has been run in this directory.
- At least `magick` and `sips`. `status` (step 2) tells you what else is
  missing and what each one costs; steps for absent engines will say so
  rather than passing quietly.
- macOS, for the HEIC fixture in step 5. On other platforms that step is
  inapplicable — say so rather than marking it passed.

## Setup

```bash
cd ~/repos/bags/filetype
rm -rf /tmp/qa-filetype && mkdir -p /tmp/qa-filetype
```

Each step runs through a scratch file in the bag directory (ESM and the local
`tsx` both resolve from here):

```bash
cat > qa-step.ts <<'EOF'
import * as t from "./src/tools.js";
const call = (tool: any, args: any) => tool.handler(args, undefined);
// step body goes here
EOF
npx tsx qa-step.ts
```

Delete `qa-step.ts` when you are done.

## Test steps

### 1. Compiles, and the checkout is in the right place

```bash
cd ~/repos/bags/filetype && npx tsc --noEmit
```

**Expected:** exit 0, no output.

This also proves the bag sits at `~/repos/bags/filetype` beside `~/repos/barry`
— the relative `link:` in `package.json` resolves nowhere else. `pnpm test`
passes even from a wrong location, so it cannot substitute for this.

### 2. Unit tests pass, and none are silently skipped

```bash
cd ~/repos/bags/filetype && pnpm test
```

**Expected:** `62 passed (62)` — and **zero skipped** on a machine with all six
engines. A skipped count here is the bug this bag already shipped once: vitest
evaluates `it.skipIf` before `beforeAll`, so an async probe leaves every gated
test skipped while the suite still reports green.

**Negative control:** temporarily change `probe-binaries.ts` to `return false`
and re-run. Expect a large skipped count and a still-green suite — that is what
the failure looked like. Restore it.

### 3. The engines are reported honestly

```bash
# in qa-step.ts
const s = await call(t.status, {});
console.log(s.status, JSON.stringify(s.unavailable ?? "none"));
```

**Expected:** `ok "none"` when all six are installed, otherwise `degraded` and
a list naming each missing binary with its install command.

**Negative control:** PATH cannot be used here — on this machine `node` lives
in `/opt/homebrew/bin` beside the engines, so removing them removes the runtime
too. Probe the detector directly instead, naming a binary known to be absent:

```bash
cat > qa-tmp.ts <<'EOF'
import { isInstalled } from "./src/run.js";
console.log("magick:", await isInstalled("magick"));
console.log("gs:", await isInstalled("gs"));
EOF
npx tsx qa-tmp.ts && rm qa-tmp.ts
```

**Expected:** `magick: true` and `gs: false` (ghostscript is not installed and
no tool here needs it). Both printing `true`, or both `false`, means the probe
is not reading PATH and `status` cannot be believed.

### 4. webp → png, the case this bag exists for

```bash
# in qa-step.ts
import { run } from "./src/run.js";
await run("magick", ["-size", "64x64", "xc:red", "/tmp/qa-filetype/in.webp"]);
const r = await call(t.convert, { input_path: "/tmp/qa-filetype/in.webp", to: "png" });
console.log(r.engine, r.verified_as, r.output_path);
```

**Expected:** `magick png /tmp/qa-filetype/in.png`, and
`file /tmp/qa-filetype/in.png` reports `PNG image data, 64 x 64`.

`verified_as` comes from re-reading the written bytes, not from the request.

### 5. HEIC → png, which ImageMagick cannot do

```bash
# in qa-step.ts
const r = await call(t.convert, {
  input_path: "/System/Library/CoreServices/DefaultDesktop.heic",
  to: "png", output_path: "/tmp/qa-filetype/desktop.png", width: 80,
});
console.log(r.engine, r.routing_reason, r.verified_as);
```

**Expected:** `sips ImageMagick cannot read heic; sips can png`.

If this reports `magick`, routing is broken — confirm with
`magick -list format | grep -i heic`, which should print nothing.

### 6. A mislabeled file is caught rather than trusted

```bash
# in qa-step.ts
await run("magick", ["-size", "16x16", "xc:blue", "/tmp/qa-filetype/truth.webp"]);
await (await import("node:fs/promises")).copyFile(
  "/tmp/qa-filetype/truth.webp", "/tmp/qa-filetype/liar.png");
const id = await call(t.identify, { file_path: "/tmp/qa-filetype/liar.png" });
console.log(id.detected_extension, id.extension_mismatch, id.warning);
```

**Expected:** `webp true` plus a warning naming both the claimed and real type.

**Negative control:** run the same call against `/tmp/qa-filetype/truth.webp`.
Expect `webp false` and no warning — proving the flag tracks the mismatch and
is not simply always true.

### 7. Converting a mislabeled file uses its real type

```bash
# in qa-step.ts
const r = await call(t.convert, { input_path: "/tmp/qa-filetype/liar.png", to: "jpg" });
console.log(r.source_format, r.verified_as, r.note);
```

**Expected:** `source_format` is `webp` (not `png`), `verified_as` is `jpg`, and
`note` says the input was actually webp. A converter reading the extension
would report `png` here and hand ImageMagick a lie.

### 8. Documents convert, and markdown → PDF is delegated

```bash
# in qa-step.ts
await (await import("node:fs/promises")).writeFile("/tmp/qa-filetype/d.md", "# T\n\nbody\n");
console.log((await call(t.convertDocumentTool, { input_path: "/tmp/qa-filetype/d.md", to: "docx" })).engine);
console.log((await call(t.convertDocumentTool, { input_path: "/tmp/qa-filetype/d.docx", to: "pdf" })).engine);
try { await call(t.convertDocumentTool, { input_path: "/tmp/qa-filetype/d.md", to: "pdf" }); console.log("NOT REFUSED — bug"); }
catch (e: any) { console.log("refused:", e.message.slice(0, 60)); }
```

**Expected:** `pandoc`, then `soffice`, then a refusal naming
`md_to_pdf.generate_pdf`. "NOT REFUSED" means this bag has started duplicating
the `markdown` bag.

### 9. A conversion that cannot work fails loudly

```bash
# in qa-step.ts
await (await import("node:fs/promises")).writeFile("/tmp/qa-filetype/fake.png", "not an image");
try { await call(t.convert, { input_path: "/tmp/qa-filetype/fake.png", to: "jpg" });
      console.log("SUCCEEDED — bug"); }
catch (e: any) { console.log("failed:", e.message.slice(0, 80)); }
```

**Expected:** a failure quoting ImageMagick's own complaint ("improper image
header"), and **no** `/tmp/qa-filetype/fake.jpg` on disk. A reported success
here is the worst outcome this bag can produce: it means a caller can be told a
file was converted when nothing was written.

### 10. The output verifier actually guards

```bash
cd ~/repos/bags/filetype
cp src/images.ts /tmp/images.ts.bak
sed -i '' 's/if (identified.detected_extension \&\& !acceptableFor/if (false \&\& identified.detected_extension \&\& !acceptableFor/' src/images.ts
npx vitest run src/images.test.ts
cp /tmp/images.ts.bak src/images.ts
```

**Expected:** exactly **1 failed** — "throws when the produced file is a
different format" — then green again after the restore.

If disabling the verifier leaves the suite green, the guard has no test and the
happy-path cases are covering for it. That was true here until a test drove
`verifyConverted` against a file the engine never rewrote.
