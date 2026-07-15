import { brandFetch, brandUpload, showToast } from "/shared/js/brand-api.js";
import { initShell, navigate } from "/shared/js/brand-shell.js";

const NAV = [
  { route: "/", label: "Overview" },
  { route: "/brand", label: "Brand Profile" },
  { route: "/connections", label: "Connections" },
  { route: "/products", label: "Products" },
  { route: "/team", label: "Team" },
  { route: "/orders", label: "Orders" },
  { route: "/settings", label: "Settings" },
];

let me = null;
let pollTimer = null;

function $(id) {
  return document.getElementById(id);
}

function show(elId) {
  ["app-shell", "app-login", "app-onboarding"].forEach((id) => {
    const el = $(id);
    if (el) el.hidden = id !== elId;
  });
}

function slugify(name) {
  return String(name || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48);
}

function statusBadge(status) {
  const s = String(status || "").toLowerCase();
  if (s === "connected" || s === "active" || s === "ok") return "badge-success";
  if (s === "invited" || s === "draft" || s === "error") return "badge-warning";
  if (s === "revoked" || s === "disconnected") return "badge-danger";
  return "";
}

function renderConnPills(stats) {
  const host = $("conn-pills");
  if (!host) return;
  const c = stats?.connections || {};
  const items = [
    { key: "printify", label: "Printify" },
    { key: "shopify", label: "Shopify" },
  ];
  host.innerHTML = items
    .map((it) => {
      const st = c[it.key]?.status || "disconnected";
      const cls = st === "connected" ? "ok" : st === "error" ? "err" : "warn";
      return `<span class="pill ${cls}">${it.label}: ${st}</span>`;
    })
    .join("");
}

/* ---------- Overview ---------- */
async function renderOverview() {
  const root = $("view-overview");
  root.innerHTML = `<div class="panel"><p class="muted">Loading…</p></div>`;
  try {
    const data = await brandFetch("brand-overview");
    if (data.needs_onboarding) {
      show("app-onboarding");
      return;
    }
    renderConnPills(data.stats);
    const printifyOk = data.stats?.connections?.printify?.status === "connected";
    const shopifyOk = data.stats?.connections?.shopify?.status === "connected";
    root.innerHTML = `
      <div class="kpi-grid">
        <div class="kpi-card"><div class="label">Products</div><div class="value">${data.stats?.products ?? 0}</div></div>
        <div class="kpi-card"><div class="label">Team members</div><div class="value">${data.stats?.members ?? 0}</div></div>
        <div class="kpi-card"><div class="label">Pending reviews</div><div class="value">${data.stats?.pending_reviews ?? 0}</div></div>
        <div class="kpi-card"><div class="label">Brand</div><div class="value" style="font-size:1.05rem">${escapeHtml(data.brand?.name || "—")}</div></div>
      </div>
      <div class="panel">
        <h2>Quick actions</h2>
        <p class="muted">Connect your Printify and Shopify accounts, invite creators, and edit your brand profile.</p>
        <div class="actions-row">
          ${!printifyOk ? `<button class="btn btn-primary" data-go="/connections">Connect Printify</button>` : ""}
          ${!shopifyOk ? `<button class="btn btn-primary" data-go="/connections">Connect Shopify</button>` : ""}
          <button class="btn btn-secondary" data-go="/team">Invite creator</button>
          <button class="btn" data-go="/brand">Edit brand</button>
          <button class="btn" data-go="/products">View products</button>
        </div>
      </div>`;
    root.querySelectorAll("[data-go]").forEach((btn) => {
      btn.addEventListener("click", () => navigate(btn.getAttribute("data-go")));
    });
  } catch (e) {
    root.innerHTML = `<div class="panel"><p class="muted">${escapeHtml(e.message)}</p></div>`;
  }
}

