"use client";

import { useState, useSyncExternalStore } from "react";
import { startAuthentication, startRegistration } from "@simplewebauthn/browser";

const CARD = "#191514";
const EDGE = "#262120";
const ACCENT = "#D97757";

/**
 * The whole console behind two fields.
 *
 * Deliberately plain: there is no account to create, nothing to recover, and
 * two people who already know the password. Anything more would be furniture.
 */
export function LoginForm({ next }: { next: string }) {
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [offerSetup, setOfferSetup] = useState(false);

  /**
   * Whether this browser can do WebAuthn at all.
   *
   * Read through useSyncExternalStore rather than an effect: the server has to
   * render `false` — it has no window — and the client has to correct it without
   * a second render pass, which is precisely what the server snapshot is for.
   * WebAuthn also needs a secure context, so on plain http the button is absent
   * rather than present and failing.
   */
  const canPasskey = useSyncExternalStore(
    () => () => {},
    () => typeof window !== "undefined" && !!window.PublicKeyCredential,
    () => false,
  );

  async function step(payload: Record<string, unknown>) {
    const res = await fetch("/api/auth/passkey", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error ?? "that did not work");
    return body;
  }

  /** Sign in with a device already registered here. */
  async function withPasskey() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const { options } = await step({ step: "login-options", name });
      const response = await startAuthentication({ optionsJSON: options });
      await step({ step: "login-verify", response });
      window.location.href = next;
    } catch (e) {
      // A cancelled prompt is not a failure worth shouting about; anything else
      // is, and the two are told apart by what the browser threw.
      const msg = e instanceof Error ? e.message : String(e);
      setError(/abort|NotAllowed|cancel/i.test(msg) ? null : msg);
      setBusy(false);
    }
  }

  /** Register this device, right after proving who you are with the password. */
  async function addPasskey() {
    setBusy(true);
    setError(null);
    try {
      const { options } = await step({ step: "register-options" });
      const response = await startRegistration({ optionsJSON: options });
      await step({ step: "register-verify", response, label: navigator.platform });
      window.location.href = next;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(/abort|NotAllowed|cancel/i.test(msg) ? null : msg);
      setBusy(false);
    }
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);

    const res = await fetch("/api/auth", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, password }),
    }).catch(() => null);

    if (res?.ok) {
      // The one moment worth asking: the password has just been proved, so
      // registering a device costs one tap and needs no second sign-in. A
      // settings page for this would be a page nobody visits.
      const known = await fetch(`/api/auth/passkey?name=${encodeURIComponent(name)}`)
        .then((r) => r.json())
        .catch(() => ({ registered: 1 }));
      if (canPasskey && !known.registered) {
        setOfferSetup(true);
        setBusy(false);
        return;
      }
      // A hard navigation, not a router push: the session arrives as a cookie
      // and every page behind it is server-rendered against that cookie.
      window.location.href = next;
      return;
    }
    const body = await res?.json().catch(() => null);
    setError(body?.error ?? "Could not sign in.");
    setBusy(false);
  }

  return (
    <main
      style={{
        minHeight: "100vh",
        background: "#141110",
        color: "#F3EDE7",
        display: "grid",
        placeItems: "center",
        padding: 24,
      }}
    >
      <form
        onSubmit={submit}
        style={{
          width: "100%",
          maxWidth: 360,
          border: `1px solid ${EDGE}`,
          borderRadius: 16,
          background: CARD,
          padding: 28,
          animation: "fadeUp .3s ease both",
        }}
      >
        <div style={{ fontFamily: "var(--serif), serif", fontSize: 26, lineHeight: 1.15 }}>
          Cloudgeng Finance Tracker
        </div>
        <div style={{ fontSize: 12.5, color: "#8B817A", marginTop: 6 }}>
          What is running out, and what it costs.
        </div>

        {offerSetup ? (
          <>
            <p style={{ fontSize: 13.5, color: "#CFC6BE", lineHeight: 1.6, margin: "22px 0 0" }}>
              Signed in as {name}. Use this device&rsquo;s fingerprint next time?
            </p>
            <p style={{ fontSize: 12, color: "#7C726B", lineHeight: 1.5, margin: "8px 0 0" }}>
              The password keeps working — this only saves typing it where people can see.
            </p>
            <button
              type="button"
              onClick={addPasskey}
              disabled={busy}
              style={{
                width: "100%",
                marginTop: 18,
                padding: "11px 14px",
                border: 0,
                borderRadius: 10,
                background: ACCENT,
                color: "#1A1210",
                fontFamily: "inherit",
                fontSize: 13.5,
                fontWeight: 500,
                cursor: "pointer",
              }}
            >
              Set up fingerprint
            </button>
            <button
              type="button"
              onClick={() => (window.location.href = next)}
              style={{
                width: "100%",
                marginTop: 10,
                padding: "10px 14px",
                border: `1px solid ${EDGE}`,
                borderRadius: 10,
                background: "transparent",
                color: "#A99F97",
                fontFamily: "inherit",
                fontSize: 13,
                cursor: "pointer",
              }}
            >
              Not now
            </button>
          </>
        ) : (
        <>
        <Field label="Name" value={name} onChange={setName} autoFocus autoComplete="username" />
        <Field
          label="Password"
          value={password}
          onChange={setPassword}
          type="password"
          autoComplete="current-password"
        />

        {error && (
          <div style={{ fontSize: 12.5, color: ACCENT, marginTop: 14, lineHeight: 1.5 }}>{error}</div>
        )}

        <button
          type="submit"
          disabled={busy || !name.trim() || !password}
          style={{
            width: "100%",
            marginTop: 20,
            padding: "11px 14px",
            border: 0,
            borderRadius: 10,
            background: ACCENT,
            color: "#1A1210",
            fontFamily: "inherit",
            fontSize: 13.5,
            fontWeight: 500,
            cursor: busy ? "default" : "pointer",
            opacity: busy || !name.trim() || !password ? 0.55 : 1,
          }}
        >
          {busy ? "Checking…" : "Sign in"}
        </button>

        {canPasskey && (
          <button
            type="button"
            onClick={withPasskey}
            disabled={busy}
            style={{
              width: "100%",
              marginTop: 10,
              padding: "10px 14px",
              border: `1px solid ${EDGE}`,
              borderRadius: 10,
              background: "transparent",
              color: "#A99F97",
              fontFamily: "inherit",
              fontSize: 13,
              cursor: "pointer",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              gap: 8,
            }}
          >
            <Fingerprint />
            Use fingerprint
          </button>
        )}
        </>
        )}
      </form>
    </main>
  );
}

