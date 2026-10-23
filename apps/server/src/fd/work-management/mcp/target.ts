import {
  parseWorkItemRefString,
  type WorkItemRef,
  WorkItemId,
  type WorkSource,
  type WorkSourceId,
} from "@t3tools/contracts/fd/work-management";

/**
 * How an agent names an item: the canonical `<sourceId>:<itemId>`, a key a human would type
 * (`fd-7k3qa2`, `#123`, `PROJ-12`) or the item's URL. Pure, so every spelling is tested.
 */
export type WorkItemReference =
  | { readonly type: "ref"; readonly ref: WorkItemRef }
  | { readonly type: "markdown"; readonly itemId: WorkItemId }
  | { readonly type: "github"; readonly itemId: WorkItemId; readonly repository?: string }
  | { readonly type: "jira"; readonly itemId: WorkItemId; readonly host?: string };

const MARKDOWN_KEY = /^fd-[0-9a-hjkmnp-tv-z]{6}$/i;
const GITHUB_KEY = /^#?(\d+)$/;
const JIRA_KEY = /^[A-Za-z][A-Za-z0-9_]+-\d+$/;

export const parseWorkItemReference = (text: string): WorkItemReference | undefined => {
  const value = text.trim();
  const ref = parseWorkItemRefString(value);
  if (ref !== undefined) return { type: "ref", ref };
  if (MARKDOWN_KEY.test(value)) {
    return { type: "markdown", itemId: WorkItemId.make(value.toLowerCase()) };
  }
  const github = GITHUB_KEY.exec(value);
  if (github !== null) return { type: "github", itemId: WorkItemId.make(github[1]!) };
  if (JIRA_KEY.test(value)) return { type: "jira", itemId: WorkItemId.make(value.toUpperCase()) };
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  const segments = url.pathname.split("/").filter((segment) => segment.length > 0);
  const host = url.host.toLowerCase();
  // https://<host>/<owner>/<name>/issues/<n>
  if (segments.length >= 4 && segments[2] === "issues" && /^\d+$/.test(segments[3]!)) {
    return {
      type: "github",
      itemId: WorkItemId.make(segments[3]!),
      repository: `${host}/${segments[0]}/${segments[1]}`.toLowerCase(),
    };
  }
  // https://<site>/browse/<KEY-1>
  const browse = segments.indexOf("browse");
  const key = browse >= 0 ? segments[browse + 1] : undefined;
  if (key !== undefined && JIRA_KEY.test(key)) {
    return { type: "jira", itemId: WorkItemId.make(key.toUpperCase()), host };
  }
  return undefined;
};

const hostOf = (siteUrl: string): string => {
  try {
    return new URL(siteUrl).host.toLowerCase();
  } catch {
    return siteUrl.trim().toLowerCase();
  }
};

/** Whether a source could hold the referenced item. */
const sourceMatches = (source: WorkSource, reference: WorkItemReference): boolean => {
  const config = source.config;
  switch (reference.type) {
    case "ref":
      return source.sourceId === reference.ref.sourceId;
    case "markdown":
      return config.kind === "markdown";
    case "github":
      return (
        config.kind === "github" &&
        (reference.repository === undefined ||
          `${config.host}/${config.owner}/${config.name}`.toLowerCase() === reference.repository)
      );
    case "jira":
      return (
        config.kind === "jira" &&
        reference.itemId.startsWith(`${config.projectKey.toUpperCase()}-`) &&
        (reference.host === undefined || hostOf(config.siteUrl) === reference.host)
      );
  }
};

export type WorkTargetResolution =
  | { readonly ok: true; readonly ref: WorkItemRef }
  | { readonly ok: false; readonly message: string };

/**
 * The item a reference names among a project's active sources. `sourceId` settles a reference
 * two sources could hold; without it an ambiguous one is refused rather than guessed.
 */
export const resolveWorkTarget = (input: {
  readonly reference: WorkItemReference;
  readonly sources: ReadonlyArray<WorkSource>;
  readonly sourceId?: WorkSourceId | undefined;
}): WorkTargetResolution => {
  const { reference } = input;
  const active = input.sources.filter((source) => source.state === "active");
  const candidates = active.filter(
    (source) =>
      (input.sourceId === undefined || source.sourceId === input.sourceId) &&
      sourceMatches(source, reference),
  );
  const itemId = reference.type === "ref" ? reference.ref.itemId : reference.itemId;
  if (candidates.length === 1)
    return { ok: true, ref: { sourceId: candidates[0]!.sourceId, itemId } };
  if (candidates.length === 0) {
    return {
      ok: false,
      message:
        active.length === 0
          ? "This project has no active Work sources."
          : `No active Work source of this project holds that item. Sources: ${describeSources(active)}.`,
    };
  }
  return {
    ok: false,
    message: `Several Work sources could hold that item; pass sourceId. Sources: ${describeSources(candidates)}.`,
  };
};

export const describeSources = (sources: ReadonlyArray<WorkSource>): string =>
  sources.map((source) => `${source.sourceId} (${source.kind}, ${source.label})`).join("; ");
