// Mock OTelContext before importing Config
const mockInfo = jest.fn();
const mockCreateModuleLogger = jest.fn(() => ({
  info: mockInfo,
}));

jest.mock("./OTelContext", () => ({
  OTelLogger: jest.fn(() => ({
    createModuleLogger: mockCreateModuleLogger,
  })),
}));

// Track constructor, addConfigField and reload calls on ConfigBase
const mockReload = jest.fn().mockResolvedValue(undefined);
let capturedServiceId: string | undefined;
let capturedConfigFields: Array<{ field: string; sensitive?: boolean }> = [];

jest.mock("@devopsplaybook.io/common-utils", () => ({
  ConfigBase: class MockConfigBase {
    public SERVICE_ID: string;
    public VERSION = "0.3.0";
    public CONFIG_FILE = "config.json";
    public API_PORT = 8080;
    public LOG_LEVEL = "info";
    public OPENTELEMETRY_COLLECTOR_HTTP_TRACES = "";
    public OPENTELEMETRY_COLLECTOR_HTTP_METRICS = "";
    public OPENTELEMETRY_COLLECTOR_HTTP_LOGS = "";
    public OPENTELEMETRY_COLLECTOR_AWS = false;
    public OPENTELEMETRY_COLLECTOR_EXPORT_LOGS_INTERVAL_SECONDS = 60;
    public OPENTELEMETRY_COLLECTOR_EXPORT_METRICS_INTERVAL_SECONDS = 60;
    public OPENTELEMETRY_COLLECT_AUTHORIZATION_HEADER = "";

    constructor(serviceId: string) {
      capturedServiceId = serviceId;
      this.SERVICE_ID = serviceId;
    }

    addConfigField(def: { field: string; sensitive?: boolean }): void {
      capturedConfigFields.push(def);
    }

    async reload(logger?: (message: string) => void): Promise<void> {
      return mockReload(logger);
    }
  },
}));

// swc hoists static imports above the mock declarations, so load the module
// under test with an in-place require after jest.mock registration.
const { Config } = require("./Config");
const { version: packageVersion } = require("../package.json");

describe("Config", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    capturedServiceId = undefined;
    capturedConfigFields = [];
  });

  describe("constructor", () => {
    it("should pass 'fluxcd-notifications' as service ID to ConfigBase", () => {
      const config = new Config();
      expect(capturedServiceId).toBe("fluxcd-notifications");
      expect(config.SERVICE_ID).toBe("fluxcd-notifications");
    });

    it("should have default property values from ConfigBase", () => {
      const config = new Config();
      expect(config.API_PORT).toBe(8080);
      expect(config.LOG_LEVEL).toBe("info");
      expect(config.OPENTELEMETRY_COLLECTOR_HTTP_TRACES).toBe("");
      expect(config.OPENTELEMETRY_COLLECTOR_HTTP_METRICS).toBe("");
      expect(config.OPENTELEMETRY_COLLECTOR_HTTP_LOGS).toBe("");
      expect(config.OPENTELEMETRY_COLLECTOR_AWS).toBe(false);
    });

    it("should default WEBHOOK_AUTHORIZATION_HEADER to empty", () => {
      const config = new Config();
      expect(config.WEBHOOK_AUTHORIZATION_HEADER).toBe("");
    });

    it("should default WEBHOOK_RATE_LIMIT_PER_MINUTE to 600", () => {
      const config = new Config();
      expect(config.WEBHOOK_RATE_LIMIT_PER_MINUTE).toBe(600);
    });

    it("should register WEBHOOK_AUTHORIZATION_HEADER as a sensitive config field", () => {
      new Config();
      expect(capturedConfigFields).toContainEqual({
        field: "WEBHOOK_AUTHORIZATION_HEADER",
        sensitive: true,
      });
    });

    it("should register WEBHOOK_RATE_LIMIT_PER_MINUTE as a non-sensitive config field", () => {
      new Config();
      expect(capturedConfigFields).toContainEqual({
        field: "WEBHOOK_RATE_LIMIT_PER_MINUTE",
      });
    });

    it("should override VERSION with the application package.json version", () => {
      const config = new Config();
      expect(config.VERSION).toBe(packageVersion);
    });
  });

  describe("reload", () => {
    it("should delegate to ConfigBase.reload with a logger callback", async () => {
      const config = new Config();
      await config.reload();

      expect(mockReload).toHaveBeenCalledTimes(1);
      const loggerCallback = mockReload.mock.calls[0][0];
      expect(typeof loggerCallback).toBe("function");
    });

    it("should pass a logger callback that logs via OTelLogger", async () => {
      const config = new Config();
      await config.reload();

      const loggerCallback = mockReload.mock.calls[0][0];
      loggerCallback("test message");

      expect(mockInfo).toHaveBeenCalledWith("test message");
    });
  });
});
