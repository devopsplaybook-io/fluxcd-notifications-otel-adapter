import { StandardMeter, StandardTracer } from "@devopsplaybook.io/otel-utils";
import { StandardTracerFastifyRegisterHooks } from "@devopsplaybook.io/otel-utils-fastify";
import Fastify, {
  type FastifyInstance,
  type FastifyServerOptions,
} from "fastify";
import { Config } from "./Config";
import { registerRoutes } from "./AppRoutes";
import { resolveRateLimitPerMinute } from "./RateLimiter";
import { resolveTrustProxy } from "./TrustProxy";
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

// A worst-case record is a 16 384-code-point message (up to ~64 KiB of UTF-16
// data) plus ~10 KiB of 256-code-point attributes and record overhead (~75 KiB);
// a full 2 048-record queue can retain roughly 150 MiB, and an in-flight export
// can hold a second copy (~300 MiB). Raise the queue or lower the caps only
// with a documented memory budget.
export const FASTIFY_OPTIONS: FastifyServerOptions = {
  bodyLimit: 64 * 1024,
  connectionTimeout: 10_000,
  requestTimeout: 15_000,
  keepAliveTimeout: 72_000,
};

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

  // Fail closed before any server or telemetry setup when authentication is
  // required but not configured: a production deployment must not silently
  // run unauthenticated.
  if (config.WEBHOOK_AUTH_REQUIRED && !config.WEBHOOK_AUTHORIZATION_HEADER) {
    throw new Error(
      "WEBHOOK_AUTH_REQUIRED is enabled but WEBHOOK_AUTHORIZATION_HEADER is not set; refusing to start with webhook authentication disabled",
    );
  }

  // Configuration is read once here and the OTel providers are built from it,
  // so changing config.json or environment variables requires a restart
  // (Kubernetes subPath ConfigMap mounts are not updated in place either).
  OTelSetTracer(new StandardTracer(config));
  OTelSetMeter(new StandardMeter(config));
  OTelLogger().initOTel(config);

  logger.info("====== Starting fluxcd-notifications-otel-adapter Server ======");

  // Authentication is active whenever the header is set; WEBHOOK_AUTH_REQUIRED
  // only makes the requirement explicit and fail-closed. The fail-open default
  // is kept for backward compatibility (the live deployment has no auth header).
  if (config.WEBHOOK_AUTH_REQUIRED) {
    logger.info("webhook authentication required and enabled");
  } else if (config.WEBHOOK_AUTHORIZATION_HEADER) {
    logger.info("webhook authentication enabled (WEBHOOK_AUTH_REQUIRED=false)");
  } else {
    logger.warn(
      "webhook authentication disabled: WEBHOOK_AUTHORIZATION_HEADER is not set and WEBHOOK_AUTH_REQUIRED is false (backward-compatible fail-open)",
    );
  }
  const rateLimitPerMinute = resolveRateLimitPerMinute(
    config.WEBHOOK_RATE_LIMIT_PER_MINUTE,
  );
  if (rateLimitPerMinute === 0) {
    logger.info(
      "rate limiting disabled (WEBHOOK_RATE_LIMIT_PER_MINUTE=0)",
    );
  } else {
    logger.info(
      `rate limit: ${rateLimitPerMinute} requests/minute per client IP on every route`,
    );
  }

  const trustProxy = resolveTrustProxy(config.TRUST_PROXY);
  if (trustProxy === true) {
    logger.warn(
      "client IP model: TRUST_PROXY=true trusts every X-Forwarded-For value; a header-sanitizing proxy is mandatory or clients can bypass the rate limiter",
    );
  } else if (trustProxy === false) {
    logger.info(
      "client IP model: TRUST_PROXY is off; request.ip is the direct peer address, so clients behind a proxy share its rate-limit bucket",
    );
  } else {
    logger.info(
      `client IP model: trusting X-Forwarded-For from ${trustProxy.length} configured proxy address range(s)`,
    );
  }

  const fastify = Fastify({ ...FASTIFY_OPTIONS, trustProxy });

  // Routes are registered before the tracing hooks so the global rate limiter
  // runs first: a 429 short-circuits before a span or body parse.
  registerRoutes(fastify, config);

  // rootApiPath "/" is required so webhook requests to POST / are traced:
  // the hooks default to "/api" and silently skip everything outside it.
  StandardTracerFastifyRegisterHooks(fastify, OTelTracer(), OTelLogger(), {
    rootApiPath: "/",
    ignoreList: ["GET-/api/status"],
    unmatchedRouteSpanName: "method",
  });

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
