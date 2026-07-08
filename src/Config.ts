import { ConfigBase } from "@devopsplaybook.io/common-utils";
import { OTelLogger } from "./OTelContext";

const logger = OTelLogger().createModuleLogger("config");

export class Config extends ConfigBase {
  constructor() {
    super("fluxcd-notifications");
  }

  public async reload(): Promise<void> {
    await super.reload((message: string) => logger.info(message));
  }
}
