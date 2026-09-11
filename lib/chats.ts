import { serviceClient } from "./apps";

export type Chat = { id: string; title: string; updated_at: string };
export type Message = {
  id: string;
  role: "user" | "assistant";
  content: string;
  payload: unknown | null;
  /** Suggested next questions, written by the turn that produced this message. */
  followups: string[] | null;
};

/**
 * A chat's title is written from its first prompt, because that is the only
 * moment the thread has a subject and no history to summarise. Trimmed to a
 * headline rather than a sentence: the list is scanned, not read.
 */
export function titleFromPrompt(prompt: string): string {
  const clean = prompt.trim().replace(/\s+/g, " ").replace(/[?？.!]+$/, "");
  if (clean.length <= 48) return clean;
  const cut = clean.slice(0, 48);
  const lastSpace = cut.lastIndexOf(" ");
  return (lastSpace > 24 ? cut.slice(0, lastSpace) : cut) + "…";
}

export async function listChats(): Promise<Chat[]> {
  const { data, error } = await serviceClient()
    .from("chats")
    .select("id, title, updated_at")
    .order("updated_at", { ascending: false })
    .limit(50);
  if (error) {
    console.error("[chats] list failed", error.message);
    return [];
  }
  return (data ?? []) as Chat[];
}

export async function listMessages(chatId: string): Promise<Message[]> {
  const { data, error } = await serviceClient()
    .from("chat_messages")
    .select("id, role, content, payload, followups")
    .eq("chat_id", chatId)
    .order("created_at");
  if (error) {
    console.error("[chats] messages failed", error.message);
    return [];
  }
  return (data ?? []) as Message[];
}
