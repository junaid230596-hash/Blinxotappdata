import { logger } from "../../logger.js";

/**
 * The only seam between Blinxot and an AI vendor. A provider receives the list of tools the *current user* may call
 * (already filtered by their permissions) and returns text and/or tool calls. It never touches the database:
 * every tool call it requests goes back through `runTool()` in ai.tools.ts, which re-checks permissions and validates input.
 */
export interface AiToolSpec { name: string; description: string; inputSchema: Record<string, unknown> }
export interface AiMessage { role: "user" | "assistant" | "tool"; content: string; toolName?: string }
export interface AiReply { text?: string; toolCalls?: { name: string; input: unknown }[] }
export interface AiProvider {
  readonly name: string;
  complete(input: { system: string; messages: AiMessage[]; tools: AiToolSpec[] }): Promise<AiReply>;
}

/** Default: no vendor connected. Connect one by implementing AiProvider and returning it from getProvider(). */
export const nullProvider: AiProvider = {
  name: "none",
  async complete() { throw new Error("No AI provider is configured"); },
};

export function getProvider(): AiProvider {
  // Example wiring (not enabled): if (process.env.AI_PROVIDER === "anthropic") return anthropicProvider();
  logger.debug("AI provider requested; none configured");
  return nullProvider;
}