/* ---------- Brand profile ---------- */
async function renderBrand() {
  const root = $("view-brand");
  root.innerHTML = `<div class="panel"><p class="muted">Loading…</p></div>`;
  try {
    const data = await brandFetch("brand-auth-me");
    const b = data.brand;
    if (!b) {
      show("app-onboarding");
      return;
    }
    root.innerHTML = `
      <div class="panel">
        <h2>Brand profile</h2>
        <p class="muted">Public brand URL later: eazpire.com/brands/<strong>${escapeHtml(b.handle)}</strong></p>
        <form id="brand-form">
          <div class="field"><label>Name</label><input class="input" name="name" value="${escapeAttr(b.name)}" required /></div>
          <div class="field"><label>Handle</label><input class="input" name="handle" value="${escapeAttr(b.handle)}" required pattern="[a-z0-9]+(?:-[a-z0-9]+)*" /></div>
          <div class="field"><label>Tagline</label><input class="input" name="tagline" value="${escapeAttr(b.tagline || "")}" /></div>
          <div class="field"><label>About</label><textarea class="textarea" name="about">${escapeHtml(b.about || "")}</textarea></div>
          <div class="field">
            <label>Logo</label>
            <input class="input" type="file" id="logo-file" accept="image/png,image/jpeg,image/webp" />
            ${b.logo_r2_key ? `<p class="muted" style="margin-top:8px">Current: ${escapeHtml(b.logo_r2_key)}</p>` : ""}
          </div>
          <button class="btn btn-primary" type="submit">Save profile</button>
        </form>
      </div>`;
    $("brand-form").addEventListener("submit", async (ev) => {
      ev.preventDefault();
      const fd = new FormData(ev.target);
      try {
        await brandFetch("brand-update", {
          method: "POST",
          body: {
            name: fd.get("name"),
            handle: fd.get("handle"),
            tagline: fd.get("tagline"),
            about: fd.get("about"),
          },
        });
        const file = $("logo-file")?.files?.[0];
        if (file) await brandUpload("brand-logo-upload", file);
        showToast("Brand saved");
        me = await brandFetch("brand-auth-me");
        renderBrand();
      } catch (err) {
        showToast(err.message, { error: true });
      }
    });
  } catch (e) {
    root.innerHTML = `<div class="panel"><p class="muted">${escapeHtml(e.message)}</p></div>`;
  }
}

