import { serviceClient } from "@/lib/apps";

/**
 * A guard on the one place the model writes text nobody checks.
 *
 * Prose is read by a person who can tell when it is wrong. A suggested follow-up
 * is a button: clicking it sends the text back as a prompt, so an invented name
 * becomes a question the assistant then has to refuse. It shipped straight away
 * too — the first live test offered "Why is photo-framer reporting no spend?"
 * for a portfolio containing VidSum and FitRater and nothing else.
 *
 * The rule is narrow on purpose. Only tokens shaped like an identifier — they
 * carry a hyphen or a dot, as app slugs and vendor names do — are checked, and
 * only against names that actually exist. Ordinary prose passes untouched,
 * because a filter that eats good suggestions is worse than the odd bad one.
 */
export async function knownNames(): Promise<Set<string>> {
  const db = serviceClient();
  const [{ data: apps }, { data: rows }] = await Promise.all([
    db.from("apps").select("name, slug"),
    db.from("resources").select("vendor, name"),
  ]);

  const known = new Set<string>();
  const add = (v: unknown) => {
    if (typeof v === "string" && v.trim()) known.add(v.trim().toLowerCase());
  };

  for (const a of apps ?? []) {
    add(a.name);
    add(a.slug);
  }
  for (const r of rows ?? []) {
    add(r.vendor);
    // Resource names carry their own identifiers — "fal · chat", "measured ·
    // transcript" — so each word counts as known on its own.
    for (const part of String(r.name ?? "").split(/[\s·|/]+/)) add(part);
  }
  return known;
}

/** Identifier-shaped tokens: `photo-framer`, `fal.ai`, `youtube.googleapis`. */
const IDENTIFIER = /[A-Za-z][A-Za-z0-9]*(?:[-.][A-Za-z0-9]+)+/g;

/** The first identifier in `text` that names nothing real, or null if all check out. */
export function ungroundedName(text: string, known: Set<string>): string | null {
  for (const token of text.match(IDENTIFIER) ?? []) {
    const lower = token.toLowerCase().replace(/[.,!?]+$/, "");
    if (known.has(lower)) continue;
    // A dotted token may be a hostname or a decimal inside a sentence; a
    // hyphenated one may be an ordinary compound like "month-to-date". Both are
    // only suspicious when no part of them is known either.
    const parts = lower.split(/[-.]/);
    if (parts.some((p) => known.has(p))) continue;
    if (parts.every((p) => COMMON.has(p))) continue;
    return token;
  }
  return null;
}

/** Drop suggestions that name something the portfolio does not contain. */
export async function groundFollowups(followups: string[]): Promise<string[]> {
  if (!followups.length) return followups;
  const known = await knownNames();
  return followups.filter((f) => {
    const bad = ungroundedName(f, known);
    if (bad) console.warn(`[followups] dropped "${f}" — no such thing as "${bad}"`);
    return !bad;
  });
}

/** Hyphenated English that is not an identifier. */
const COMMON = new Set([
  "month", "to", "date", "year", "over", "pay", "as", "you", "go", "run", "rate",
  "day", "week", "per", "self", "non", "re", "pre", "post", "up", "down", "top",
  "left", "real", "time", "on", "off", "in", "out", "by", "of", "the", "a", "an",
]);
