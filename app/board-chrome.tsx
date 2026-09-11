"use client";

import Link from "next/link";
import { usePanel } from "./canvas";

/**
 * The header's two controls.
 *
 * Client-side because both are stateful in ways the page is not: one toggles a
 * panel owned by the layout, and the other is a keyboard shortcut that has to
 * be bound to the window.
 */
export function BoardChrome() {
  const { open, toggle } = usePanel();

  // The ⌥A binding lives in the shell: one listener for every screen, and two
  // would toggle twice and cancel each other out.
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <Link
        href="/"
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "8px 12px",
          border: "1px solid #322b28",
          borderRadius: 9,
          background: "#1D1917",
          color: "#E5DDD5",
          fontSize: 12.5,
          textDecoration: "none",
        }}
      >
        <span style={{ color: "#8B817A" }}>←</span>
        All apps
      </Link>
      <button
        onClick={toggle}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          padding: "8px 12px",
          border: "1px solid #322b28",
          borderRadius: 9,
          background: "#1D1917",
          color: "#E5DDD5",
          fontFamily: "inherit",
          fontSize: 12.5,
          cursor: "pointer",
        }}
      >
        <span
          style={{
            width: 14,
            height: 14,
            border: "1.5px solid currentColor",
            borderRadius: 3,
            position: "relative",
            display: "inline-block",
            opacity: 0.8,
          }}
        >
          <span
            style={{
              position: "absolute",
              top: -1.5,
              bottom: -1.5,
              right: -1.5,
              width: 6,
              background: "currentColor",
              borderRadius: "0 3px 3px 0",
            }}
          />
        </span>
        <span>{open ? "Close assistant" : "Open assistant"}</span>
        <span style={{ fontFamily: "var(--mono), monospace", color: "#7C726B" }}>⌥A</span>
      </button>
    </div>
  );
}
