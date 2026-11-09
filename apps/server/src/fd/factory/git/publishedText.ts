import { creditedParties, isOnlyCursor, namesAiTool } from "@t3tools/shared/fd/publishedNames";

/**
 * What Factory refuses in what it publishes: the branch, the commit messages settle checks and the
 * pull request text it writes. `evaluatePublication` in `settle.ts` applies all of it right before a
 * push or pull request. The names themselves are in `@t3tools/shared/fd/publishedNames`, which Work
 * reads too for the branches it names.
 */
export { namesAiTool };

/**
 * Generated or assisted attribution anywhere, not only as a line-start trailer, so an inline or
 * indented "Generated-by:" is caught too. A trailer key can have spaces or tabs before its colon, as
 * Git reads it. Who a credit line names is judged apart, by who it names.
 */
const aiAttribution =
  /\b(generated|assisted)-by\b|\b(generated|made)-with[ \t]*:|(^|\n)\s*ai-[a-z-]+[ \t]*:|generated\s+with|\bai[- ](generated|assisted)\b|\b(generated|written|created|made)\s+(by|with|using)\s+(an?\s+)?ai\b/i;

/** A name or address that is only an assistant's word, with a role word at most. */
const ONLY_ASSISTANT = /^\W*(ai|assistant|llm)(\W*(ai|assistant|agent|bot|app))?\W*$/i;
/**
 * Whether a person's name says an assistant holds it. "AI" in capitals does anywhere, and so does
 * "ai" in a lowercase handle such as "sweep-ai[bot]". "Ai" in a longer name is a given name.
 */
const nameIsAssistant = (name: string) =>
  /\bAI\b|^[a-z0-9_-]*\bai\b[a-z0-9_-]*(\[bot\])?$/.test(name) ||
  /\b(assistant|llm)\b/i.test(name) ||
  ONLY_ASSISTANT.test(name);

const localPart = (email: string) => email.split("@")[0] ?? "";

/**
 * Whether the text carries generated or assisted attribution, or credits an assistant. A person named
 * Ai is not attribution, so a credit line is judged by who it names. One credited to a named tool is
 * caught by that name.
 */
export const carriesAiAttribution = (text: string) =>
  aiAttribution.test(text) ||
  creditedParties(text).some(
    ({ name, address }) => nameIsAssistant(name) || ONLY_ASSISTANT.test(address),
  );

/**
 * Whether a commit's author or committer is a tool. An identity names one party, so what would be an
 * everyday word in a sentence says who it is here: "Cursor" and "AI Assistant" are not people, while
 * "Ada Cursor" and "Ai Nguyen" are.
 */
export const identityIsAiTool = (identity: { readonly name: string; readonly email: string }) => {
  const { name, email } = identity;
  return (
    namesAiTool(`${name}\n${email}`) ||
    nameIsAssistant(name.trim()) ||
    isOnlyCursor(name) ||
    ONLY_ASSISTANT.test(localPart(email)) ||
    isOnlyCursor(localPart(email))
  );
};

/** A Conventional Commit subject or pull request title: its type, scope and breaking mark. */
export const conventionalSubject =
  /^(feat|fix|chore|docs|style|refactor|perf|test|build|ci|revert)(?:\(([^)]+)\))?(!)?: \S/;

/** The fork's task branches: `feature/`, `bugfix/`, `chore/` or `docs/` with a name after it. */
const neutralBranch = /^(feature|bugfix|chore|docs)\/\S/;

/** What keeps the branch from being published, whenever it was created. */
export const branchProblems = (branch: string) => [
  ...(neutralBranch.test(branch) ? [] : (["branch_prefix"] as const)),
  ...(namesAiTool(branch) ? (["ai_name_in_branch"] as const) : []),
  ...(carriesAiAttribution(branch) ? (["ai_attribution_in_branch"] as const) : []),
];

/** How long a pull request title may be, as the fork's commit subjects aim to be. */
export const PULL_REQUEST_TITLE_MAX_CHARS = 72;

const holdsKey = (title: string, key: string) =>
  new RegExp(`(?<![\\w-])${key.replace(/[.*+?^${}()|[\]\\/-]/g, "\\$&")}(?![\\w-])`).test(title);

/** A rule pull request text breaks; Factory publishes neither field while one does. */
interface FactoryPullRequestTextProblem {
  readonly field: "title" | "body";
  readonly rule: "malformed_title" | "ai_name" | "ai_attribution";
}

/**
 * What keeps the text from being published, in field order; empty when nothing does. The title must
 * be one short Conventional line holding the item's verified key, whoever wrote it.
 */
export const pullRequestTextProblems = (text: {
  readonly title: string;
  readonly body: string;
  readonly key: string;
}): ReadonlyArray<FactoryPullRequestTextProblem> => {
  const { title, key } = text;
  const wellFormed =
    !/[\r\n]/.test(title) &&
    title.length <= PULL_REQUEST_TITLE_MAX_CHARS &&
    conventionalSubject.test(title) &&
    holdsKey(title, key);
  return [
    ...(wellFormed ? [] : [{ field: "title" as const, rule: "malformed_title" as const }]),
    ...(["title", "body"] as const).flatMap((field) => [
      ...(namesAiTool(text[field]) ? [{ field, rule: "ai_name" as const }] : []),
      ...(carriesAiAttribution(text[field]) ? [{ field, rule: "ai_attribution" as const }] : []),
    ]),
  ];
};
