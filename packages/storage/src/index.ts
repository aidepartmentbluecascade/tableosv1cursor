import { Storage } from "@google-cloud/storage";

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

export interface TabulaStorage {
  presignUpload(key: string, contentType: string): Promise<PresignedUpload>;
  presignDownload(key: string): Promise<PresignedDownload>;
  ensureBucket(): Promise<void>;
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
  };
}
