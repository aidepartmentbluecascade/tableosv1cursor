import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

const METADATA_IPV4 = "169.254.169.254";

export class HttpEgressBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HttpEgressBlockedError";
  }
}

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) {
    return null;
  }
  let n = 0;
  for (const part of parts) {
    const octet = Number(part);
    if (!Number.isInteger(octet) || octet < 0 || octet > 255) {
      return null;
    }
    n = (n << 8) + octet;
  }
  return n >>> 0;
}

function isPrivateOrReservedIpv4(ip: string): boolean {
  const n = ipv4ToInt(ip);
  if (n === null) {
    return true;
  }
  if (ip === METADATA_IPV4) {
    return true;
  }
  // 0.0.0.0/8, 10.0.0.0/8, 127.0.0.0/8, 169.254.0.0/16, 172.16.0.0/12, 192.168.0.0/16
  if ((n & 0xff000000) === 0x00000000) return true;
  if ((n & 0xff000000) === 0x0a000000) return true;
  if ((n & 0xff000000) === 0x7f000000) return true;
  if ((n & 0xffff0000) === 0xa9fe0000) return true;
  if ((n & 0xfff00000) === 0xac100000) return true;
  if ((n & 0xffff0000) === 0xc0a80000) return true;
  return false;
}

function isPrivateOrReservedIpv6(ip: string): boolean {
  const normalized = ip.toLowerCase();
  if (normalized === "::1") {
    return true;
  }
  if (normalized.startsWith("fe80:")) {
    return true;
  }
  if (normalized.startsWith("fc") || normalized.startsWith("fd")) {
    return true;
  }
  if (normalized.startsWith("::ffff:")) {
    const mapped = normalized.slice("::ffff:".length);
    if (isIP(mapped) === 4) {
      return isPrivateOrReservedIpv4(mapped);
    }
  }
  return false;
}

function isBlockedIpAddress(host: string): boolean {
  const kind = isIP(host);
  if (kind === 4) {
    return isPrivateOrReservedIpv4(host);
  }
  if (kind === 6) {
    return isPrivateOrReservedIpv6(host);
  }
  return false;
}

function isBlockedHostname(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/\.$/, "");
  if (h === "localhost" || h.endsWith(".localhost")) {
    return true;
  }
  if (h === "metadata.google.internal") {
    return true;
  }
  return isBlockedIpAddress(h);
}

async function assertSafeUrl(url: string): Promise<URL> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new HttpEgressBlockedError("Invalid URL");
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new HttpEgressBlockedError("Only http(s) URLs are allowed");
  }

  const hostname = parsed.hostname;
  if (isBlockedHostname(hostname)) {
    throw new HttpEgressBlockedError("Egress to private or link-local hosts is blocked");
  }

  const kind = isIP(hostname);
  if (kind === 0) {
    const records = await lookup(hostname, { all: true, verbatim: true });
    for (const record of records) {
      if (isBlockedIpAddress(record.address)) {
        throw new HttpEgressBlockedError(
          "Egress to private or link-local hosts is blocked",
        );
      }
    }
  }

  return parsed;
}

/** Outbound fetch with SSRF guards (private IPs, link-local, cloud metadata). */
export async function safeFetch(
  url: string,
  init?: RequestInit,
): Promise<Response> {
  await assertSafeUrl(url);
  return fetch(url, init);
}
