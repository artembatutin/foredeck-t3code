/**
 * What Factory refuses in text it publishes: the commit messages settle checks and the pull
 * request text it writes. Ported from Looper. Names match whole words only, so "gptq" passes.
 * Attribution matches anywhere, not only as a line-start trailer, so an inline or indented
 * "Generated-by:" is caught too.
 */
export const aiNames = /\b(claude|codex|chatgpt|gpt|openai|anthropic|devin|cognition)\b/i;
export const aiAttribution = /\b(generated|assisted)-by\b|generated\s+with/i;
