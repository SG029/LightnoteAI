import type { ErrorRequestHandler, RequestHandler } from "express";
import { ZodError } from "zod";
import { AppError } from "../lib/errors.js";
import { logger } from "../lib/logger.js";
import { config } from "../config.js";

export const notFoundHandler: RequestHandler = (req, res) => {
  res.status(404).json({
    error: { code: "not_found", message: `No route for ${req.method} ${req.path}` },
  });
};

/**
 * Terminal error middleware. Every failure leaves here in one shape:
 *   { error: { code, message, details? } }
 * so the client never has to guess how to read a failure.
 */
export const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  if (err instanceof AppError) {
    if (err.statusCode >= 500) logger.error({ err }, err.code);
    else logger.warn({ code: err.code, message: err.message }, "Request rejected");
    res.status(err.statusCode).json(err.toJSON());
    return;
  }

  if (err instanceof ZodError) {
    res.status(400).json({
      error: {
        code: "validation_failed",
        message: "The request body did not match the expected shape.",
        details: err.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
      },
    });
    return;
  }

  // Anything reaching here is an unhandled bug. Log it in full, but return a
  // generic message so internals are not exposed to the client.
  logger.error({ err }, "Unhandled error");
  res.status(500).json({
    error: {
      code: "internal_error",
      message: "Something went wrong on the server.",
      ...(config.isDev ? { details: (err as Error)?.message } : {}),
    },
  });
};
