/**
 * Application errors carry an HTTP status and a stable machine-readable
 * code, so the client can branch on `code` while showing `message`.
 * Anything thrown that is NOT an AppError is treated as a bug and
 * reported as a generic 500 without leaking internals.
 */
export class AppError extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly details?: unknown;

  constructor(statusCode: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = "AppError";
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
    Error.captureStackTrace?.(this, AppError);
  }

  static badRequest(code: string, message: string, details?: unknown) {
    return new AppError(400, code, message, details);
  }

  static notFound(message = "Not found") {
    return new AppError(404, "not_found", message);
  }

  static unauthorized(message = "Unauthorized") {
    return new AppError(401, "unauthorized", message);
  }

  static conflict(code: string, message: string) {
    return new AppError(409, code, message);
  }

  static upstream(code: string, message: string, details?: unknown) {
    return new AppError(502, code, message, details);
  }

  toJSON() {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.details !== undefined ? { details: this.details } : {}),
      },
    };
  }
}
