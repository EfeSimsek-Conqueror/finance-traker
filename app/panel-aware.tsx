"use client";

import { usePanel } from "./canvas";

/**
 * Keeps a document page clear of the assistant.
 *
 * The canvas board handles this itself by being `position:fixed` with a `right`
 * inset. A scrolling document has no such inset, so without this the panel sits
 * on top of the right-hand column — the Contribution figure and the "counted
 * by" column were both underneath it.
 */
export function PanelAware({ children }: { children: React.ReactNode }) {
  const { width } = usePanel();
  return <div style={{ marginRight: width, transition: "margin-right .15s ease" }}>{children}</div>;
}
