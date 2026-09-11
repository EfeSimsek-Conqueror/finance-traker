import { serviceClient } from "@/lib/apps";
import type { Resource } from "@/lib/apps";
import { connectionState } from "@/lib/apps";
import {
  byVendor,
  costMtd,
  counted,
  coverage,
  dedupeShared,
  ghostVendors,
  mergeCeilings,
  revenueMtd,
  usd,
} from "@/lib/money";
import { syncConnection, SUPPORTED_VENDORS } from "@/lib/connectors/sync";
import { seriesFor, type Reading } from "@/lib/readings";
// Type-only, so nothing here imports lib/briefing at runtime and the two files
// cannot form a cycle — briefing.ts imports TOOLS from this one.
import type { BriefingDraft } from "@/lib/briefing";

/**
 * What the assistant can do.
 *
 * Every reading tool goes through lib/money rather than summing rows itself, so
 * the model and the board cannot disagree about a total — they are the same
 * arithmetic called twice.
 *
 * The write tools are real and take effect immediately. They are all scoped to
 * this tracker's own tables, where every change is reversible and the worst
 * outcome is a row that has to be re-synced. What the model deliberately cannot
 * reach is the vendor credentials in `connections.secret`: a tool that posted
 * arbitrary requests with those keys could refund a customer or delete a
 * deployment, and no answer on this board is worth that blast radius. It syncs
 * through the connectors instead, which is the same power with a known shape.
 */
