import pino, { type Logger, type LoggerOptions } from "pino";

export interface CreateLoggerOptions {
  name: string;
  level?: LoggerOptions["level"];
  role?: string;
}

export function createLogger(options: CreateLoggerOptions): Logger {
  const { name, level = process.env["LOG_LEVEL"] ?? "info", role } = options;
  const opts: LoggerOptions = { name, level };
  if (role !== undefined) {
    opts.base = { role };
  }
  return pino(opts);
}
