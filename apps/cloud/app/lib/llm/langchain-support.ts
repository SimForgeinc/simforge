import { ChatAnthropic } from "@langchain/anthropic";

export const DEFAULT_ANTHROPIC_MODEL = "claude-sonnet-4-6";

export function anthropicConfigured() {
  return Boolean(process.env.ANTHROPIC_API_KEY?.trim());
}

export function isAnthropicThinkingEnabled(): boolean {
  return process.env.ANTHROPIC_THINKING_ENABLED?.trim().toLowerCase() === "true";
}

export function createChatModel() {
  const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
  if (!apiKey) {
    throw new Error("ANTHROPIC_API_KEY environment variable is not set.");
  }

  return new ChatAnthropic({
    apiKey,
    model: process.env.ANTHROPIC_MODEL?.trim() || DEFAULT_ANTHROPIC_MODEL,
    temperature: 0.2,
    maxTokens: 4096,
  });
}

export function traceableFunction<T extends (...args: never[]) => unknown>(fn: T): T {
  return fn;
}
