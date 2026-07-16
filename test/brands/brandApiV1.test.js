import { describe, it, expect } from "vitest";
import { rewriteBrandApiV1Request } from "../../src/features/brands/brandApiV1.js";
import { authHasScope, BRAND_API_SCOPES, DEFAULT_BRAND_API_SCOPES } from "../../src/features/brands/rbac.js";

describe("rewriteBrandApiV1Request", () => {
  it("maps static product list path", () => {
    const req = new Request("https://brand.eazpire.com/api/v1/products");
    const out = rewriteBrandApiV1Request(req);
    expect(out).toBeTruthy();
    expect(new URL(out.url).searchParams.get("op")).toBe("brand-api-products");
  });

  it("maps GET brand vs POST brand", () => {
    const get = rewriteBrandApiV1Request(new Request("https://brand.eazpire.com/api/v1/brand"));
    expect(new URL(get.url).searchParams.get("op")).toBe("brand-api-brand");
    const post = rewriteBrandApiV1Request(
      new Request("https://brand.eazpire.com/api/v1/brand", { method: "POST" })
    );
    expect(new URL(post.url).searchParams.get("op")).toBe("brand-api-brand-update");
  });

  it("maps product id get/update and leaves sync alone", () => {
    const get = rewriteBrandApiV1Request(new Request("https://brand.eazpire.com/api/v1/products/bp_123"));
    expect(new URL(get.url).searchParams.get("op")).toBe("brand-api-product-get");
    expect(new URL(get.url).searchParams.get("product_id")).toBe("bp_123");

    const sync = rewriteBrandApiV1Request(
      new Request("https://brand.eazpire.com/api/v1/products/sync", { method: "POST" })
    );
    expect(new URL(sync.url).searchParams.get("op")).toBe("brand-api-sync");
  });

  it("maps team invite", () => {
    const out = rewriteBrandApiV1Request(
      new Request("https://brand.eazpire.com/api/v1/team/invite", { method: "POST" })
    );
    expect(new URL(out.url).searchParams.get("op")).toBe("brand-api-team-invite");
  });

  it("maps webhooks list/create and id actions", () => {
    const list = rewriteBrandApiV1Request(new Request("https://brand.eazpire.com/api/v1/webhooks"));
    expect(new URL(list.url).searchParams.get("op")).toBe("brand-api-webhooks");

    const create = rewriteBrandApiV1Request(
      new Request("https://brand.eazpire.com/api/v1/webhooks", { method: "POST" })
    );
    expect(new URL(create.url).searchParams.get("op")).toBe("brand-api-webhooks-create");

    const update = rewriteBrandApiV1Request(
      new Request("https://brand.eazpire.com/api/v1/webhooks/bwh_1", { method: "POST" })
    );
    expect(new URL(update.url).searchParams.get("op")).toBe("brand-api-webhooks-update");
    expect(new URL(update.url).searchParams.get("webhook_id")).toBe("bwh_1");

    const test = rewriteBrandApiV1Request(
      new Request("https://brand.eazpire.com/api/v1/webhooks/bwh_1/test", { method: "POST" })
    );
    expect(new URL(test.url).searchParams.get("op")).toBe("brand-api-webhooks-test");

    const revoke = rewriteBrandApiV1Request(
      new Request("https://brand.eazpire.com/api/v1/webhooks/bwh_1/revoke", { method: "POST" })
    );
    expect(new URL(revoke.url).searchParams.get("op")).toBe("brand-api-webhooks-revoke");
  });
  it("maps orders list and detail", () => {
    const list = rewriteBrandApiV1Request(new Request("https://brand.eazpire.com/api/v1/orders"));
    expect(new URL(list.url).searchParams.get("op")).toBe("brand-api-orders");

    const get = rewriteBrandApiV1Request(new Request("https://brand.eazpire.com/api/v1/orders/5678"));
    expect(new URL(get.url).searchParams.get("op")).toBe("brand-api-order-get");
    expect(new URL(get.url).searchParams.get("order_id")).toBe("5678");
  });
});

describe("brand API scopes", () => {
  it("includes expanded default scopes", () => {
    expect(DEFAULT_BRAND_API_SCOPES).toContain(BRAND_API_SCOPES.BRAND_WRITE);
    expect(DEFAULT_BRAND_API_SCOPES).toContain(BRAND_API_SCOPES.TEAM_INVITE);
    expect(DEFAULT_BRAND_API_SCOPES).toContain(BRAND_API_SCOPES.CONNECTIONS_READ);
    expect(DEFAULT_BRAND_API_SCOPES).toContain(BRAND_API_SCOPES.WEBHOOKS_READ);
    expect(DEFAULT_BRAND_API_SCOPES).toContain(BRAND_API_SCOPES.WEBHOOKS_WRITE);
    expect(DEFAULT_BRAND_API_SCOPES).toContain(BRAND_API_SCOPES.ORDERS_READ);
  });

  it("authHasScope respects wildcard and session", () => {
    expect(authHasScope({ type: "session", scopes: ["*"] }, "brand:write")).toBe(true);
    expect(authHasScope({ type: "api_key", scopes: ["products:read"] }, "brand:write")).toBe(false);
    expect(authHasScope({ type: "api_key", scopes: ["*"] }, "brand:write")).toBe(true);
  });
});
