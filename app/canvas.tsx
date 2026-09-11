"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";

const MIN_Z = 0.2;
const MAX_Z = 2;

/** Bounding box of everything the canvas should be able to frame. */
export type Bounds = { minX: number; minY: number; maxX: number; maxY: number };

type Ctx = { open: boolean; toggle: () => void; width: number };

/**
 * What a node needs to move itself.
 *
 * `zoom` because a drag arrives in screen pixels and the board is measured in
 * board pixels; dividing by the scale is the difference between a card that
 * follows the cursor and one that drifts away from it. `editing` because a
 * board you can rearrange by accident is a board you cannot trust the position
 * of, and position is how this screen is read.
 */
type CanvasCtx = { zoom: number; editing: boolean };
const CanvasContext = createContext<CanvasCtx>({ zoom: 1, editing: false });
export const useCanvas = () => useContext(CanvasContext);
const PanelCtx = createContext<Ctx>({ open: true, toggle: () => {}, width: 0 });
export const PanelProvider = PanelCtx.Provider;
export const usePanel = () => useContext(PanelCtx);

/**
 * The pannable, zoomable surface both maps are drawn on.
 *
 * Extracted because the portfolio map and an app's resource map are the same
 * space at different scales — same grid, same gestures, same framing rules.
 * Two implementations would drift, and the whole point of the app map is that
 * it feels like zooming further into the board you were already on.
 */