export const TOOLS = [
  {
    type: "function",
    function: {
      name: "read_board",
      description:
        "Everything on the board: apps, their resources (quotas, spend, revenue) and connection health. Start here.",
      parameters: {
        type: "object",
        properties: {
          app: { type: "string", description: "Optional app slug or name to narrow to." },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "quota_status",
      description:
        "Ceilings and how full each is, sorted fullest first. Separates measured ceilings from ones with a known limit but no counter.",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  {
    type: "function",
    function: {
      name: "spend_breakdown",
      description:
        "Cost month to date by vendor, revenue, margin, vendors that bill but report nothing, and how much of each invoice the app's own ledger accounts for.",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  {
    type: "function",
    function: {
      name: "read_history",
      description:
        "What the board looked like before. Every sync archives its readings; this reads them back per (vendor, name) series and reports what moved inside a window. The resources table holds only the present, so this is the only source of 'since yesterday'. It also says, per series, whether a comparison is possible at all. Returns one entry per app.",
      parameters: {
        type: "object",
        properties: {
          app: { type: "string", description: "App slug or name. Omit for every app." },
          since_hours: { type: "number", description: "Window length in hours. Defaults to 24." },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_table",
      description:
        "Read rows from a tracker table: apps, resources, connections, chats, chat_messages. Credentials are never returned.",
      parameters: {
        type: "object",
        properties: {
          table: { type: "string", enum: ["apps", "resources", "connections", "chats", "chat_messages"] },
          match: { type: "object", description: "Optional equality filters, e.g. {\"vendor\":\"fal.ai\"}" },
          limit: { type: "number" },
        },
        required: ["table"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "sync_vendor",
      description:
        "Re-read a vendor now and write the fresh measurement onto the board. Use this when a figure looks stale rather than estimating what it would be.",
      parameters: {
        type: "object",
        properties: {
          vendor: { type: "string", description: "e.g. fal.ai, vercel, stripe, google, ledger, revenuecat" },
          app: { type: "string", description: "Optional app slug; omit to sync this vendor everywhere." },
        },
        required: ["vendor"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "set_manual_cost",
      description:
        "Record a cost that has no API behind it — an Apple developer fee, a domain renewal. Written as a manual row so the board can tell it apart from a measurement.",
      parameters: {
        type: "object",
        properties: {
          app: { type: "string", description: "App slug." },
          vendor: { type: "string" },
          name: { type: "string" },
          monthly_usd: { type: "number", description: "Monthly equivalent. Divide an annual fee by 12." },
          note: { type: "string" },
        },
        required: ["app", "vendor", "name", "monthly_usd"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "remove_resource",
      description: "Delete a row from the board by id. A vendor row comes back on the next sync.",
      parameters: {
        type: "object",
        properties: { id: { type: "string" } },
        required: ["id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "present",
      description:
        "Attach structured blocks to your answer, and propose what to ask next. Call once, last, alongside your prose.",
      parameters: {
        type: "object",
        properties: {
          blocks: {
            type: "array",
            items: {
              type: "object",
              properties: {
                type: { type: "string", enum: ["bars", "value", "action"] },
                title: { type: "string" },
                rows: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      label: { type: "string" },
                      value: { type: "string" },
                      pct: { type: "number" },
                      tone: { type: "string", enum: ["ok", "warn", "crit", "neutral"] },
                    },
                    required: ["label", "value", "pct"],
                  },
                },
                value: { type: "string" },
                caption: { type: "string" },
                body: { type: "string" },
                tone: { type: "string", enum: ["ok", "warn", "crit", "neutral"] },
                confirm: { type: "string" },
                dismiss: { type: "string" },
                note: { type: "string" },
              },
              required: ["type"],
            },
          },
          followups: {
            type: "array",
            description:
              "Three short questions the operator would plausibly ask next, given what you just found. Each must point somewhere genuinely different — a cause, a consequence, a gap — not a rephrasing of the question already answered. Under six words each, answerable with the tools you have. If a figure was unmeasured, one of these should be about closing that gap.",
            items: { type: "string" },
          },
        },
        required: ["blocks"],
      },
    },
  },
] as const;

/**
 * Filing today's note. Only the briefer gets this one.
 *
 * Structured output arrives through a tool rather than by parsing prose, for the
 * same reason `present` does: a malformed sentence can then never become a
 * malformed record. The difference is that here the tool payload IS the product
 * — the card renders `headline` and `body`, and anything the model writes
 * outside this call is thrown away.
 */
const WRITE_BRIEFING = {
  type: "function",
  function: {
    name: "write_briefing",
    description:
      "File today's note. Call once, last. This is the only thing that reaches the card — prose written outside this tool is discarded.",
    parameters: {
      type: "object",
      properties: {
        headline: {
          type: "string",
          description:
            "One clause, at most 60 characters, no full stop. The single thing that changed or is closest to mattering.",
        },
        body: {
          type: "string",
          description: "32 to 55 words of plain sentences. No markdown, no bullets, no headings.",
        },
        tone: {
          type: "string",
          enum: ["ok", "warn", "crit", "neutral"],
          description:
            "crit only when a measured thing runs out in under 24 hours. neutral when nothing was comparable.",
        },
        cites: {
          type: "array",
          description:
            "Every money figure and every percentage that appears in headline or body, copied character for character from a tool result.",
          items: {
            type: "object",
            properties: {
              label: { type: "string", description: "What the figure is, in three or four words." },
              value: { type: "string", description: "Exactly as the tool printed it." },
              source: {
                type: "string",
                enum: ["read_board", "read_history", "quota_status", "spend_breakdown"],
              },
            },
            required: ["label", "value", "source"],
          },
        },
      },
      required: ["headline", "body", "tone", "cites"],
    },
  },
} as const;

/**
 * What the daily briefer can do, and deliberately what it cannot.
 *
 * Named as an allow-list rather than assembled by subtraction: a tool added to
 * TOOLS later must be named here to reach the briefer, so the next write tool
 * someone gives the assistant cannot arrive on the 04:35 cron by accident.
 *
 * `sync_vendor`, `set_manual_cost` and `remove_resource` are missing on purpose.
 * A model running unattended must not be able to write — a read-only briefer
 * that is wrong is wrong for one day, a write-capable one deletes a row at 04:35
 * with nobody watching. `read_table` is missing because every column it would
 * reach is already in read_board, and `present` because the card has no blocks.
 */
const BRIEFER_CAN_READ = ["read_board", "read_history", "quota_status", "spend_breakdown"] as const;

export const BRIEFING_TOOLS = [
  ...TOOLS.filter((t) => (BRIEFER_CAN_READ as readonly string[]).includes(t.function.name)),
  WRITE_BRIEFING,
] as const;

type Args = Record<string, unknown>;

/** Blocks the model asked to render, collected across the run. */
export type Presented = unknown[] | null;

export async function runTool(
  name: string,
  args: Args,
): Promise<{
  result: unknown;
  presented?: Presented;
  followups?: string[];
  /**
   * A filed note, unverified. The caller decides whether it survives: only the
   * loop has the tool results to check its figures against, so runTool hands the
   * draft back rather than accepting it.
   */
  briefing?: BriefingDraft;
}> {
  const db = serviceClient();

  switch (name) {
    case "write_briefing": {
      const tone = String(args.tone ?? "neutral");
      const draft: BriefingDraft = {
        headline: String(args.headline ?? "").trim(),
        body: String(args.body ?? "").trim(),
        tone: (["ok", "warn", "crit", "neutral"] as const).includes(tone as "ok")
          ? (tone as BriefingDraft["tone"])
          : "neutral",
        cites: (Array.isArray(args.cites) ? args.cites : [])
          .filter((c): c is Record<string, unknown> => !!c && typeof c === "object")
          .map((c) => ({
            label: String(c.label ?? ""),
            value: String(c.value ?? ""),
            source: String(c.source ?? ""),
          })),
      };
      return {
        result: {
          ok: true,
          next: "Filed. Stop — no more tool calls, and do not repeat the note in prose.",
        },
        briefing: draft,
      };
    }

    case "read_history": {
      // Clamped rather than trusted: a model that asks for 100000 hours would
      // otherwise pull every reading the board has ever taken into one payload.
      const raw = Number(args.since_hours ?? 24);
      const hours = Number.isFinite(raw) ? Math.min(Math.max(raw, 1), 24 * 90) : 24;

      const { data: apps } = await db.from("apps").select("id, slug, name");
      const wanted = args.app
        ? (apps ?? []).filter(
            (a) =>
              a.slug === String(args.app).toLowerCase() ||
              a.name.toLowerCase() === String(args.app).toLowerCase(),
          )
        : (apps ?? []);
      if (!wanted.length) return { result: { error: `no app matching "${args.app}"` } };

      const out = [];
      for (const a of wanted) out.push(await historyFor(db, a, hours));
      return { result: out };
    }

    case "present":
      return {
        result: {
          ok: true,
          next: "Blocks attached. Now write the prose answer — no more tool calls.",
        },
        presented: (args.blocks as unknown[]) ?? [],
        followups: Array.isArray(args.followups)
          ? (args.followups as string[]).map(String).slice(0, 4)
          : undefined,
      };

    case "read_board": {
      const { data: apps } = await db.from("apps").select("id, slug, name, stack");
      const wanted = args.app
        ? (apps ?? []).filter(
            (a) =>
              a.slug === String(args.app).toLowerCase() ||
              a.name.toLowerCase() === String(args.app).toLowerCase(),
          )
        : (apps ?? []);

      const out = [];
      for (const a of wanted) {
        const { data: rows } = await db
          .from("resources")
          .select(
            "id, kind, name, vendor, unit, used, cap, reset_label, projection, projection_note, status, mtd_usd, run_rate_usd, source, is_sample",
          )
          .eq("app_id", a.id);
        const { data: conns } = await db
          .from("connections")
          .select("id, vendor, status, last_sync_at, last_error")
          .eq("app_id", a.id);

        const real = mergeCeilings(((rows ?? []) as Resource[]).filter((r) => !r.is_sample));
        out.push({
          app: a.name,
          slug: a.slug,
          stack: a.stack,
          connections: (conns ?? []).map((c) => ({
            vendor: c.vendor,
            state: connectionState(c),
            last_sync_at: c.last_sync_at,
            last_error: c.last_error,
          })),
          resources: real,
          seeded_rows_hidden: (rows ?? []).length - real.length,
        });
      }
      return { result: out };
    }

    case "quota_status": {
      const rows = await allReal(db);
      const gauges = rows.filter((r) => r.kind === "metered" && r.cap != null);
      return {
        result: {
          measured: gauges
            .filter((r) => r.used != null)
            .map((r) => ({
              name: r.name,
              vendor: r.vendor,
              used: r.used,
              cap: r.cap,
              unit: r.unit,
              pct: Math.round(((r.used ?? 0) / (r.cap ?? 1)) * 100),
              status: r.status,
              resets: r.reset_label,
              projection: r.projection,
              projection_note: r.projection_note,
            }))
            .sort((a, b) => b.pct - a.pct),
          known_but_uncounted: gauges
            .filter((r) => r.used == null)
            .map((r) => ({ name: r.name, vendor: r.vendor, cap: r.cap, unit: r.unit, resets: r.reset_label })),
        },
      };
    }

    case "spend_breakdown": {
      const rows = dedupeShared(await allReal(db));
      const cost = costMtd(rows);
      const revenue = revenueMtd(rows);
      const vendors = byVendor(rows);
      return {
        result: {
          cost_mtd_usd: cost,
          cost_mtd: usd(cost),
          revenue_mtd_usd: revenue,
          revenue_mtd: usd(revenue),
          margin_pct: revenue > 0 ? ((revenue - cost) / revenue) * 100 : null,
          by_vendor: vendors.map((v) => ({ vendor: v.vendor, usd: v.total, formatted: usd(v.total) })),
          billing_but_unmeasured: ghostVendors(rows),
          ledger_coverage: vendors
            .map((v) => ({ vendor: v.vendor, ...(coverage(rows, v.vendor) ?? {}) }))
            .filter((c) => "pct" in c),
          note:
            "One reading per vendor per bucket. A shared subscription counted under several apps is collapsed to one bill.",
        },
      };
    }

    case "read_table": {
      const table = String(args.table);
      const cols =
        table === "connections" ? "id, app_id, vendor, status, last_sync_at, last_error" : "*";
      let q = db.from(table).select(cols).limit(Number(args.limit ?? 100));
      for (const [k, v] of Object.entries((args.match as Args) ?? {})) q = q.eq(k, v as never);
      const { data, error } = await q;
      if (error) return { result: { error: error.message } };
      return { result: data };
    }

    case "sync_vendor": {
      const vendor = String(args.vendor);
      let q = db.from("connections").select("id, app_id, vendor").eq("vendor", vendor);
      if (args.app) {
        const { data: a } = await db
          .from("apps")
          .select("id")
          .eq("slug", String(args.app).toLowerCase())
          .maybeSingle();
        if (a) q = q.eq("app_id", a.id);
      }
      const { data: conns } = await q;
      if (!conns?.length) {
        return {
          result: {
            error: `no ${vendor} connection`,
            connectable: SUPPORTED_VENDORS.map((v) => v.id),
          },
        };
      }
      const results = [];
      for (const c of conns) results.push(await syncConnection(c.id));
      return { result: results };
    }

    case "set_manual_cost": {
      const { data: a } = await db
        .from("apps")
        .select("id")
        .eq("slug", String(args.app).toLowerCase())
        .maybeSingle();
      if (!a) return { result: { error: `no app with slug "${args.app}"` } };

      const { data, error } = await db
        .from("resources")
        .insert({
          app_id: a.id,
          kind: "fixed",
          name: String(args.name),
          vendor: String(args.vendor),
          // Marked as its own source so the board never mistakes a figure a
          // human stated for one a vendor reported.
          source: "manual",
          status: "neutral",
          mtd_usd: Number(args.monthly_usd),
          projection_note: args.note ? String(args.note) : null,
          is_sample: false,
        })
        .select("id")
        .single();
      if (error) return { result: { error: error.message } };
      return { result: { ok: true, id: data.id } };
    }

    case "remove_resource": {
      const { error } = await db.from("resources").delete().eq("id", String(args.id));
      return { result: error ? { error: error.message } : { ok: true } };
    }

    default:
      return { result: { error: `no tool named ${name}` } };
  }
}

type Db = ReturnType<typeof serviceClient>;

/**
 * The console's clock. Istanbul is UTC+3 with no DST since 2016, so there is not
 * even a twice-yearly hour to reason about.
 *
 * It lives here rather than in lib/briefing because lib/briefing imports this
 * file, and putting the shared helper the other way round would make a cycle out
 * of a two-line function. Exported so there is exactly one definition of what
 * time this console thinks it is.
 */
export const CONSOLE_TZ = "Europe/Istanbul";

/**
 * A stored timestamp as the board would show it.
 *
 * Readings are stored in UTC and a model asked for "since yesterday" will
 * happily read 09:05Z off the wire and write "09:05 today" onto a card whose own
 * footer says 12:05 — which is not a wrong number so much as a number about the
 * wrong clock, and the operator has no way to tell from the card. So the tool
 * does the conversion and the model quotes it.
 */
export function localStamp(iso: string | null): string | null {
  if (!iso) return null;
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return null;
  const f = new Intl.DateTimeFormat("en-GB", {
    timeZone: CONSOLE_TZ,
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  return `${f.format(at)} Istanbul time`;
}

type HistoryPoint = {
  at: string;
  /** The same instant on the console's clock, so nobody has to convert it. */
  at_local: string | null;
  used: number | null;
  mtd_usd: number | null;
  /**
   * The same two figures as the board prints them. Both forms are here because
   * they are for different readers: the raw float is what arithmetic needs, and
   * the formatted twin is what fits on a card. A model handed only the float
   * writes "1.237133225" into a sentence, which is true and unreadable.
   */
  used_formatted: string | null;
  mtd_usd_formatted: string | null;
};

const RESOURCE_COLS =
  "id, kind, name, vendor, unit, used, cap, reset_label, projection, projection_note, status, mtd_usd, run_rate_usd, source, is_sample";

/**
 * One app's history, per (vendor, name) series, with the edges named.
 *
 * The whole point of the tool is the second half of each series: not just what
 * moved, but whether the question "what moved?" can be answered at all. A window
 * holding one reading has no delta, and a console that filled that in from a
 * single sample would be inventing the rate it claims to measure.
 */
async function historyFor(db: Db, app: { id: string; slug: string; name: string }, hours: number) {
  const cutoff = Date.now() - hours * 3_600_000;
  const series = await seriesFor(app.id, hours / 24);

  const { data: rowData } = await db.from("resources").select(RESOURCE_COLS).eq("app_id", app.id);
  const rows = (rowData ?? []) as Resource[];

  // `counted` is recomputed from TODAY's rows and applied backwards. `readings`
  // never stored `source`, so lib/money's one-winner-per-vendor-per-bucket rule
  // cannot be reconstructed from history alone; adding the column now would
  // leave every existing row null and still could not classify a series whose
  // resource has since been deleted. Deciding the winner on today's evidence is
  // the honest version of an unanswerable question.
  const countedKeys = new Set(counted(rows).map((r) => `${r.vendor}|${r.name}`));
  const current = new Map(rows.map((r) => [`${r.vendor}|${r.name}`, r]));

  const { data: oldest } = await db
    .from("readings")
    .select("taken_at")
    .eq("app_id", app.id)
    .order("taken_at")
    .limit(1);
  const recordingSince: string | null = oldest?.[0]?.taken_at ?? null;
  const recordingSinceLocal = localStamp(recordingSince);

  // A sync round runs one insert per connector, each in its own transaction, so
  // six vendors land on six distinct taken_at values seconds apart. Counting
  // those as six syncs would overstate how often the board has actually been
  // read. Ten minutes is far longer than a round takes and far shorter than the
  // hourly cron, so it separates rounds without ever splitting one.
  const stamps = [...series.values()]
    .flat()
    .map((h) => Date.parse(h.taken_at))
    .filter((t) => t >= cutoff)
    .sort((a, b) => a - b);
  let syncs = 0;
  let previous = -Infinity;
  for (const t of stamps) {
    if (t - previous > 600_000) syncs++;
    previous = t;
  }

  const keys = new Set(series.keys());
  // A counted cost with nothing in history still has to appear as a series, or
  // the total below could exclude the one row nobody archives and still call
  // itself complete.
  for (const k of countedKeys) keys.add(k);

  const built = [...keys].sort().map((key) => {
    const res = current.get(key) ?? null;
    const cut = key.indexOf("|");
    const vendor = res?.vendor ?? key.slice(0, cut);
    const name = res?.name ?? key.slice(cut + 1);
    const kind = res?.kind ?? "unknown";

    const all = series.get(key) ?? [];
    // A metered row's number is its counter; everything else carries money.
    const metered = res ? res.kind === "metered" : all.some((h) => h.used != null);
    const pick = (h: Reading) => (metered ? h.used : h.mtd_usd);
    const points = all.filter((h) => Date.parse(h.taken_at) >= cutoff && pick(h) != null);

    // A metered counter is only money when it is denominated in it — fal's
    // credit pot is USD, YouTube's units are not.
    const money = !metered || res?.unit === "USD";
    const fmt = (n: number) => (money ? usd(n) : n.toLocaleString("en-US"));

    const at = (h: Reading): HistoryPoint => ({
      at: h.taken_at,
      at_local: localStamp(h.taken_at),
      used: h.used,
      mtd_usd: h.mtd_usd,
      used_formatted: h.used == null ? null : fmt(h.used),
      mtd_usd_formatted: h.mtd_usd == null ? null : usd(h.mtd_usd),
    });
    const first = points.length ? at(points[0]) : null;
    const last = points.length ? at(points[points.length - 1]) : null;
    const spanHours = first && last ? (Date.parse(last.at) - Date.parse(first.at)) / 3_600_000 : 0;

    // Detect the reset; do not try to classify it. `reset_label` is advisory at
    // best — fal's row says "does not reset · top-up" while the column it
    // describes is month-to-date — so the rule is simply that a cumulative
    // counter which went down was reset or restated, and either way the
    // difference is not spend. Widened past the metered/usage pair to revenue,
    // because month-to-date revenue rolls over on the 1st exactly as spend does
    // and "revenue fell" every month-start would be the same lie about money.
    const cumulative = kind === "metered" || kind === "usage" || kind === "revenue";
    const monotonicBreak =
      cumulative && points.length >= 2 && (pick(points[points.length - 1]) ?? 0) < (pick(points[0]) ?? 0);

    let comparable = true;
    let reason: string | null = null;
    const fail = (why: string) => {
      comparable = false;
      reason ??= why;
    };

    if (!res) fail("no longer on the board");
    if (points.length < 2) {
      fail(
        points.length === 0
          ? recordingSinceLocal
            ? `nothing has archived this series in this window; the board has been recording since ${recordingSinceLocal}`
            : "nothing has ever archived this series"
          : `only one reading in this window; the board has been recording since ${recordingSinceLocal}`,
      );
    } else if (spanHours < 0.5) {
      fail(
        `both readings fall inside ${Math.round(spanHours * 60)} minutes, which is not long enough to read a rate from`,
      );
    }
    if (monotonicBreak) {
      fail(
        `the counter reset inside this window (${res?.reset_label ?? "no reset label on the row"}); the drop is not a saving`,
      );
    }
    if (kind === "revenue" && /trailing/i.test(res?.reset_label ?? "")) {
      fail(`${res?.reset_label} — a trailing window, so its change is not what was earned yesterday`);
    }

    // Withheld when the comparison is disqualified: handing over the raw
    // difference alongside the reason not to use it is an invitation to use it.
    const delta =
      comparable && first && last ? (pick(points[points.length - 1]) as number) - (pick(points[0]) as number) : null;

    return {
      vendor,
      name,
      kind,
      source: res?.source ?? null,
      counted: countedKeys.has(key),
      reset_label: res?.reset_label ?? null,
      readings_in_window: points.length,
      first,
      last,
      comparable,
      reason,
      monotonic_break: monotonicBreak,
      delta,
      delta_formatted: delta == null ? null : fmt(delta),
      // Scaling four hours up to a day would report a rate nobody observed.
      per_day_formatted: delta == null || spanHours < 12 ? null : fmt((delta / spanHours) * 24),
    };
  });

  // A fixed cost that did not move is not news; a fixed cost that DID move is a
  // seat someone added, which is. So the unchanged ones are named and dropped
  // rather than itemised, and the moved ones stay as full series.
  const quiet = built.filter((s) => s.kind === "fixed" && s.delta === 0);
  const quietKeys = new Set(quiet.map((s) => `${s.vendor}|${s.name}`));

  const countedSeries = built.filter((s) => s.counted);
  const missing = countedSeries.filter((s) => !s.comparable);
  // A partial total is how you publish a wrong total. If even one counted series
  // could not be compared there is no figure here, and the note says which ones
  // were missing instead of quietly summing the rest.
  const sum = countedSeries.reduce((t, s) => t + (s.delta ?? 0), 0);
  const complete = countedSeries.length > 0 && missing.length === 0;

  const { data: mine } = await db
    .from("briefings")
    .select("cost_usd")
    .eq("app_id", app.id)
    .gte("generated_at", new Date(cutoff).toISOString());
  const costs = (mine ?? []).map((b) => b.cost_usd).filter((c): c is number => c != null);
  const selfCost = (mine ?? []).length === 0 ? 0 : costs.length ? costs.reduce((a, b) => a + b, 0) : null;

  return {
    app: app.name,
    slug: app.slug,
    window_hours: hours,
    recording_since: recordingSince,
    recording_since_local: recordingSinceLocal,
    syncs_in_window: syncs,
    series: built.filter((s) => !quietKeys.has(`${s.vendor}|${s.name}`)),
    fixed_unchanged: quiet.map((s) => `${s.vendor} · ${s.name}`),
    counted_cost_delta: complete ? { usd: sum, formatted: usd(sum) } : null,
    counted_cost_delta_note: !countedSeries.length
      ? "no counted cost series for this app, so there is no total"
      : complete
        ? `every one of the ${countedSeries.length} counted series had two readings, so this total is complete`
        : `${missing.length} of ${countedSeries.length} counted series had no comparison, so there is no total: ${missing
            .map((s) => `${s.vendor} · ${s.name}`)
            .join(", ")}`,
    // The briefing is itself a line item on fal's invoice, so a note reporting
    // that fal spend rose could be reporting its own previous run. This is how
    // it subtracts itself.
    self: {
      briefings_in_window: (mine ?? []).length,
      cost_usd: selfCost,
      formatted: usd(selfCost),
    },
  };
}

async function allReal(db: ReturnType<typeof serviceClient>): Promise<Resource[]> {
  const { data } = await db
    .from("resources")
    .select(
      "id, kind, name, vendor, unit, used, cap, reset_label, projection, projection_note, status, mtd_usd, run_rate_usd, source, is_sample",
    );
  // Same join the board applies. Without it the model would report a ceiling
  // twice — once with a limit and no reading, once with a reading and no limit.
  return mergeCeilings(((data ?? []) as Resource[]).filter((r) => !r.is_sample));
}
