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

// Track constructor and reload calls on ConfigBase
const mockReload = jest.fn().mockResolvedValue(undefined);
let capturedServiceId: string | undefined;

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

    async reload(logger?: (message: string) => void): Promise<void> {
      return mockReload(logger);
    }
  },
}));

import { Config } from "./Config";

describe("Config", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    capturedServiceId = undefined;
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
