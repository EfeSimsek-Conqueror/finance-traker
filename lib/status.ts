import type { Resource } from "@/lib/apps";

/**
 * The shape this module needs from a history row, declared locally rather than
 * imported: lib/readings imports the rate function from here, and taking its
 * type back would close a cycle for no benefit. Structural typing means a
 * Reading satisfies this already.
 */
type Sample = { used: number | null; taken_at: string };

/**
 * Where green and red come from.
 *
 * Colour used to be whatever each connector felt like writing: fal called a
 * balance critical under fourteen days, the ledger called a quota critical at
 * ninety per cent, and Google's connector had no opinion at all. Three vendors,
 * three definitions of trouble, one screen. Judgement belongs in one place,
 * driven by numbers an operator can change without a deploy.
 */
export type Tone = "ok" | "warn" | "crit" | "neutral" | "unknown";

export type Thresholds = {
  ceiling_crit_hours: number;
  ceiling_warn_hours: number;
  ceiling_crit_pct: number;
  ceiling_warn_pct: number;
  budget_crit_pct: number;
  budget_warn_pct: number;
};

export const DEFAULT_THRESHOLDS: Thresholds = {
  ceiling_crit_hours: 24,
  ceiling_warn_hours: 72,
  ceiling_crit_pct: 90,
  ceiling_warn_pct: 75,
  budget_crit_pct: 100,
  budget_warn_pct: 80,
};

/**
 * One rendering of a percentage, shared with the board.
 *
 * 143 of 50,000 is 0.286%. Rounded it becomes "0%", which reads as "nothing
 * measured" directly beneath a gauge showing 0.3% — the same number printed two
 * ways, three lines apart, on a screen whose whole claim is internal
 * consistency.
 */
export const pctLabel = (pct: number) =>
  pct > 0 && pct < 1 ? `${pct.toFixed(1)}%` : `${Math.round(pct)}%`;

/** A colour and the sentence that earned it. */
export type Judgement = { tone: Tone; why: string };

/**
 * Consumption per hour, from the ends of the window.
 *
 * The ends rather than a fitted line: these are cumulative counters, so the
 * first and last reading already contain everything that happened between them,
 * and a regression would only add sensitivity to sampling jitter.
 */
export function ratePerHour(series: Sample[]): { perHour: number; overHours: number } | null {
  const points = series.filter((p) => p.used != null);
  if (points.length < 2) return null;

  const first = points[0];
  const last = points[points.length - 1];
  const overHours = (Date.parse(last.taken_at) - Date.parse(first.taken_at)) / 3_600_000;
  // Two samples minutes apart describe noise, not a rate.
  if (overHours < 0.5) return null;

  return { perHour: ((last.used as number) - (first.used as number)) / overHours, overHours };
}

/**
 * Judge a ceiling.
 *
 * Time first, fullness only as a fallback. Fullness on its own is a bad signal
 * and the reason is the calendar: eighty per cent of a monthly quota is alarming
 * on the third and unremarkable on the twenty-ninth. What an operator can act on
 * is how long they have.
 */
export function judgeCeiling(
  r: Resource,
  series: Sample[],
  t: Thresholds,
  now = Date.now(),
): Judgement {
  if (r.cap == null) return { tone: "neutral", why: "no ceiling recorded" };

  // A limit nobody counts against cannot be green. Green is a claim, and the
  // claim here would be "we checked" — which is the one thing that did not
  // happen.
  if (r.used == null) {
    return { tone: "unknown", why: "known limit, no counter — nothing measures this" };
  }

  const pct = (r.used / r.cap) * 100;
  const rate = ratePerHour(series);

  if (rate && rate.perHour > 0) {
    const hoursLeft = (r.cap - r.used) / rate.perHour;

    // The decisive case, and the one a pure percentage gets wrong: a daily quota
    // sitting at 92% at eleven at night is not in trouble, because it refills
    // before the pace could finish it. Colouring that red teaches people to
    // ignore red.
    if (r.resets_at) {
      const hoursToReset = (Date.parse(r.resets_at) - now) / 3_600_000;
      if (hoursToReset > 0 && hoursLeft > hoursToReset) {
        return { tone: "ok", why: `refills in ${short(hoursToReset)}, before this pace could finish it` };
      }
    }

    if (hoursLeft <= t.ceiling_crit_hours) {
      return { tone: "crit", why: `${short(hoursLeft)} left at the measured pace` };
    }
    if (hoursLeft <= t.ceiling_warn_hours) {
      return { tone: "warn", why: `${short(hoursLeft)} left at the measured pace` };
    }
    return { tone: "ok", why: `${short(hoursLeft)} left at the measured pace` };
  }

  if (rate && rate.perHour <= 0) {
    return { tone: "ok", why: `flat or falling over the last ${short(rate.overHours)}` };
  }

  // One reading. Fullness is all there is, and it is said as such.
  if (pct >= t.ceiling_crit_pct) {
    return { tone: "crit", why: `${pctLabel(pct)} used, and no second reading to project from` };
  }
  if (pct >= t.ceiling_warn_pct) {
    return { tone: "warn", why: `${pctLabel(pct)} used, and no second reading to project from` };
  }
  // "Idle" is the finding when a counter exists and has barely moved; it is not
  // the same as having no counter, and the wording has to keep them apart.
  return {
    tone: "ok",
    why: pct < 1 ? `${pctLabel(pct)} used · idle since recording started` : `${pctLabel(pct)} used`,
  };
}

