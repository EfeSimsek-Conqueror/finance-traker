"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import type { App, AppSummary } from "@/lib/apps";
import { usd } from "@/lib/money";
import { Canvas, usePanel } from "./canvas";

const TILE = 300;
const GAP = 140;

/**
 * The portfolio map — every app in the studio, laid out spatially.
 *
 * Spatial rather than a sorted list because you learn where things are and
 * glance at the same corner every morning. A sorted table would reshuffle
 * itself the moment a number moves, which is exactly when you least want the
 * screen to change shape.
 */
const TONE: Record<string, string> = {
  ok: "#5FA777",
  warn: "#C8894F",
  crit: "#D97757",
  neutral: "#4A413C",
};

export function Board({
  apps,
  summaries,
  portfolioCost,
}: {
  apps: App[];
  summaries: Record<string, AppSummary>;
  /** Deduped across apps — the tiles do not add up to this, on purpose. */
  portfolioCost: string;
}) {
  const [adding, setAdding] = useState(false);

  const addX = apps.length ? Math.max(...apps.map((a) => a.x)) + TILE + GAP : 160;
  const addY = apps.length ? Math.min(...apps.map((a) => a.y)) : 200;

  const xs = [...apps.map((a) => a.x), addX];
  const ys = [...apps.map((a) => a.y), addY];
  const bounds = {
    minX: Math.min(...xs),
    minY: Math.min(...ys),
    maxX: Math.max(...xs) + TILE,
    // +90 for the name and revenue line that hang below each tile.
    maxY: Math.max(...ys) + TILE + 90,
  };

  return (
    <>
      <Canvas
        bounds={bounds}
        chrome={
          <>
            <AttentionStrip summaries={summaries} portfolioCost={portfolioCost} />
          </>
        }
      >
        {apps.map((a) => (
          <Tile key={a.id} app={a} s={summaries[a.id]} />
        ))}
        <AddTile x={addX} y={addY} onClick={() => setAdding(true)} />
      </Canvas>
      {adding && <AddDialog onClose={() => setAdding(false)} />}
    </>
  );
}

/**
 * The 24-hour attention strip.
 *
 * Red and loud when something is about to run out, quiet otherwise. Most days
 * it will be quiet, and a quiet day has to look deliberate rather than broken —
 * a strip that always shouts stops being read.
 */
/**
 * The only way back to the panel from here.
 *
 * The resource board carries this control in its header; the map is a canvas
 * with no header, so it lives in the strip. Without one of these on every
 * screen, closing the assistant would be one-way — the shortcut alone is not
 * discoverable enough to be the only route.
 */
function AssistantToggle() {
  const { open, toggle } = usePanel();
  return (
    <button
      onClick={toggle}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 9,
        padding: "6px 11px",
        border: "1px solid #322b28",
        borderRadius: 8,
        background: "#1D1917",
        color: "#E5DDD5",
        fontFamily: "inherit",
        fontSize: 12,
        cursor: "pointer",
      }}
    >
      <span
        style={{
          width: 16,
          height: 16,
          borderRadius: 5,
          background: "#D97757",
          color: "#1A1210",
          display: "grid",
          placeItems: "center",
          fontSize: 9,
        }}
      >
        ◈
      </span>
      {open ? "Close assistant" : "Assistant"}
      <span style={{ fontFamily: "var(--mono)", fontSize: 11, color: "#7C726B" }}>⌥A</span>
    </button>
  );
}

