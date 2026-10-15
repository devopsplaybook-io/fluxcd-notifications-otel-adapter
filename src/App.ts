import { StandardMeter, StandardTracer } from "@devopsplaybook.io/otel-utils";
import { StandardTracerFastifyRegisterHooks } from "@devopsplaybook.io/otel-utils-fastify";
import Fastify from "fastify";
import { watchFile } from "fs-extra";
import { Config } from "./Config";
import { registerRoutes } from "./AppRoutes";
import {
  OTelLogger,
  OTelSetMeter,
  OTelSetTracer,
  OTelTracer,
} from "./OTelContext";

const logger = OTelLogger().createModuleLogger("app");

logger.info("====== Starting fluxcd-notifications-otel-adapter Server ======");

Promise.resolve().then(async () => {
  //
  const config = new Config();
  await config.reload();
  watchFile(config.CONFIG_FILE, () => {
    logger.info(`Config updated: ${config.CONFIG_FILE}`);
    config.reload();
  });

  OTelSetTracer(new StandardTracer(config));
  OTelSetMeter(new StandardMeter(config));
  OTelLogger().initOTel(config);

  const span = OTelTracer().startSpan("init");
  span.end();

  // API

  const fastify = Fastify({});

  // rootApiPath "/" is required so webhook requests to POST / are traced:
  // the hooks default to "/api" and silently skip everything outside it.
  StandardTracerFastifyRegisterHooks(fastify, OTelTracer(), OTelLogger(), {
    rootApiPath: "/",
    ignoreList: ["GET-/api/status"],
  });

  registerRoutes(fastify, config);

  fastify.listen({ port: config.API_PORT, host: "0.0.0.0" }, (err) => {
    if (err) {
      logger.error("Error Starting API", err);
      process.exit(1);
    }
    logger.info("API Listening");
  });
});
