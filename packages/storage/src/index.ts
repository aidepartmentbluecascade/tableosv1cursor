import { Storage } from "@google-cloud/storage";
import { createReadStream } from "node:fs";
import { mkdir, open, rm, stat, writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import type { Readable } from "node:stream";

export interface StorageEnv {
  projectId?: string;
  bucket: string;
  /** Absolute path to a service-account JSON key file. */
  keyFilename?: string;
  /**
   * Inline service-account JSON (string). Useful when mounting secrets as env.
   * Takes precedence over keyFilename when both are set.
   */
  credentialsJson?: string;
}

export interface PresignedUpload {
  url: string;
  method: "PUT";
  headers: Record<string, string>;
}

export interface PresignedDownload {
  url: string;
  method: "GET";
}

export interface StoredObjectInfo {
  size: number;
  contentType: string | null;
}

export type StorageDriverName = "gcs" | "local";

export interface TabulaStorage {
  readonly driver: StorageDriverName;
  /**
   * Direct-to-storage upload URL. The local driver has no URL of its own;
   * callers proxy uploads through the API instead (`putObject`).
   */
  presignUpload(key: string, contentType: string): Promise<PresignedUpload>;
  presignDownload(key: string): Promise<PresignedDownload>;
  ensureBucket(): Promise<void>;
  putObject(key: string, body: Buffer, contentType: string): Promise<void>;
  headObject(key: string): Promise<StoredObjectInfo | null>;
  /** First `bytes` bytes of an object (mime sniffing). */
  readPrefix(key: string, bytes: number): Promise<Buffer>;
  openReadStream(key: string): Promise<Readable>;
  deleteObject(key: string): Promise<void>;
}

export function storageEnvFromProcess(env: {
  GCS_BUCKET?: string | undefined;
  GCS_PROJECT_ID?: string | undefined;
  GCS_KEY_FILE?: string | undefined;
  GOOGLE_APPLICATION_CREDENTIALS?: string | undefined;
  GCS_CREDENTIALS_JSON?: string | undefined;
  /** Alias accepted for convenience. */
  GOOGLE_CREDENTIALS_JSON?: string | undefined;
}): StorageEnv | null {
  if (!env.GCS_BUCKET) {
    return null;
  }
  const keyFilename =
    env.GCS_KEY_FILE ?? env.GOOGLE_APPLICATION_CREDENTIALS ?? undefined;
  const credentialsJson =
    env.GCS_CREDENTIALS_JSON ?? env.GOOGLE_CREDENTIALS_JSON ?? undefined;
  return {
    bucket: env.GCS_BUCKET,
    ...(env.GCS_PROJECT_ID ? { projectId: env.GCS_PROJECT_ID } : {}),
    ...(keyFilename ? { keyFilename } : {}),
    ...(credentialsJson ? { credentialsJson } : {}),
  };
}

function normalizeServiceAccountCredentials(
  credentials: Record<string, unknown>,
): Record<string, unknown> {
  const privateKey = credentials["private_key"];
  if (typeof privateKey === "string" && privateKey.includes("\\n")) {
    return { ...credentials, private_key: privateKey.replace(/\\n/g, "\n") };
  }
  return credentials;
}

function createGcsClient(env: StorageEnv): Storage {
  if (env.credentialsJson) {
    const credentials = normalizeServiceAccountCredentials(
      JSON.parse(env.credentialsJson) as Record<string, unknown>,
    );
    return new Storage({
      ...(env.projectId ? { projectId: env.projectId } : {}),
      credentials,
    });
  }
  return new Storage({
    ...(env.projectId ? { projectId: env.projectId } : {}),
    ...(env.keyFilename ? { keyFilename: env.keyFilename } : {}),
  });
}

export function createStorage(env: StorageEnv): TabulaStorage {
  const storage = createGcsClient(env);
  const bucket = storage.bucket(env.bucket);

  return {
    driver: "gcs",

    async ensureBucket(): Promise<void> {
      const [exists] = await bucket.exists();
      if (!exists) {
        await storage.createBucket(env.bucket, {
          ...(env.projectId ? { project: env.projectId } : {}),
          location: "US",
          storageClass: "STANDARD",
        });
      }
    },

    async presignUpload(
      key: string,
      contentType: string,
    ): Promise<PresignedUpload> {
      const file = bucket.file(key);
      const [url] = await file.getSignedUrl({
        version: "v4",
        action: "write",
        expires: Date.now() + 60 * 60 * 1000,
        contentType,
      });
      return {
        url,
        method: "PUT",
        headers: { "Content-Type": contentType },
      };
    },

    async presignDownload(key: string): Promise<PresignedDownload> {
      const file = bucket.file(key);
      const [url] = await file.getSignedUrl({
        version: "v4",
        action: "read",
        expires: Date.now() + 60 * 60 * 1000,
      });
      return { url, method: "GET" };
    },

    async putObject(key, body, contentType): Promise<void> {
      await bucket.file(key).save(body, { contentType, resumable: false });
    },

    async headObject(key): Promise<StoredObjectInfo | null> {
      const file = bucket.file(key);
      const [exists] = await file.exists();
      if (!exists) return null;
      const [meta] = await file.getMetadata();
      return {
        size: Number(meta.size ?? 0),
        contentType: typeof meta.contentType === "string" ? meta.contentType : null,
      };
    },

    async readPrefix(key, bytes): Promise<Buffer> {
      const [buf] = await bucket
        .file(key)
        .download({ start: 0, end: Math.max(0, bytes - 1) });
      return buf;
    },

    async openReadStream(key): Promise<Readable> {
      return bucket.file(key).createReadStream();
    },

    async deleteObject(key): Promise<void> {
      await bucket.file(key).delete({ ignoreNotFound: true });
    },
  };
}

/**
 * Development storage: objects live under `rootDir` on local disk and are
 * served by the API (no presigned URLs). Keys are sanitised so they can never
 * escape the root.
 */
export function createLocalStorage(rootDir: string): TabulaStorage {
  const root = path.resolve(rootDir);

  function resolveKey(key: string): string {
    const safe = key
      .split("/")
      .filter((p) => p && p !== "." && p !== "..")
      .map((p) => p.replace(/[^A-Za-z0-9._-]/g, "_"))
      .join(path.sep);
    const full = path.resolve(root, safe);
    if (!full.startsWith(root + path.sep)) {
      throw new Error("Invalid storage key");
    }
    return full;
  }

  async function metaOf(full: string): Promise<{ contentType: string | null }> {
    try {
      const raw = await readFile(`${full}.meta.json`, "utf8");
      const parsed = JSON.parse(raw) as { contentType?: string };
      return { contentType: parsed.contentType ?? null };
    } catch {
      return { contentType: null };
    }
  }

  return {
    driver: "local",

    async ensureBucket(): Promise<void> {
      await mkdir(root, { recursive: true });
    },

    async presignUpload(): Promise<PresignedUpload> {
      throw new Error("Local storage does not support presigned uploads");
    },

    async presignDownload(): Promise<PresignedDownload> {
      throw new Error("Local storage does not support presigned downloads");
    },

    async putObject(key, body, contentType): Promise<void> {
      const full = resolveKey(key);
      await mkdir(path.dirname(full), { recursive: true });
      await writeFile(full, body);
      await writeFile(`${full}.meta.json`, JSON.stringify({ contentType }));
    },

    async headObject(key): Promise<StoredObjectInfo | null> {
      const full = resolveKey(key);
      try {
        const s = await stat(full);
        const meta = await metaOf(full);
        return { size: s.size, contentType: meta.contentType };
      } catch {
        return null;
      }
    },

    async readPrefix(key, bytes): Promise<Buffer> {
      const full = resolveKey(key);
      const fh = await open(full, "r");
      try {
        const buf = Buffer.alloc(bytes);
        const { bytesRead } = await fh.read(buf, 0, bytes, 0);
        return buf.subarray(0, bytesRead);
      } finally {
        await fh.close();
      }
    },

    async openReadStream(key): Promise<Readable> {
      const full = resolveKey(key);
      await stat(full);
      return createReadStream(full);
    },

    async deleteObject(key): Promise<void> {
      const full = resolveKey(key);
      await rm(full, { force: true });
      await rm(`${full}.meta.json`, { force: true });
    },
  };
}

export { sniffMime, isImageMime, readImageSize } from "./sniff.js";
