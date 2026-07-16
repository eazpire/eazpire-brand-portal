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
  handleBrandGet,
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
import {
  handleBrandProductsList,
  handleBrandProductsSync,
  handleBrandProductGet,
  handleBrandProductUpdate,
} from "./brandProducts.js";
import {
  handleBrandTeamList,
  handleBrandTeamInvite,
  handleBrandTeamUpdate,
  handleBrandTeamRevoke,
} from "./brandTeam.js";
import { handleBrandPublicList, handleBrandPublicGet } from "./brandPublic.js";
import { handleBrandDualPublish, handleBrandDualUnpublish } from "./brandDualPublish.js";
import {
  handleBrandCustomerOAuthStart,
  handleBrandCustomerOAuthCallback,
  handleBrandCustomerUnlink,
} from "./brandCustomerOAuth.js";
import {
  handleBrandMyMemberships,
  handleBrandAcceptInvite,
} from "./creatorBrandWorkspace.js";
import {
  handleBrandApiKeysList,
  handleBrandApiKeysCreate,
  handleBrandApiKeysRevoke,
} from "./brandApiKeys.js";
import {
  handleBrandWebhooksList,
  handleBrandWebhooksCreate,
  handleBrandWebhooksUpdate,
  handleBrandWebhooksRevoke,
  handleBrandWebhooksTest,
} from "./brandWebhooks.js";
import { handleBrandOrdersList, handleBrandOrderGet } from "./brandOrders.js";
import { requireBrandAuth } from "./rbac.js";

export async function handleBrandRouter(request, env, ctx) {
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

    if (op === "brand-overview" || op === "brand-api-overview") return handleBrandOverview(request, env);
    if (op === "brand-create") return handleBrandCreate(request, env);
    if (op === "brand-update" || op === "brand-api-brand-update") return handleBrandUpdate(request, env);
    if (op === "brand-api-brand" || op === "brand-get") return handleBrandGet(request, env);
    if (op === "brand-logo-upload") return handleBrandLogoUpload(request, env);

    if (op === "brand-connections" || op === "brand-api-connections") {
      return handleBrandConnectionsList(request, env);
    }
    if (op === "brand-printify-connect") return handleBrandPrintifyConnect(request, env);
    if (op === "brand-shopify-connect") return handleBrandShopifyConnect(request, env);
    if (op === "brand-shopify-oauth-start") return handleBrandShopifyOAuthStart(request, env);
    if (op === "brand-connection-ping") return handleBrandConnectionPing(request, env);
    if (op === "brand-connection-disconnect") return handleBrandConnectionDisconnect(request, env);

    // Product catalog + dual-publish onto eazpire (aliases for clear Brand API naming)
    if (op === "brand-products" || op === "brand-api-products") return handleBrandProductsList(request, env);
    if (op === "brand-api-product-get" || op === "brand-product-get") return handleBrandProductGet(request, env);
    if (op === "brand-api-product-update" || op === "brand-product-update") {
      return handleBrandProductUpdate(request, env, ctx);
    }
    if (op === "brand-products-sync" || op === "brand-api-sync") {
      return handleBrandProductsSync(request, env, ctx);
    }
    if (
      op === "brand-dual-publish" ||
      op === "brand-products-publish" ||
      op === "brand-api-publish"
    ) {
      return handleBrandDualPublish(request, env, ctx);
    }
    if (
      op === "brand-dual-unpublish" ||
      op === "brand-products-unpublish" ||
      op === "brand-api-unpublish"
    ) {
      return handleBrandDualUnpublish(request, env, ctx);
    }
    if (op === "brand-team" || op === "brand-api-team") return handleBrandTeamList(request, env);

    // API key management — portal session only (create / list / revoke)
    if (op === "brand-api-keys" || op === "brand-api-keys-list") return handleBrandApiKeysList(request, env);
    if (op === "brand-api-keys-create") return handleBrandApiKeysCreate(request, env);
    if (op === "brand-api-keys-revoke") return handleBrandApiKeysRevoke(request, env);

    // Orders (read-only) — eazpire platform shop, filtered to dual-published brand products
    if (op === "brand-api-orders" || op === "brand-orders") {
      return handleBrandOrdersList(request, env);
    }
    if (op === "brand-api-order-get" || op === "brand-order-get") {
      return handleBrandOrderGet(request, env);
    }

    // Webhooks — session or API key with webhooks:read / webhooks:write
    if (op === "brand-api-webhooks" || op === "brand-webhooks-list") {
      return handleBrandWebhooksList(request, env);
    }
    if (op === "brand-api-webhooks-create" || op === "brand-webhooks-create") {
      return handleBrandWebhooksCreate(request, env);
    }
    if (op === "brand-api-webhooks-update" || op === "brand-webhooks-update") {
      return handleBrandWebhooksUpdate(request, env);
    }
    if (op === "brand-api-webhooks-revoke" || op === "brand-webhooks-revoke") {
      return handleBrandWebhooksRevoke(request, env);
    }
    if (op === "brand-api-webhooks-test" || op === "brand-webhooks-test") {
      return handleBrandWebhooksTest(request, env);
    }

    // Memberships for the signed-in user (Creator invites) — session only; not Brand API key
    if (op === "brand-my-memberships" || op === "brand-api-memberships") {
      const auth = await requireBrandAuth(request, env);
      if (auth?.type === "api_key") {
        return json(
          {
            ok: false,
            error: "eazpire_account_link_required",
            message:
              "Memberships are personal to a portal session / linked eazpire Account. Use a session cookie, or Link eazpire Account for Creator design workspace ops.",
          },
          403,
          cors
        );
      }
      return handleBrandMyMemberships(request, env);
    }

    if (
      op === "brand-team-invite" ||
      op === "brand-api-team-invite"
    ) {
      return handleBrandTeamInvite(request, env);
    }
    if (
      op === "brand-team-update" ||
      op === "brand-api-team-update"
    ) {
      return handleBrandTeamUpdate(request, env);
    }
    if (
      op === "brand-team-revoke" ||
      op === "brand-api-team-revoke"
    ) {
      return handleBrandTeamRevoke(request, env);
    }
    if (op === "brand-accept-invite") return handleBrandAcceptInvite(request, env);

    if (op === "brand-customer-unlink") return handleBrandCustomerUnlink(request, env);

    if (op === "brand-ping") {
      return json({ ok: true, service: "brand-portal", ts: Date.now() }, 200, cors);
    }

    return json({ ok: false, error: "unknown_op", op }, 404, cors);
  } catch (err) {
    console.error("[brand-router]", op, err?.message || err);
    return json({ ok: false, error: "internal_error", message: String(err?.message || err) }, 500, cors);
  }
}

export {
  handleBrandAuthVerify,
  handleBrandShopifyOAuthCallback,
  handleBrandCustomerOAuthStart,
  handleBrandCustomerOAuthCallback,
};
