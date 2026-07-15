/**
 * Magic-link verify UX for Brand Portal (self-contained for mirror repo).
 */

function escapeHtmlAttr(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;");
}

export function wantsJsonVerifyResponse(request, url) {
  const accept = request.headers.get("accept") || "";
  return accept.includes("application/json") || url.searchParams.get("format") === "json";
}

export function renderMagicLinkConfirmPage({ actionPath, token, title, lead, buttonLabel }) {
  const safeToken = escapeHtmlAttr(token);
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtmlAttr(title)}</title>
  <style>
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; font-family: system-ui, sans-serif; background: #0b1420; color: #f3f5f7; }
    .card { width: min(420px, calc(100vw - 32px)); background: #111c2e; border: 1px solid #243044; border-radius: 16px; padding: 28px; box-shadow: 0 20px 60px rgba(0,0,0,.35); }
    h1 { margin: 0 0 12px; font-size: 1.35rem; }
    p { margin: 0; line-height: 1.5; color: #a8b3c7; font-size: 0.95rem; }
    form { margin-top: 22px; }
    button { width: 100%; border: 0; border-radius: 10px; padding: 12px 16px; font-size: 1rem; font-weight: 600; cursor: pointer; background: #0f766e; color: #fff; }
    button:hover { background: #0d9488; }
  </style>
</head>
<body>
  <div class="card">
    <h1>${escapeHtmlAttr(title)}</h1>
    <p>${escapeHtmlAttr(lead)}</p>
    <form method="POST" action="${escapeHtmlAttr(actionPath)}">
      <input type="hidden" name="token" value="${safeToken}" />
      <button type="submit">${escapeHtmlAttr(buttonLabel)}</button>
    </form>
  </div>
</body>
</html>`;
}

export function authTokenStatus(row) {
  if (!row) return "invalid_or_expired_token";
  if (row.used_at) return "token_already_used";
  if (Number(row.expires_at) <= Date.now()) return "invalid_or_expired_token";
  return "valid";
}

export async function readVerifyToken(request, url) {
  if (request.method === "POST") {
    const contentType = request.headers.get("content-type") || "";
    if (contentType.includes("application/json")) {
      const body = await request.json().catch(() => ({}));
      return String(body.token || "").trim();
    }
    const form = await request.formData().catch(() => null);
    if (form) return String(form.get("token") || "").trim();
  }
  return String(url.searchParams.get("token") || "").trim();
}

export function redirectWithHeaders(location, status, headers = {}) {
  return new Response(null, {
    status,
    headers: {
      Location: location,
      ...headers,
    },
  });
}
