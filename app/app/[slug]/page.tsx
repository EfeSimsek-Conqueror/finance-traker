import { notFound } from "next/navigation";
import { getApp, listConnections, listResources } from "@/lib/apps";
import { enrich, seriesFor } from "@/lib/readings";
import { applyJudgements, judgeSpend } from "@/lib/status";
import { loadThresholds } from "@/lib/settings";
import { costMtd, mergeCeilings } from "@/lib/money";
import { PanelAware } from "../../panel-aware";
import { ResourceBoard } from "../../resource-board";

export const dynamic = "force-dynamic";

/**
 * Costs this portfolio knows it has and cannot read.
 *
 * Stated here rather than derived, because that is what they are: facts someone
 * established by looking, which no connector will ever report. Leaving them off
 * the board would make the totals look complete when they are not — and a
 * console that quietly rounds its own blind spots to zero is the failure mode
 * everything else here is built to avoid.
 */
const KNOWN_GAPS = [
  { name: "Google spend", need: "needs a billing account on the project" },
  { name: "Supabase", need: "needs a management token" },
  { name: "Railway analyzer", need: "no connector written" },
  { name: "Stripe live revenue", need: "the key in use is test mode" },
  { name: "Search quota burn", need: "ceiling known, nothing counts against it" },
];

export default async function Page({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const app = await getApp(slug);
  if (!app) notFound();

  const [resources, connections, series, thresholds] = await Promise.all([
    listResources(app.id),
    listConnections(app.id),
    seriesFor(app.id),
    loadThresholds(),
  ]);

  // Colour is decided once, here, from thresholds an operator can retune — not
  // by each connector's private opinion of what counts as trouble.
  // Two connectors describe each YouTube sub-ceiling — Google the limit, the
  // app's call log the usage — so they are merged before anything judges them.
  const { rows, judgements } = applyJudgements(
    mergeCeilings(enrich(resources, series)),
    series,
    thresholds,
  );
  const spend = judgeSpend(costMtd(rows.filter((r) => !r.is_sample)), app.budget_usd, thresholds);

  return (
    <PanelAware>
      <ResourceBoard
        app={app}
        resources={rows}
        connections={connections}
        judgements={judgements}
        spend={spend}
        gaps={KNOWN_GAPS}
      />
    </PanelAware>
  );
}
