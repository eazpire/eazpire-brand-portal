export function brandApiBase() {
  return window.__BRAND_API_BASE__ || window.location.origin;
}

export async function brandFetch(op, { method = "GET", body, query = {} } = {}) {
  const url = new URL(brandApiBase());
  url.searchParams.set("op", op);
  for (const [k, v] of Object.entries(query)) {
    if (v != null && v !== "") url.searchParams.set(k, String(v));
  }
  const res = await fetch(url.toString(), {
    method,
    credentials: "include",
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok === false) {
    const err = new Error(data.message || data.detail || data.error || `http_${res.status}`);
    err.data = data;
    err.status = res.status;
    throw err;
  }
  return data;
}

export async function brandUpload(op, file, { formFields = {} } = {}) {
  const url = new URL(brandApiBase());
  url.searchParams.set("op", op);
  const form = new FormData();
  form.append("file", file);
  for (const [k, v] of Object.entries(formFields)) {
    if (v != null) form.append(k, String(v));
  }
  const res = await fetch(url.toString(), {
    method: "POST",
    credentials: "include",
    body: form,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok === false) {
    const err = new Error(data.message || data.error || `http_${res.status}`);
    err.data = data;
    throw err;
  }
  return data;
}

export function showToast(message, { error = false } = {}) {
  let el = document.getElementById("brand-toast");
  if (!el) {
    el = document.createElement("div");
    el.id = "brand-toast";
    el.className = "toast";
    document.body.appendChild(el);
  }
  el.textContent = message;
  el.classList.toggle("error", !!error);
  el.hidden = false;
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => {
    el.hidden = true;
  }, 3200);
}
