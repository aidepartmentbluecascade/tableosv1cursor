import { TabulaErrorCodes, createTabulaError } from "@tabula/types";
import type { FastifyReply, FastifyRequest } from "fastify";
import { handleRouteError, sendProblem } from "../../http/errors.js";
import {
  StorageUnavailableError,
  UploadRejectedError,
} from "../attachments/service.js";

export function serviceUnavailable(
  request: FastifyRequest,
  reply: FastifyReply,
  detail: string,
): void {
  sendProblem(
    reply,
    request,
    createTabulaError(TabulaErrorCodes.VALIDATION_FAILED, {
      status: 503,
      title: "Service unavailable",
      detail,
      meta: { reason: "storage_unavailable" },
    }),
  );
}

export function gone(request: FastifyRequest, reply: FastifyReply, detail: string, reason: string): void {
  sendProblem(
    reply,
    request,
    createTabulaError(TabulaErrorCodes.NOT_FOUND, {
      status: 410,
      title: "Gone",
      detail,
      meta: { reason },
    }),
  );
}

export function tooManyRequests(request: FastifyRequest, reply: FastifyReply, detail: string): void {
  sendProblem(
    reply,
    request,
    createTabulaError(TabulaErrorCodes.VALIDATION_FAILED, {
      status: 429,
      title: "Too many requests",
      detail,
    }),
  );
}

export function passwordRequired(request: FastifyRequest, reply: FastifyReply, wrong: boolean): void {
  sendProblem(
    reply,
    request,
    createTabulaError(TabulaErrorCodes.UNAUTHENTICATED, {
      title: wrong ? "Incorrect password" : "Password required",
      detail: wrong ? "The password is incorrect" : "This share is password protected",
      meta: { reason: wrong ? "password_incorrect" : "password_required" },
    }),
  );
}

/** handleRouteError plus the wave-4 specific errors. */
export function handleWave4Error(request: FastifyRequest, reply: FastifyReply, err: unknown): void {
  if (err instanceof StorageUnavailableError) {
    serviceUnavailable(request, reply, err.message);
    return;
  }
  if (err instanceof UploadRejectedError) {
    sendProblem(
      reply,
      request,
      createTabulaError(TabulaErrorCodes.VALIDATION_FAILED, {
        status: /too large/i.test(err.message) ? 413 : 422,
        detail: err.message,
      }),
    );
    return;
  }
  handleRouteError(request, reply, err);
}
