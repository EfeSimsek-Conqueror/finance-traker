"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import type { Chat, Message } from "@/lib/chats";

/** The design's panel: wide enough for a bar and a number, no wider. */
export const PANEL_W = 400;

/**
 * Cold start only.
 *
 * Once a thread has an answer in it the chips come from that answer instead —
 * a fixed menu stops being a prompt and becomes furniture the moment the
 * conversation has moved past it.
 */
/** How many fit on two rows at this width. */
const CHIPS_SHOWN = 4;

/** Only ever seen before the board has been read. */
const OPENING_CHIPS = [
  "What runs out today?",
  "Where is spend going?",
  "Can I trust the gauge?",
  "What can I ignore?",
];

/** A finding's kind, as a colour. Four letters carry the rest. */
const TAG: Record<string, { bg: string; fg: string }> = {
  gap: { bg: "#3A241E", fg: "#E08B6B" },
  warn: { bg: "#3A2E1E", fg: "#D9A96B" },
  data: { bg: "#2A2440", fg: "#A79BD8" },
  note: { bg: "#1E3028", fg: "#7FC49A" },
};

type Finding = {
  id: string;
  tag: string;
  tagTone: keyof typeof TAG;
  where: string;
  title: string;
  body: string;
  action: string;
  prompt: string;
};

/**
 * The portfolio assistant.
 *
 * Sits beside the map rather than in a modal because its answers are meant to
 * steer it — asking "what runs out today" and then clicking a row should move
 * the main pane, which a dialog would fight. It is mounted by the layout, so
 * navigating into an app never interrupts a conversation.
 *
 * It answers from the same tables the map renders. Until a connector has
 * reported it has nothing to answer FROM, and it says so instead of
 * improvising — an assistant that invents a number on a finance screen is
 * worse than one that admits it is empty.
 */
