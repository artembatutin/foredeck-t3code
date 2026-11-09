/**
 * The AI agent, model and provider names a new branch, commit or pull request must not hold. Ported
 * from Looper and widened to the providers T3 runs and the other well-known assistants, model
 * families and their makers. It lives here because Work names branches and Factory judges them, and
 * Work imports nothing of Factory. A list cannot name every tool; extend it here.
 */

/**
 * Names that are nothing else in a repository, matched as whole words with any model number they
 * run into, so "gpt4" counts and "gptq" passes.
 */
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
const NAME_WORDS = `\\b(${NAMES.join("|")})(\\d+[a-z]?)?\\b`;
const aiNames = new RegExp(NAME_WORDS, "i");

/** A trailer key's end as Git reads it: spaces or tabs may stand before the colon. */
const KEY_END = "[ \\t]*:";
/** The trailers that credit someone with the change or its idea. */
const CREDIT_KEY = `\\b(?:co-authored|signed-off|reviewed|acked|tested|helped|suggested|reported)-by${KEY_END}`;

/**
 * A name that is also an everyday programming word counts only where it can only mean the
 * product: its product forms, its domains (which its commit emails use), something said to be made
 * with it, and the capitalized name after a word of tool use ("drafted using Cursor"), or a credit
 * line naming it as the party credited (see `creditsCursor`). A database, text or pagination cursor
 * is not the Cursor editor, and neither is "Cursor-based pagination" or a "built-in cursor". Hyphens
 * count as spaces in the forms a branch's slug can hold, since a slug has nothing else to separate
 * words with.
 */
const PRODUCT_FORM = "\\bcursor[ -](agent|ai|ide|cli|editor|adapter|provider)s?\\b|\\banysphere\\b";
const MADE_WITH =
  "\\b(made|built|written|created|generated|drafted|coded|authored)[\\s-]+(with|using|by|via)[\\s-]+cursor\\b";
const DOMAIN = "\\bcursor[.-](com|sh)\\b";
const MADE_WITH_TRAILER = `\\bmade-with${KEY_END}[^\\n]*\\bcursor\\b`;
const aiProductForms = new RegExp(
  `${PRODUCT_FORM}|${MADE_WITH}|${DOMAIN}|${MADE_WITH_TRAILER}`,
  "i",
);
const PRODUCT_USE = "\\b(with|using|via|by|in|from|through)\\s+Cursor\\b(?!-)";
const aiProductUse = new RegExp(PRODUCT_USE);

/** A name or address that is only the Cursor editor's, with a role word at most. */
const ONLY_CURSOR = /^\W*cursor(\W*(ai|assistant|agent|bot|app|team))?\W*$/i;

/** Whether a name or address says the Cursor editor holds it. "Ada Cursor" is a person. */
export const isOnlyCursor = (text: string) => ONLY_CURSOR.test(text);

/**
 * Git reads a line that starts with whitespace and holds more as a continuation of the trailer above
 * it, so `Co-authored-by:` and a name on the next line are one credit. A blank line ends the trailer.
 */
const TRAILER_CONTINUATION = /\r?\n[ \t\r]+(?=\S)/g;

/**
 * A credit runs to the end of its line or to the next credit key on it. Git reads
 * `Signed-off-by: Ada <ada@example.com>` with `Co-authored-by: Cursor` after it, on that line or
 * indented below it, as one sign-off; read as one, the second credit would hide in a person's name.
 */
const CREDIT_LINE = new RegExp(`${CREDIT_KEY}((?:(?!${CREDIT_KEY})[^\\n])*)`, "gi");

/** What separates a credit's parties outside an address, as in "Ada, Grace and Mei". */
const PARTY_SEPARATOR = "[,;&+/]|\\b(?:and|plus)\\b";

/**
 * An address written without brackets, read whole up to the end of its domain: a `+`, `&` or `/` in
 * `ada+cursor@example.com` is part of one mailbox, and what follows the domain is another party. Only
 * one that starts a word counts, so a long line is searched for one once per word, not per character.
 */
const BARE_ADDRESS = "(?<![^\\s,;:>])[^\\s<>@,;]+@[\\w.-]*";

/**
 * One party of a credit: any word that only joins it to the last, then a bare address, or its name
 * and an address, which ends at whitespace when it is never closed so that nothing after it goes
 * unread. A name ends where a bare address starts. Read in turn, not split on a separator with a look
 * ahead for the address it may be in: a look ahead at each of a long line's separators is quadratic,
 * and this runs on whatever a commit message holds.
 */
const PARTY = new RegExp(
  `\\s*(?:(?:the|also)\\s+)*(?:(${BARE_ADDRESS})|((?:(?!${PARTY_SEPARATOR}|${BARE_ADDRESS})[^<>])*)(?:<([^>\\s]*))?>?)(?:${PARTY_SEPARATOR})?`,
  "gi",
);

/**
 * Who each line such as `Signed-off-by: Ada Lovelace <ada@example.com>` credits, as Git reads it and
 * however many it names: each name as written and its address up to the `@`, or a bare address's own.
 * What follows an address counts too, so `Ada Lovelace <ada@example.com> and Cursor` credits two.
 */
export const creditedParties = (text: string) =>
  [...text.replace(TRAILER_CONTINUATION, " ").matchAll(CREDIT_LINE)].flatMap(([, credit = ""]) =>
    [...credit.matchAll(PARTY)].flatMap(([, bare, written = "", email]) => {
      const name = (bare ?? written).trim();
      const address = (email ?? name).split("@")[0] ?? "";
      return name === "" && address === "" ? [] : [{ name, address }];
    }),
  );

/** Whether a credit line names the editor rather than a person who shares its name. */
const creditsCursor = (text: string) =>
  creditedParties(text).some(({ name, address }) => isOnlyCursor(name) || isOnlyCursor(address));

/** Whether the text names an AI agent, model or provider. */
export const namesAiTool = (text: string) =>
  aiNames.test(text) || aiProductForms.test(text) || aiProductUse.test(text) || creditsCursor(text);

const nameInSlug = new RegExp(`${NAME_WORDS}|${PRODUCT_FORM}|${MADE_WITH}|${DOMAIN}`, "gi");

/**
 * What only the original text can show: the rest of a credit line, which no branch name needs whoever
 * it credits, and a use that a slug's lowercase would make look like an everyday cursor.
 */
const CREDIT = `(?:${CREDIT_KEY}|\\bmade-with${KEY_END})[^\\n]*\\bcursor\\b`;
const nameInContext = [
  new RegExp(`${CREDIT}[^\\n]*`, "gi"),
  new RegExp(MADE_WITH, "gi"),
  new RegExp(PRODUCT_USE, "g"),
];

/**
 * Taking a name out can join its neighbours into another ("cursor-claude-agent"), so this repeats
 * until nothing changes.
 */
const withoutNames = (slug: string): string => {
  const next = slug
    .replace(nameInSlug, "")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "");
  return next === slug ? next : withoutNames(next);
};

/**
 * The text as at most `maxLength` lowercase letters, digits and single dashes, with every name taken
 * out. The original text is judged first, since a slug loses what tells a product from an everyday
 * word, and the cut is judged too, since it can leave a name ("claudette" after its sixth letter).
 */
export const slugWithoutAiNames = (text: string, maxLength: number): string => {
  const words = nameInContext
    .reduce(
      (rest, name) => rest.replace(name, " "),
      text.normalize("NFKD").replace(TRAILER_CONTINUATION, " "),
    )
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-");
  return withoutNames(withoutNames(words).slice(0, maxLength));
};
