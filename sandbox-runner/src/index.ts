import { config } from "./config.js";
import { logger } from "./middleware.js";
import { buildServer } from "./server.js";
import { startWorker, execQueue, execEvents } from "./queue.js";
import { startReaper, destroyAllSessions } from "./sessions.js";
import { sweepOrphans, docker } from "./docker.js";

async function main(): Promise<void> {
  // Fail fast if Docker or the sandbox image isn't available.
  await docker.ping();
  try {
    await docker.getImage(config.SANDBOX_IMAGE).inspect();
  } catch {
    logger.error(`Sandbox image "${config.SANDBOX_IMAGE}" not found. Build it first: docker build -t ${config.SANDBOX_IMAGE} ./sandbox-image`);
    process.exit(1);
  }

  await sweepOrphans();

  const worker = startWorker();
  const reaper = startReaper();
  const app = buildServer();
  const server = app.listen(config.PORT, () => {
    logger.info({ port: config.PORT, image: config.SANDBOX_IMAGE, concurrency: config.MAX_CONCURRENT_JOBS }, "sandbox runner listening");
  });

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, "shutting down");
    clearInterval(reaper);
    server.close();
    await worker.close();
    await execEvents.close();
    await execQueue.close();
    await destroyAllSessions();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((e) => {
  logger.error({ err: e }, "fatal startup error");
  process.exit(1);
});
