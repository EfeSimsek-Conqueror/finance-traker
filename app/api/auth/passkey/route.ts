import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import {
  generateRegistrationOptions,
  generateAuthenticationOptions,
  verifyRegistrationResponse,
  verifyAuthenticationResponse,
} from "@simplewebauthn/server";
import {
  bumpCounter,
  credentialById,
  credentialsFor,
  relyingParty,
  saveCredential,
  CHALLENGE_COOKIE,
} from "@/lib/passkey";
import { allowedUsers, issueSession, readSession, SESSION_COOKIE, SESSION_MAX_AGE } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Every step of both passkey flows, on one route.
 *
 * Four endpoints for what is really one conversation — ask for a challenge,
 * come back with an answer — and splitting them across files would spread the
 * challenge cookie's lifetime over four places that all have to agree about it.
 */
export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as {
    step?: string;
    name?: string;
    response?: unknown;
    label?: string;
  };
  const { rpID, origin } = relyingParty(request);
  const jar = await cookies();

  // The challenge is kept in a short-lived httpOnly cookie rather than a table.
  // It is single-use, worthless once spent, and tying it to the browser that
  // asked for it is exactly what a cookie does.
  const setChallenge = (res: NextResponse, value: string) => {
    res.cookies.set(CHALLENGE_COOKIE, value, {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/",
      maxAge: 300,
    });
    return res;
  };

  switch (body.step) {
    // ── registering this device, which requires already being signed in ──
    case "register-options": {
      const who = await readSession(jar.get(SESSION_COOKIE)?.value);
      if (!who) return NextResponse.json({ error: "not signed in" }, { status: 401 });

      const existing = await credentialsFor(who);
      const options = await generateRegistrationOptions({
        rpName: "Cloudgeng Finance Tracker",
        rpID,
        userName: who,
        // Registering the same authenticator twice would leave two rows that
        // both work and neither explains.
        excludeCredentials: existing.map((c) => ({ id: c.credential_id })),
        authenticatorSelection: {
          residentKey: "preferred",
          userVerification: "required",
        },
      });
      return setChallenge(NextResponse.json({ options }), options.challenge);
    }

    case "register-verify": {
      const who = await readSession(jar.get(SESSION_COOKIE)?.value);
      if (!who) return NextResponse.json({ error: "not signed in" }, { status: 401 });

      const expected = jar.get(CHALLENGE_COOKIE)?.value;
      if (!expected) return NextResponse.json({ error: "challenge expired" }, { status: 400 });

      const check = await verifyRegistrationResponse({
        response: body.response as never,
        expectedChallenge: expected,
        expectedOrigin: origin,
        expectedRPID: rpID,
        requireUserVerification: true,
      });
      if (!check.verified || !check.registrationInfo) {
        return NextResponse.json({ error: "could not verify this device" }, { status: 400 });
      }

      const { credential } = check.registrationInfo;
      await saveCredential({
        user_name: who,
        credential_id: credential.id,
        public_key: Buffer.from(credential.publicKey).toString("base64url"),
        counter: credential.counter,
        transports: credential.transports ?? null,
        label: body.label ?? null,
      });

      const res = NextResponse.json({ ok: true });
      res.cookies.set(CHALLENGE_COOKIE, "", { path: "/", maxAge: 0 });
      return res;
    }

    // ── signing in with a device already registered ──────────────────────
    case "login-options": {
      const who = (body.name ?? "").trim().toLowerCase();
      // Allowed credentials are left empty unless a name was typed, so the
      // browser offers whatever passkey it holds for this site and the form
      // never has to say which names exist.
      const allow = allowedUsers().includes(who) ? await credentialsFor(who) : [];
      const options = await generateAuthenticationOptions({
        rpID,
        userVerification: "required",
        allowCredentials: allow.map((c) => ({
          id: c.credential_id,
          transports: (c.transports ?? undefined) as never,
        })),
      });
      return setChallenge(NextResponse.json({ options }), options.challenge);
    }

    case "login-verify": {
      const expected = jar.get(CHALLENGE_COOKIE)?.value;
      if (!expected) return NextResponse.json({ error: "challenge expired" }, { status: 400 });

      const sent = body.response as { id?: string } | undefined;
      const stored = sent?.id ? await credentialById(sent.id) : null;
      if (!stored) return NextResponse.json({ error: "unknown device" }, { status: 401 });

      const check = await verifyAuthenticationResponse({
        response: body.response as never,
        expectedChallenge: expected,
        expectedOrigin: origin,
        expectedRPID: rpID,
        requireUserVerification: true,
        credential: {
          id: stored.credential_id,
          publicKey: new Uint8Array(Buffer.from(stored.public_key, "base64url")),
          counter: Number(stored.counter),
          transports: (stored.transports ?? undefined) as never,
        },
      });
      if (!check.verified) {
        return NextResponse.json({ error: "that device did not verify" }, { status: 401 });
      }

      // Re-checked here too: a credential belonging to someone since removed
      // from the allowlist must stop working, not outlive the decision.
      if (!allowedUsers().includes(stored.user_name)) {
        return NextResponse.json({ error: "no longer permitted" }, { status: 401 });
      }

      await bumpCounter(stored.credential_id, check.authenticationInfo.newCounter);

      const res = NextResponse.json({ ok: true, name: stored.user_name });
      res.cookies.set(SESSION_COOKIE, await issueSession(stored.user_name), {
        httpOnly: true,
        sameSite: "lax",
        secure: process.env.NODE_ENV === "production",
        path: "/",
        maxAge: SESSION_MAX_AGE,
      });
      res.cookies.set(CHALLENGE_COOKIE, "", { path: "/", maxAge: 0 });
      return res;
    }

    default:
      return NextResponse.json({ error: "unknown step" }, { status: 400 });
  }
}

/** GET — whether this name has any device registered, for the form's copy. */
export async function GET(request: Request) {
  const name = (new URL(request.url).searchParams.get("name") ?? "").trim().toLowerCase();
  if (!allowedUsers().includes(name)) return NextResponse.json({ registered: 0 });
  return NextResponse.json({ registered: (await credentialsFor(name)).length });
}