/* ---------- Connections ---------- */
async function renderConnections() {
  const root = $("view-connections");
  root.innerHTML = `<div class="panel"><p class="muted">Loading…</p></div>`;
  try {
    const data = await brandFetch("brand-connections");
    const byType = Object.fromEntries((data.connections || []).map((c) => [c.type, c]));
    const p = byType.printify || { status: "disconnected" };
    const s = byType.shopify || { status: "disconnected" };

    root.innerHTML = `
      <div class="panel">
        <h2>Printify</h2>
        <p class="muted">Connect your own Printify API token. Status: <span class="badge ${statusBadge(p.status)}">${escapeHtml(p.status)}</span>
        ${p.shop_name ? ` · Shop: ${escapeHtml(p.shop_name)}` : ""}
        ${p.token_hint ? ` · ${escapeHtml(p.token_hint)}` : ""}</p>
        <form id="printify-form">
          <div class="field"><label>API token</label><input class="input" name="api_token" type="password" autocomplete="off" required placeholder="Paste Printify API token" /></div>
          <div class="field"><label>Shop ID (optional if you have one shop)</label><input class="input" name="shop_id" placeholder="e.g. 12345678" /></div>
          <div id="printify-shops"></div>
          <div class="actions-row">
            <button class="btn btn-primary" type="submit">Connect Printify</button>
            ${p.status === "connected" ? `<button type="button" class="btn" id="btn-ping-printify">Re-test</button>
            <button type="button" class="btn btn-danger" id="btn-disc-printify">Disconnect</button>` : ""}
          </div>
        </form>
      </div>
      <div class="panel">
        <h2>Shopify</h2>
        <p class="muted">Connect your Shopify store (Admin API token). Status: <span class="badge ${statusBadge(s.status)}">${escapeHtml(s.status)}</span>
        ${s.shop_domain ? ` · ${escapeHtml(s.shop_domain)}` : ""}
        ${s.token_hint ? ` · ${escapeHtml(s.token_hint)}` : ""}</p>
        <p class="muted">Printify↔Shopify linking is configured in Printify. Eazpire stores both sides and checks connectivity.</p>
        <form id="shopify-form">
          <div class="field"><label>Shop domain</label><input class="input" name="shop" required placeholder="your-store.myshopify.com" value="${escapeAttr(s.shop_domain || "")}" /></div>
          <div class="field"><label>Admin API access token</label><input class="input" name="access_token" type="password" autocomplete="off" required placeholder="shpat_…" /></div>
          <div class="actions-row">
            <button class="btn btn-primary" type="submit">Connect Shopify</button>
            <button type="button" class="btn btn-secondary" id="btn-oauth-shopify">Start OAuth (if configured)</button>
            ${s.status === "connected" ? `<button type="button" class="btn" id="btn-ping-shopify">Re-test</button>
            <button type="button" class="btn btn-danger" id="btn-disc-shopify">Disconnect</button>` : ""}
          </div>
        </form>
      </div>`;

    $("printify-form").addEventListener("submit", async (ev) => {
      ev.preventDefault();
      const fd = new FormData(ev.target);
      try {
        const res = await brandFetch("brand-printify-connect", {
          method: "POST",
          body: { api_token: fd.get("api_token"), shop_id: fd.get("shop_id") || undefined },
        });
        if (res.needs_shop_selection) {
          const box = $("printify-shops");
          box.innerHTML = `<div class="field"><label>Select shop</label>
            <select class="input" id="printify-shop-select">
              ${(res.shops || []).map((sh) => `<option value="${escapeAttr(sh.id)}">${escapeHtml(sh.title)} (${escapeHtml(sh.id)})</option>`).join("")}
            </select></div>
            <button type="button" class="btn btn-primary" id="btn-printify-shop">Connect selected shop</button>`;
          $("btn-printify-shop").addEventListener("click", async () => {
            try {
              await brandFetch("brand-printify-connect", {
                method: "POST",
                body: {
                  api_token: fd.get("api_token"),
                  shop_id: $("printify-shop-select").value,
                },
              });
              showToast("Printify connected");
              renderConnections();
            } catch (err) {
              showToast(err.message, { error: true });
            }
          });
          return;
        }
        showToast("Printify connected");
        renderConnections();
      } catch (err) {
        showToast(err.message, { error: true });
      }
    });

    $("shopify-form").addEventListener("submit", async (ev) => {
      ev.preventDefault();
      const fd = new FormData(ev.target);
      try {
        await brandFetch("brand-shopify-connect", {
          method: "POST",
          body: { shop: fd.get("shop"), access_token: fd.get("access_token") },
        });
        showToast("Shopify connected");
        renderConnections();
      } catch (err) {
        showToast(err.message, { error: true });
      }
    });

    $("btn-oauth-shopify")?.addEventListener("click", async () => {
      const shop = $("shopify-form").shop.value;
      try {
        const res = await brandFetch("brand-shopify-oauth-start", { query: { shop } });
        if (res.authorize_url) location.href = res.authorize_url;
      } catch (err) {
        showToast(err.message, { error: true });
      }
    });

    async function ping(type) {
      try {
        const res = await brandFetch("brand-connection-ping", { method: "POST", body: { type } });
        showToast(res.healthy ? `${type} OK` : `${type} unhealthy`, { error: !res.healthy });
        renderConnections();
      } catch (err) {
        showToast(err.message, { error: true });
      }
    }
    async function disconnect(type) {
      try {
        await brandFetch("brand-connection-disconnect", { method: "POST", body: { type } });
        showToast(`${type} disconnected`);
        renderConnections();
      } catch (err) {
        showToast(err.message, { error: true });
      }
    }
    $("btn-ping-printify")?.addEventListener("click", () => ping("printify"));
    $("btn-disc-printify")?.addEventListener("click", () => disconnect("printify"));
    $("btn-ping-shopify")?.addEventListener("click", () => ping("shopify"));
    $("btn-disc-shopify")?.addEventListener("click", () => disconnect("shopify"));

    const params = new URLSearchParams(location.search);
    if (params.get("shopify") === "connected") showToast("Shopify connected via OAuth");
    if (params.get("shopify_error")) showToast(`Shopify OAuth: ${params.get("shopify_error")}`, { error: true });
  } catch (e) {
    root.innerHTML = `<div class="panel"><p class="muted">${escapeHtml(e.message)}</p></div>`;
  }
}

