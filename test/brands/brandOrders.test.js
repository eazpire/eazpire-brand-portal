/**
 * Unit helpers for brandOrders mapping (no Shopify network).
 */
import { describe, it, expect } from "vitest";
import { BRAND_API_SCOPES, DEFAULT_BRAND_API_SCOPES, authHasScope } from "../../src/features/brands/rbac.js";

describe("orders:read scope", () => {
  it("is in defaults and enforced by authHasScope", () => {
    expect(BRAND_API_SCOPES.ORDERS_READ).toBe("orders:read");
    expect(DEFAULT_BRAND_API_SCOPES).toContain("orders:read");
    expect(authHasScope({ type: "api_key", scopes: ["orders:read"] }, "orders:read")).toBe(true);
    expect(authHasScope({ type: "api_key", scopes: ["products:read"] }, "orders:read")).toBe(false);
  });
});
