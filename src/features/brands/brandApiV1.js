/**
 * Map /api/v1/* paths to brand ?op= aliases (versioned Brand API).
 */

const API_V1_MAP = {
  "/api/v1/overview": "brand-api-overview",
  "/api/v1/products": "brand-api-products",
  "/api/v1/products/sync": "brand-api-sync",
  "/api/v1/products/publish": "brand-api-publish",
  "/api/v1/products/unpublish": "brand-api-unpublish",
  "/api/v1/team": "brand-api-team",
  "/api/v1/memberships": "brand-api-memberships",
  "/api/v1/keys": "brand-api-keys",
};

/**
 * If request is /api/v1/..., return a cloned Request with ?op= set (unless already present).
 * @returns {Request|null} rewritten request, or null if not an API v1 path
 */
export function rewriteBrandApiV1Request(request) {
  const url = new URL(request.url);
  if (url.searchParams.get("op")) return null;

  let pathname = url.pathname.replace(/\/$/, "") || "/";
  const op = API_V1_MAP[pathname];
  if (!op) return null;

  url.searchParams.set("op", op);
  return new Request(url.toString(), request);
}

export { API_V1_MAP };
