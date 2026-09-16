import { open } from "node:fs/promises";
import { extname, basename } from "node:path";
import { runAllowingFailure } from "./run.js";

export interface Signature {
  /** Canonical extension, without the dot. */
  ext: string;
  mime: string;
  kind: "image" | "video" | "audio" | "document" | "archive";
  /** Bytes that must match at `offset`. */
  magic: number[];
  offset?: number;
  /** Extra predicate for containers whose magic is ambiguous (RIFF, ISO-BMFF). */
  refine?: (head: Buffer) => boolean;
}

const ascii = (s: string): number[] => [...s].map((c) => c.charCodeAt(0));

/**
 * Magic-byte table, longest/most specific first.
 *
 * Extension is deliberately not consulted here. `media`'s format detection
 * reads `path.extname()` alone, which is why a webp renamed `.png` reports as
 * a PNG — the exact case this bag exists to stop.
 */
const SIGNATURES: Signature[] = [
  // RIFF containers share the first 4 bytes; the type tag at offset 8 decides.
  {
    ext: "webp", mime: "image/webp", kind: "image", magic: ascii("RIFF"),
    refine: (h) => h.subarray(8, 12).toString("latin1") === "WEBP",
  },
  {
    ext: "wav", mime: "audio/wav", kind: "audio", magic: ascii("RIFF"),
    refine: (h) => h.subarray(8, 12).toString("latin1") === "WAVE",
  },
  {
    ext: "avi", mime: "video/x-msvideo", kind: "video", magic: ascii("RIFF"),
    refine: (h) => h.subarray(8, 12).toString("latin1") === "AVI ",
  },

  // ISO base media: the brand at offset 8 separates HEIC from AVIF from MP4.
  {
    ext: "heic", mime: "image/heic", kind: "image", magic: ascii("ftyp"), offset: 4,
    refine: (h) => ["heic", "heix", "heim", "heis", "hevc"].includes(h.subarray(8, 12).toString("latin1")),
  },
  {
    ext: "avif", mime: "image/avif", kind: "image", magic: ascii("ftyp"), offset: 4,
    refine: (h) => ["avif", "avis"].includes(h.subarray(8, 12).toString("latin1")),
  },
  {
    ext: "mov", mime: "video/quicktime", kind: "video", magic: ascii("ftyp"), offset: 4,
    refine: (h) => h.subarray(8, 12).toString("latin1") === "qt  ",
  },
  {
    ext: "mp4", mime: "video/mp4", kind: "video", magic: ascii("ftyp"), offset: 4,
  },

  { ext: "png", mime: "image/png", kind: "image", magic: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  { ext: "jpg", mime: "image/jpeg", kind: "image", magic: [0xff, 0xd8, 0xff] },
  { ext: "gif", mime: "image/gif", kind: "image", magic: ascii("GIF8") },
  { ext: "bmp", mime: "image/bmp", kind: "image", magic: ascii("BM") },
  { ext: "tif", mime: "image/tiff", kind: "image", magic: [0x49, 0x49, 0x2a, 0x00] },
  { ext: "tif", mime: "image/tiff", kind: "image", magic: [0x4d, 0x4d, 0x00, 0x2a] },
  { ext: "ico", mime: "image/x-icon", kind: "image", magic: [0x00, 0x00, 0x01, 0x00] },
  { ext: "jxl", mime: "image/jxl", kind: "image", magic: [0xff, 0x0a] },
  { ext: "jxl", mime: "image/jxl", kind: "image", magic: [0x00, 0x00, 0x00, 0x0c, 0x4a, 0x58, 0x4c, 0x20] },
  { ext: "psd", mime: "image/vnd.adobe.photoshop", kind: "image", magic: ascii("8BPS") },

  { ext: "pdf", mime: "application/pdf", kind: "document", magic: ascii("%PDF-") },
  { ext: "rtf", mime: "application/rtf", kind: "document", magic: ascii("{\\rtf") },

  // OOXML/ODF are ZIP containers. Reported as zip-based here; `identify`
  // refines them with `file(1)`, which reads the central directory.
  { ext: "zip", mime: "application/zip", kind: "archive", magic: [0x50, 0x4b, 0x03, 0x04] },
  { ext: "gz", mime: "application/gzip", kind: "archive", magic: [0x1f, 0x8b] },
  { ext: "bz2", mime: "application/x-bzip2", kind: "archive", magic: ascii("BZh") },
  { ext: "xz", mime: "application/x-xz", kind: "archive", magic: [0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00] },
  { ext: "7z", mime: "application/x-7z-compressed", kind: "archive", magic: [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c] },

  { ext: "mp3", mime: "audio/mpeg", kind: "audio", magic: ascii("ID3") },
  { ext: "flac", mime: "audio/flac", kind: "audio", magic: ascii("fLaC") },
  { ext: "ogg", mime: "audio/ogg", kind: "audio", magic: ascii("OggS") },
  { ext: "mkv", mime: "video/x-matroska", kind: "video", magic: [0x1a, 0x45, 0xdf, 0xa3] },
];

/** Extensions that are legitimate spellings of the same detected format. */
const ALIASES: Record<string, string[]> = {
  jpg: ["jpg", "jpeg", "jpe"],
  tif: ["tif", "tiff"],
  heic: ["heic", "heif", "hif"],
  mp4: ["mp4", "m4v", "m4a"],
  zip: ["zip", "docx", "xlsx", "pptx", "odt", "ods", "odp", "epub", "jar"],
  gz: ["gz", "tgz"],
  mov: ["mov", "qt"],
};

const HEAD_BYTES = 4096;

async function readHead(filePath: string): Promise<Buffer> {
  const handle = await open(filePath, "r");
  try {
    const buffer = Buffer.alloc(HEAD_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, HEAD_BYTES, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

function matches(head: Buffer, sig: Signature): boolean {
  const offset = sig.offset ?? 0;
  if (head.length < offset + sig.magic.length) return false;
  for (let i = 0; i < sig.magic.length; i++) {
    if (head[offset + i] !== sig.magic[i]) return false;
  }
  return sig.refine ? sig.refine(head) : true;
}

/** Match a buffer against the signature table. Exported for tests. */
export function sniff(head: Buffer): Signature | undefined {
  return SIGNATURES.find((sig) => matches(head, sig));
}

/** Whether `ext` is an accepted spelling for a detected format. */
export function extensionAgrees(detectedExt: string, fileExt: string): boolean {
  if (!fileExt) return false;
  const accepted = ALIASES[detectedExt] ?? [detectedExt];
  return accepted.includes(fileExt);
}

function looksLikeText(head: Buffer): boolean {
  if (head.length === 0) return false;
  // A NUL byte in the head is the classic binary tell.
  if (head.includes(0)) return false;
  let printable = 0;
  for (const byte of head) {
    if (byte === 0x09 || byte === 0x0a || byte === 0x0d || (byte >= 0x20 && byte < 0x7f)) printable++;
  }
  return printable / head.length > 0.9;
}

export interface Identification {
  path: string;
  size_bytes: number;
  /** Detected format, or null when no signature matched. */
  detected_extension: string | null;
  detected_mime: string | null;
  kind: Signature["kind"] | "text" | "unknown";
  extension_on_disk: string | null;
  /** True when the name claims a format the bytes contradict. */
  extension_mismatch: boolean;
  /** Present only on a mismatch — the whole point of the tool. */
  warning?: string;
  /** `file(1)`'s description, when available. */
  file_description?: string;
}

/**
 * Identify a file by its content.
 *
 * `file(1)` is consulted for a human description and to refine ZIP-based
 * formats, but the mismatch verdict comes from the signature table so the
 * answer does not depend on a binary that may be missing.
 */
export async function identifyFile(filePath: string, sizeBytes: number): Promise<Identification> {
  const head = await readHead(filePath);
  const signature = sniff(head);
  const onDisk = extname(filePath).slice(1).toLowerCase() || null;

  let detectedExt = signature?.ext ?? null;
  let detectedMime = signature?.mime ?? null;
  let kind: Identification["kind"] = signature?.kind ?? (looksLikeText(head) ? "text" : "unknown");

  const described = await runAllowingFailure("/usr/bin/file", ["-b", "--mime-type", filePath], 10_000);
  const fileMime = described.code === 0 ? described.stdout.trim() : undefined;

  // ZIP-based formats (docx/xlsx/pptx/odt/epub) share PK magic; `file` reads
  // far enough in to name them, so prefer its answer over the container.
  if (detectedExt === "zip" && fileMime && fileMime !== "application/zip") {
    detectedMime = fileMime;
    const refined: Record<string, string> = {
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
      "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
      "application/vnd.oasis.opendocument.text": "odt",
      "application/epub+zip": "epub",
    };
    detectedExt = refined[fileMime] ?? detectedExt;
    kind = detectedExt === "epub" || detectedExt in refined ? "document" : kind;
  }

  if (!detectedMime && fileMime) detectedMime = fileMime;

  const mismatch = detectedExt !== null && !extensionAgrees(detectedExt, onDisk ?? "");

  const description = await runAllowingFailure("/usr/bin/file", ["-b", filePath], 10_000);

  return {
    path: filePath,
    size_bytes: sizeBytes,
    detected_extension: detectedExt,
    detected_mime: detectedMime,
    kind,
    extension_on_disk: onDisk,
    extension_mismatch: mismatch,
    ...(mismatch
      ? {
          warning:
            `${basename(filePath)} is named .${onDisk ?? "(none)"} but its bytes are ${detectedExt}. ` +
            `Tools that trust the extension will mishandle it; convert it or rename it to .${detectedExt}.`,
        }
      : {}),
    ...(description.code === 0 ? { file_description: description.stdout.trim() } : {}),
  };
}
