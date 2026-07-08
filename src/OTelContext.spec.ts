// Mock common-utils before any imports
const mockOTelSetTracer = jest.fn();
const mockOTelTracer = jest.fn();
const mockOTelSetMeter = jest.fn();
const mockOTelMeter = jest.fn();
const mockOTelLogger = jest.fn();
const mockOTelRequestSpan = jest.fn();

jest.mock("@devopsplaybook.io/common-utils", () => ({
  createOTelContext: jest.fn(() => ({
    OTelSetTracer: mockOTelSetTracer,
    OTelTracer: mockOTelTracer,
    OTelSetMeter: mockOTelSetMeter,
    OTelMeter: mockOTelMeter,
    OTelLogger: mockOTelLogger,
    OTelRequestSpan: mockOTelRequestSpan,
  })),
}));

import {
  OTelSetTracer,
  OTelTracer,
  OTelSetMeter,
  OTelMeter,
  OTelLogger,
  OTelRequestSpan,
} from "./OTelContext";

describe("OTelContext", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("should create an OTelContext at module load", () => {
    // The exports are wired up during module load, proving createOTelContext was called
    expect(OTelSetTracer).toBeDefined();
    expect(OTelTracer).toBeDefined();
    expect(OTelSetMeter).toBeDefined();
    expect(OTelMeter).toBeDefined();
    expect(OTelLogger).toBeDefined();
    expect(OTelRequestSpan).toBeDefined();
  });

  describe("OTelSetTracer", () => {
    it("should delegate to the context OTelSetTracer", () => {
      const tracer = { id: "tracer1" };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      OTelSetTracer(tracer as any);
      expect(mockOTelSetTracer).toHaveBeenCalledWith(tracer);
    });
  });

  describe("OTelTracer", () => {
    it("should delegate to the context OTelTracer", () => {
      const expected = { id: "tracer1" };
      mockOTelTracer.mockReturnValueOnce(expected);
      expect(OTelTracer()).toBe(expected);
    });
  });

  describe("OTelSetMeter", () => {
    it("should delegate to the context OTelSetMeter", () => {
      const meter = { id: "meter1" };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      OTelSetMeter(meter as any);
      expect(mockOTelSetMeter).toHaveBeenCalledWith(meter);
    });
  });

  describe("OTelMeter", () => {
    it("should delegate to the context OTelMeter", () => {
      const expected = { id: "meter1" };
      mockOTelMeter.mockReturnValueOnce(expected);
      expect(OTelMeter()).toBe(expected);
    });
  });

  describe("OTelLogger", () => {
    it("should delegate to the context OTelLogger", () => {
      const expected = { info: jest.fn() };
      mockOTelLogger.mockReturnValueOnce(expected);
      expect(OTelLogger()).toBe(expected);
    });
  });

  describe("OTelRequestSpan", () => {
    it("should delegate to the context OTelRequestSpan", () => {
      const req = { tracerSpanApi: { end: jest.fn() } };
      mockOTelRequestSpan.mockReturnValueOnce(req.tracerSpanApi);
      expect(OTelRequestSpan(req)).toBe(req.tracerSpanApi);
    });

    it("should return undefined when request has no span", () => {
      mockOTelRequestSpan.mockReturnValueOnce(undefined);
      expect(OTelRequestSpan({})).toBeUndefined();
    });
  });
});
