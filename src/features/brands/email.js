/**
 * Resend helpers for Brand Portal magic links + invites
 */

async function sendResend(env, { to, subject, html }) {
  const key = String(env.RESEND_API_KEY || "").trim();
  if (!key) return { ok: false, skipped: true, error: "resend_not_configured" };

  const from =
    String(env.BRAND_FROM_EMAIL || env.ACCOUNT_DELETION_FROM_EMAIL || "").trim() ||
    "Eazpire <noreply@eazpire.com>";

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ from, to: [to], subject, html }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    return { ok: false, error: "resend_error", detail: text.slice(0, 300) };
  }
  return { ok: true };
}

export async function sendBrandMagicLinkEmail(env, { to, verifyUrl }) {
  return sendResend(env, {
    to,
    subject: "Sign in to Eazpire Brand Portal",
    html: `<p>Click to sign in to your brand workspace:</p><p><a href="${verifyUrl}">Sign in to brand.eazpire.com</a></p><p>This link expires in 15 minutes.</p>`,
  });
}

export async function sendBrandInviteEmail(env, { to, brandName, portalUrl }) {
  return sendResend(env, {
    to,
    subject: `You're invited to create for ${brandName}`,
    html: `<p>You've been invited to join <strong>${brandName}</strong> as a brand creator on Eazpire.</p>
<p>The creator workspace under this brand will launch soon. For now, the brand owner manages access at <a href="${portalUrl}">${portalUrl}</a>.</p>
<p>Designs created under a brand belong to that brand.</p>`,
  });
}
