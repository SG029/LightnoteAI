import { mkdir } from "node:fs/promises";
import express from "express";
import cors from "cors";
import { pinoHttp } from "pino-http";
import mongoose from "mongoose";
import { config } from "./config.js";
import { logger } from "./lib/logger.js";
import { jobsRouter } from "./routes/jobs.js";
import { internalRouter } from "./routes/internal.js";
import { healthRouter } from "./routes/health.js";
import { errorHandler, notFoundHandler } from "./middleware/errorHandler.js";
import { reconcileOrphanedJobs, drain } from "./services/dispatcher.js";

const app = express();

app.disable("x-powered-by");
app.set("trust proxy", true);

app.use(
  pinoHttp({
    logger,
    // Health polling and SSE heartbeats would otherwise drown the log.
    autoLogging: {
      ignore: (req: { url?: string }) =>
        req.url?.startsWith("/api/health") || req.url?.includes("/stream") || false,
    },
  }),
);

app.use(cors({ origin: true, credentials: true }));

// Only JSON bodies are parsed globally — multipart uploads are handled by
// multer inside the jobs router, which must see the raw stream.
app.use(express.json({ limit: "1mb" }));

app.use("/api/health", healthRouter);
app.use("/api/jobs", jobsRouter);
app.use("/internal", internalRouter);

app.use(notFoundHandler);
app.use(errorHandler);

async function start() {
  // Ensure artifact directories exist before anything tries to write to them.
  await Promise.all([
    mkdir(config.paths.uploads, { recursive: true }),
    mkdir(config.paths.frames, { recursive: true }),
    mkdir(config.paths.outputs, { recursive: true }),
  ]);

  mongoose.set("strictQuery", true);
  await mongoose.connect(config.MONGODB_URI, { serverSelectionTimeoutMS: 5000 }).catch((err) => {
    logger.error(
      { err: err.message },
      `Could not reach MongoDB at ${config.MONGODB_URI}. Start it with "npm run mongo:up".`,
    );
    process.exit(1);
  });
  logger.info("Connected to MongoDB");

  await reconcileOrphanedJobs();

  const server = app.listen(config.PORT, () => {
    logger.info(`API listening on http://localhost:${config.PORT}`);
    logger.info(`ML worker expected at ${config.ML_SERVICE_URL}`);
  });

  // Renders legitimately take minutes; the default 2-minute socket timeout
  // would sever an SSE stream mid-job.
  server.requestTimeout = 0;
  server.headersTimeout = 0;

  const shutdown = async (signal: string) => {
    logger.info({ signal }, "Shutting down");
    server.close();
    await drain();
    await mongoose.connection.close();
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

start().catch((err) => {
  logger.error({ err }, "Failed to start server");
  process.exit(1);
});
