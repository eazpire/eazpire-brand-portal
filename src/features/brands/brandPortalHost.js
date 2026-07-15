/**
 * Serve brand.eazpire.com SPA + auth verify / Shopify OAuth callback paths
 */

import {
  handleBrandAuthVerify,
  handleBrandShopifyOAuthCallback,
  handleBrandCustomerOAuthStart,
  handleBrandCustomerOAuthCallback,
} from "./brandRouter.js";

let BRAND_STATIC_BUNDLE = null;
async function loadBundle() {
  if (BRAND_STATIC_BUNDLE) return BRAND_STATIC_BUNDLE;
  try {
    const mod = await import("./brandStaticBundle.js");
    BRAND_STATIC_BUNDLE = mod.BRAND_STATIC_BUNDLE || {};
  } catch {
    BRAND_STATIC_BUNDLE = {};
  }
  return BRAND_STATIC_BUNDLE;
}

function isBrandHost(hostname) {
  const h = String(hostname || "").toLowerCase();
  return (
    h === "brand.eazpire.com" ||
    h === "brand.local.eazpire.com" ||
    h.endsWith(".brand.eazpire.com") ||
    h === "localhost" ||
    h === "127.0.0.1"
  );
}

function assetKeyForPath(pathname) {
  let p = pathname || "/";
  if (p === "/" || p === "") return "index.html";
  if (p.startsWith("/")) p = p.slice(1);
  // SPA routes
  const spaRoutes = ["overview", "brand", "connections", "products", "team", "orders", "settings"];
  if (spaRoutes.includes(p) || spaRoutes.some((r) => p.startsWith(r + "?"))) {
    return "index.html";
  }
  if (p.startsWith("shared/") || p.startsWith("js/") || p.endsWith(".css") || p.endsWith(".js") || p.endsWith(".svg")) {
    return p;
  }
  // deep SPA paths
  if (!p.includes(".")) return "index.html";
  return p;
}

async function serveAsset(env, key) {
  const bundle = await loadBundle();
  if (bundle[key]) {
    return new Response(bundle[key].body, {
      status: 200,
      headers: {
        "content-type": bundle[key].contentType || "application/octet-stream",
        "cache-control": key === "index.html" ? "no-cache" : "public, max-age=300",
      },
    });
  }

  if (env.BRAND_ASSETS?.fetch) {
    const assetReq = new Request(`https://assets.local/${key}`);
    const res = await env.BRAND_ASSETS.fetch(assetReq);
    if (res.ok) return res;
  }

  return null;
}

export async function handleBrandPortalRequest(request, env) {
  const url = new URL(request.url);
  if (url.searchParams.get("op")) return null;
  if (!isBrandHost(url.hostname) && !url.hostname.includes("workers.dev")) {
    // allow workers.dev preview for the brand worker
    if (!String(env.BRAND_PORTAL_URL || "").includes(url.hostname)) {
      // still serve if this is the brand worker (single purpose)
    }
  }

  if (url.pathname === "/auth/verify") {
    return handleBrandAuthVerify(request, env);
  }
  if (url.pathname === "/auth/shopify/callback") {
    return handleBrandShopifyOAuthCallback(request, env);
  }
  if (url.pathname === "/auth/customer/start") {
    return handleBrandCustomerOAuthStart(request, env);
  }
  if (url.pathname === "/auth/customer/callback") {
    return handleBrandCustomerOAuthCallback(request, env);
  }

  const key = assetKeyForPath(url.pathname);
  const asset = await serveAsset(env, key);
  if (asset) return asset;

  // SPA fallback
  if (!url.pathname.includes(".")) {
    const index = await serveAsset(env, "index.html");
    if (index) return index;
  }

  return new Response("Not found", { status: 404 });
}