/** How long ago, in the least precise unit that is still useful. */
function ago(iso: string): string {
  const mins = Math.round((Date.now() - Date.parse(iso)) / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  return hours < 48 ? `${hours}h ago` : `${Math.round(hours / 24)} days ago`;
}

function AttentionStrip({
  summaries,
  portfolioCost,
}: {
  summaries: Record<string, AppSummary>;
  portfolioCost: string;
}) {
  const all = Object.values(summaries);
  const near = all.reduce((t, s) => t + s.nearLimit, 0);
  const unmeasured = all.reduce((t, s) => t + s.unmeasured, 0);
  const broken = all.reduce((t, s) => t + s.errored + s.stale, 0);
  const measured = all.reduce((t, s) => t + s.measuredRows, 0);

  const line = near
    ? `${near} ceiling${near === 1 ? "" : "s"} near a limit`
    : broken
      ? `${broken} connector${broken === 1 ? "" : "s"} not reporting now`
      : measured
        ? `nothing near a limit · ${unmeasured} vendor${unmeasured === 1 ? "" : "s"} still unmeasured`
        : "nothing measured — connect a vendor to start projecting";

  const tone = near ? "#D97757" : broken ? "#C8894F" : measured ? "#5FA777" : "#4A413C";

  return <Strip line={line} tone={tone} total={measured ? portfolioCost : null} />;
}

function Strip({ line, tone, total }: { line: string; tone: string; total: string | null }) {
  return (
    <div
      data-chrome="1"
      style={{
        position: "absolute",
        top: 0,
        left: 0,
        right: 0,
        height: 46,
        display: "flex",
        alignItems: "center",
        gap: 12,
        padding: "0 22px",
        background: "rgba(20,17,16,.93)",
        borderBottom: "1px solid #262120",
        backdropFilter: "blur(8px)",
        zIndex: 10,
      }}
    >
      {/* The name sits where a name sits — first. The alert reads as a state
          of this thing rather than as the thing itself, which is what putting
          it on the left used to imply. */}
      <span
        style={{
          fontSize: 12.5,
          fontWeight: 700,
          letterSpacing: ".2em",
          textTransform: "uppercase",
          color: "#B5ABA3",
        }}
      >
        Cloudgeng Finance Tracker
      </span>
      <span style={{ width: 1, height: 16, background: "#2A2523", margin: "0 6px" }} />
      <span style={{ width: 8, height: 8, borderRadius: "50%", background: tone }} />
      <span
        style={{
          fontFamily: "var(--mono)",
          fontSize: 12,
          letterSpacing: ".16em",
          textTransform: "uppercase",
          color: "#7C726B",
        }}
      >
        Runs out &lt; 24h
      </span>
      <span style={{ fontSize: 13, color: "#6E645D" }}>{line}</span>
      {total && (
        <>
          <span style={{ width: 1, height: 16, background: "#2A2523", margin: "0 4px" }} />
          <span style={{ fontFamily: "var(--mono)", fontSize: 13, color: "#B5ABA3" }}>
            {total} this month
          </span>
          <span style={{ fontSize: 12, color: "#6E645D" }}>
            portfolio-wide · shared bills counted once
          </span>
        </>
      )}
      <span style={{ flex: 1 }} />
      <AssistantToggle />
    </div>
  );
}

function Tile({ app, s }: { app: App; s?: AppSummary }) {
  return (
    <Link
      href={`/app/${app.slug}`}
      data-tile="1"
      style={{
        position: "absolute",
        left: app.x,
        top: app.y,
        width: TILE,
        textDecoration: "none",
      }}
    >
      <div
        style={{
          width: TILE,
          height: TILE,
          borderRadius: 34,
          // A filled logo needs no frame — the rim would read as a seam around
          // the artwork. Only the empty (logo-less) tile keeps its border.
          border: app.logo_url ? "none" : "1px solid #22364f",
          background: app.logo_url
            ? "transparent"
            : "linear-gradient(160deg,#111d31,#0b1220 65%,#0a1017)",
          boxShadow: "0 30px 60px -24px rgba(0,0,0,.95)",
          position: "relative",
          display: "grid",
          placeItems: "center",
          overflow: "hidden",
          cursor: "pointer",
        }}
      >
        {!app.logo_url && (
          <div
            style={{
              position: "absolute",
              inset: 0,
              backgroundImage:
                "repeating-linear-gradient(0deg,#132646 0 1px,transparent 1px 44px)," +
                "repeating-linear-gradient(90deg,#132646 0 1px,transparent 1px 44px)",
              opacity: 0.7,
            }}
          />
        )}
        {app.logo_url ? (
          <>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={app.logo_url}
              alt=""
              style={{
                position: "absolute",
                inset: 0,
                width: "100%",
                height: "100%",
                objectFit: "cover",
              }}
            />
            {/* Scrims. App icons are as often cream as they are black, so the
                status line and the numbers need their own contrast rather than
                trusting whatever the logo happens to be. */}
            <div
              style={{
                position: "absolute",
                inset: 0,
                background:
                  "linear-gradient(180deg,rgba(0,0,0,.74) 0%,rgba(0,0,0,0) 28%," +
                  "rgba(0,0,0,0) 66%,rgba(0,0,0,.8) 100%)",
              }}
            />
          </>
        ) : (
          <div
            style={{
              fontFamily: "var(--mono)",
              fontSize: 104,
              fontWeight: 600,
              letterSpacing: "-.04em",
              color: "#2b3a52",
              position: "relative",
            }}
          >
            {app.name.charAt(0).toUpperCase()}
          </div>
        )}

        <div
          style={{
            position: "absolute",
            top: 18,
            left: 18,
            right: 18,
            display: "flex",
            alignItems: "center",
            gap: 7,
            zIndex: 1,
          }}
        >
          {/* The dot is the worst tone across this app's ceilings, and grey
              still means nothing has been measured — which is now a fact about
              the rows rather than a string. */}
          <span
            style={{
              width: 7,
              height: 7,
              borderRadius: "50%",
              background: TONE[s?.tone ?? "neutral"],
            }}
          />
          <span
            style={{
              fontFamily: "var(--mono)",
              fontSize: 10.5,
              fontWeight: 600,
              letterSpacing: ".13em",
              textTransform: "uppercase",
              color: "#c3ccd6",
            }}
          >
            {!s || s.measuredRows === 0
              ? "no data"
              : s.errored
                ? `${s.errored} error`
                : s.stale
                  ? `${s.stale} stale`
                  : `${s.connected} live`}
          </span>
          <span style={{ flex: 1 }} />
          <span style={{ fontFamily: "var(--mono)", fontSize: 11, color: "#9aa7b4" }}>
            {s && s.nearLimit > 0
              ? `${s.nearLimit} near limit`
              : s && s.measuredRows
                ? `${s.measuredRows} row${s.measuredRows === 1 ? "" : "s"}`
                : ""}
          </span>
        </div>

        <div
          style={{
            position: "absolute",
            bottom: 16,
            left: 18,
            right: 18,
            display: "flex",
            alignItems: "baseline",
            justifyContent: "space-between",
            fontFamily: "var(--mono)",
            zIndex: 1,
          }}
        >
          {/* Cost, and revenue beside it. A dash where revenue is unmeasured,
              never $0.00 — the tile cannot tell you a figure nobody read. */}
          <span style={{ fontSize: 20, fontWeight: 600, color: "#c9d7e8" }}>
            {s ? usd(s.costMtd) : "—"}
          </span>
          <span style={{ fontSize: 13, color: "#8fa3ba" }}>
            {s?.revenueMtd == null ? "—" : usd(s.revenueMtd)}
          </span>
        </div>
      </div>

      <div
        style={{
          marginTop: 14,
          fontSize: 24,
          fontWeight: 700,
          letterSpacing: ".09em",
          textTransform: "uppercase",
          lineHeight: 1.1,
          color: "#e4ecf7",
        }}
      >
        {app.name}
      </div>
      <div
        style={{
          marginTop: 5,
          fontFamily: "var(--mono)",
          fontSize: 12.5,
          color: s?.unmeasured ? "#C8894F" : "#7C726B",
        }}
      >
        {/* Says what is missing rather than claiming nothing exists. A vendor
            that bills without reporting makes the cost above a floor, and that
            belongs on the tile where the figure is. */}
        {!s || s.measuredRows === 0
          ? "nothing measured yet"
          : s.unmeasured
            ? `${s.unmeasured} vendor${s.unmeasured === 1 ? "" : "s"} unmeasured`
            : s.lastSync
              ? `synced ${ago(s.lastSync)}`
              : "never synced"}
      </div>
    </Link>
  );
}

function AddTile({ x, y, onClick }: { x: number; y: number; onClick: () => void }) {
  return (
    <div data-tile="1" style={{ position: "absolute", left: x, top: y, width: TILE }}>
      <button
        onClick={onClick}
        style={{
          width: TILE,
          height: TILE,
          borderRadius: 34,
          border: "1px dashed #22364f",
          background: "transparent",
          display: "grid",
          placeItems: "center",
          cursor: "pointer",
          color: "#33455f",
          fontSize: 76,
          fontWeight: 200,
          lineHeight: 1,
          fontFamily: "var(--mono)",
        }}
      >
        +
      </button>
      <div
        style={{
          marginTop: 14,
          fontSize: 24,
          fontWeight: 700,
          letterSpacing: ".09em",
          textTransform: "uppercase",
          color: "#33455f",
        }}
      >
        Add app
      </div>
    </div>
  );
}

function AddDialog({ onClose }: { onClose: () => void }) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    if (!name.trim()) return;
    setBusy(true);
    setError(null);
    const body = new FormData();
    body.set("name", name.trim());
    if (file) body.set("logo", file);

    const res = await fetch("/api/apps", { method: "POST", body });
    if (res.ok) {
      // Straight into the new app rather than back to the board. A tile with
      // nothing behind it is half an answer — the next thing to do is always
      // to attach something that reports, and that lives on the app's page.
      const { slug } = await res.json();
      router.push(`/app/${slug}`);
      return;
    }
    setError((await res.json().catch(() => ({}))).error ?? "could not add");
    setBusy(false);
  }

  return (
    <div
      data-chrome="1"
      onMouseDown={(e) => e.stopPropagation()}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,.72)",
        display: "grid",
        placeItems: "center",
        zIndex: 50,
      }}
    >
      <div
        style={{
          width: 460,
          borderRadius: 28,
          border: "1px solid #22364f",
          background: "linear-gradient(160deg,#111d31,#0a1220)",
          padding: 28,
        }}
      >
        <div
          style={{
            fontSize: 22,
            fontWeight: 700,
            letterSpacing: ".07em",
            textTransform: "uppercase",
            color: "#e4ecf7",
          }}
        >
          Add app
        </div>

        <label style={labelStyle}>Name</label>
        <input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="FitRater"
          style={inputStyle}
        />

        <label style={labelStyle}>Logo</label>
        <input
          type="file"
          accept="image/png,image/jpeg,image/svg+xml,image/webp"
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          style={{ ...inputStyle, padding: 10, fontSize: 13 }}
        />

        {error && <div style={{ marginTop: 14, color: "#f85149", fontSize: 13 }}>{error}</div>}

        <div style={{ display: "flex", gap: 10, marginTop: 24, justifyContent: "flex-end" }}>
          <button onClick={onClose} style={{ ...btnStyle, color: "#7c93ad" }}>
            Cancel
          </button>
          <button
            onClick={submit}
            disabled={busy || !name.trim()}
            style={{
              ...btnStyle,
              background: "#f0f2f5",
              color: "#05070a",
              opacity: busy || !name.trim() ? 0.5 : 1,
            }}
          >
            {busy ? "Adding…" : "Add"}
          </button>
        </div>
      </div>
    </div>
  );
}

const labelStyle: React.CSSProperties = {
  display: "block",
  marginTop: 22,
  marginBottom: 8,
  fontSize: 12,
  letterSpacing: ".13em",
  textTransform: "uppercase",
  color: "#55667d",
};

const inputStyle: React.CSSProperties = {
  width: "100%",
  borderRadius: 10,
  border: "1px solid #1e3050",
  background: "#0a1220",
  color: "#e4ecf7",
  padding: "12px 14px",
  fontSize: 15,
  outline: "none",
};

const btnStyle: React.CSSProperties = {
  borderRadius: 10,
  border: "1px solid #22364f",
  background: "transparent",
  padding: "10px 18px",
  fontSize: 14,
  fontWeight: 600,
  cursor: "pointer",
};
