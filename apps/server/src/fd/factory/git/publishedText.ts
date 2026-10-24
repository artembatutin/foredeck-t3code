/**
 * What Factory refuses in text it publishes: the commit messages settle checks and the pull
 * request text it writes. Ported from Looper and widened to the providers T3 runs and the other
 * well-known assistants, model families and their makers. A list cannot name every tool; extend
 * it here, where both checks read it.
 */

/** Names that are nothing else in a repository, matched as whole words, so "gptq" passes. */
const NAMES = [
  // Looper's list.
  "claude",
  "codex",
  "chatgpt",
  "gpt",
  "openai",
  "anthropic",
  "devin",
  "cognition",
  // The other providers T3 runs.
  "grok",
  "opencode",
  "antigravity",
  // Other assistants, model families and their makers.
  "copilot",
  "gemini",
  "gemma",
  "windsurf",
  "codeium",
  "aider",
  "cline",
  "tabnine",
  "deepseek",
  "qwen",
  "mistral",
  "mixtral",
  "llama",
  "xai",
];
const aiNames = new RegExp(`\\b(${NAMES.join("|")})\\b`, "i");

/**
 * A name that is also an everyday programming word counts only where it can only mean the
 * product: its product forms, its domains (which its commit emails use), a co-author line, and
 * the capitalized name after a word of tool use ("made with Cursor"). A database, text or
 * pagination cursor is not the Cursor editor, and neither is "Cursor-based pagination".
 */
const aiProductForms =
  /\bcursor[ -](agent|ai|ide|cli|editor|adapter|provider)s?\b|\banysphere\b|\bcursor\.(com|sh)\b|co-authored-by:[^\n]*\bcursor\b/i;
const aiProductUse = /\b(with|using|via|by|in|from|through)\s+Cursor\b(?!-)/;

/**
 * Generated or assisted attribution anywhere, not only as a line-start trailer, so an inline or
 * indented "Generated-by:" is caught too, and co-authorship credited to an assistant. A human
 * co-author is not attribution; one credited to a named tool is caught by its name.
 */
const aiAttribution =
  /\b(generated|assisted)-by\b|generated\s+with|\bai[- ]generated\b|\b(generated|written|created|made)\s+(by|with|using)\s+(an?\s+)?ai\b|co-authored-by:[^\n]*\b(ai|assistant|llm)\b/i;

/** Whether the text names an AI agent, model or provider. */
export const namesAiTool = (text: string) =>
  aiNames.test(text) || aiProductForms.test(text) || aiProductUse.test(text);

/** Whether the text carries generated or assisted attribution, or AI co-authorship. */
export const carriesAiAttribution = (text: string) => aiAttribution.test(text);
