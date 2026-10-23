import { StandardMeter, StandardTracer } from "@devopsplaybook.io/otel-utils";
import { StandardTracerFastifyRegisterHooks } from "@devopsplaybook.io/otel-utils-fastify";
import Fastify, { type FastifyInstance } from "fastify";
import { Config } from "./Config";
import { registerRoutes } from "./AppRoutes";
import {
  OTelLogger,
  OTelMeter,
  OTelSetMeter,
  OTelSetTracer,
  OTelTracer,
} from "./OTelContext";

export interface AppOptions {
  exit?: (code: number) => void;
  shutdownTimeoutMs?: number;
}

const DEFAULT_SHUTDOWN_TIMEOUT_MS = 10_000;

const logger = OTelLogger().createModuleLogger("app");

let fastifyInstance: FastifyInstance | undefined;
let stopPromise: Promise<void> | undefined;
let shuttingDown = false;

function getExit(options?: AppOptions): (code: number) => void {
  return options?.exit ?? process.exit;
}

function handleSignal(signal: NodeJS.Signals, options?: AppOptions): void {
  const exit = getExit(options);
  if (shuttingDown) {
    logger.warn(`Received ${signal} while shutting down; exiting immediately`);
    exit(1);
    return;
  }
  shuttingDown = true;
  logger.info(`Received ${signal}; shutting down`);

  stop(options).catch((error: unknown) => {
    logger.error(
      "Error during shutdown",
      error instanceof Error ? error : new Error(String(error)),
    );
    exit(1);
  });
}

async function performStop(options?: AppOptions): Promise<void> {
  const exit = getExit(options);
  const shutdownTimeoutMs =
    options?.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS;

  const shutdown = (async () => {
    if (fastifyInstance) {
      const instance = fastifyInstance;
      fastifyInstance = undefined;
      await instance.close();
    }
    await Promise.allSettled([
      OTelLogger().shutdown(),
      OTelTracer()?.shutdown?.(),
      OTelMeter()?.shutdown?.(),
    ]);
  })().catch((error: unknown) => {
    logger.error(
      "Error while flushing telemetry",
      error instanceof Error ? error : new Error(String(error)),
    );
  });

  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(() => {
      logger.warn(`Shutdown timed out after ${shutdownTimeoutMs} ms`);
      resolve();
    }, shutdownTimeoutMs);
    timer.unref();
  });

  try {
    await Promise.race([shutdown, timeout]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
  exit(0);
}

/**
 * Stops accepting requests, flushes the OTel providers with a bounded timeout
 * and exits. Idempotent: concurrent or repeated calls share one shutdown.
 */
export async function stop(options?: AppOptions): Promise<void> {
  if (!stopPromise) {
    stopPromise = performStop(options);
  }
  await stopPromise;
}

/**
 * Loads the configuration once (changes require a restart) and starts the
 * HTTP server. A webhook request reads only the authorization header at
 * request time; collector endpoints and export intervals are fixed at startup.
 */
export async function start(options?: AppOptions): Promise<FastifyInstance> {
  const config = new Config();
  await config.reload();

  // Configuration is read once here and the OTel providers are built from it,
  // so changing config.json or environment variables requires a restart
  // (Kubernetes subPath ConfigMap mounts are not updated in place either).
  OTelSetTracer(new StandardTracer(config));
  OTelSetMeter(new StandardMeter(config));
  OTelLogger().initOTel(config);

  logger.info("====== Starting fluxcd-notifications-otel-adapter Server ======");

  const fastify = Fastify({});

  // rootApiPath "/" is required so webhook requests to POST / are traced:
  // the hooks default to "/api" and silently skip everything outside it.
  StandardTracerFastifyRegisterHooks(fastify, OTelTracer(), OTelLogger(), {
    rootApiPath: "/",
    ignoreList: ["GET-/api/status"],
  });

  registerRoutes(fastify, config);

  await fastify.listen({ port: config.API_PORT, host: "0.0.0.0" });
  logger.info("API Listening");

  fastifyInstance = fastify;
  process.on("SIGTERM", () => handleSignal("SIGTERM", options));
  process.on("SIGINT", () => handleSignal("SIGINT", options));

  return fastify;
}

export async function main(options?: AppOptions): Promise<void> {
  const exit = getExit(options);
  try {
    await start(options);
  } catch (error) {
    logger.error(
      "Error starting fluxcd-notifications-otel-adapter",
      error instanceof Error ? error : new Error(String(error)),
    );
    exit(1);
  }
}

if (require.main === module) {
  void main();
}
