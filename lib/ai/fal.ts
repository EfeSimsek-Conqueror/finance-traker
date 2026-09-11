import { serviceClient } from "@/lib/apps";

/**
 * Chat completions, routed fal → OpenRouter.
 *
 * Everything model-shaped in this portfolio goes through fal, so spend lands on
 * one invoice the board already reads. A pleasant side effect: the assistant's
 * own cost shows up on the screen it is describing.
 */
export const MODEL = "google/gemini-2.5-pro";

const ENDPOINT = "https://fal.run/openrouter/router/openai/v1/chat/completions";

export type ToolCall = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
};

export type ChatMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: ToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

export type Completion = {
  content: string | null;
  toolCalls: ToolCall[];
  costUsd: number;
};

/**
 * The key, in preference order.
 *
 * An explicit FAL_KEY wins so inference can be moved onto a narrow key without
 * touching the connector. Failing that it borrows the one already attached for
 * billing — the same secret this process can already read, so nothing new is
 * exposed by using it.
 */
export async function falKey(): Promise<string> {
  if (process.env.FAL_KEY) return process.env.FAL_KEY;
  const { data } = await serviceClient()
    .from("connections")
    .select("secret")
    .eq("vendor", "fal.ai")
    .limit(1)
    .maybeSingle();
  if (!data?.secret) throw new Error("no fal credential — connect fal.ai or set FAL_KEY");
  return data.secret as string;
}

export async function chat(
  key: string,
  messages: ChatMessage[],
  tools: unknown[],
  /** "none" forces prose — used to make the model land the answer. */
  toolChoice: "auto" | "none" = "auto",
): Promise<Completion> {
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: { Authorization: `Key ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify(
      toolChoice === "none"
        ? { model: MODEL, messages }
        : { model: MODEL, messages, tools, tool_choice: "auto" },
    ),
  });

  const body = await res.text();
  if (!res.ok) throw new Error(`fal ${res.status}: ${body.slice(0, 240)}`);

  const json = JSON.parse(body) as {
    choices?: { message?: { content?: string | null; tool_calls?: ToolCall[] } }[];
    usage?: { cost?: number };
  };
  const message = json.choices?.[0]?.message;

  return {
    content: message?.content ?? null,
    toolCalls: message?.tool_calls ?? [],
    // Reported by the router, in USD, and the same figure fal invoices.
    costUsd: json.usage?.cost ?? 0,
  };
}
