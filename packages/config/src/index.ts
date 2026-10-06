import { z } from "zod";

export const ProcessRoleSchema = z.enum([
  "api",
  "realtime",
  "worker",
  "scheduler",
  "relay",
]);

export type ProcessRole = z.infer<typeof ProcessRoleSchema>;

/** Empty env values (GOOGLE_CLIENT_ID=) should behave like unset. */
const optionalNonEmpty = z.preprocess(
  (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
  z.string().min(1).optional(),
);

const optionalSecret = z.preprocess(
  (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
  z.string().min(16).optional(),
);

export const EnvSchema = z.object({
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),
  SESSION_SECRET: z.string().min(16),
  APP_URL: z.string().url(),
  API_URL: z.string().url(),
  PORT: z.coerce.number().int().positive().default(3000),
  REALTIME_PORT: z.coerce.number().int().positive().default(3002),
  WS_TICKET_SECRET: optionalSecret,
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  ROLE: ProcessRoleSchema.default("api"),
  GOOGLE_CLIENT_ID: optionalNonEmpty,
  GOOGLE_CLIENT_SECRET: optionalNonEmpty,
  MFA_ENCRYPTION_KEY: optionalSecret,
  /** GCS bucket for attachments (required for uploads). */
  GCS_BUCKET: optionalNonEmpty,
  GCS_PROJECT_ID: optionalNonEmpty,
  /** Path to service-account JSON; falls back to GOOGLE_APPLICATION_CREDENTIALS. */
  GCS_KEY_FILE: optionalNonEmpty,
  GOOGLE_APPLICATION_CREDENTIALS: optionalNonEmpty,
  /** Inline service-account JSON string (alternative to key file). */
  GCS_CREDENTIALS_JSON: optionalNonEmpty,
  /** Alias for GCS_CREDENTIALS_JSON. */
  GOOGLE_CREDENTIALS_JSON: optionalNonEmpty,
});

export type Env = z.infer<typeof EnvSchema>;

export function loadEnv(
  source: Record<string, string | undefined> = process.env,
): Env {
  return EnvSchema.parse(source);
}
