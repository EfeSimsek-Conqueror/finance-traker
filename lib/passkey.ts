import { serviceClient } from "@/lib/apps";

/**
 * Fingerprint sign-in, as a second way in rather than a replacement.
 *
 * A passkey is bound to one device, so the password has to keep working — lose
 * the laptop and it is the only route back. What the passkey buys is that the
 * shared password stops being typed in front of people, and that the thing
 * proving identity never leaves the device.
 *
 * One caveat worth stating: a credential is registered to whichever name was
 * signed in when it was created. Since both of you share a password, the name
 * on a passkey is still a label somebody chose, not proof of who they are.
 */
export type StoredCredential = {
  credential_id: string;
  public_key: string;
  counter: number;
  transports: string[] | null;
  user_name: string;
};

export const CHALLENGE_COOKIE = "cg_challenge";

/**
 * The relying party is the site itself, read from the request.
 *
 * Hard-coding a domain would break the moment this runs anywhere but where it
 * was written — localhost, a Vercel preview, the production host are three
 * different relying parties and a passkey is bound to exactly one.
 */
export function relyingParty(request: Request): { rpID: string; origin: string } {
  const url = new URL(request.url);
  const host = request.headers.get("x-forwarded-host") ?? url.host;
  const proto = request.headers.get("x-forwarded-proto") ?? url.protocol.replace(":", "");
  return { rpID: host.split(":")[0], origin: `${proto}://${host}` };
}

export async function credentialsFor(name: string): Promise<StoredCredential[]> {
  const { data } = await serviceClient()
    .from("credentials")
    .select("credential_id, public_key, counter, transports, user_name")
    .eq("user_name", name);
  return (data ?? []) as StoredCredential[];
}

export async function credentialById(id: string): Promise<StoredCredential | null> {
  const { data } = await serviceClient()
    .from("credentials")
    .select("credential_id, public_key, counter, transports, user_name")
    .eq("credential_id", id)
    .maybeSingle();
  return (data as StoredCredential) ?? null;
}

export async function saveCredential(row: {
  user_name: string;
  credential_id: string;
  public_key: string;
  counter: number;
  transports: string[] | null;
  label: string | null;
}): Promise<void> {
  const { error } = await serviceClient().from("credentials").insert(row);
  if (error) throw new Error(error.message);
}

/**
 * The counter is how a cloned authenticator gets caught: it only ever goes up,
 * so a replayed assertion arrives with a number we have already seen.
 */
export async function bumpCounter(credentialId: string, counter: number): Promise<void> {
  await serviceClient()
    .from("credentials")
    .update({ counter, last_used_at: new Date().toISOString() })
    .eq("credential_id", credentialId);
}
