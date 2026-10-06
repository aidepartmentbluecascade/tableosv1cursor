import {
  TabulaErrorCodes,
  createTabulaError,
  type TabulaError,
  type TabulaErrorCode,
} from "@tabula/types";
import type { FastifyReply, FastifyRequest } from "fastify";
import { ZodError } from "zod";
import { ForbiddenActionError } from "../modules/access/assert.js";
import { PlanLimitExceededError } from "../modules/billing/limits-service.js";

export const PROBLEM_CONTENT_TYPE = "application/problem+json";

export interface ProblemDocument extends TabulaError {
  type: string;
  requestId: string;
}

const ERROR_TYPE_BASE = "https://tabula.dev/errors";

export function problemType(code: TabulaErrorCode): string {
  return `${ERROR_TYPE_BASE}/${code.toLowerCase().replace(/_/g, "-")}`;
}

export function sendProblem(
  reply: FastifyReply,
  request: FastifyRequest,
  error: TabulaError,
): void {
  const body: ProblemDocument = {
    ...error,
    type: problemType(error.code),
    requestId: request.id,
  };
  void reply
    .code(error.status)
    .header("content-type", PROBLEM_CONTENT_TYPE)
    .send(body);
}

export function validationProblem(
  request: FastifyRequest,
  reply: FastifyReply,
  detail: string,
  errors?: TabulaError["errors"],
): void {
  sendProblem(
    reply,
    request,
    createTabulaError(TabulaErrorCodes.VALIDATION_FAILED, {
      detail,
      ...(errors !== undefined ? { errors } : {}),
    }),
  );
}

export function notFound(request: FastifyRequest, reply: FastifyReply, detail?: string): void {
  sendProblem(
    reply,
    request,
    createTabulaError(TabulaErrorCodes.NOT_FOUND, {
      ...(detail !== undefined ? { detail } : {}),
    }),
  );
}

export function unauthorized(request: FastifyRequest, reply: FastifyReply): void {
  sendProblem(
    reply,
    request,
    createTabulaError(TabulaErrorCodes.UNAUTHENTICATED),
  );
}

export function forbidden(request: FastifyRequest, reply: FastifyReply, detail?: string): void {
  sendProblem(
    reply,
    request,
    createTabulaError(TabulaErrorCodes.FORBIDDEN, {
      ...(detail !== undefined ? { detail } : {}),
    }),
  );
}

export function conflict(request: FastifyRequest, reply: FastifyReply, detail: string): void {
  sendProblem(
    reply,
    request,
    createTabulaError(TabulaErrorCodes.VERSION_CONFLICT, { detail }),
  );
}

export function handleRouteError(
  request: FastifyRequest,
  reply: FastifyReply,
  err: unknown,
): void {
  if (err instanceof ZodError) {
    validationProblem(request, reply, "Invalid request body", err.errors.map((e) => ({
      field: e.path.join("."),
      message: e.message,
    })));
    return;
  }
  if (
    err instanceof Error &&
    (err.message === "INVALID_FILTER_AST" || err.message === "FILTER_DEPTH_EXCEEDED")
  ) {
    validationProblem(request, reply, err.message === "INVALID_FILTER_AST"
      ? "Invalid filter expression"
      : "Filter is nested too deeply");
    return;
  }
  if (err instanceof PublicIdError) {
    validationProblem(request, reply, err.message);
    return;
  }
  if (err instanceof ForbiddenActionError) {
    forbidden(request, reply, `Missing permission: ${err.action}`);
    return;
  }
  if (err instanceof PlanLimitExceededError) {
    sendProblem(
      reply,
      request,
      createTabulaError(TabulaErrorCodes.PLAN_LIMIT_EXCEEDED, {
        detail: err.message,
        ...(err.meta !== undefined ? { meta: err.meta } : {}),
      }),
    );
    return;
  }
  request.log.error({ err }, "Unhandled route error");
  sendProblem(
    reply,
    request,
    createTabulaError(TabulaErrorCodes.VALIDATION_FAILED, {
      status: 500,
      title: "Internal server error",
      detail: "An unexpected error occurred",
    }),
  );
}

export class PublicIdError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PublicIdError";
  }
}

export function wrapPublicId<T>(fn: () => T): T {
  try {
    return fn();
  } catch (e) {
    if (e instanceof Error && e.message.includes("public id")) {
      throw new PublicIdError(e.message);
    }
    throw e;
  }
}
