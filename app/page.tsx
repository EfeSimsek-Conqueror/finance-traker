import { listApps } from "@/lib/apps";
import { loadThresholds } from "@/lib/settings";
import { portfolioCost, summarise } from "@/lib/portfolio";
import { Board } from "./board";

// The board reflects a table that changes when the operator adds an app, so it
// must not be statically cached at build time.
export const dynamic = "force-dynamic";

export default async function Page() {
  const apps = await listApps();
  // Every tile speaks from its own rows. The map used to print the same three
  // literals under each app regardless of what had been measured.
  const [thresholds] = await Promise.all([loadThresholds()]);
  const [summaries, cost] = await Promise.all([summarise(apps, thresholds), portfolioCost(apps)]);
  return <Board apps={apps} summaries={summaries} portfolioCost={cost.label} />;
}
