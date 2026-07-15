/**
 * Encrypt / decrypt brand connection secrets (AES-GCM)
 */

function bytesToB64(bytes) {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function b64ToBytes(b64) {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

async function deriveKey(env) {
  const raw = String(env.BRAND_SECRETS_KEY || env.BRAND_JWT_SECRET || env.JWT_APP_SECRET || "").trim();
  if (!raw) throw new Error("brand_secrets_key_missing");
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(raw));
  return crypto.subtle.importKey("raw", hash, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

export async function encryptSecret(env, plaintext) {
  const key = await deriveKey(env);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    new TextEncoder().encode(String(plaintext || ""))
  );
  const combined = new Uint8Array(iv.length + cipher.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(cipher), iv.length);
  return bytesToB64(combined);
}

export async function decryptSecret(env, ciphertext) {
  if (!ciphertext) return null;
  const key = await deriveKey(env);
  const combined = b64ToBytes(ciphertext);
  const iv = combined.slice(0, 12);
  const data = combined.slice(12);
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, data);
  return new TextDecoder().decode(plain);
}

export function maskSecret(value) {
  const s = String(value || "");
  if (s.length <= 8) return "••••••••";
  return `${s.slice(0, 4)}…${s.slice(-4)}`;
}
