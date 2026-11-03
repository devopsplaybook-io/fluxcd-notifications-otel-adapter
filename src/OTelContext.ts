import { createOTelContext } from "@devopsplaybook.io/common-utils/otel";

const otelContext = createOTelContext();

export const OTelSetTracer = otelContext.OTelSetTracer;
export const OTelTracer = otelContext.OTelTracer;
export const OTelSetMeter = otelContext.OTelSetMeter;
export const OTelMeter = otelContext.OTelMeter;
export const OTelLogger = otelContext.OTelLogger;
