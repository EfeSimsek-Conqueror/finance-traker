import { LoginForm } from "./form";

export const metadata = { title: "Sign in · Cloudgeng Finance Tracker" };

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const { next } = await searchParams;
  // Only same-origin paths are honoured: an absolute URL in `next` would make
  // this form a redirector to anywhere, which is how a login page becomes a
  // phishing tool.
  const safe = next && next.startsWith("/") && !next.startsWith("//") ? next : "/";
  return <LoginForm next={safe} />;
}
