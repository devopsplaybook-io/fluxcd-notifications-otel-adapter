import { ConfigBase } from "@devopsplaybook.io/common-utils";
import { OTelLogger } from "./OTelContext";

const logger = OTelLogger().createModuleLogger("config");

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { version: APP_VERSION } = require("../package.json");

export class Config extends ConfigBase {
  public WEBHOOK_AUTHORIZATION_HEADER = "";

  constructor() {
    super("fluxcd-notifications");
    this.addConfigField({
      field: "WEBHOOK_AUTHORIZATION_HEADER",
      sensitive: true,
    });
    // ConfigBase defaults VERSION to the shared library's version; telemetry
    // must report this application's version instead.
    this.VERSION = APP_VERSION;
  }

  public async reload(): Promise<void> {
    await super.reload((message: string) => logger.info(message));
  }
}