export function Assistant({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  const [chats, setChats] = useState<Chat[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [browsing, setBrowsing] = useState(false);
  const [question, setQuestion] = useState("");
  const [busy, setBusy] = useState(false);
  const [lastCost, setLastCost] = useState<number | null>(null);
  const [findings, setFindings] = useState<Finding[]>([]);
  const [pool, setPool] = useState<string[]>([]);
  const [turn, setTurn] = useState(0);
  const [fresh, setFresh] = useState(0);
  const [dismissed, setDismissed] = useState<string[]>([]);
  const scroller = useRef<HTMLDivElement>(null);
  const path = usePathname();

  const loadChats = useCallback(async () => {
    const r = await fetch("/api/chats").then((x) => x.json()).catch(() => null);
    if (r?.chats) setChats(r.chats);
  }, []);

  // Pull the thread list once the panel exists. The lint rule reads this as a
  // synchronous setState in an effect; it is not — the state lands in the
  // promise callback, which is exactly the subscribe-to-an-external-system
  // shape the rule is asking for.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadChats();
  }, [loadChats]);

  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight });
  }, [messages]);

  // Findings belong to the app being looked at, and this panel outlives any one
  // page, so it asks the route where it is rather than being told.
  const slug = path.startsWith("/app/") ? path.split("/")[2] : null;
  useEffect(() => {
    let live = true;
    if (!slug) {
      // Deferred rather than set inline: clearing during the effect body is a
      // synchronous setState, and the portfolio route would cascade a render
      // for a list that is already empty.
      queueMicrotask(() => {
        if (live) setFindings([]);
      });
      return () => {
        live = false;
      };
    }
    void fetch(`/api/findings?slug=${slug}`)
      .then((r) => r.json())
      .then((r) => {
        if (!live) return;
        setFindings(r.findings ?? []);
        setPool(r.suggestions ?? []);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [slug, turn]);

  // Move the window rather than showing the same four forever. Slow enough that
  // a chip does not slide out from under a cursor reaching for it.
  const [offset, setOffset] = useState(0);
  useEffect(() => {
    if (pool.length <= CHIPS_SHOWN) return;
    const t = setInterval(() => setOffset((o) => o + CHIPS_SHOWN), 18_000);
    return () => clearInterval(t);
  }, [pool.length]);

  const open_ = findings.filter((f) => !dismissed.includes(f.id));

  // The conversation's own follow-ups win once there is a conversation: they
  // know what was just said, which no amount of reading the rows can.
  const fromThread = [...messages].reverse().find((m) => m.role === "assistant" && m.followups?.length)
    ?.followups;
  const chips =
    fromThread ??
    (pool.length
      ? Array.from({ length: Math.min(CHIPS_SHOWN, pool.length) }, (_, i) => pool[(offset + i) % pool.length])
      : OPENING_CHIPS);

  async function openChat(id: string) {
    setActiveId(id);
    setBrowsing(false);
    const r = await fetch(`/api/chats/${id}/messages`).then((x) => x.json()).catch(() => null);
    setMessages(r?.messages ?? []);
  }

  /**
   * Send a turn.
   *
   * With no thread selected this starts one, titled from this very prompt —
   * which is what makes "just type" the default path and picking a thread the
   * deliberate one.
   */
  async function ask(text: string) {
    const prompt = text.trim();
    if (!prompt || busy) return;
    setBusy(true);
    setQuestion("");
    setBrowsing(false);

    let id = activeId;
    if (!id) {
      const created = await fetch("/api/chats", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt }),
      })
        .then((x) => x.json())
        .catch(() => null);
      if (!created?.chat) {
        setBusy(false);
        return;
      }
      id = created.chat.id as string;
      setActiveId(id);
    }

    // Optimistic: the question should appear the instant it is asked.
    setMessages((m) => [
      ...m,
      { id: `local-${Date.now()}`, role: "user", content: prompt, payload: null, followups: null },
    ]);

    const r = await fetch("/api/assistant/ask", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chatId: id, prompt }),
    })
      .then((x) => x.json())
      .catch(() => null);

    if (typeof r?.costUsd === "number") setLastCost(r.costUsd);
    if (r?.reply) {
      setMessages((m) => [
        ...m,
        {
          id: `local-a-${Date.now()}`,
          role: "assistant",
          content: r.reply,
          payload: r.payload ?? null,
          followups: r.followups ?? null,
        },
      ]);
    }
    void loadChats();
    // The board may have moved under the panel — a turn can sync a vendor or
    // write a row — so the findings and the chips are re-derived, not stale.
    setTurn((t) => t + 1);
    setBusy(false);
  }

  function newChat() {
    setActiveId(null);
    setMessages([]);
    setBrowsing(false);
    setLastCost(null);
    // Remounts the panel body, which is what makes the animation play again on
    // a second press. Without a changing key, clearing an already-empty panel
    // would look like the button did nothing.
    setFresh((n) => n + 1);
  }

  // No floating tab when collapsed. Closing the panel is a request for the
  // width back, and a button pinned over the board is the one thing that does
  // not give it to you — the header keeps an "Open assistant" control and ⌥A
  // works from anywhere.
  if (!open) return null;

  return (
    <aside
      data-chrome="1"
      onMouseDown={(e) => e.stopPropagation()}
      style={{
        position: "fixed",
        top: 0,
        right: 0,
        bottom: 0,
        width: PANEL_W,
        // Barely there. The panel needs to read as a separate surface from the
        // board, but a strong rule would put a wall through a screen whose
        // whole point is that the two halves belong together.
        borderLeft: "1px solid #262120",
        background: "#141110",
        display: "flex",
        flexDirection: "column",
        zIndex: 30,
      }}
    >
      <header
        style={{
          display: "flex",
          alignItems: "center",
          gap: 9,
          padding: "16px 18px",
          borderBottom: "1px solid #262120",
        }}
      >
        <span
          style={{
            width: 26,
            height: 26,
            borderRadius: 8,
            background: "#D97757",
            display: "grid",
            placeItems: "center",
            fontSize: 12,
            color: "#1A1210",
            flexShrink: 0,
          }}
        >
          ◈
        </span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 13.5, color: "#F3EDE7" }}>Board assistant</div>
          <div style={{ fontSize: 11, color: "#7C726B" }}>
            {open_.length
              ? `${open_.length} finding${open_.length === 1 ? "" : "s"} need${open_.length === 1 ? "s" : ""} a decision`
              : "nothing needs a decision"}
          </div>
        </div>
        <IconBtn title="New chat" onClick={newChat}>
          <span key={fresh} style={{ display: "inline-block", animation: "twist .32s cubic-bezier(.2,.9,.3,1) both" }}>
            ＋
          </span>
        </IconBtn>
        <IconBtn title="Chats" onClick={() => setBrowsing((v) => !v)} active={browsing}>
          ☰
        </IconBtn>
        <button
          onClick={onToggle}
          title="Close panel (⌥A)"
          style={{
            width: 28,
            height: 28,
            border: "1px solid #322b28",
            borderRadius: 8,
            background: "#1D1917",
            color: "#A99F97",
            cursor: "pointer",
            fontSize: 13,
            fontFamily: "inherit",
            flexShrink: 0,
          }}
        >
          ✕
        </button>
      </header>

      <div ref={scroller} style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "14px 16px" }}>
        <div key={fresh} style={{ animation: "sweepIn .3s cubic-bezier(.2,.9,.3,1) both" }}>
        {browsing ? (
          <ChatList chats={chats} activeId={activeId} onPick={openChat} />
        ) : messages.length ? (
          <Thread messages={messages} busy={busy} cost={lastCost} onAsk={ask} />
        ) : open_.length ? (
          <>
            <div
              style={{
                fontSize: 11,
                letterSpacing: ".07em",
                textTransform: "uppercase",
                color: "#857B74",
                marginBottom: 12,
              }}
            >
              Audit findings
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              {open_.map((f) => (
                <FindingCard
                  key={f.id}
                  f={f}
                  onApply={() => ask(f.prompt)}
                  onDismiss={() => setDismissed((d) => [...d, f.id])}
                />
              ))}
            </div>
          </>
        ) : (
          <Card title="Ask the board">
            <p style={{ color: "#c2d0e0", fontSize: 12.5, lineHeight: 1.55, margin: 0 }}>
              I answer from the rows on the map — ceilings, vendor spend and
              revenue — and nothing else. Where a figure has not been measured I
              say so rather than estimating it.
            </p>
            <p style={{ color: "#6b7c90", fontSize: 11.5, lineHeight: 1.5, margin: "10px 0 0" }}>
              A new thread starts on your first message, titled from it.
            </p>
          </Card>
        )}
        </div>
      </div>

      <footer style={{ padding: "14px 16px", borderTop: "1px solid #262120", background: "#191514" }}>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 10 }}>
          {chips.map((c) => (
            <button
              key={c}
              onClick={() => ask(c)}
              style={{
                borderRadius: 999,
                border: "1px solid #322b28",
                background: "#1D1917",
                color: "#A99F97",
                fontSize: 11.5,
                padding: "6px 11px",
                cursor: "pointer",
              }}
            >
              {c}
            </button>
          ))}
        </div>

        <div
          style={{
            display: "flex",
            gap: 8,
            alignItems: "center",
            borderRadius: 12,
            border: "1px solid #302a27",
            background: "#1D1918",
            padding: "10px 12px",
          }}
        >
          <input
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && ask(question)}
            placeholder={activeId ? "Reply…" : "Ask about a row…"}
            style={{
              flex: 1,
              border: "none",
              background: "transparent",
              color: "#F3EDE7",
              fontSize: 13,
              minWidth: 0,
              outline: "none",
            }}
          />
          <button
            onClick={() => ask(question)}
            disabled={busy}
            style={{
              borderRadius: 8,
              border: "none",
              background: "#D97757",
              color: "#1A1210",
              width: 28,
              height: 28,
              fontSize: 13,
              fontWeight: 600,
              cursor: "pointer",
              opacity: busy ? 0.5 : 1,
            }}
          >
            {busy ? "…" : "\u2191"}
          </button>
        </div>
        <div style={{ fontSize: 10.5, color: "#6E645D", marginTop: 8 }}>
          Every action here writes to the ledger and shows up in history.
        </div>
      </footer>
    </aside>
  );
}

