/**
 * Minimal content sniffing from the first bytes of a file. Returns null when
 * the format is not recognised (callers then keep the declared mime, unless the
 * declared mime claims a format we *can* recognise — that is a mismatch).
 */
export function sniffMime(head: Buffer): string | null {
  const b = head;
  const starts = (sig: number[], offset = 0) =>
    b.length >= offset + sig.length && sig.every((v, i) => b[offset + i] === v);

  if (starts([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (starts([0xff, 0xd8, 0xff])) return "image/jpeg";
  if (starts([0x47, 0x49, 0x46, 0x38])) return "image/gif";
  if (starts([0x52, 0x49, 0x46, 0x46]) && starts([0x57, 0x45, 0x42, 0x50], 8)) return "image/webp";
  if (starts([0x42, 0x4d])) return "image/bmp";
  if (starts([0x25, 0x50, 0x44, 0x46])) return "application/pdf";
  if (starts([0x50, 0x4b, 0x03, 0x04])) return "application/zip";
  if (starts([0x1f, 0x8b])) return "application/gzip";
  if (starts([0x66, 0x74, 0x79, 0x70], 4)) return "video/mp4";
  if (starts([0x49, 0x44, 0x33]) || starts([0xff, 0xfb])) return "audio/mpeg";
  const text = b.subarray(0, 256).toString("utf8").trimStart().toLowerCase();
  if (text.startsWith("<svg") || (text.startsWith("<?xml") && text.includes("<svg"))) {
    return "image/svg+xml";
  }
  return null;
}

export function isImageMime(mime: string): boolean {
  return /^image\/(png|jpe?g|gif|webp|bmp|svg\+xml)$/i.test(mime);
}

/** Width/height for PNG, GIF, JPEG and WebP from the file head (≥ 64KB recommended for JPEG). */
export function readImageSize(head: Buffer): { width: number; height: number } | null {
  const b = head;
  try {
    if (b.length >= 24 && b[0] === 0x89 && b[1] === 0x50) {
      return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
    }
    if (b.length >= 10 && b[0] === 0x47 && b[1] === 0x49) {
      return { width: b.readUInt16LE(6), height: b.readUInt16LE(8) };
    }
    if (b.length >= 30 && b.toString("ascii", 8, 12) === "WEBP") {
      const chunk = b.toString("ascii", 12, 16);
      if (chunk === "VP8X") {
        return {
          width: 1 + b.readUIntLE(24, 3),
          height: 1 + b.readUIntLE(27, 3),
        };
      }
      if (chunk === "VP8 ") {
        return { width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff };
      }
      if (chunk === "VP8L") {
        const bits = b.readUInt32LE(21);
        return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
      }
    }
    if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) {
      let i = 2;
      while (i + 9 < b.length) {
        if (b[i] !== 0xff) {
          i += 1;
          continue;
        }
        const marker = b[i + 1] ?? 0;
        const len = b.readUInt16BE(i + 2);
        if (
          (marker >= 0xc0 && marker <= 0xc3) ||
          (marker >= 0xc5 && marker <= 0xc7) ||
          (marker >= 0xc9 && marker <= 0xcb) ||
          (marker >= 0xcd && marker <= 0xcf)
        ) {
          return { height: b.readUInt16BE(i + 5), width: b.readUInt16BE(i + 7) };
        }
        i += 2 + len;
      }
    }
  } catch {
    return null;
  }
  return null;
}
