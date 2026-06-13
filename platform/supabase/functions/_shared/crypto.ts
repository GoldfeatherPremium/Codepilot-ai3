// AES-256-GCM envelope encryption for provider API keys and GitHub tokens.
// ENCRYPTION_MASTER_KEY: 32-byte key, base64-encoded, stored as a Supabase
// secret (`supabase secrets set ENCRYPTION_MASTER_KEY=...`).
// Ciphertext + IV are stored in Postgres; the plaintext key never leaves
// edge function memory and is never returned to any client.

const b64 = {
  encode: (buf: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(buf))),
  decode: (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0)),
};

async function masterKey(): Promise<CryptoKey> {
  const raw = b64.decode(Deno.env.get("ENCRYPTION_MASTER_KEY")!);
  if (raw.byteLength !== 32) throw new Error("ENCRYPTION_MASTER_KEY must be 32 bytes (base64)");
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}

export async function encryptSecret(plaintext: string) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await masterKey();
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    new TextEncoder().encode(plaintext),
  );
  return { ciphertext: b64.encode(ct), iv: b64.encode(iv.buffer) };
}

export async function decryptSecret(ciphertext: string, iv: string) {
  const key = await masterKey();
  const pt = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: b64.decode(iv) },
    key,
    b64.decode(ciphertext),
  );
  return new TextDecoder().decode(pt);
}