function ChatList({
  chats,
  activeId,
  onPick,
}: {
  chats: Chat[];
  activeId: string | null;
  onPick: (id: string) => void;
}) {
  if (!chats.length) {
    return (
      <Card title="No chats yet">
        <p style={{ color: "#c2d0e0", fontSize: 12.5, margin: 0, lineHeight: 1.55 }}>
          Ask something and a thread appears here, titled from what you asked.
        </p>
      </Card>
    );
  }
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      {chats.map((c) => (
        <button
          key={c.id}
          onClick={() => onPick(c.id)}
          style={{
            textAlign: "left",
            borderRadius: 10,
            border: "none",
            background: c.id === activeId ? "#141b24" : "#0b1017",
            color: "#c2d0e0",
            padding: "9px 11px",
            fontSize: 12,
            cursor: "pointer",
            lineHeight: 1.35,
          }}
        >
          {c.title}
        </button>
      ))}
    </div>
  );
}

function Thread({
  messages,
  busy,
  cost,
  onAsk,
}: {
  messages: Message[];
  busy: boolean;
  cost: number | null;
  onAsk: (text: string) => void;
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      {messages.map((m) =>
        m.role === "user" ? (
          <div key={m.id}>
            <div style={{ fontSize: 11.5, color: "#7C726B", marginBottom: 6 }}>You asked</div>
            <div style={{ fontSize: 13, fontWeight: 500, color: "#F3EDE7", lineHeight: 1.45 }}>
              {m.content}
            </div>
          </div>
        ) : (
          <div key={m.id} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <div style={{ fontSize: 13, color: "#CFC6BE", lineHeight: 1.55, whiteSpace: "pre-wrap" }}>
              {m.content}
            </div>
            <Blocks payload={m.payload} onAsk={onAsk} />
          </div>
        ),
      )}
      {busy && <div style={{ fontSize: 11.5, color: "#55667d" }}>Thinking…</div>}
      {!busy && cost != null && (
        <div style={{ fontSize: 10.5, color: "#44556b" }}>
          this answer cost {cost < 0.01 ? "<$0.01" : `$${cost.toFixed(2)}`} · gemini-2.5-pro via fal
        </div>
      )}
    </div>
  );
}