/* ---------- Products ---------- */
async function renderProducts() {
  const root = $("view-products");
  root.innerHTML = `<div class="panel"><p class="muted">Loading…</p></div>`;
  try {
    const status = root.dataset.filter || "";
    const data = await brandFetch("brand-products", { query: status ? { status } : {} });
    const products = data.products || [];
    root.innerHTML = `
      <div class="panel">
        <div style="display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;align-items:center">
          <div>
            <h2 style="margin:0">Products</h2>
            <p class="muted" style="margin:6px 0 0">Synced from your Printify shop (read-only in phase 1).</p>
          </div>
          <div class="actions-row" style="margin:0">
            <select class="input" id="product-filter" style="width:auto">
              <option value="" ${!status ? "selected" : ""}>All</option>
              <option value="active" ${status === "active" ? "selected" : ""}>Active</option>
              <option value="draft" ${status === "draft" ? "selected" : ""}>Draft</option>
            </select>
            <button class="btn btn-primary" id="btn-sync-products">Refresh sync</button>
          </div>
        </div>
        <div class="table-wrap" style="margin-top:16px">
          <table class="data">
            <thead><tr><th></th><th>Title</th><th>Status</th><th>Printify</th><th>Shopify</th><th>Synced</th></tr></thead>
            <tbody>
              ${
                products.length
                  ? products
                      .map(
                        (p) => `<tr>
                  <td>${p.thumbnail_url ? `<img class="product-thumb" src="${escapeAttr(p.thumbnail_url)}" alt="" />` : ""}</td>
                  <td>${escapeHtml(p.title || "—")}</td>
                  <td><span class="badge ${statusBadge(p.status)}">${escapeHtml(p.status || "—")}</span></td>
                  <td>${escapeHtml(p.printify_product_id || "—")}</td>
                  <td>${escapeHtml(p.shopify_product_id || "—")}</td>
                  <td>${p.last_synced_at ? new Date(p.last_synced_at).toLocaleString() : "—"}</td>
                </tr>`
                      )
                      .join("")
                  : `<tr><td colspan="6" class="muted">No products yet. Connect Printify and run Refresh sync.</td></tr>`
              }
            </tbody>
          </table>
        </div>
      </div>`;
    $("btn-sync-products").addEventListener("click", async () => {
      try {
        const res = await brandFetch("brand-products-sync", { method: "POST", body: {} });
        showToast(`Synced ${res.synced || 0} products`);
        renderProducts();
      } catch (err) {
        showToast(err.message, { error: true });
      }
    });
    $("product-filter").addEventListener("change", (ev) => {
      root.dataset.filter = ev.target.value;
      renderProducts();
    });
  } catch (e) {
    root.innerHTML = `<div class="panel"><p class="muted">${escapeHtml(e.message)}</p></div>`;
  }
}

