// src/utils/response.js

// CORS-Header für alle Responses (mit credentials support)
const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
  "access-control-allow-headers":
    "content-type, authorization, x-eaz-debug-activate, x-eaz-logged-in-customer-id, x-requested-with",
  "access-control-allow-credentials": "true",
  "access-control-max-age": "86400",
};

// Dynamische CORS-Header mit Origin-Support für credentials
/** CORS + explicit no-store so dynamic hero APIs are not cached by browser or Cloudflare edge. */
export function noStoreCorsHeaders(request) {
  return {
    ...getCorsHeaders(request),
    "cache-control": "private, no-store, max-age=0, must-revalidate",
    pragma: "no-cache",
    "cdn-cache-control": "no-store",
  };
}

export function getCorsHeaders(request) {
  const origin = request.headers.get("origin");
  const allowedOrigins = [
    // Produktions-Domain (ohne und mit www)
    "https://eazpire.com",
    "https://www.eazpire.com",
    // Manufacturer network portals
    "https://partner.eazpire.com",
    "https://admin.eazpire.com",
    "https://wear.eazpire.com",
    "https://play.eazpire.com",
    "https://ads.eazpire.com",
    // Shopify-Store
    "https://allyoucanpink.myshopify.com",
  ];
  
  // Check if origin matches allowed origins or Shopify preview pattern
  let allowOrigin = null;
  if (origin) {
    const originLower = origin.toLowerCase();

    // Exact match (case-insensitive)
    if (allowedOrigins.some((o) => o.toLowerCase() === originLower)) {
      allowOrigin = origin;
    }
    // Shopify preview pattern: *.myshopify.com
    else if (originLower.includes(".myshopify.com")) {
      allowOrigin = origin;
    }
  }

  // Fallbacks:
  // - Wenn eine Origin existiert, aber nicht whitelisted ist -> verwende sie trotzdem (für Development/Testing)
  // - Wenn gar keine Origin existiert (Server-zu-Server) -> erste erlaubte Domain
  if (!allowOrigin) {
    allowOrigin = origin || allowedOrigins[0];
  }
  
  return {
    "access-control-allow-origin": allowOrigin,
    "access-control-allow-methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
    "access-control-allow-headers":
      "content-type, authorization, x-eaz-debug-activate, x-eaz-logged-in-customer-id, x-requested-with",
    "access-control-expose-headers": "x-eaz-crop-run-id",
    "access-control-allow-credentials": "true",
    "access-control-max-age": "86400"
  };
}

// kleines JSON-Hilfsding, wie früher
export function json(obj, status = 200, headers = {}, request = null) {
    // Prüfe ob CORS-Headers bereits vorhanden sind (case-insensitive)
    const hasCorsHeaders = Object.keys(headers).some(key =>
      key.toLowerCase().includes('access-control-allow-origin') ||
      key.toLowerCase().includes('access-control-allow-methods') ||
      key.toLowerCase().includes('access-control-allow-headers')
    );

    // Erstelle finalHeaders ohne CORS-Header zunächst
    const finalHeaders = {
      "content-type": "application/json"
    };

    // Wenn CORS-Headers übergeben wurden, verwende diese (nicht die statischen)
    if (hasCorsHeaders) {
      Object.assign(finalHeaders, headers);
    } else if (request) {
      // Wenn Request verfügbar, verwende dynamische CORS-Headers
      const dynamicCorsHeaders = getCorsHeaders(request);
      Object.assign(finalHeaders, dynamicCorsHeaders);
    } else {
      // Fallback: Keine CORS-Header übergeben und kein Request - verwende statische
      // ABER verwende die gleichen Header wie getCorsHeaders für localhost/Entwicklung
      const fallbackHeaders = {
        "access-control-allow-origin": "https://www.eazpire.com",
        "access-control-allow-methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
        "access-control-allow-headers":
          "content-type, authorization, x-eaz-debug-activate, x-eaz-logged-in-customer-id, x-requested-with",
        "access-control-expose-headers": "x-eaz-crop-run-id",
        "access-control-allow-credentials": "true",
        "access-control-max-age": "86400"
      };
      Object.assign(finalHeaders, fallbackHeaders);
    }

    // Zusätzliche Header (z. B. x-eaz-crop-run-id), wenn CORS aus Request kommt und `headers` nur Erweiterungen enthält
    if (!hasCorsHeaders && headers && typeof headers === "object") {
      for (const key of Object.keys(headers)) {
        const lower = key.toLowerCase();
        if (
          lower === "content-type" ||
          lower.startsWith("access-control-allow-") ||
          lower === "access-control-max-age" ||
          lower === "access-control-expose-headers"
        ) {
          continue;
        }
        finalHeaders[key] = headers[key];
      }
    }

    return new Response(JSON.stringify(obj), {
      status,
      headers: finalHeaders
    });
  }

export { CORS_HEADERS };  