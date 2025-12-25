import { StandardMeter, StandardTracer } from "@devopsplaybook.io/otel-utils";
import { StandardTracerFastifyRegisterHooks } from "@devopsplaybook.io/otel-utils-fastify";
import Fastify from "fastify";
import { watchFile } from "fs-extra";
import { Config } from "./Config";
import {
  OTelLogger,
  OTelSetMeter,
  OTelSetTracer,
  OTelTracer,
} from "./OTelContext";
import { FlucCDRoutes } from "./fluxcd/FlucCDRoutes";

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

  const fastify = Fastify({
    logger: config.LOG_LEVEL === process.env.FASTIFY_LOG_LEVEL,
  });

  /* eslint-disable-next-line */
  fastify.register(require("@fastify/multipart"));

  StandardTracerFastifyRegisterHooks(fastify, OTelTracer(), OTelLogger(), {
    ignoreList: ["GET-/api/status"],
  });

  fastify.register(new FlucCDRoutes().getRoutes, {
    prefix: "/api/fluxcd",
  });

  fastify.get("/api/status", async () => {
    return { started: true };
  });

  fastify.setNotFoundHandler((request, reply) => {
    console.log("Method:", request.method);
    console.log("URL:", request.url);
    console.log("Body:", request.body);
    reply.status(404).send({ error: "Not Found" });
  });

  fastify.listen({ port: config.API_PORT, host: "0.0.0.0" }, (err) => {
    if (err) {
      logger.error("Error Starting API", err);
      process.exit(1);
    }
    logger.info("API Listening");
  });
});
