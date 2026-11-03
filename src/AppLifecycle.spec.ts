const mockAppLogger = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
};
const mockLoggerShutdown = jest.fn();
const mockTracerShutdown = jest.fn();
const mockMeterShutdown = jest.fn();
const mockStandardLogger = {
  createModuleLogger: jest.fn(() => mockAppLogger),
  initOTel: jest.fn(),
  shutdown: mockLoggerShutdown,
};
const mockStandardTracer = { shutdown: mockTracerShutdown };
const mockStandardMeter = { shutdown: mockMeterShutdown };
const mockOTelLogger = jest.fn(() => mockStandardLogger);
const mockOTelTracer = jest.fn(() => mockStandardTracer);
const mockOTelMeter = jest.fn(() => mockStandardMeter);
const mockOTelSetTracer = jest.fn();
const mockOTelSetMeter = jest.fn();

jest.mock("./OTelContext", () => ({
  OTelLogger: mockOTelLogger,
  OTelTracer: mockOTelTracer,
  OTelMeter: mockOTelMeter,
  OTelSetTracer: mockOTelSetTracer,
  OTelSetMeter: mockOTelSetMeter,
}));

const mockStandardTracerCtor = jest.fn();
const mockStandardMeterCtor = jest.fn();

jest.mock("@devopsplaybook.io/otel-utils", () => ({
  StandardTracer: mockStandardTracerCtor,
  StandardMeter: mockStandardMeterCtor,
}));

const mockRegisterHooks = jest.fn();

jest.mock("@devopsplaybook.io/otel-utils-fastify", () => ({
  StandardTracerFastifyRegisterHooks: mockRegisterHooks,
}));

const mockRegisterRoutes = jest.fn();

jest.mock("./AppRoutes", () => ({
  registerRoutes: mockRegisterRoutes,
}));

const mockConfigReload = jest.fn();
const mockConfig = {
  API_PORT: 8080,
  VERSION: "0.7.0",
  WEBHOOK_AUTHORIZATION_HEADER: "",
  WEBHOOK_AUTH_REQUIRED: false,
  WEBHOOK_RATE_LIMIT_PER_MINUTE: 600,
  TRUST_PROXY: "",
  reload: mockConfigReload,
};

jest.mock("./Config", () => ({
  Config: jest.fn(() => mockConfig),
}));

const mockWatchFile = jest.fn();

jest.mock("fs-extra", () => ({
  watchFile: mockWatchFile,
}));

const mockFastifyListen = jest.fn();
const mockFastifyClose = jest.fn();
const mockFastifyInstance = {
  listen: mockFastifyListen,
  close: mockFastifyClose,
};
const mockFastifyFactory = jest.fn(() => mockFastifyInstance);

jest.mock("fastify", () => ({
  __esModule: true,
  default: mockFastifyFactory,
}));

let initialSigtermListeners: Function[] = [];
let initialSigintListeners: Function[] = [];

beforeEach(() => {
  jest.clearAllMocks();
  mockConfigReload.mockReset().mockResolvedValue(undefined);
  mockFastifyListen.mockReset().mockResolvedValue(undefined);
  mockFastifyClose.mockReset().mockResolvedValue(undefined);
  mockLoggerShutdown.mockReset().mockResolvedValue(undefined);
  mockTracerShutdown.mockReset().mockResolvedValue(undefined);
  mockMeterShutdown.mockReset().mockResolvedValue(undefined);
  mockConfig.WEBHOOK_AUTHORIZATION_HEADER = "";
  mockConfig.WEBHOOK_AUTH_REQUIRED = false;
  mockConfig.WEBHOOK_RATE_LIMIT_PER_MINUTE = 600;
  mockConfig.TRUST_PROXY = "";
  jest.resetModules();

  initialSigtermListeners = process.listeners("SIGTERM");
  initialSigintListeners = process.listeners("SIGINT");
});

afterEach(() => {
  for (const listener of process.listeners("SIGTERM")) {
    if (!initialSigtermListeners.includes(listener)) {
      process.removeListener("SIGTERM", listener);
    }
  }
  for (const listener of process.listeners("SIGINT")) {
    if (!initialSigintListeners.includes(listener)) {
      process.removeListener("SIGINT", listener);
    }
  }
  jest.restoreAllMocks();
});

