const PAGE_LABELS = {
  "/": "Overview",
  "/overview": "Overview",
  "/brand": "Brand Profile",
  "/connections": "Connections",
  "/products": "Products",
  "/team": "Team",
  "/orders": "Orders",
  "/settings": "Settings",
};

let _onRoute = null;

export function navigate(path, onRoute = _onRoute) {
  const clean = path.startsWith("/") ? path : `/${path}`;
  const route = clean === "/overview" ? "/" : clean;
  history.pushState({}, "", route);
  document.querySelectorAll(".view").forEach((v) => {
    const r = v.getAttribute("data-route");
    v.classList.toggle("active", r === route || (route === "/" && r === "/"));
  });
  document.querySelectorAll(".nav-item").forEach((btn) => {
    btn.classList.toggle("active", btn.getAttribute("data-route") === route);
  });
  const title = document.getElementById("page-title");
  if (title) title.textContent = PAGE_LABELS[route] || "Brand Portal";
  document.getElementById("app-shell")?.classList.remove("nav-open");
  if (typeof onRoute === "function") onRoute(route);
}

export function initShell({ navItems, onRoute }) {
  _onRoute = onRoute;
  const nav = document.getElementById("brand-nav");
  if (nav) {
    nav.innerHTML = "";
    for (const item of navItems) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "nav-item";
      btn.dataset.route = item.route;
      btn.textContent = item.label;
      btn.addEventListener("click", () => navigate(item.route, onRoute));
      nav.appendChild(btn);
    }
  }

  document.getElementById("sidebar-toggle")?.addEventListener("click", () => {
    document.getElementById("app-shell")?.classList.toggle("nav-open");
  });

  window.addEventListener("popstate", () => {
    navigate(location.pathname || "/", onRoute);
  });

  navigate(location.pathname || "/", onRoute);
}
