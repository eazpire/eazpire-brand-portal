/**
 * Brand Portal API (?op=…)
 */

import { json, getCorsHeaders } from "../../utils/response.js";
import {
  handleBrandAuthRequest,
  handleBrandAuthPoll,
  handleBrandAuthExchange,
  handleBrandAuthVerify,
  handleBrandAuthLogout,
  handleBrandAuthMe,
} from "./brandAuth.js";
import {
  handleBrandCreate,
  handleBrandUpdate,
  handleBrandLogoUpload,
  handleBrandOverview,
} from "./brandProfile.js";
import {
  handleBrandConnectionsList,
  handleBrandPrintifyConnect,
  handleBrandShopifyConnect,
  handleBrandShopifyOAuthStart,
  handleBrandShopifyOAuthCallback,
  handleBrandConnectionPing,
  handleBrandConnectionDisconnect,
} from "./brandConnections.js";
import { handleBrandProductsList, handleBrandProductsSync } from "./brandProducts.js";
import {
  handleBrandTeamList,
  handleBrandTeamInvite,
  handleBrandTeamUpdate,
  handleBrandTeamRevoke,
} from "./brandTeam.js";
import { handleBrandPublicList, handleBrandPublicGet } from "./brandPublic.js";

export async function handleBrandRouter(request, env) {
  const url = new URL(request.url);
  const op = url.searchParams.get("op");
  if (!op) return null;

  const cors = getCorsHeaders(request);

  try {
    if (op === "brand-public-list") return handleBrandPublicList(request, env);
    if (op === "brand-public-get") return handleBrandPublicGet(request, env);

    if (op === "brand-auth-request") return handleBrandAuthRequest(request, env);
    if (op === "brand-auth-poll") return handleBrandAuthPoll(request, env);
    if (op === "brand-auth-exchange") return handleBrandAuthExchange(request, env);
    if (op === "brand-auth-verify") return handleBrandAuthVerify(request, env);
    if (op === "brand-auth-logout") return handleBrandAuthLogout(request, env);
    if (op === "brand-auth-me") return handleBrandAuthMe(request, env);

    if (op === "brand-overview") return handleBrandOverview(request, env);
    if (op === "brand-create") return handleBrandCreate(request, env);
    if (op === "brand-update") return handleBrandUpdate(request, env);
    if (op === "brand-logo-upload") return handleBrandLogoUpload(request, env);

    if (op === "brand-connections") return handleBrandConnectionsList(request, env);
    if (op === "brand-printify-connect") return handleBrandPrintifyConnect(request, env);
    if (op === "brand-shopify-connect") return handleBrandShopifyConnect(request, env);
    if (op === "brand-shopify-oauth-start") return handleBrandShopifyOAuthStart(request, env);
    if (op === "brand-connection-ping") return handleBrandConnectionPing(request, env);
    if (op === "brand-connection-disconnect") return handleBrandConnectionDisconnect(request, env);

    if (op === "brand-products") return handleBrandProductsList(request, env);
    if (op === "brand-products-sync") return handleBrandProductsSync(request, env);

    if (op === "brand-team") return handleBrandTeamList(request, env);
    if (op === "brand-team-invite") return handleBrandTeamInvite(request, env);
    if (op === "brand-team-update") return handleBrandTeamUpdate(request, env);
    if (op === "brand-team-revoke") return handleBrandTeamRevoke(request, env);

    if (op === "brand-ping") {
      return json({ ok: true, service: "brand-portal", ts: Date.now() }, 200, cors);
    }

    return json({ ok: false, error: "unknown_op", op }, 404, cors);
  } catch (err) {
    console.error("[brand-router]", op, err?.message || err);
    return json({ ok: false, error: "internal_error", message: String(err?.message || err) }, 500, cors);
  }
}

export { handleBrandAuthVerify, handleBrandShopifyOAuthCallback };
