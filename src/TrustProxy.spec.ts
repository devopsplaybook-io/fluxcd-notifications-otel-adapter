import { resolveTrustProxy } from "./TrustProxy";

describe("resolveTrustProxy", () => {
  it.each([
    ["undefined", undefined],
    ["null", null],
    ["an empty string", ""],
    ["whitespace", "   "],
    ["false", false],
    ["the string false", "false"],
    ["no", "NO"],
    ["off", "off"],
    ["0", "0"],
    ["the number 0", 0],
  ])("resolves %s to false", (_label, value) => {
    expect(resolveTrustProxy(value)).toBe(false);
  });

  it.each([
    ["true", true],
    ["the string true", "true"],
    ["yes", "YES"],
    ["on", "on"],
  ])("resolves %s to true", (_label, value) => {
    expect(resolveTrustProxy(value)).toBe(true);
  });

  it.each(["loopback", "linklocal", "uniquelocal"])(
    "accepts the named subnet %s",
    (name) => {
      expect(resolveTrustProxy(name)).toEqual([name]);
    },
  );

  it.each(["10.0.0.1", "::1", "2001:db8::1"])("accepts the IP address %s", (ip) => {
    expect(resolveTrustProxy(ip)).toEqual([ip]);
  });

  it.each(["10.0.0.0/8", "10.0.0.0/0", "::1/128", "2001:db8::/32"])(
    "accepts the CIDR range %s",
    (cidr) => {
      expect(resolveTrustProxy(cidr)).toEqual([cidr]);
    },
  );

  it("trims, lowercases and splits a comma-separated list", () => {
    expect(
      resolveTrustProxy(" 10.0.0.0/8 , 192.168.0.1 , Loopback ,, "),
    ).toEqual(["10.0.0.0/8", "192.168.0.1", "loopback"]);
  });

  it.each([
    ["an unknown keyword", "garbage"],
    ["an IPv4 prefix over 32", "10.0.0.0/33"],
    ["an IPv6 prefix over 128", "::1/129"],
    ["a named subnet with a prefix", "loopback/8"],
    ["a non-numeric prefix", "10.0.0.0/eight"],
    ["an empty prefix", "10.0.0.0/"],
    ["a missing address", "/8"],
    ["two prefixes", "10.0.0.0/8/9"],
    ["a number", 42],
    ["an object", {}],
    ["a list", ["10.0.0.0/8"]],
  ])("throws for %s", (_label, value) => {
    expect(() => resolveTrustProxy(value)).toThrow(/TRUST_PROXY/);
  });

  it("does not echo more than 64 characters of an invalid value", () => {
    const value = "x".repeat(500);
    expect(() => resolveTrustProxy(value)).toThrow(
      `Invalid TRUST_PROXY value "${"x".repeat(64)}..."`,
    );
  });
});
