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
    const data = await brandFetch("brand-api-products", { query: status ? { status } : {} });
    const products = data.products || [];
    root.innerHTML = `
      <div class="panel">
        <div style="display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;align-items:center">
          <div>
            <h2 style="margin:0">Products</h2>
            <p class="muted" style="margin:6px 0 0">Synced from your Printify shop. Publish mirrors selected products onto eazpire (not your own shop).</p>
          </div>
          <div class="actions-row" style="margin:0">
            <select class="input" id="product-filter" style="width:auto">
              <option value="" ${!status ? "selected" : ""}>All</option>
              <option value="active" ${status === "active" ? "selected" : ""}>Active</option>
              <option value="draft" ${status === "draft" ? "selected" : ""}>Draft</option>
            </select>
            <button class="btn" id="btn-sync-products">Refresh sync</button>
            <button class="btn btn-primary" id="btn-dual-publish">Publish to eazpire</button>
            <button class="btn" id="btn-dual-unpublish">Unpublish from eazpire</button>
          </div>
        </div>
        <div class="table-wrap" style="margin-top:16px">
          <table class="data">
            <thead><tr><th></th><th></th><th>Title</th><th>Status</th><th>Printify</th><th>Brand Shopify</th><th>eazpire</th><th>Synced</th></tr></thead>
            <tbody>
              ${
                products.length
                  ? products
                      .map(
                        (p) => `<tr>
                  <td><input type="checkbox" class="prod-select" value="${escapeAttr(p.id)}" /></td>
                  <td>${p.thumbnail_url ? `<img class="product-thumb" src="${escapeAttr(p.thumbnail_url)}" alt="" />` : ""}</td>
                  <td>${escapeHtml(p.title || "—")}</td>
                  <td><span class="badge ${statusBadge(p.status)}">${escapeHtml(p.status || "—")}</span></td>
                  <td>${escapeHtml(p.printify_product_id || "—")}</td>
                  <td>${escapeHtml(p.shopify_product_id || "—")}</td>
                  <td>${
                    p.dual_publish_status === "published"
                      ? `<span class="badge ok">${escapeHtml(p.eazpire_handle || p.eazpire_shopify_product_id || "published")}</span>`
                      : p.dual_publish_status === "unpublished"
                        ? `<span class="badge">unpublished</span>`
                      : p.dual_publish_status === "error"
                        ? `<span class="badge warn" title="${escapeAttr(p.dual_publish_error || "")}">error</span>`
                        : `<span class="muted">—</span>`
                  }</td>
                  <td>${p.last_synced_at ? new Date(p.last_synced_at).toLocaleString() : "—"}</td>
                </tr>`
                      )
                      .join("")
                  : `<tr><td colspan="8" class="muted">No products yet. Connect Printify and run Refresh sync.</td></tr>`
              }
            </tbody>
          </table>
        </div>
      </div>`;
    const selectedIds = () => [...root.querySelectorAll(".prod-select:checked")].map((el) => el.value);
    $("btn-sync-products").addEventListener("click", async () => {
      try {
        const res = await brandFetch("brand-products-sync", { method: "POST", body: {} });
        showToast(`Synced ${res.synced || 0} products`);
        renderProducts();
      } catch (err) {
        showToast(err.message, { error: true });
      }
    });
    $("btn-dual-publish").addEventListener("click", async () => {
      try {
        const ids = selectedIds();
        const body = ids.length ? { product_ids: ids } : { limit: 20 };
        const res = await brandFetch("brand-api-publish", { method: "POST", body });
        showToast(`Published ${res.published || 0} products to eazpire`);
        renderProducts();
      } catch (err) {
        showToast(err.message, { error: true });
      }
    });
    $("btn-dual-unpublish").addEventListener("click", async () => {
      try {
        const ids = selectedIds();
        if (!ids.length) {
          showToast("Select products to unpublish", { error: true });
          return;
        }
        const res = await brandFetch("brand-api-unpublish", {
          method: "POST",
          body: { product_ids: ids },
        });
        showToast(`Unpublished ${res.unpublished || 0} from eazpire`);
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
        <p class="muted">Only invited users can develop products for your brand. Invited creators link their eazpire Account, then switch to your brand workspace in Creator Settings.</p>
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
  const linkedId = me?.user?.shopify_customer_id || "";
  const linkedAt = me?.user?.shopify_linked_at;
  $("view-settings").innerHTML = `
    <div class="panel">
      <h2>Account</h2>
      <p class="muted">Signed in as <strong>${escapeHtml(email)}</strong></p>
      <div class="actions-row">
        <button class="btn" id="btn-settings-logout">Sign out</button>
      </div>
    </div>
    <div class="panel">
      <h2>Link eazpire Account</h2>
      <p class="muted">Connect your eazpire shop login so Creator can use brand workspaces. This is not your brand Shopify shop (see Connections), and not an API key.</p>
      ${
        linkedId
          ? `<p>Linked eazpire account ID: <code>${escapeHtml(linkedId)}</code>${
              linkedAt ? ` · ${escapeHtml(new Date(linkedAt).toLocaleString())}` : ""
            }</p>
             <div class="actions-row">
               <button class="btn" id="btn-relink-customer">Re-link eazpire Account</button>
               <button class="btn" id="btn-unlink-customer">Unlink</button>
             </div>`
          : `<div class="actions-row">
               <a class="btn btn-primary" href="/auth/customer/start">Link eazpire Account</a>
             </div>`
      }
    </div>
    <div class="panel">
      <h2>eazpire API keys</h2>
      <p class="muted">Machine access to the Brand API (catalog, sync, dual-publish, team, profile). Keys are hashed at rest; the full key is shown <strong>once</strong> when created. This is not Shopify and not Link eazpire Account.</p>
      <p style="margin:0 0 12px"><a href="/docs" target="_blank" rel="noopener">View API documentation</a></p>
      <div class="actions-row" style="margin-bottom:12px">
        <input type="text" id="api-key-name" placeholder="Key name (e.g. Production)" style="min-width:200px;flex:1" />
        <button class="btn btn-primary" id="btn-create-api-key">Create API key</button>
      </div>
      <div id="api-key-scopes" style="margin-bottom:12px">
        <p class="muted" style="margin:0 0 8px">Scopes (leave all checked for defaults, or pick a subset). <label style="margin-left:8px"><input type="checkbox" id="scope-star" /> Full access (<code>*</code>)</label></p>
        <div style="display:flex;flex-wrap:wrap;gap:8px 14px;font-size:0.88rem" id="scope-checks"></div>
      </div>
      <div id="api-key-once" hidden class="panel" style="background:rgba(0,0,0,.04);margin-bottom:12px"></div>
      <div id="api-keys-list" class="muted">Loading keys…</div>
    </div>
    <div class="panel">
      <h2>Webhooks</h2>
      <p class="muted">Receive HTTPS callbacks when products are published, unpublished, updated, or synced — so your systems do not need to poll. Signing secret is shown <strong>once</strong>. See <a href="/docs#webhooks" target="_blank" rel="noopener">webhook docs</a>.</p>
      <div class="actions-row" style="margin-bottom:12px;flex-wrap:wrap">
        <input type="url" id="webhook-url" placeholder="https://example.com/hooks/eazpire" style="min-width:260px;flex:1" />
        <button class="btn btn-primary" id="btn-create-webhook">Add webhook</button>
      </div>
      <div id="webhook-events" style="margin-bottom:12px">
        <p class="muted" style="margin:0 0 8px">Events (defaults: all product events)</p>
        <div style="display:flex;flex-wrap:wrap;gap:8px 14px;font-size:0.88rem" id="webhook-event-checks"></div>
      </div>
      <div id="webhook-once" hidden class="panel" style="background:rgba(0,0,0,.04);margin-bottom:12px"></div>
      <div id="webhooks-list" class="muted">Loading webhooks…</div>
    </div>
    <div class="panel">
      <h2>Creator invites</h2>
      <p class="muted">If you were invited to another brand, accept here so Creator can see that workspace after you link your eazpire Account.</p>
      <button class="btn" id="btn-accept-invites">Accept pending invites</button>
      <div id="membership-list" class="muted" style="margin-top:12px"></div>
    </div>
    <div class="panel">
      <h2>Danger zone</h2>
      <p class="muted">Soft-delete for brands will be available in a later release. Contact support if you need to remove a brand now.</p>
    </div>`;
  $("btn-settings-logout")?.addEventListener("click", () => $("btn-logout")?.click());
  $("btn-relink-customer")?.addEventListener("click", () => {
    location.href = "/auth/customer/start";
  });
  $("btn-unlink-customer")?.addEventListener("click", async () => {
    try {
      await brandFetch("brand-customer-unlink", { method: "POST", body: {} });
      showToast("eazpire Account unlinked");
      me = await brandFetch("brand-auth-me");
      renderSettings();
    } catch (err) {
      showToast(err.message, { error: true });
    }
  });
  $("btn-accept-invites")?.addEventListener("click", async () => {
    try {
      const res = await brandFetch("brand-accept-invite", { method: "POST", body: {} });
      showToast(`Activated ${res.activated || 0} invite(s)`);
      loadMemberships();
    } catch (err) {
      showToast(err.message, { error: true });
    }
  });
  $("btn-create-api-key")?.addEventListener("click", () => createApiKey());
  $("btn-create-webhook")?.addEventListener("click", () => createWebhook());
  wireScopePicker();
  wireWebhookEventPicker();
  loadMemberships();
  loadApiKeys();
  loadWebhooks();

  const params = new URLSearchParams(location.search);
  if (params.get("customer_linked") === "1") {
    showToast("eazpire Account linked");
    history.replaceState({}, "", "/settings");
  }
  if (params.get("customer_link_error")) {
    showToast(`Link failed: ${params.get("customer_link_error")}`, { error: true });
    history.replaceState({}, "", "/settings");
  }
}

const API_SCOPE_OPTIONS = [
  "overview:read",
  "brand:read",
  "brand:write",
  "connections:read",
  "products:read",
  "products:write",
  "products:sync",
  "products:publish",
  "team:read",
  "team:invite",
  "team:write",
  "webhooks:read",
  "webhooks:write",
];

const WEBHOOK_EVENT_OPTIONS = [
  "product.published",
  "product.unpublished",
  "product.updated",
  "product.synced",
];

function wireScopePicker() {
  const host = $("scope-checks");
  if (!host) return;
  host.innerHTML = API_SCOPE_OPTIONS.map(
    (s) =>
      `<label><input type="checkbox" class="scope-opt" value="${escapeAttr(s)}" checked /> <code>${escapeHtml(s)}</code></label>`
  ).join("");
  const star = $("scope-star");
  star?.addEventListener("change", () => {
    const on = !!star.checked;
    host.querySelectorAll(".scope-opt").forEach((el) => {
      el.checked = on ? false : true;
      el.disabled = on;
    });
  });
}

function wireWebhookEventPicker() {
  const host = $("webhook-event-checks");
  if (!host) return;
  host.innerHTML = WEBHOOK_EVENT_OPTIONS.map(
    (e) =>
      `<label><input type="checkbox" class="webhook-event-opt" value="${escapeAttr(e)}" checked /> <code>${escapeHtml(e)}</code></label>`
  ).join("");
}

function selectedApiScopes() {
  if ($("scope-star")?.checked) return ["*"];
  const picked = [...document.querySelectorAll(".scope-opt:checked")].map((el) => el.value);
  return picked.length ? picked : [...API_SCOPE_OPTIONS];
}

function selectedWebhookEvents() {
  const picked = [...document.querySelectorAll(".webhook-event-opt:checked")].map((el) => el.value);
  return picked.length ? picked : [...WEBHOOK_EVENT_OPTIONS];
}

async function loadApiKeys() {
  const box = $("api-keys-list");
  if (!box) return;
  try {
    const data = await brandFetch("brand-api-keys");
    const keys = data.keys || [];
    if (!keys.length) {
      box.textContent = "No API keys yet.";
      return;
    }
    box.innerHTML = `<div class="table-wrap"><table class="data">
      <thead><tr><th>Name</th><th>Prefix</th><th>Scopes</th><th>Created</th><th>Last used</th><th>Status</th><th></th></tr></thead>
      <tbody>${keys
        .map(
          (k) => `<tr>
        <td>${escapeHtml(k.name)}</td>
        <td><code>${escapeHtml(k.key_prefix)}…</code></td>
        <td style="max-width:220px;font-size:0.8rem">${escapeHtml((k.scopes || []).join(", ") || "—")}</td>
        <td>${k.created_at ? escapeHtml(new Date(k.created_at).toLocaleString()) : "—"}</td>
        <td>${k.last_used_at ? escapeHtml(new Date(k.last_used_at).toLocaleString()) : "—"}</td>
        <td><span class="badge ${k.active ? "badge-success" : "badge-danger"}">${k.active ? "active" : "revoked"}</span></td>
        <td>${
          k.active
            ? `<button type="button" class="btn btn-secondary btn-revoke-key" data-id="${escapeHtml(k.id)}">Revoke</button>`
            : ""
        }</td>
      </tr>`
        )
        .join("")}</tbody></table></div>`;
    box.querySelectorAll(".btn-revoke-key").forEach((btn) => {
      btn.addEventListener("click", async () => {
        if (!confirm("Revoke this API key? External systems using it will stop working.")) return;
        try {
          await brandFetch("brand-api-keys-revoke", { method: "POST", body: { key_id: btn.getAttribute("data-id") } });
          showToast("API key revoked");
          const once = $("api-key-once");
          if (once) once.hidden = true;
          loadApiKeys();
        } catch (err) {
          showToast(err.message, { error: true });
        }
      });
    });
  } catch (e) {
    box.textContent = e.message;
  }
}

async function createApiKey() {
  const name = String($("api-key-name")?.value || "").trim();
  if (!name) {
    showToast("Enter a key name", { error: true });
    return;
  }
  try {
    const scopes = selectedApiScopes();
    const res = await brandFetch("brand-api-keys-create", { method: "POST", body: { name, scopes } });
    const once = $("api-key-once");
    if (once && res.api_key) {
      once.hidden = false;
      once.innerHTML = `
        <p><strong>Copy this key now</strong> — it will not be shown again.</p>
        <p><code id="api-key-raw" style="word-break:break-all">${escapeHtml(res.api_key)}</code></p>
        <p class="muted">Scopes: ${escapeHtml((res.key?.scopes || scopes).join(", "))}</p>
        <button type="button" class="btn btn-secondary" id="btn-copy-api-key">Copy to clipboard</button>`;
      $("btn-copy-api-key")?.addEventListener("click", async () => {
        try {
          await navigator.clipboard.writeText(res.api_key);
          showToast("Copied");
        } catch {
          showToast("Copy failed — select the key manually", { error: true });
        }
      });
    }
    if ($("api-key-name")) $("api-key-name").value = "";
    showToast("API key created");
    loadApiKeys();
  } catch (err) {
    showToast(err.message, { error: true });
  }
}

async function loadWebhooks() {
  const box = $("webhooks-list");
  if (!box) return;
  try {
    const data = await brandFetch("brand-api-webhooks");
    const hooks = data.webhooks || [];
    if (!hooks.length) {
      box.textContent = "No webhooks yet.";
      return;
    }
    box.innerHTML = `<div class="table-wrap"><table class="data">
      <thead><tr><th>URL</th><th>Events</th><th>Status</th><th>Last delivery</th><th></th></tr></thead>
      <tbody>${hooks
        .map(
          (h) => `<tr>
        <td style="max-width:240px;word-break:break-all;font-size:0.85rem">${escapeHtml(h.url)}</td>
        <td style="max-width:200px;font-size:0.8rem">${escapeHtml((h.events || []).join(", ") || "—")}</td>
        <td><span class="badge ${h.status === "active" ? "badge-success" : "badge-danger"}">${escapeHtml(h.status)}</span>${
            h.last_error ? `<div class="muted" style="font-size:0.75rem;max-width:160px">${escapeHtml(h.last_error)}</div>` : ""
          }</td>
        <td>${h.last_delivery_at ? escapeHtml(new Date(h.last_delivery_at).toLocaleString()) : "—"}</td>
        <td style="white-space:nowrap">
          ${
            h.status === "active"
              ? `<button type="button" class="btn btn-secondary btn-test-webhook" data-id="${escapeHtml(h.id)}">Test</button>
                 <button type="button" class="btn btn-secondary btn-disable-webhook" data-id="${escapeHtml(h.id)}">Disable</button>`
              : `<button type="button" class="btn btn-secondary btn-enable-webhook" data-id="${escapeHtml(h.id)}">Enable</button>`
          }
          <button type="button" class="btn btn-secondary btn-delete-webhook" data-id="${escapeHtml(h.id)}">Delete</button>
        </td>
      </tr>`
        )
        .join("")}</tbody></table></div>`;

    box.querySelectorAll(".btn-test-webhook").forEach((btn) => {
      btn.addEventListener("click", async () => {
        try {
          const res = await brandFetch("brand-api-webhooks-test", {
            method: "POST",
            body: { webhook_id: btn.getAttribute("data-id") },
          });
          showToast(res.sent ? "Ping delivered" : "Ping failed — check URL / logs", {
            error: !res.sent,
          });
          loadWebhooks();
        } catch (err) {
          showToast(err.message, { error: true });
        }
      });
    });
    box.querySelectorAll(".btn-disable-webhook").forEach((btn) => {
      btn.addEventListener("click", async () => {
        try {
          await brandFetch("brand-api-webhooks-update", {
            method: "POST",
            body: { webhook_id: btn.getAttribute("data-id"), status: "disabled" },
          });
          showToast("Webhook disabled");
          loadWebhooks();
        } catch (err) {
          showToast(err.message, { error: true });
        }
      });
    });
    box.querySelectorAll(".btn-enable-webhook").forEach((btn) => {
      btn.addEventListener("click", async () => {
        try {
          await brandFetch("brand-api-webhooks-update", {
            method: "POST",
            body: { webhook_id: btn.getAttribute("data-id"), status: "active" },
          });
          showToast("Webhook enabled");
          loadWebhooks();
        } catch (err) {
          showToast(err.message, { error: true });
        }
      });
    });
    box.querySelectorAll(".btn-delete-webhook").forEach((btn) => {
      btn.addEventListener("click", async () => {
        if (!confirm("Delete this webhook permanently?")) return;
        try {
          await brandFetch("brand-api-webhooks-revoke", {
            method: "POST",
            body: { webhook_id: btn.getAttribute("data-id"), hard: true },
          });
          showToast("Webhook deleted");
          const once = $("webhook-once");
          if (once) once.hidden = true;
          loadWebhooks();
        } catch (err) {
          showToast(err.message, { error: true });
        }
      });
    });
  } catch (e) {
    box.textContent = e.message;
  }
}

async function createWebhook() {
  const url = String($("webhook-url")?.value || "").trim();
  if (!url) {
    showToast("Enter a webhook URL", { error: true });
    return;
  }
  try {
    const events = selectedWebhookEvents();
    const res = await brandFetch("brand-api-webhooks-create", {
      method: "POST",
      body: { url, events },
    });
    const once = $("webhook-once");
    if (once && res.secret) {
      once.hidden = false;
      once.innerHTML = `
        <p><strong>Copy this signing secret now</strong> — it will not be shown again.</p>
        <p><code id="webhook-secret-raw" style="word-break:break-all">${escapeHtml(res.secret)}</code></p>
        <p class="muted">Verify deliveries with header <code>X-Eazpire-Signature: sha256=…</code> (HMAC-SHA256 of the raw body).</p>
        <button type="button" class="btn btn-secondary" id="btn-copy-webhook-secret">Copy to clipboard</button>`;
      $("btn-copy-webhook-secret")?.addEventListener("click", async () => {
        try {
          await navigator.clipboard.writeText(res.secret);
          showToast("Copied");
        } catch {
          showToast("Copy failed — select the secret manually", { error: true });
        }
      });
    }
    if ($("webhook-url")) $("webhook-url").value = "";
    showToast("Webhook created");
    loadWebhooks();
  } catch (err) {
    showToast(err.message, { error: true });
  }
}

async function loadMemberships() {
  const box = $("membership-list");
  if (!box) return;
  try {
    const data = await brandFetch("brand-my-memberships");
    const list = data.memberships || [];
    if (!list.length) {
      box.textContent = "No brand memberships for this email.";
      return;
    }
    box.innerHTML = `<ul style="margin:0;padding-left:18px">${list
      .map(
        (m) =>
          `<li>${escapeHtml(m.name || m.handle)} · ${escapeHtml(m.status)} · ${escapeHtml(m.publish_mode)}</li>`
      )
      .join("")}</ul>`;
  } catch (e) {
    box.textContent = e.message;
  }
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
