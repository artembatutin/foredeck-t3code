import { describe, expect, it } from "@effect/vitest";
import { ProjectId } from "@t3tools/contracts";
import {
  type WorkSource,
  type WorkSourceConfig,
  WorkSourceId,
} from "@t3tools/contracts/fd/work-management";

import { parseWorkItemReference, resolveWorkTarget } from "./target.ts";

const id = (n: number) => WorkSourceId.make(`00000000-0000-4000-8000-00000000000${n}`);

const source = (
  n: number,
  config: WorkSourceConfig,
  state: WorkSource["state"] = "active",
): WorkSource => ({
  sourceId: id(n),
  projectId: ProjectId.make("p"),
  kind: config.kind,
  identity: String(n),
  label: `Source ${n}`,
  config,
  state,
  version: 1,
  credential: { configured: false },
  capabilities: {
    create: true,
    statuses: [],
    fields: [],
    comments: "add",
    transitions: false,
    people: false,
  },
  health: { status: "ok" },
  updatedAt: "2026-10-21T09:00:00.000Z",
});

const markdown = source(1, { kind: "markdown", directory: ".foredeck/work", autoStart: true });
const github = source(2, { kind: "github", host: "github.com", owner: "Acme", name: "App" });
const jira = source(3, {
  kind: "jira",
  siteUrl: "https://acme.atlassian.net",
  projectKey: "PROJ",
  email: "me@acme.test",
});

describe("parseWorkItemReference", () => {
  it("reads every spelling an agent uses", () => {
    expect(parseWorkItemReference(`${id(1)}:fd-7k3qa2`)).toEqual({
      type: "ref",
      ref: { sourceId: id(1), itemId: "fd-7k3qa2" },
    });
    expect(parseWorkItemReference("FD-7K3QA2")).toEqual({ type: "markdown", itemId: "fd-7k3qa2" });
    expect(parseWorkItemReference("#123")).toEqual({ type: "github", itemId: "123" });
    expect(parseWorkItemReference("proj-12")).toEqual({ type: "jira", itemId: "PROJ-12" });
    expect(parseWorkItemReference("https://github.com/Acme/App/issues/9#top")).toEqual({
      type: "github",
      itemId: "9",
      repository: "github.com/acme/app",
    });
    expect(parseWorkItemReference("https://acme.atlassian.net/browse/PROJ-4")).toEqual({
      type: "jira",
      itemId: "PROJ-4",
      host: "acme.atlassian.net",
    });
    expect(parseWorkItemReference("fix the bug")).toBeUndefined();
  });
});

describe("resolveWorkTarget", () => {
  const sources = [markdown, github, jira];

  it("finds the one source that can hold the item", () => {
    for (const [text, sourceId] of [
      ["fd-7k3qa2", id(1)],
      ["#5", id(2)],
      ["https://github.com/acme/app/issues/5", id(2)],
      ["PROJ-1", id(3)],
    ] as const) {
      const resolved = resolveWorkTarget({ reference: parseWorkItemReference(text)!, sources });
      expect(resolved.ok && resolved.ref.sourceId, text).toBe(sourceId);
    }
  });

  it("refuses ambiguous, foreign and disconnected targets", () => {
    const second = source(4, { kind: "markdown", directory: "tasks", autoStart: true });
    const ambiguous = resolveWorkTarget({
      reference: parseWorkItemReference("fd-7k3qa2")!,
      sources: [markdown, second],
    });
    expect(ambiguous).toMatchObject({ ok: false });
    expect(
      resolveWorkTarget({
        reference: parseWorkItemReference("fd-7k3qa2")!,
        sources: [markdown, second],
        sourceId: id(4),
      }),
    ).toMatchObject({ ok: true, ref: { sourceId: id(4) } });
    expect(
      resolveWorkTarget({ reference: parseWorkItemReference("OTHER-1")!, sources }),
    ).toMatchObject({ ok: false });
    expect(
      resolveWorkTarget({
        reference: parseWorkItemReference("#1")!,
        sources: [source(2, github.config, "disconnected")],
      }),
    ).toMatchObject({ ok: false });
  });
});
