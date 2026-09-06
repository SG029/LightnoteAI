import { randomUUID } from "node:crypto";
import { extname } from "node:path";
import multer from "multer";
import { config } from "../config.js";
import { AppError } from "../lib/errors.js";

const VIDEO_MIME = new Set([
  "video/mp4",
  "video/quicktime",
  "video/webm",
  "video/x-matroska",
]);

const IMAGE_MIME = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
]);

const VIDEO_EXT = new Set([".mp4", ".mov", ".webm", ".mkv", ".m4v"]);
const IMAGE_EXT = new Set([".jpg", ".jpeg", ".png", ".webp"]);

/**
 * Generic types a client sends when it cannot or does not classify the file.
 * curl always does this; browsers do it too when the OS MIME registry has no
 * entry for the extension, which is common for .mkv on Windows.
 */
const UNCLASSIFIED = new Set(["", "application/octet-stream", "binary/octet-stream"]);

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, config.paths.uploads),
  // Random filenames: user-supplied names are a path-traversal vector, and
  // two people uploading "video.mp4" must not collide.
  filename: (_req, file, cb) => {
    const ext = extname(file.originalname).toLowerCase().slice(0, 10) || ".bin";
    cb(null, `${randomUUID()}${ext}`);
  },
});

export const uploadJobFiles = multer({
  storage,
  limits: {
    fileSize: config.maxVideoBytes,
    files: 2,
    fields: 10,
  },
  fileFilter: (_req, file, cb) => {
    const isVideo = file.fieldname === "video";
    const allowedMime = isVideo ? VIDEO_MIME : IMAGE_MIME;
    const allowedExt = isVideo ? VIDEO_EXT : IMAGE_EXT;

    if (allowedMime.has(file.mimetype)) return cb(null, true);

    // Fall back to the extension when the client did not classify the file.
    // This is not a weakened check: ffprobe reads the actual container before
    // the job is accepted, so a mislabelled file is still rejected — just
    // with an accurate message about its contents rather than its label.
    const ext = extname(file.originalname).toLowerCase();
    if (UNCLASSIFIED.has(file.mimetype) && allowedExt.has(ext)) return cb(null, true);

    cb(
      AppError.badRequest(
        "unsupported_file_type",
        isVideo
          ? `Unsupported video type "${file.mimetype || ext || "unknown"}". Use MP4, MOV, WebM or MKV.`
          : `Unsupported image type "${file.mimetype || ext || "unknown"}". Use JPEG, PNG or WebP.`,
      ),
    );
  },
}).fields([
  { name: "video", maxCount: 1 },
  { name: "referenceImage", maxCount: 1 },
]);

/** Translates multer's own errors into the app's error shape. */
export function normaliseUploadError(err: unknown): AppError {
  if (err instanceof AppError) return err;

  if (err instanceof multer.MulterError) {
    if (err.code === "LIMIT_FILE_SIZE") {
      return AppError.badRequest(
        "file_too_large",
        `That file exceeds the ${config.MAX_VIDEO_MB} MB limit. Trim the clip or lower its resolution.`,
      );
    }
    if (err.code === "LIMIT_UNEXPECTED_FILE") {
      return AppError.badRequest(
        "unexpected_field",
        `Unexpected upload field "${err.field}". Send "video" and optionally "referenceImage".`,
      );
    }
    return AppError.badRequest("upload_failed", err.message);
  }

  return new AppError(500, "upload_failed", "The upload could not be processed.");
}
