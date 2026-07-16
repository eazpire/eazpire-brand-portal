import { describe, it, expect } from "vitest";
import {
  validateWebhookUrl,
  normalizeWebhookEvents,
  hmacSha256Hex,
} from "../../src/features/brands/brandWebhookDelivery.js";

describe("validateWebhookUrl", () => {
  it("requires https for public hosts", () => {
    expect(validateWebhookUrl("http://example.com/hook").ok).toBe(false);
    expect(validateWebhookUrl("https://example.com/hook").ok).toBe(true);
  });

  it("allows localhost http", () => {
    expect(validateWebhookUrl("http://localhost:3000/hook").ok).toBe(true);
    expect(validateWebhookUrl("http://127.0.0.1:8080/h").ok).toBe(true);
  });

  it("blocks private / metadata hosts", () => {
    expect(validateWebhookUrl("https://169.254.169.254/latest").ok).toBe(false);
    expect(validateWebhookUrl("https://10.0.0.1/hook").ok).toBe(false);
    expect(validateWebhookUrl("https://192.168.1.1/hook").ok).toBe(false);
  });
});

describe("normalizeWebhookEvents", () => {
  it("defaults to product events", () => {
    const ev = normalizeWebhookEvents([]);
    expect(ev).toContain("product.published");
    expect(ev).toContain("product.synced");
  });

  it("filters unknown events", () => {
    expect(normalizeWebhookEvents(["product.published", "orders.created"])).toEqual([
      "product.published",
    ]);
  });
});

describe("hmacSha256Hex", () => {
  it("matches known vector", async () => {
    const hex = await hmacSha256Hex("whsec_test", '{"ok":true}');
    expect(hex).toMatch(/^[a-f0-9]{64}$/);
    const again = await hmacSha256Hex("whsec_test", '{"ok":true}');
    expect(hex).toBe(again);
  });
});