function Field({
  label,
  value,
  onChange,
  type = "text",
  autoFocus,
  autoComplete,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  type?: string;
  autoFocus?: boolean;
  autoComplete?: string;
}) {
  return (
    <label style={{ display: "block", marginTop: 20 }}>
      <span
        style={{
          display: "block",
          fontSize: 11,
          letterSpacing: ".08em",
          textTransform: "uppercase",
          color: "#857B74",
          marginBottom: 8,
        }}
      >
        {label}
      </span>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        type={type}
        autoFocus={autoFocus}
        autoComplete={autoComplete}
        style={{
          width: "100%",
          border: "1px solid #302a27",
          borderRadius: 10,
          background: "#1D1918",
          color: "#F3EDE7",
          padding: "11px 13px",
          fontFamily: "inherit",
          fontSize: 14,
          outline: "none",
        }}
      />
    </label>
  );
}


/** A fingerprint, drawn rather than fetched — no icon set is loaded here. */
function Fingerprint() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
      <path d="M12 10v4c0 3-1 5-2 6.5" />
      <path d="M8.5 8.5A4.5 4.5 0 0 1 16.5 12v2c0 1.5-.3 3-.8 4.2" />
      <path d="M5.5 12a6.5 6.5 0 0 1 3-5.5" />
      <path d="M19 8.5A8 8 0 0 0 5 9.5" />
      <path d="M9 14v-2a3 3 0 0 1 6 0v3" />
    </svg>
  );
}
