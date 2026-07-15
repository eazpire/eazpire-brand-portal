/**
 * eazpire-brand-portal — brand.eazpire.com
 *
 * Deploy: npm run deploy:brand (wrangler-brand.toml)
 */

import { json, getCorsHeaders } from "./utils/response.js";
import { handleBrandRouter } from "./features/brands/brandRouter.js";
import { handleBrandPortalRequest } from "./features/brands/brandPortalHost.js";

export default {
  async fetch(request, env, ctx) {
    if (request.method === "OPTIONS") {
      const cors = getCorsHeaders(request);
      return new Response(null, { status: 204, headers: cors });
    }

    const apiResp = await handleBrandRouter(request, env);
    if (apiResp) return apiResp;

    const portalResp = await handleBrandPortalRequest(request, env);
    if (portalResp) return portalResp;

    const cors = getCorsHeaders(request);
    return json({ ok: false, error: "not_found" }, 404, cors);
  },
};