describe("App lifecycle", () => {
  it("should load config once, wire telemetry and listen", async () => {
    const { start } = require("./App");

    const instance = await start();

    expect(mockConfigReload).toHaveBeenCalledTimes(1);
    expect(mockStandardTracerCtor).toHaveBeenCalledWith(mockConfig);
    expect(mockStandardMeterCtor).toHaveBeenCalledWith(mockConfig);
    expect(mockOTelSetTracer).toHaveBeenCalledTimes(1);
    expect(mockOTelSetMeter).toHaveBeenCalledTimes(1);
    expect(mockStandardLogger.initOTel).toHaveBeenCalledWith(mockConfig);
    expect(mockFastifyFactory).toHaveBeenCalledWith(
      expect.objectContaining({ trustProxy: false }),
    );
    expect(mockRegisterHooks).toHaveBeenCalledWith(
      mockFastifyInstance,
      mockStandardTracer,
      mockStandardLogger,
      {
        rootApiPath: "/",
        ignoreList: ["GET-/api/status"],
        unmatchedRouteSpanName: "method",
      },
    );
    expect(mockRegisterRoutes).toHaveBeenCalledWith(
      mockFastifyInstance,
      mockConfig,
    );
    expect(mockRegisterRoutes.mock.invocationCallOrder[0]).toBeLessThan(
      mockRegisterHooks.mock.invocationCallOrder[0],
    );
    expect(mockFastifyListen).toHaveBeenCalledWith({
      port: 8080,
      host: "0.0.0.0",
    });
    expect(instance).toBe(mockFastifyInstance);
    expect(mockAppLogger.info).toHaveBeenCalledWith(
      "====== Starting fluxcd-notifications-otel-adapter Server ======",
    );
    expect(mockAppLogger.info).toHaveBeenCalledWith("API Listening");
    expect(mockAppLogger.info).toHaveBeenCalledWith(
      expect.stringContaining("TRUST_PROXY is off"),
    );
    expect(mockWatchFile).not.toHaveBeenCalled();
  });

  it("should pass a CIDR list to Fastify and log the client IP model", async () => {
    mockConfig.TRUST_PROXY = "10.0.0.0/8, loopback";
    const { start } = require("./App");

    await start();

    expect(mockFastifyFactory).toHaveBeenCalledWith(
      expect.objectContaining({
        trustProxy: ["10.0.0.0/8", "loopback"],
      }),
    );
    expect(mockAppLogger.info).toHaveBeenCalledWith(
      expect.stringContaining("2 configured proxy address range(s)"),
    );
  });

  it("should warn when every forwarded header is trusted", async () => {
    mockConfig.TRUST_PROXY = "true";
    const { start } = require("./App");

    await start();

    expect(mockFastifyFactory).toHaveBeenCalledWith(
      expect.objectContaining({ trustProxy: true }),
    );
    expect(mockAppLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining("TRUST_PROXY=true"),
    );
  });

  it("should fail startup for an invalid TRUST_PROXY value", async () => {
    mockConfig.TRUST_PROXY = "not-an-ip";
    const exit = jest.fn();
    const { main } = require("./App");

    await main({ exit });

    expect(exit).toHaveBeenCalledWith(1);
    expect(mockFastifyListen).not.toHaveBeenCalled();
    expect(mockAppLogger.error).toHaveBeenCalledWith(
      "Error starting fluxcd-notifications-otel-adapter",
      expect.any(Error),
    );
  });

  it("should refuse to start when auth is required but the webhook header is empty", async () => {
    mockConfig.WEBHOOK_AUTH_REQUIRED = true;
    mockConfig.WEBHOOK_AUTHORIZATION_HEADER = "";
    const exit = jest.fn();
    const { main } = require("./App");

    await main({ exit });

    expect(exit).toHaveBeenCalledWith(1);
    expect(mockFastifyListen).not.toHaveBeenCalled();
    expect(mockAppLogger.error).toHaveBeenCalledWith(
      "Error starting fluxcd-notifications-otel-adapter",
      expect.objectContaining({
        message: expect.stringContaining("WEBHOOK_AUTH_REQUIRED"),
      }),
    );
    // The guard runs before any telemetry provider is built.
    expect(mockStandardTracerCtor).not.toHaveBeenCalled();
    expect(mockStandardMeterCtor).not.toHaveBeenCalled();
    expect(mockOTelSetTracer).not.toHaveBeenCalled();
    expect(mockOTelSetMeter).not.toHaveBeenCalled();
    expect(mockStandardLogger.initOTel).not.toHaveBeenCalled();
  });

  it("should start and log the required mode when auth is required with a header", async () => {
    mockConfig.WEBHOOK_AUTH_REQUIRED = true;
    mockConfig.WEBHOOK_AUTHORIZATION_HEADER = "Bearer secret";
    const { start } = require("./App");

    await start();

    expect(mockFastifyListen).toHaveBeenCalled();
    expect(mockAppLogger.info).toHaveBeenCalledWith(
      "webhook authentication required and enabled",
    );
    expect(mockAppLogger.warn).not.toHaveBeenCalledWith(
      expect.stringContaining("webhook authentication disabled"),
    );
  });

  it("should log enabled auth when a header is set without the fail-closed switch", async () => {
    mockConfig.WEBHOOK_AUTH_REQUIRED = false;
    mockConfig.WEBHOOK_AUTHORIZATION_HEADER = "Bearer secret";
    const { start } = require("./App");

    await start();

    expect(mockFastifyListen).toHaveBeenCalled();
    expect(mockAppLogger.info).toHaveBeenCalledWith(
      "webhook authentication enabled (WEBHOOK_AUTH_REQUIRED=false)",
    );
  });

  it("should keep starting with the fail-open warning when auth is not required and no header is set", async () => {
    mockConfig.WEBHOOK_AUTH_REQUIRED = false;
    mockConfig.WEBHOOK_AUTHORIZATION_HEADER = "";
    const { start } = require("./App");

    await start();

    expect(mockFastifyListen).toHaveBeenCalled();
    expect(mockAppLogger.warn).toHaveBeenCalledWith(
      "webhook authentication disabled: WEBHOOK_AUTHORIZATION_HEADER is not set and WEBHOOK_AUTH_REQUIRED is false (backward-compatible fail-open)",
    );
  });

  it("should close fastify, flush telemetry and exit 0 on SIGTERM", async () => {
    let resolveExit: (code: number) => void = () => {};
    const exited = new Promise<number>((resolve) => {
      resolveExit = resolve;
    });
    const exit = jest.fn((code: number) => resolveExit(code));
    const { start } = require("./App");
    await start({ exit, shutdownTimeoutMs: 1_000 });

    process.emit("SIGTERM");

    await expect(exited).resolves.toBe(0);
    expect(mockFastifyClose).toHaveBeenCalledTimes(1);
    expect(mockLoggerShutdown).toHaveBeenCalledTimes(1);
    expect(mockTracerShutdown).toHaveBeenCalledTimes(1);
    expect(mockMeterShutdown).toHaveBeenCalledTimes(1);
    expect(mockFastifyClose.mock.invocationCallOrder[0]).toBeLessThan(
      mockLoggerShutdown.mock.invocationCallOrder[0],
    );
    expect(mockAppLogger.info).toHaveBeenCalledWith(
      "Received SIGTERM; shutting down",
    );
  });

  it("should exit 1 immediately on a second signal while shutting down", async () => {
    mockLoggerShutdown.mockReturnValue(new Promise(() => {}));
    const exit = jest.fn();
    const { start } = require("./App");
    await start({ exit, shutdownTimeoutMs: 60_000 });

    process.emit("SIGTERM");
    process.emit("SIGINT");

    expect(exit).toHaveBeenCalledWith(1);
    expect(mockFastifyClose).toHaveBeenCalledTimes(1);
    expect(mockAppLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining("while shutting down"),
    );
  });

  it("should only close and flush once when stop is called repeatedly", async () => {
    const exit = jest.fn();
    const { start, stop } = require("./App");
    await start({ exit });

    await stop({ exit });
    await stop({ exit });

    expect(mockFastifyClose).toHaveBeenCalledTimes(1);
    expect(mockLoggerShutdown).toHaveBeenCalledTimes(1);
    expect(mockTracerShutdown).toHaveBeenCalledTimes(1);
    expect(mockMeterShutdown).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it("should not hang when telemetry shutdown never completes", async () => {
    mockLoggerShutdown.mockReturnValue(new Promise(() => {}));
    const exit = jest.fn();
    const { start, stop } = require("./App");
    await start({ exit });

    const startedAt = Date.now();
    await stop({ exit, shutdownTimeoutMs: 25 });
    const elapsed = Date.now() - startedAt;

    expect(elapsed).toBeLessThan(2_000);
    expect(exit).toHaveBeenCalledWith(0);
    expect(mockFastifyClose).toHaveBeenCalledTimes(1);
    expect(mockAppLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining("Shutdown timed out after 25 ms"),
    );
  });

  it("should be safe to stop when start never ran", async () => {
    const exit = jest.fn();
    const { stop } = require("./App");

    await stop({ exit });

    expect(mockFastifyClose).not.toHaveBeenCalled();
    expect(exit).toHaveBeenCalledWith(0);
  });

  it("should default to process.exit when no exit function is injected", async () => {
    const processExit = jest
      .spyOn(process, "exit")
      .mockImplementation((() => undefined) as never);
    const { stop } = require("./App");

    await stop();

    expect(processExit).toHaveBeenCalledWith(0);
  });

  it("should log and exit 1 when config load fails", async () => {
    mockConfigReload.mockRejectedValueOnce(new Error("config boom"));
    const exit = jest.fn();
    const { main } = require("./App");

    await main({ exit });

    expect(exit).toHaveBeenCalledWith(1);
    expect(mockAppLogger.error).toHaveBeenCalledWith(
      "Error starting fluxcd-notifications-otel-adapter",
      expect.any(Error),
    );
    expect(mockFastifyListen).not.toHaveBeenCalled();
  });

  it("should log and exit 1 when listen fails", async () => {
    mockFastifyListen.mockRejectedValueOnce(new Error("EADDRINUSE"));
    const exit = jest.fn();
    const { main } = require("./App");

    await main({ exit });

    expect(exit).toHaveBeenCalledWith(1);
    expect(mockAppLogger.error).toHaveBeenCalledWith(
      "Error starting fluxcd-notifications-otel-adapter",
      expect.any(Error),
    );
  });
});

export {};