/* ---------- Team ---------- */
async function renderTeam() {
  const root = $("view-team");
  root.innerHTML = `<div class="panel"><p class="muted">Loading…</p></div>`;
  try {
    const data = await brandFetch("brand-team");
    const members = data.members || [];
    root.innerHTML = `
      <div class="panel">
        <h2>Invite creators</h2>
        <p class="muted">Only invited users can develop products for your brand. Creator workspace under brand launches later. Designs created under a brand belong to the brand.</p>
        <form id="invite-form" class="actions-row" style="align-items:flex-end">
          <div class="field" style="flex:1;min-width:200px;margin:0">
            <label>Email</label>
            <input class="input" name="email" type="email" required />
          </div>
          <div class="field" style="margin:0">
            <label>Publish mode</label>
            <select class="input" name="publish_mode">
              <option value="review" selected>Review</option>
              <option value="auto_publish">Auto Publish</option>
            </select>
          </div>
          <button class="btn btn-primary" type="submit">Send invite</button>
        </form>
      </div>
      <div class="panel">
        <h2>Members</h2>
        <div class="table-wrap">
          <table class="data">
            <thead><tr><th>Email</th><th>Status</th><th>Publish mode</th><th></th></tr></thead>
            <tbody>
              ${
                members.length
                  ? members
                      .map(
                        (m) => `<tr data-id="${escapeAttr(m.id)}">
                  <td>${escapeHtml(m.email)}</td>
                  <td><span class="badge ${statusBadge(m.status)}">${escapeHtml(m.status)}</span></td>
                  <td>
                    <select class="input publish-mode" style="width:auto">
                      <option value="review" ${m.publish_mode === "review" ? "selected" : ""}>Review</option>
                      <option value="auto_publish" ${m.publish_mode === "auto_publish" ? "selected" : ""}>Auto Publish</option>
                    </select>
                  </td>
                  <td><button type="button" class="btn btn-danger btn-revoke">Revoke</button></td>
                </tr>`
                      )
                      .join("")
                  : `<tr><td colspan="4" class="muted">No creators invited yet.</td></tr>`
              }
            </tbody>
          </table>
        </div>
      </div>`;

    $("invite-form").addEventListener("submit", async (ev) => {
      ev.preventDefault();
      const fd = new FormData(ev.target);
      try {
        await brandFetch("brand-team-invite", {
          method: "POST",
          body: { email: fd.get("email"), publish_mode: fd.get("publish_mode") },
        });
        showToast("Invite sent");
        renderTeam();
      } catch (err) {
        showToast(err.message, { error: true });
      }
    });

    root.querySelectorAll("tr[data-id]").forEach((row) => {
      const id = row.getAttribute("data-id");
      row.querySelector(".publish-mode")?.addEventListener("change", async (ev) => {
        try {
          await brandFetch("brand-team-update", {
            method: "POST",
            body: { member_id: id, publish_mode: ev.target.value },
          });
          showToast("Publish mode updated");
        } catch (err) {
          showToast(err.message, { error: true });
        }
      });
      row.querySelector(".btn-revoke")?.addEventListener("click", async () => {
        try {
          await brandFetch("brand-team-revoke", { method: "POST", body: { member_id: id } });
          showToast("Member revoked");
          renderTeam();
        } catch (err) {
          showToast(err.message, { error: true });
        }
      });
    });
  } catch (e) {
    root.innerHTML = `<div class="panel"><p class="muted">${escapeHtml(e.message)}</p></div>`;
  }
}

function renderOrders() {
  $("view-orders").innerHTML = `
    <div class="panel">
      <h2>Orders</h2>
      <p class="muted">Coming soon — order sync will appear once fulfillment is connected for your brand shop.</p>
    </div>`;
}

function renderSettings() {
  const email = me?.user?.email || "";
  $("view-settings").innerHTML = `
    <div class="panel">
      <h2>Account</h2>
      <p class="muted">Signed in as <strong>${escapeHtml(email)}</strong></p>
      <div class="actions-row">
        <button class="btn" id="btn-settings-logout">Sign out</button>
      </div>
    </div>
    <div class="panel">
      <h2>Link Shopify customer account</h2>
      <p class="muted">Coming soon — optional link for design access via Creator later.</p>
      <button class="btn" disabled>Coming soon</button>
    </div>
    <div class="panel">
      <h2>Danger zone</h2>
      <p class="muted">Soft-delete for brands will be available in a later release. Contact support if you need to remove a brand now.</p>
    </div>`;
  $("btn-settings-logout")?.addEventListener("click", () => $("btn-logout")?.click());
}

async function onRoute(route) {
  if (route === "/" || route === "/overview") return renderOverview();
  if (route === "/brand") return renderBrand();
  if (route === "/connections") return renderConnections();
  if (route === "/products") return renderProducts();
  if (route === "/team") return renderTeam();
  if (route === "/orders") return renderOrders();
  if (route === "/settings") return renderSettings();
}

