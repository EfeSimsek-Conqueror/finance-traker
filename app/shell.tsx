"use client";

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { Assistant, PANEL_W } from "./assistant";
import { Transition } from "./transition";
import { PanelProvider } from "./canvas";

/**
 * The frame every page renders inside.
 *
 * The assistant lives here rather than in a page so it survives navigation:
 * moving from the portfolio map into an app must not unmount the panel, or the
 * conversation you are in the middle of would vanish the moment you clicked a
 * card. Next's layouts persist across route changes, which is exactly the
 * property this needs.
 */
export function Shell({ children }: { children: React.ReactNode }) {
  // Closed on arrival. The board is the thing you came for; a panel that opens
  // itself takes a quarter of the width to say nothing yet.
  const [open, setOpen] = useState(false);
  const path = usePathname();

  // Nothing to assist with before you are in, and the panel would be answering
  // questions about a board the visitor cannot see.
  if (path === "/login") return <>{children}</>;

  return <Framed open={open} setOpen={setOpen}>{children}</Framed>;
}

function Framed({
  open,
  setOpen,
  children,
}: {
  open: boolean;
  setOpen: (fn: (v: boolean) => boolean) => void;
  children: React.ReactNode;
}) {
  // Bound here rather than in a page, so the shortcut works on every screen and
  // there is one binding rather than one per board.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.altKey || (e.key !== "a" && e.key !== "A" && e.code !== "KeyA")) return;
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable)) return;
      e.preventDefault();
      setOpen((v) => !v);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setOpen]);

  return (
    <PanelProvider
      value={{ open, toggle: () => setOpen((v) => !v), width: open ? PANEL_W : 0 }}
    >
      <Transition>{children}</Transition>
      <Assistant open={open} onToggle={() => setOpen((v) => !v)} />
    </PanelProvider>
  );
}
