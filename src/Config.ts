import { ConfigBase } from "@devopsplaybook.io/common-utils";
import { OTelLogger } from "./OTelContext";

const logger = OTelLogger().createModuleLogger("config");

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { version: APP_VERSION } = require("../package.json");

export class Config extends ConfigBase {
  public WEBHOOK_AUTHORIZATION_HEADER = "";
  // When true, startup refuses to continue without WEBHOOK_AUTHORIZATION_HEADER
  // (fail closed); when false (backward-compatible default), an empty header
  // only logs a warning at startup.
  public WEBHOOK_AUTH_REQUIRED = false;
  // Per-client-IP fixed window; 0 disables the in-process limiter.
  public WEBHOOK_RATE_LIMIT_PER_MINUTE = 600;
  // Fastify trustProxy: empty (direct peer), true (trust every X-Forwarded-For)
  // or a comma-separated list of trusted proxy addresses/CIDR ranges.
  public TRUST_PROXY = "";

  constructor() {
    super("fluxcd-notifications");
    this.addConfigField({
      field: "WEBHOOK_AUTHORIZATION_HEADER",
      sensitive: true,
    });
    this.addConfigField({ field: "WEBHOOK_AUTH_REQUIRED" });
    this.addConfigField({ field: "WEBHOOK_RATE_LIMIT_PER_MINUTE" });
    this.addConfigField({ field: "TRUST_PROXY" });
    // ConfigBase defaults VERSION to the shared library's version; telemetry
    // must report this application's version instead.
    this.VERSION = APP_VERSION;
  }

  public async reload(): Promise<void> {
    await super.reload((message: string) => logger.info(message));
  }
}
