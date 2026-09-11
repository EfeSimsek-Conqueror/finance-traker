"use client";

import { usePathname } from "next/navigation";

/**
 * A short cross-fade between screens.
 *
 * Moving from the portfolio map to an app is a change of scale, not a change of
 * product, and an instant swap reads as a reload. Keyed on the path so the
 * animation restarts on every navigation; without the key React reuses the
 * element and nothing plays the second time.
 *
 * Deliberately short. This sits in front of numbers somebody opened the page to
 * read, and a transition long enough to admire is a transition in the way.
 *
 * The fade is opacity-only on purpose — see `screenIn` in globals.css. Anything
 * that sets a transform here becomes a containing block and breaks every
 * `position: fixed` surface underneath it.
 */
export function Transition({ children }: { children: React.ReactNode }) {
  const path = usePathname();
  return (
    <div key={path} style={{ animation: "screenIn .22s cubic-bezier(.2,.9,.3,1) both" }}>
      {children}
    </div>
  );
}