function Eyebrow({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        fontSize: 10,
        fontWeight: 700,
        letterSpacing: ".12em",
        textTransform: "uppercase",
        color: "#857B74",
        marginBottom: 11,
      }}
    >
      {children}
    </div>
  );
}

function IconBtn({
  children,
  onClick,
  title,
  active,
}: {
  children: React.ReactNode;
  onClick: () => void;
  title: string;
  active?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      style={{
        border: "none",
        borderRadius: 8,
        background: active ? "#141b24" : "transparent",
        color: "#57606a",
        cursor: "pointer",
        fontSize: 14,
        lineHeight: 1,
        padding: "6px 8px",
      }}
    >
      {children}
    </button>
  );
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section
      style={{
        borderRadius: 12,
        border: "1px solid #2A2523",
        background: "#1C1817",
        padding: 14,
        animation: "fadeUp .25s ease both",
      }}
    >
      <Eyebrow>{title}</Eyebrow>
      {children}
    </section>
  );
}

/* ── answer blocks ─────────────────────────────────────────────────────── */

const TONE: Record<string, string> = {
  crit: "#D97757",
  warn: "#C8894F",
  ok: "#5FA777",
  neutral: "#4A413C",
};

/**
 * The structured half of an answer.
 *
 * Prose says what happened; these say by how much. They are driven entirely by
 * what the answer carried — a block with no data does not render, because an
 * empty gauge on a finance screen reads as a measured zero.
 */
type Block =
  | { type: "bars"; title: string; rows: { label: string; value: string; pct: number; tone?: string }[] }
  | { type: "value"; title: string; value: string; tone?: string; caption?: string; body?: string }
  | { type: "action"; body: string; confirm: string; dismiss?: string; note?: string };

function Blocks({ payload, onAsk }: { payload: unknown; onAsk: (text: string) => void }) {
  const blocks = Array.isArray(payload) ? (payload as Block[]) : null;
  if (!blocks?.length) return null;

  return (
    <>
      {blocks.map((b, i) => {
        if (b.type === "bars") return <BarsBlock key={i} block={b} />;
        if (b.type === "value") return <ValueBlock key={i} block={b} />;
        return <ActionBlock key={i} block={b} onAsk={onAsk} />;
      })}
    </>
  );
}

