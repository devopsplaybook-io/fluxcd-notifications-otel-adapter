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

  StandardTracerFastifyRegisterHooks(fastify, OTelTracer(), OTelLogger(), {
    ignoreList: ["GET-/api/status"],
  });

  fastify.get("/api/status", async () => {
    return { started: true };
  });

  const fluxtLogger = OTelLogger().createModuleLogger("fluxcd-notifications");

  fastify.post("/", async (request, reply) => {
    const body = request.body as {
      message?: string;
      reason?: string;
      metadata?: { cluster?: string };
    };
    if (body?.message && body?.reason && body?.metadata?.cluster) {
      fluxtLogger.info(
        `${body.metadata.cluster}: ${body.reason} - ${body.message}`,
      );
      reply.status(200).send({ status: "ok" });
      return;
    }
    reply.status(400).send({ error: "Bad Request" });
  });

  fastify.listen({ port: config.API_PORT, host: "0.0.0.0" }, (err) => {
    if (err) {
      logger.error("Error Starting API", err);
      process.exit(1);
    }
    logger.info("API Listening");
  });
});