export function Canvas({
  bounds,
  children,
  chrome,
  onResetLayout,
}: {
  bounds: Bounds;
  children: React.ReactNode;
  chrome?: React.ReactNode;
  /** Present when this board has placements an operator could have moved. */
  onResetLayout?: () => void;
}) {
  const { width: panelW } = usePanel();
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(1);
  const [dragging, setDragging] = useState(false);
  const [editing, setEditing] = useState(false);
  const drag = useRef<{ x: number; y: number; px: number; py: number } | null>(null);
  const viewport = useRef<HTMLDivElement>(null);

  const fitAll = useCallback(() => {
    const el = viewport.current;
    if (!el) return;
    const w = bounds.maxX - bounds.minX;
    const h = bounds.maxY - bounds.minY;
    if (w <= 0 || h <= 0) return;
    // The alert strip, breadcrumb and zoom bar float above the board rather
    // than taking layout space, so framing has to leave room for them by hand —
    // otherwise the first card sits under the breadcrumb on every load.
    const inset = { top: 110, bottom: 80, x: 60 };
    const availW = el.clientWidth - inset.x * 2;
    const availH = el.clientHeight - inset.top - inset.bottom;
    // Never above 1. "Fit" means make it all visible, not fill the screen with
    // it — a portfolio of two tiles would otherwise open magnified to 168%,
    // one card wide, which is the opposite of an overview. Zooming in stays a
    // thing you ask for.
    const z = Math.min(1, MAX_Z, Math.max(MIN_Z, Math.min(availW / w, availH / h)));
    setZoom(z);
    setPan({
      x: inset.x + (availW - w * z) / 2 - bounds.minX * z,
      y: inset.top + (availH - h * z) / 2 - bounds.minY * z,
    });
  }, [bounds]);

  /** One notch, about the middle of the view — the cursor is not involved. */
  const nudge = useCallback((dir: 1 | -1) => {
    const el = viewport.current;
    if (!el) return;
    const cx = el.clientWidth / 2;
    const cy = el.clientHeight / 2;
    setZoom((z) => {
      const next = Math.min(MAX_Z, Math.max(MIN_Z, z * (dir > 0 ? 1.18 : 1 / 1.18)));
      setPan((p) => ({ x: cx - ((cx - p.x) / z) * next, y: cy - ((cy - p.y) / z) * next }));
      return next;
    });
  }, []);

  // Frame once, on mount.
  //
  // Deliberately NOT re-framing when the side panel opens or closes: refitting
  // moves every card, and this screen is read by position. Collapsing a panel
  // is a request for more room, not to rearrange the map.
  useEffect(() => {
    fitAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * Trackpad gestures.
   *
   * macOS reports a pinch as a wheel event with ctrlKey set and two-finger
   * scroll as a plain wheel, so one handler covers both. Registered natively
   * rather than through onWheel because React attaches wheel listeners as
   * passive, and a passive listener cannot preventDefault — the browser would
   * zoom the whole page instead of the board.
   */
  useEffect(() => {
    const el = viewport.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const cx = e.clientX - rect.left;
      const cy = e.clientY - rect.top;
      if (e.ctrlKey) {
        // Zoom about the pointer: the board point under the cursor must stay
        // under the cursor, or pinching drifts away from what you aimed at.
        setZoom((z) => {
          const next = Math.min(MAX_Z, Math.max(MIN_Z, z * Math.exp(-e.deltaY / 260)));
          setPan((p) => ({
            x: cx - ((cx - p.x) / z) * next,
            y: cy - ((cy - p.y) / z) * next,
          }));
          return next;
        });
        return;
      }
      setPan((p) => ({ x: p.x - e.deltaX, y: p.y - e.deltaY }));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  // Space re-frames. Bound on the window so it works wherever focus is, but
  // ignored while typing — otherwise naming an app would snap the map behind
  // the dialog on every space bar.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code !== "Space") return;
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable)) return;
      e.preventDefault();
      fitAll();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [fitAll]);

  return (
    <div
      ref={viewport}
      data-surface="canvas"
      onMouseDown={(e) => {
        if ((e.target as HTMLElement).closest("[data-tile],[data-chrome]")) return;
        drag.current = { x: e.clientX, y: e.clientY, px: pan.x, py: pan.y };
        setDragging(true);
      }}
      onMouseMove={(e) => {
        const d = drag.current;
        if (!d) return;
        setPan({ x: d.px + (e.clientX - d.x), y: d.py + (e.clientY - d.y) });
      }}
      onMouseUp={() => {
        drag.current = null;
        setDragging(false);
      }}
      onMouseLeave={() => {
        drag.current = null;
        setDragging(false);
      }}
      style={{
        position: "fixed",
        top: 0,
        left: 0,
        bottom: 0,
        right: panelW,
        // Warm, matching the resource board. The grid is the same structure in
        // the new palette — it marks distance on a surface you pan, and a cold
        // blue rule under warm cards read as two products.
        background: "#141110",
        backgroundImage:
          "repeating-linear-gradient(0deg,#2A211D 0 1px,transparent 1px 176px)," +
          "repeating-linear-gradient(90deg,#2A211D 0 1px,transparent 1px 176px)",
        overflow: "hidden",
        cursor: dragging ? "grabbing" : "grab",
        userSelect: "none",
      }}
    >
      <div
        style={{
          position: "absolute",
          transformOrigin: "0 0",
          transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
        }}
      >
        <CanvasContext.Provider value={{ zoom, editing }}>{children}</CanvasContext.Provider>
      </div>

      {chrome}

      {/* Zoom readout and framing, bottom-left. A percentage rather than a
          slider: the number is the only part anyone reads back to themselves
          when they say "I was at 40%". */}
      <div
        data-chrome="1"
        style={{
          position: "absolute",
          left: 18,
          bottom: 18,
          display: "flex",
          alignItems: "center",
          gap: 4,
          padding: 6,
          borderRadius: 10,
          border: "1px solid #322b28",
          background: "rgba(20,17,16,.92)",
          backdropFilter: "blur(6px)",
          zIndex: 10,
        }}
      >
        <ZoomButton onClick={() => nudge(-1)} label="−" />
        <span
          style={{
            fontFamily: "var(--mono)",
            fontSize: 12,
            color: "#A99F97",
            width: 52,
            textAlign: "center",
          }}
        >
          {Math.round(zoom * 100)}%
        </span>
        <ZoomButton onClick={() => nudge(1)} label="+" />
        <span style={{ width: 1, height: 20, background: "#322b28", margin: "0 4px" }} />
        <button
          onClick={() => setEditing((v) => !v)}
          style={{
            border: "none",
            background: editing ? "#262020" : "transparent",
            color: editing ? "#F3EDE7" : "#A99F97",
            fontSize: 11.5,
            fontWeight: 600,
            height: 30,
            padding: "0 11px",
            borderRadius: 7,
            cursor: "pointer",
          }}
        >
          {editing ? "Done" : "Arrange"}
        </button>
        {editing && onResetLayout && (
          <button
            onClick={onResetLayout}
            style={{
              border: "none",
              background: "transparent",
              color: "#55667d",
              fontSize: 11.5,
              height: 30,
              padding: "0 11px",
              borderRadius: 7,
              cursor: "pointer",
            }}
          >
            Reset layout
          </button>
        )}
        <button
          onClick={fitAll}
          style={{
            border: "none",
            background: "transparent",
            color: "#A99F97",
            fontSize: 11.5,
            fontWeight: 600,
            height: 30,
            padding: "0 11px",
            borderRadius: 7,
            cursor: "pointer",
          }}
        >
          Fit all
        </button>
      </div>
    </div>
  );
}

function ZoomButton({ onClick, label }: { onClick: () => void; label: string }) {
  return (
    <button
      onClick={onClick}
      style={{
        width: 30,
        height: 30,
        borderRadius: 7,
        border: "none",
        background: "transparent",
        color: "#A99F97",
        fontSize: 17,
        lineHeight: 1,
        cursor: "pointer",
      }}
    >
      {label}
    </button>
  );
}
