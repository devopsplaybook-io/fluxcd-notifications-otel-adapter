// Mock fs-extra and path BEFORE imports
const mockReadJsonSync = jest.fn();
const mockReadJson = jest.fn();

jest.mock("fs-extra", () => ({
  readJsonSync: mockReadJsonSync,
  readJson: mockReadJson,
}));

jest.mock("path", () => ({
  resolve: jest.fn((...args: string[]) => args.join("/").replace(/\/+/g, "/")),
  default: {
    resolve: jest.fn((...args: string[]) =>
      args.join("/").replace(/\/+/g, "/"),
    ),
  },
}));

// Mock OTelLogger before importing Config
const mockInfo = jest.fn();
const mockCreateModuleLogger = jest.fn(() => ({
  info: mockInfo,
}));

jest.mock("./OTelContext", () => ({
  OTelLogger: jest.fn(() => ({
    createModuleLogger: mockCreateModuleLogger,
  })),
}));

import { Config } from "./Config";

describe("Config", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.LOG_LEVEL;
    delete process.env.OPENTELEMETRY_COLLECTOR_HTTP_TRACES;
    delete process.env.OPENTELEMETRY_COLLECTOR_HTTP_METRICS;
    delete process.env.OPENTELEMETRY_COLLECTOR_HTTP_LOGS;
    delete process.env.OPENTELEMETRY_COLLECTOR_AWS;
    delete process.env.OPENTELEMETRY_COLLECT_AUTHORIZATION_HEADER;
    delete process.env.OPENTELEMETRY_COLLECTOR_EXPORT_LOGS_INTERVAL_SECONDS;
    delete process.env.OPENTELEMETRY_COLLECTOR_EXPORT_METRICS_INTERVAL_SECONDS;
  });

  describe("constructor", () => {
    it("should read version from package.json", () => {
      mockReadJsonSync.mockReturnValueOnce({ version: "2.3.4" });

      const config = new Config();

      expect(config.VERSION).toBe("2.3.4");
      expect(mockReadJsonSync).toHaveBeenCalled();
    });

    it("should fallback to version '1' when package.json read fails", () => {
      mockReadJsonSync.mockImplementationOnce(() => {
        throw new Error("File not found");
      });

      const config = new Config();

      expect(config.VERSION).toBe("1");
    });

    it("should fallback to version '1' when package.json has no version field", () => {
      mockReadJsonSync.mockReturnValueOnce({ name: "test" });

      const config = new Config();

      expect(config.VERSION).toBe("1");
    });

    it("should have default property values", () => {
      mockReadJsonSync.mockReturnValueOnce({ version: "1.0.0" });

      const config = new Config();

      expect(config.SERVICE_ID).toBe("fluxcd-notifications");
      expect(config.API_PORT).toBe(8080);
      expect(config.LOG_LEVEL).toBe("info");
      expect(config.OPENTELEMETRY_COLLECTOR_HTTP_TRACES).toBe("");
      expect(config.OPENTELEMETRY_COLLECTOR_HTTP_METRICS).toBe("");
      expect(config.OPENTELEMETRY_COLLECTOR_HTTP_LOGS).toBe("");
      expect(config.OPENTELEMETRY_COLLECTOR_AWS).toBe(false);
    });
  });

  describe("reload", () => {
    it("should load values from config.json", async () => {
      mockReadJsonSync.mockReturnValueOnce({ version: "1.0.0" });
      mockReadJson.mockResolvedValueOnce({
        LOG_LEVEL: "debug",
        OPENTELEMETRY_COLLECTOR_HTTP_TRACES: "http://otel:4318/v1/traces",
        OPENTELEMETRY_COLLECTOR_AWS: "true",
      });

      const config = new Config();
      await config.reload();

      expect(config.LOG_LEVEL).toBe("debug");
      expect(config.OPENTELEMETRY_COLLECTOR_HTTP_TRACES).toBe(
        "http://otel:4318/v1/traces",
      );
      expect(config.OPENTELEMETRY_COLLECTOR_AWS).toBe("true");
    });

    it("should prefer environment variables over config.json values", async () => {
      process.env.LOG_LEVEL = "error";
      mockReadJsonSync.mockReturnValueOnce({ version: "1.0.0" });
      mockReadJson.mockResolvedValueOnce({
        LOG_LEVEL: "debug",
      });

      const config = new Config();
      await config.reload();

      expect(config.LOG_LEVEL).toBe("error");
    });

    it("should keep default values when neither env nor config provides them", async () => {
      mockReadJsonSync.mockReturnValueOnce({ version: "1.0.0" });
      mockReadJson.mockResolvedValueOnce({});

      const config = new Config();
      await config.reload();

      // These fields are not set by setIfSet when missing from both env and config,
      // so they retain their class-level defaults
      expect(config.LOG_LEVEL).toBe("info");
      expect(config.OPENTELEMETRY_COLLECTOR_HTTP_TRACES).toBe("");
      expect(config.OPENTELEMETRY_COLLECTOR_HTTP_METRICS).toBe("");
      expect(config.OPENTELEMETRY_COLLECTOR_HTTP_LOGS).toBe("");
    });

    it("should log masked value for OPENTELEMETRY_COLLECT_AUTHORIZATION_HEADER", async () => {
      mockReadJsonSync.mockReturnValueOnce({ version: "1.0.0" });
      mockReadJson.mockResolvedValueOnce({
        OPENTELEMETRY_COLLECT_AUTHORIZATION_HEADER: "supersecret",
      });

      const config = new Config();
      await config.reload();

      // Should have logged with masked value
      const maskedCall = mockInfo.mock.calls.find((call: string[]) =>
        call[0].includes("********************"),
      );
      expect(maskedCall).toBeDefined();
      expect(config.OPENTELEMETRY_COLLECT_AUTHORIZATION_HEADER).toBe(
        "supersecret",
      );
    });

    it("should handle numeric fields from config.json", async () => {
      mockReadJsonSync.mockReturnValueOnce({ version: "1.0.0" });
      mockReadJson.mockResolvedValueOnce({
        OPENTELEMETRY_COLLECTOR_EXPORT_LOGS_INTERVAL_SECONDS: "120",
        OPENTELEMETRY_COLLECTOR_EXPORT_METRICS_INTERVAL_SECONDS: "30",
      });

      const config = new Config();
      await config.reload();

      expect(config.OPENTELEMETRY_COLLECTOR_EXPORT_LOGS_INTERVAL_SECONDS).toBe(
        "120",
      );
      expect(
        config.OPENTELEMETRY_COLLECTOR_EXPORT_METRICS_INTERVAL_SECONDS,
      ).toBe("30");
    });
  });
});