function BarsBlock({ block }: { block: Extract<Block, { type: "bars" }> }) {
  return (
    <Card title={block.title}>
      {block.rows.map((r) => (
        <div
          key={r.label}
          style={{
            display: "grid",
            gridTemplateColumns: "minmax(0,1fr) 42px",
            gap: 8,
            alignItems: "center",
            marginBottom: 9,
          }}
        >
          <div style={{ minWidth: 0 }}>
            <div
              style={{
                fontSize: 11.5,
                color: "#c2d0e0",
                marginBottom: 4,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {r.label}
            </div>
            <div style={{ height: 8, borderRadius: 3, background: "#141f33", overflow: "hidden" }}>
              <div
                style={{
                  height: "100%",
                  width: `${Math.max(0, Math.min(100, r.pct))}%`,
                  borderRadius: 3,
                  background: TONE[r.tone ?? "neutral"],
                }}
              />
            </div>
          </div>
          <div
            style={{
              fontFamily: "var(--mono)",
              fontSize: 13,
              fontWeight: 600,
              textAlign: "right",
              color: TONE[r.tone ?? "neutral"],
            }}
          >
            {r.value}
          </div>
        </div>
      ))}
    </Card>
  );
}

function ValueBlock({ block }: { block: Extract<Block, { type: "value" }> }) {
  return (
    <section
      style={{
        borderRadius: 9,
        border: "1px solid #2A2523",
        background: "#1C1817",
        padding: "12px 13px",
      }}
    >
      <div
        style={{
          fontSize: 10,
          fontWeight: 700,
          letterSpacing: ".12em",
          textTransform: "uppercase",
          color: "#55667d",
          marginBottom: 7,
        }}
      >
        {block.title}
      </div>
      <div style={{ display: "flex", alignItems: "baseline", gap: 9, flexWrap: "wrap" }}>
        <span
          style={{
            fontFamily: "var(--mono)",
            fontSize: 26,
            fontWeight: 600,
            letterSpacing: "-.02em",
            color: TONE[block.tone ?? "neutral"],
          }}
        >
          {block.value}
        </span>
        {block.caption && <span style={{ fontSize: 11.5, color: "#8fa3ba" }}>{block.caption}</span>}
      </div>
      {block.body && (
        <div style={{ fontSize: 11.5, color: "#7c8da2", marginTop: 6, lineHeight: 1.45 }}>
          {block.body}
        </div>
      )}
    </section>
  );
}

/**
 * A proposal, never an act.
 *
 * The assistant can reach the same tables the board reads, so the restraint has
 * to be visible: the note is part of the block and not a caption someone can
 * forget to pass.
 */
function ActionBlock({ block, onAsk }: { block: Extract<Block, { type: "action" }>; onAsk: (text: string) => void }) {
  return (
    <section
      style={{
        borderRadius: 9,
        border: "1px solid #322b28",
        background: "#1D1918",
        padding: "12px 13px",
      }}
    >
      <div style={{ fontSize: 12, color: "#c2d0e0", lineHeight: 1.5, marginBottom: 10 }}>
        {block.body}
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <button
          style={{
            borderRadius: 6,
            border: "none",
            background: "#D97757",
            color: "#1A1210",
            padding: "7px 12px",
            fontSize: 11.5,
            fontWeight: 600,
            cursor: "pointer",
          }}
          onClick={() => onAsk(block.confirm)}
        >
          {block.confirm}
        </button>
        <button
          style={{
            border: "none",
            background: "transparent",
            color: "#A99F97",
            padding: "7px 10px",
            fontSize: 11.5,
            cursor: "pointer",
          }}
        >
          {block.dismiss ?? "Not now"}
        </button>
        <span style={{ flex: 1 }} />
        <span style={{ fontSize: 10, color: "#44556b" }}>{block.note ?? "never acts alone"}</span>
      </div>
    </section>
  );
}


/**
 * One thing that is wrong, and the one button that starts fixing it.
 *
 * "Not now" hides it for this session only. A dismissal that outlived the
 * problem would be a way to make the board stop mentioning something that is
 * still true, which is the opposite of what this panel is for — the finding
 * comes back on reload because it is derived, not stored.
 */
function FindingCard({
  f,
  onApply,
  onDismiss,
}: {
  f: Finding;
  onApply: () => void;
  onDismiss: () => void;
}) {
  const tag = TAG[f.tagTone] ?? TAG.note;
  return (
    <div
      style={{
        border: "1px solid #2A2523",
        borderRadius: 12,
        background: "#1C1817",
        padding: 14,
        animation: "fadeUp .25s ease both",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
        <span
          style={{
            fontFamily: "var(--mono), monospace",
            fontSize: 10.5,
            padding: "2px 6px",
            borderRadius: 5,
            background: tag.bg,
            color: tag.fg,
          }}
        >
          {f.tag}
        </span>
        <span style={{ fontSize: 11, color: "#7C726B", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {f.where}
        </span>
      </div>
      <div style={{ fontSize: 13, lineHeight: 1.45, color: "#EDE6DF" }}>{f.title}</div>
      <div style={{ fontSize: 11.5, lineHeight: 1.5, color: "#8B817A", marginTop: 6 }}>{f.body}</div>
      <div style={{ display: "flex", gap: 8, marginTop: 12, alignItems: "center" }}>
        <button
          onClick={onApply}
          style={{
            padding: "7px 12px",
            border: 0,
            borderRadius: 8,
            background: "#D97757",
            color: "#1A1210",
            fontFamily: "inherit",
            fontSize: 12,
            fontWeight: 500,
            cursor: "pointer",
          }}
        >
          {f.action}
        </button>
        <button
          onClick={onDismiss}
          style={{
            padding: "7px 12px",
            border: "1px solid #322b28",
            borderRadius: 8,
            background: "transparent",
            color: "#A99F97",
            fontFamily: "inherit",
            fontSize: 12,
            cursor: "pointer",
          }}
        >
          Not now
        </button>
      </div>
    </div>
  );
}
