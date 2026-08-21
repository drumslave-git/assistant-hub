import { describe, expect, it } from "vitest";

import { isPrivateIp, isSafePublicUrl, normalizeUrl } from "./url-safety";

describe("isSafePublicUrl", () => {
  it("allows public http(s) URLs", () => {
    expect(isSafePublicUrl("https://example.com/path?q=1")).toBe(true);
    expect(isSafePublicUrl("http://news.example.org")).toBe(true);
    expect(isSafePublicUrl("https://93.184.216.34/")).toBe(true); // public IP literal
  });

  it("rejects non-http(s) schemes", () => {
    expect(isSafePublicUrl("ftp://example.com")).toBe(false);
    expect(isSafePublicUrl("file:///etc/passwd")).toBe(false);
    expect(isSafePublicUrl("javascript:alert(1)")).toBe(false);
  });

  it("rejects embedded credentials", () => {
    expect(isSafePublicUrl("https://user:pass@example.com")).toBe(false);
    expect(isSafePublicUrl("https://user@example.com")).toBe(false);
  });

  it("rejects localhost and the docker host gateway", () => {
    expect(isSafePublicUrl("http://localhost:3200")).toBe(false);
    expect(isSafePublicUrl("http://app.localhost")).toBe(false);
    expect(isSafePublicUrl("http://host.docker.internal")).toBe(false);
  });

  it("rejects private and loopback IPv4", () => {
    expect(isSafePublicUrl("http://127.0.0.1")).toBe(false);
    expect(isSafePublicUrl("http://10.0.0.5")).toBe(false);
    expect(isSafePublicUrl("http://192.168.1.1")).toBe(false);
    expect(isSafePublicUrl("http://172.16.0.1")).toBe(false);
    expect(isSafePublicUrl("http://169.254.1.1")).toBe(false);
    expect(isSafePublicUrl("http://0.0.0.0")).toBe(false);
  });

  it("rejects private and loopback IPv6", () => {
    expect(isSafePublicUrl("http://[::1]")).toBe(false);
    expect(isSafePublicUrl("http://[fc00::1]")).toBe(false);
    expect(isSafePublicUrl("http://[fe80::1]")).toBe(false);
  });

  it("rejects malformed input", () => {
    expect(isSafePublicUrl("not a url")).toBe(false);
    expect(isSafePublicUrl("")).toBe(false);
  });
});

describe("isPrivateIp", () => {
  it("judges IPv4 ranges", () => {
    expect(isPrivateIp("8.8.8.8")).toBe(false);
    expect(isPrivateIp("10.1.2.3")).toBe(true);
    expect(isPrivateIp("127.0.0.1")).toBe(true);
    expect(isPrivateIp("169.254.169.254")).toBe(true);
  });

  it("judges IPv6, including the unspecified address", () => {
    expect(isPrivateIp("2606:4700::1111")).toBe(false);
    expect(isPrivateIp("::1")).toBe(true);
    expect(isPrivateIp("::")).toBe(true);
    expect(isPrivateIp("fd12::1")).toBe(true);
    expect(isPrivateIp("fe80::1")).toBe(true);
  });

  it("judges the embedded v4 of an IPv6-mapped address", () => {
    // The shape dns.lookup can return for a v4-only host.
    expect(isPrivateIp("::ffff:192.168.1.1")).toBe(true);
    expect(isPrivateIp("::ffff:8.8.8.8")).toBe(false);
  });
});

describe("normalizeUrl", () => {
  it("returns the canonical href for valid http(s) URLs", () => {
    expect(normalizeUrl("  https://example.com  ")).toBe("https://example.com/");
    expect(normalizeUrl("http://example.com/a?b=1")).toBe("http://example.com/a?b=1");
  });

  it("returns null for empty or non-http(s) input", () => {
    expect(normalizeUrl("")).toBeNull();
    expect(normalizeUrl("   ")).toBeNull();
    expect(normalizeUrl("ftp://example.com")).toBeNull();
    expect(normalizeUrl("garbage")).toBeNull();
  });
});