function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
function escapeAttr(s) {
  return escapeHtml(s).replace(/'/g, "&#39;");
}

async function startShell() {
  show("app-shell");
  initShell({ navItems: NAV, onRoute });
  try {
    const overview = await brandFetch("brand-overview");
    renderConnPills(overview.stats);
  } catch {
    /* ignore */
  }
}

function stopPoll() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
}

async function beginLoginPoll(pollToken, email) {
  stopPoll();
  pollTimer = setInterval(async () => {
    try {
      const res = await brandFetch("brand-auth-poll", { query: { poll_token: pollToken } });
      if (res.status === "verified" && res.exchange_token) {
        stopPoll();
        await brandFetch("brand-auth-exchange", {
          method: "POST",
          body: { exchange_token: res.exchange_token },
        });
        await boot();
      } else if (res.status === "expired" || res.status === "cancelled") {
        stopPoll();
        $("login-waiting").hidden = true;
        $("login-panel").hidden = false;
        $("login-message").textContent = "Link expired. Please try again.";
      }
    } catch {
      /* keep polling */
    }
  }, 2000);
}

async function boot() {
  const authError = new URLSearchParams(location.search).get("auth_error");

  try {
    me = await brandFetch("brand-auth-me");
  } catch {
    me = null;
  }

  // Successful cookie from verify/poll: drop ugly ?auth_error= from URL
  if (me?.user && authError) {
    history.replaceState({}, "", location.pathname || "/");
  }

  if (!me?.user) {
    show("app-login");
    $("login-panel").hidden = false;
    $("login-waiting").hidden = true;
    if (authError === "token_already_used") {
      $("login-message").textContent =
        "This sign-in link was already used. Request a new magic link below.";
    } else if (authError === "invalid_or_expired_token") {
      $("login-message").textContent = "This sign-in link expired. Request a new one below.";
    } else if (authError) {
      $("login-message").textContent = `Sign-in failed (${authError}). Try again.`;
    }
    return;
  }

  if (me.needs_onboarding || !me.brand) {
    show("app-onboarding");
    return;
  }

  await startShell();
}

function wireAuthUi() {
  $("login-form")?.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const email = $("login-email").value.trim();
    $("login-message").textContent = "Sending…";
    try {
      const res = await brandFetch("brand-auth-request", { method: "POST", body: { email } });
      $("login-panel").hidden = true;
      $("login-waiting").hidden = false;
      $("login-waiting-email").textContent = email;
      const dev = $("login-dev-link");
      if (res.dev_verify_url) {
        dev.hidden = false;
        dev.innerHTML = `Dev verify link: <a href="${escapeAttr(res.dev_verify_url)}">${escapeHtml(res.dev_verify_url)}</a>`;
      } else {
        dev.hidden = true;
      }
      if (res.poll_token) beginLoginPoll(res.poll_token, email);
      $("login-message").textContent = "";
    } catch (err) {
      $("login-message").textContent = err.message || "Failed to send link";
    }
  });

  $("btn-login-waiting-cancel")?.addEventListener("click", () => {
    stopPoll();
    $("login-waiting").hidden = true;
    $("login-panel").hidden = false;
  });

  $("ob-name")?.addEventListener("input", (ev) => {
    const handle = $("ob-handle");
    if (handle && !handle.dataset.touched) handle.value = slugify(ev.target.value);
  });
  $("ob-handle")?.addEventListener("input", () => {
    $("ob-handle").dataset.touched = "1";
  });

  $("onboarding-form")?.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const msg = $("onboarding-message");
    msg.textContent = "Creating…";
    try {
      await brandFetch("brand-create", {
        method: "POST",
        body: {
          name: $("ob-name").value,
          handle: $("ob-handle").value,
          tagline: $("ob-tagline").value,
        },
      });
      me = await brandFetch("brand-auth-me");
      await startShell();
    } catch (err) {
      msg.textContent = err.message || "Could not create brand";
    }
  });

  $("btn-logout")?.addEventListener("click", async () => {
    try {
      await brandFetch("brand-auth-logout", { method: "POST", body: {} });
    } catch {
      /* ignore */
    }
    me = null;
    show("app-login");
  });
}

wireAuthUi();
boot();
