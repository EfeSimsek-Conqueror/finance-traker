import { NextResponse } from "next/server";
import { checkPassword, issueSession, SESSION_COOKIE, SESSION_MAX_AGE } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** POST — sign in. */
export async function POST(request: Request) {
  const { name, password } = (await request.json().catch(() => ({}))) as {
    name?: string;
    password?: string;
  };

  const who = checkPassword(name ?? "", password ?? "");
  if (!who) {
    // One message for both failures. Saying "no such user" would turn the form
    // into a way to find out who has access.
    return NextResponse.json({ error: "That name and password do not match." }, { status: 401 });
  }

  const res = NextResponse.json({ ok: true, name: who });
  res.cookies.set(SESSION_COOKIE, await issueSession(who), {
    httpOnly: true,
    sameSite: "lax",
    // Secure in production only, or the cookie would be dropped over plain
    // http on localhost and sign-in would appear to succeed and do nothing.
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: SESSION_MAX_AGE,
  });
  return res;
}

/** DELETE — sign out. */
export async function DELETE() {
  const res = NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE, "", { path: "/", maxAge: 0 });
  return res;
}