/**
 * Judge spend against a budget.
 *
 * With no budget set there is no such thing as overspending, and the honest
 * colour is none at all — a green that means "we have no idea" is the worst
 * kind.
 */
export function judgeSpend(spentUsd: number, budgetUsd: number | null, t: Thresholds): Judgement {
  if (budgetUsd == null || budgetUsd <= 0) {
    return { tone: "neutral", why: "no budget set, so there is nothing to be over" };
  }
  const pct = (spentUsd / budgetUsd) * 100;
  if (pct >= t.budget_crit_pct) return { tone: "crit", why: `${Math.round(pct)}% of the monthly budget` };
  if (pct >= t.budget_warn_pct) return { tone: "warn", why: `${Math.round(pct)}% of the monthly budget` };
  return { tone: "ok", why: `${Math.round(pct)}% of the monthly budget` };
}

/** Money in versus money out. The one place where green needs no threshold. */
export function judgeContribution(revenueUsd: number, costUsd: number): Judgement {
  if (revenueUsd <= 0) {
    return { tone: "neutral", why: "no revenue measured, so margin cannot be drawn" };
  }
  const contribution = revenueUsd - costUsd;
  return contribution >= 0
    ? { tone: "ok", why: `${Math.round((contribution / revenueUsd) * 100)}% margin` }
    : { tone: "crit", why: "cost exceeds revenue" };
}

const short = (h: number) =>
  h < 1 ? `${Math.round(h * 60)}m` : h < 48 ? `${Math.round(h)}h` : `${Math.round(h / 24)} days`;

/**
 * Replace each row's connector-written status with a judged one.
 *
 * Done here rather than threaded through the board as a prop because the board
 * reads `r.status` in a dozen places — the rail, the band dot, the gauge, the
 * alert strip. Deciding it once, upstream, means every one of those becomes
 * threshold-driven without a component knowing that anything changed.
 *
 * `why` is only allowed to replace a note the row does not already have. Where
 * history produced a projection, its wording is more specific than a judgement
 * summary and overwriting it would lose detail.
 */
export function applyJudgements<T extends Resource>(
  rows: T[],
  series: Map<string, { used: number | null; taken_at: string }[]>,
  t: Thresholds,
  now = Date.now(),
): { rows: T[]; judgements: Record<string, Judgement> } {
  const judgements: Record<string, Judgement> = {};
  const out = rows.map((r) => {
    if (r.kind !== "metered") return r;
    const j = judgeCeiling(r, series.get(`${r.vendor}|${r.name}`) ?? [], t, now);
    judgements[r.id] = j;
    const noProjection = !r.projection || /no projection/i.test(r.projection);

    // The projection has to agree with the colour, and it did not.
    //
    // judgeCeiling knows about resets_at; the connector's own projection does
    // not. A daily quota that refills in three hours at a pace that would take
    // five is judged `ok` — and rendered a green rail beside 36px of green type
    // reading "runs out 14:00 today", which is the card contradicting itself
    // in one glance. Where the judgement disagrees, the judgement wins: it is
    // the one that looked at the reset.
    const contradicts =
      j.tone === "ok" && !!r.projection && /^runs out/i.test(r.projection) && !!r.resets_at;

    return {
      ...r,
      status: j.tone,
      projection: contradicts ? "refills first" : r.projection,
      projection_note: noProjection || contradicts ? j.why : r.projection_note,
    };
  });
  return { rows: out, judgements };
}
