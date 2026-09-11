import { listApps } from "@/lib/apps";
import { Board } from "./board";

// The board reflects a table that changes when the operator adds an app, so it
// must not be statically cached at build time.
export const dynamic = "force-dynamic";

export default async function Page() {
  const apps = await listApps();
  return <Board apps={apps} />;
}
