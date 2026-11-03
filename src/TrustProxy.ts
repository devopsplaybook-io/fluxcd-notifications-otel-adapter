import { isIP } from "node:net";

// Fastify `trustProxy` setting: `false` keys on the direct peer, `true` trusts
// every X-Forwarded-For value, an array trusts the listed proxies (named
// subnets, IPs or CIDR ranges) when resolving `request.ip`.
export type TrustProxySetting = boolean | string[];

const FALSE_VALUES = new Set(["", "false", "no", "off", "0"]);
const TRUE_VALUES = new Set(["true", "yes", "on"]);
const NAMED_SUBNETS = new Set(["loopback", "linklocal", "uniquelocal"]);

function invalid(value: string): Error {
  const shown = value.length > 64 ? `${value.slice(0, 64)}...` : value;
  return new Error(
    `Invalid TRUST_PROXY value "${shown}": expected a boolean, "loopback"/"linklocal"/"uniquelocal", or a comma-separated list of IP addresses and CIDR ranges`,
  );
}

function validateEntry(entry: string): void {
  if (NAMED_SUBNETS.has(entry)) {
    return;
  }
  const [address, prefix, extra] = entry.split("/");
  if (extra !== undefined || !address) {
    throw invalid(entry);
  }
  const family = isIP(address);
  if (family === 0) {
    throw invalid(entry);
  }
  if (prefix !== undefined) {
    if (!/^\d+$/.test(prefix)) {
      throw invalid(entry);
    }
    const bits = Number(prefix);
    if (bits > (family === 4 ? 32 : 128)) {
      throw invalid(entry);
    }
  }
}

/**
 * Validates and normalizes TRUST_PROXY at startup: Fastify throws lazily per
 * request on an invalid value, which would turn every request into a 500.
 */
export function resolveTrustProxy(value: unknown): TrustProxySetting {
  if (value === undefined || value === null || value === false || value === 0) {
    return false;
  }
  if (value === true) {
    return true;
  }
  if (typeof value !== "string") {
    throw invalid(String(value));
  }
  const normalized = value.trim().toLowerCase();
  if (FALSE_VALUES.has(normalized)) {
    return false;
  }
  if (TRUE_VALUES.has(normalized)) {
    return true;
  }
  const entries = normalized
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  if (entries.length === 0) {
    return false;
  }
  for (const entry of entries) {
    validateEntry(entry);
  }
  return entries;
}
