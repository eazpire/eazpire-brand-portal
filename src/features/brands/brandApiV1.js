/**
 * Map /api/v1/* paths to brand ?op= aliases (versioned Brand API).
 */

const API_V1_MAP = {
  "/api/v1/overview": "brand-api-overview",
  "/api/v1/brand": null, // method-aware below
  "/api/v1/connections": "brand-api-connections",
  "/api/v1/products": "brand-api-products",
  "/api/v1/products/sync": "brand-api-sync",
  "/api/v1/products/publish": "brand-api-publish",
  "/api/v1/products/unpublish": "brand-api-unpublish",
  "/api/v1/team": "brand-api-team",
  "/api/v1/team/invite": "brand-api-team-invite",
  "/api/v1/team/update": "brand-api-team-update",
  "/api/v1/team/revoke": "brand-api-team-revoke",
  "/api/v1/memberships": "brand-api-memberships",
  "/api/v1/keys": "brand-api-keys",
  "/api/v1/webhooks": null, // method-aware below
};

const PRODUCT_ACTION_SEGMENTS = new Set(["sync", "publish", "unpublish"]);

/**
 * If request is /api/v1/..., return a cloned Request with ?op= set (unless already present).
 * @returns {Request|null} rewritten request, or null if not an API v1 path
 */
export function rewriteBrandApiV1Request(request) {
  const url = new URL(request.url);
  if (url.searchParams.get("op")) return null;

  let pathname = url.pathname.replace(/\/$/, "") || "/";
  if (!pathname.startsWith("/api/v1")) return null;

  // GET/POST /api/v1/brand
  if (pathname === "/api/v1/brand") {
    const method = (request.method || "GET").toUpperCase();
    const op = method === "GET" || method === "HEAD" ? "brand-api-brand" : "brand-api-brand-update";
    url.searchParams.set("op", op);
    return new Request(url.toString(), request);
  }

  // GET/POST /api/v1/webhooks
  if (pathname === "/api/v1/webhooks") {
    const method = (request.method || "GET").toUpperCase();
    const op =
      method === "GET" || method === "HEAD" ? "brand-api-webhooks" : "brand-api-webhooks-create";
    url.searchParams.set("op", op);
    return new Request(url.toString(), request);
  }

  // POST/PATCH/DELETE /api/v1/webhooks/:id[/test|/revoke]
  const webhookMatch = pathname.match(/^\/api\/v1\/webhooks\/([^/]+)(?:\/(test|revoke))?$/);
  if (webhookMatch) {
    const webhookId = decodeURIComponent(webhookMatch[1]);
    const action = webhookMatch[2] || "";
    const method = (request.method || "GET").toUpperCase();
    url.searchParams.set("webhook_id", webhookId);
    let op = "brand-api-webhooks-update";
    if (action === "test") op = "brand-api-webhooks-test";
    else if (action === "revoke" || method === "DELETE") op = "brand-api-webhooks-revoke";
    else if (method === "GET" || method === "HEAD") {
      // No single-get yet — treat as update path unavailable
      return null;
    }
    url.searchParams.set("op", op);
    return new Request(url.toString(), request);
  }

  // GET/POST /api/v1/products/:id (not sync/publish/unpublish)
  const productMatch = pathname.match(/^\/api\/v1\/products\/([^/]+)$/);
  if (productMatch) {
    const segment = decodeURIComponent(productMatch[1]);
    if (!PRODUCT_ACTION_SEGMENTS.has(segment)) {
      const method = (request.method || "GET").toUpperCase();
      const op =
        method === "GET" || method === "HEAD" ? "brand-api-product-get" : "brand-api-product-update";
      url.searchParams.set("op", op);
      url.searchParams.set("product_id", segment);
      return new Request(url.toString(), request);
    }
  }

  const mapped = API_V1_MAP[pathname];
  if (!mapped) return null;

  url.searchParams.set("op", mapped);
  return new Request(url.toString(), request);
}

export { API_V1_MAP };
