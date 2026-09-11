/**
 * Who is allowed in.
 *
 * Two people and one shared password, which is what was asked for and is
 * proportionate to a private console — but it is worth being clear about what
 * it does and does not give you. The name is a label, not an identity: anyone
 * holding the password can sign in as either of you, so the session says which
 * name was typed, not who typed it. Nothing here should be read as an audit
 * trail of a person.
 *
 * Written against Web Crypto rather than node:crypto so the same verification
 * runs in middleware, where the Edge runtime has no Node built-ins.
 */

const DAY = 86_400;
/** Long enough not to be re-typed daily, short enough that a stolen cookie expires. */
const TTL = 30 * DAY;

export const SESSION_COOKIE = "cg_session";

const enc = new TextEncoder();

function secret(): string {
  const s = process.env.AUTH_SECRET;
  // A default would mean every deployment that forgot to set one shares a
  // signing key, and a forged cookie from anywhere would work everywhere.
  if (!s) throw new Error("AUTH_SECRET is not set");
  return s;
}

export function allowedUsers(): string[] {
  return (process.env.CONSOLE_USERS ?? "")
    .split(",")
    .map((u) => u.trim().toLowerCase())
    .filter(Boolean);
}

async function hmac(value: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret()),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(value));
  return base64url(new Uint8Array(sig));
}

/**
 * Base64url without Buffer.
 *
 * This module is imported by middleware, which runs on the Edge runtime — no
 * Node built-ins, so `Buffer.from(...)` threw on every request and the whole
 * site answered 500 instead of redirecting to the form.
 */
function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Compare without leaking how far the match got. */
function sameSecret(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function checkPassword(name: string, password: string): string | null {
  const expected = process.env.CONSOLE_PASSWORD;
  if (!expected) throw new Error("CONSOLE_PASSWORD is not set");

  const who = name.trim().toLowerCase();
  const known = allowedUsers().includes(who);
  // Both checks always run, and the name is only trusted after the password
  // matches — so a wrong name and a wrong password fail the same way and at the
  // same speed, and the form cannot be used to enumerate who has an account.
  const ok = sameSecret(password, expected);
  return known && ok ? who : null;
}

export async function issueSession(name: string): Promise<string> {
  const expires = Math.floor(Date.now() / 1000) + TTL;
  const body = `${name}.${expires}`;
  return `${body}.${await hmac(body)}`;
}

export async function readSession(value: string | undefined): Promise<string | null> {
  if (!value) return null;
  const parts = value.split(".");
  if (parts.length !== 3) return null;
  const [name, expires, sig] = parts;

  if (!/^\d+$/.test(expires) || Number(expires) * 1000 < Date.now()) return null;
  if (!sameSecret(sig, await hmac(`${name}.${expires}`))) return null;
  // Re-checked on every request, not just at sign-in: removing someone from
  // CONSOLE_USERS has to end their session, or revocation would mean waiting a
  // month for a cookie to expire.
  if (!allowedUsers().includes(name)) return null;
  return name;
}

export const SESSION_MAX_AGE = TTL;
