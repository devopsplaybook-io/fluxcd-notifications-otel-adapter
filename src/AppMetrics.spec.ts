const mockModuleLogger = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
};
const mockGetLogger = jest.fn().mockReturnValue(undefined);
let currentMeter: unknown;

// The routes read the meter once at registration: expose the real SDK meter
// built per test so the exporter observes the actual counter increments.
jest.mock("./OTelContext", () => ({
  OTelLogger: jest.fn(() => ({
    createModuleLogger: jest.fn().mockReturnValue(mockModuleLogger),
    getLogger: mockGetLogger,
  })),
  OTelMeter: jest.fn(() => currentMeter),
}));

jest.mock("./Config", () => ({ Config: jest.fn() }));

// swc hoists static imports above the mock declarations, so load the modules
// under test with in-place requires after jest.mock registration.
const { registerRoutes } = require("./AppRoutes");
const { FASTIFY_OPTIONS } = require("./App");
const Fastify = require("fastify").default;
const {
  AggregationTemporality,
  InMemoryMetricExporter,
  MeterProvider,
  PeriodicExportingMetricReader,
} = require("@opentelemetry/sdk-metrics");

import type {
  InMemoryMetricExporter as InMemoryMetricExporterInstance,
  MeterProvider as MeterProviderInstance,
} from "@opentelemetry/sdk-metrics";
import type { Config } from "./Config";
import type { FluxEventPayload } from "./AppRoutes";

interface TestDataPoint {
  attributes: Record<string, unknown>;
  value: number;
}

const REJECTED_METRIC = "fluxcd-notifications.rejected_events_total";
const EVENTS_METRIC = "fluxcd-notifications.events_total";

function buildConfig(overrides: Partial<Config> = {}): Config {
  return {
    VERSION: "1.2.3",
    WEBHOOK_AUTHORIZATION_HEADER: "",
    WEBHOOK_RATE_LIMIT_PER_MINUTE: 600,
    ...overrides,
  } as unknown as Config;
}

function fullFluxPayload(): FluxEventPayload {
  return {
    severity: "info",
    message: "Deployment my-app applied successfully",
    reason: "ReconciliationSucceeded",
    metadata: { cluster: "production-us-east-1" },
  };
}

describe("rejection metrics (in-memory reader)", () => {
  let exporter: InMemoryMetricExporterInstance;
  let provider: MeterProviderInstance;
  let fastify: ReturnType<typeof Fastify> | undefined;

  beforeEach(() => {
    jest.clearAllMocks();
    exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
    provider = new MeterProvider({
      readers: [
        new PeriodicExportingMetricReader({
          exporter,
          exportIntervalMillis: 60_000,
        }),
      ],
    });
    const meter = provider.getMeter("app-metrics-test");
    currentMeter = {
      createCounter: (key: string) =>
        meter.createCounter(`fluxcd-notifications.${key}`),
    };
  });

  afterEach(async () => {
    if (fastify) {
      await fastify.close();
      fastify = undefined;
    }
    await provider.shutdown();
  });

  function setup(overrides: Partial<Config> = {}): void {
    fastify = Fastify({ logger: false, ...FASTIFY_OPTIONS });
    registerRoutes(fastify, buildConfig(overrides));
  }

  async function dataPoints(name: string): Promise<TestDataPoint[]> {
    await provider.forceFlush();
    const points: TestDataPoint[] = [];
    for (const resourceMetrics of exporter.getMetrics()) {
      for (const scopeMetrics of resourceMetrics.scopeMetrics) {
        for (const metric of scopeMetrics.metrics) {
          if (metric.descriptor.name === name) {
            points.push(...(metric.dataPoints as TestDataPoint[]));
          }
        }
      }
    }
    return points;
  }

  async function expectRejectedOnce(reason: string): Promise<void> {
    const points = await dataPoints(REJECTED_METRIC);
    expect(points).toHaveLength(1);
    expect(points[0].attributes).toEqual({ reason });
    expect(points[0].value).toBe(1);
  }

  it("counts invalid JSON exactly once", async () => {
    setup();

    const response = await fastify!.inject({
      method: "POST",
      url: "/",
      headers: { "content-type": "application/json" },
      payload: '{"broken":',
    });

    expect(response.statusCode).toBe(400);
    await expectRejectedOnce("invalid_json");
  });

  it("counts an oversized body exactly once", async () => {
    setup();

    const response = await fastify!.inject({
      method: "POST",
      url: "/",
      headers: { "content-type": "text/plain" },
      payload: "x".repeat(64 * 1024 + 1),
    });

    expect(response.statusCode).toBe(413);
    await expectRejectedOnce("payload_too_large");
  });

  it("counts an unsupported content type exactly once", async () => {
    setup();

    const response = await fastify!.inject({
      method: "POST",
      url: "/",
      headers: { "content-type": "application/xml" },
      payload: "<event/>",
    });

    expect(response.statusCode).toBe(415);
    await expectRejectedOnce("unsupported_media_type");
  });

  it("counts a missing authorization header exactly once", async () => {
    setup({ WEBHOOK_AUTHORIZATION_HEADER: "Bearer s3cr3t" });

    const response = await fastify!.inject({
      method: "POST",
      url: "/",
      payload: fullFluxPayload(),
    });

    expect(response.statusCode).toBe(401);
    expect(response.headers["www-authenticate"]).toBe("Bearer");
    await expectRejectedOnce("unauthorized");
  });

  it("counts a rate-limited request exactly once", async () => {
    setup({ WEBHOOK_RATE_LIMIT_PER_MINUTE: 1 });

    const first = await fastify!.inject({
      method: "POST",
      url: "/",
      payload: fullFluxPayload(),
    });
    const second = await fastify!.inject({
      method: "POST",
      url: "/",
      payload: fullFluxPayload(),
    });

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(429);
    await expectRejectedOnce("rate_limited");
  });

  it("counts a malformed payload exactly once", async () => {
    setup();

    const response = await fastify!.inject({
      method: "POST",
      url: "/",
      payload: {},
    });

    expect(response.statusCode).toBe(400);
    await expectRejectedOnce("invalid_payload");
  });

  it("counts an unknown route exactly once", async () => {
    setup();

    const response = await fastify!.inject({ method: "GET", url: "/nope" });

    expect(response.statusCode).toBe(404);
    await expectRejectedOnce("bad_request");
  });

  it("counts an accepted event in events_total and not as a rejection", async () => {
    setup();

    const response = await fastify!.inject({
      method: "POST",
      url: "/",
      payload: fullFluxPayload(),
    });

    expect(response.statusCode).toBe(200);
    const points = await dataPoints(EVENTS_METRIC);
    expect(points).toHaveLength(1);
    expect(points[0].attributes).toEqual({
      cluster: "production-us-east-1",
      reason: "reconciliationsucceeded",
      severity: "info",
    });
    expect(points[0].value).toBe(1);
    expect(await dataPoints(REJECTED_METRIC)).toHaveLength(0);
  });
});
