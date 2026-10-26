import * as NodeFS from "node:fs";

import type { FactoryFleetEnvironment } from "@t3tools/client-runtime/fd/factory";
import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { type FactoryDelivery, FactoryDeliveryId } from "@t3tools/contracts/fd/factory";
import { WorkItemId, WorkSourceId } from "@t3tools/contracts/fd/work-management";
import { describe, expect, it } from "vite-plus/test";

import { mobileFleetRows, mobileFleetRowTarget } from "./fleetList";

const envA = EnvironmentId.make("env-a");
const envB = EnvironmentId.make("env-b");
const projectA = ProjectId.make("project-a");
const projectB = ProjectId.make("project-b");
const sourceId = WorkSourceId.make("6f9b1c2e-3d4a-4b5c-8d6e-7f8091a2b3c4");

const delivery = (
  id: string,
  createdAt: string,
  overrides: Partial<FactoryDelivery> = {},
): FactoryDelivery => ({
  deliveryId: FactoryDeliveryId.make(id),
  projectId: projectA,
  itemRef: { sourceId, itemId: WorkItemId.make(`item-${id}`) },
  childIds: [],
  status: "running",
  rounds: { fix: 0, review: 0 },
  threads: {},
  receipts: [],
  reviews: [],
  stageRuns: [],
  createdAt,
  updatedAt: createdAt,
  ...overrides,
});

const env = (
  environmentId: EnvironmentId,
  deliveries: ReadonlyArray<FactoryDelivery> | null,
  supported = true,
): FactoryFleetEnvironment => ({ environmentId, supported, deliveries });

const LABELS = {
  projects: [
    { environmentId: envA, id: projectA, title: "Foredeck" },
    { environmentId: envB, id: projectA, title: "Foredeck on B" },
  ],
  environments: [
    { environmentId: envA, environmentLabel: "Laptop" },
    { environmentId: envB, environmentLabel: "Server" },
  ],
};

describe("mobileFleetRows", () => {
  it("lists active deliveries needing you first, with their labels, and leaves terminal ones out", () => {
    const rows = mobileFleetRows(
      [
        env(envA, [
          delivery("running", "2026-10-26T10:00:00.000Z", {
            stage: { name: "author", kind: "agent" },
          }),
          delivery("blocked", "2026-10-26T08:00:00.000Z", {
            status: "blocked",
            stage: { name: "verify", kind: "command" },
            needsYou: "Verify failed twice with the same failure.",
          }),
          delivery("done", "2026-10-26T11:00:00.000Z", { status: "done" }),
          delivery("unknown", "2026-10-26T06:00:00.000Z", { status: "unknown" }),
        ]),
      ],
      LABELS,
    );
    expect(rows.map((row) => row.key)).toEqual(["env-a:blocked", "env-a:running", "env-a:unknown"]);
    expect(rows[0]).toEqual({
      key: "env-a:blocked",
      project: "Foredeck",
      item: "item-blocked",
      status: "Blocked",
      stage: "Verify",
      needsYou: "Verify failed twice with the same failure.",
      target: {
        name: "WorkItem",
        params: {
          environmentId: envA,
          projectId: projectA,
          sourceId,
          itemId: "item-blocked",
        },
      },
    });
    expect(rows[1]).toMatchObject({ status: "Running", stage: "Author", needsYou: undefined });
    // A status this build does not know stays listed: the delivery may still be running.
    expect(rows[2]).toMatchObject({ status: "Unknown", stage: undefined, needsYou: undefined });
  });

  it("orders environments' rows as the shared fleet does and names each environment", () => {
    const rows = mobileFleetRows(
      [
        env(envA, [
          delivery("a-running", "2026-10-26T10:00:00.000Z"),
          delivery("a-cancelled", "2026-10-26T12:00:00.000Z", { status: "cancelled" }),
        ]),
        env(envB, [
          delivery("b-waiting", "2026-10-26T09:00:00.000Z", {
            status: "waiting",
            stage: { name: "approve_plan", kind: "gate" },
          }),
          delivery("b-pr", "2026-10-26T07:00:00.000Z", {
            status: "pr_open",
            projectId: projectB,
            stage: { name: "pr", kind: "pr" },
          }),
        ]),
      ],
      LABELS,
    );
    expect(
      rows.map(({ key, project, status, stage, needsYou }) => ({
        key,
        project,
        status,
        stage,
        needsYou,
      })),
    ).toEqual([
      {
        key: "env-b:b-waiting",
        project: "Foredeck on B · Server",
        status: "Waiting for you",
        stage: "Plan approval",
        // The server sent no reason, so the shared fallback stands.
        needsYou: "Factory is waiting for your decision.",
      },
      {
        key: "env-a:a-running",
        project: "Foredeck · Laptop",
        status: "Running",
        stage: undefined,
        needsYou: undefined,
      },
      {
        key: "env-b:b-pr",
        // A project this device has not loaded is named by its id.
        project: "project-b · Server",
        status: "PR open",
        stage: "Pull request",
        needsYou: undefined,
      },
    ]);
  });

  it("names no environment when only one serves Factory", () => {
    const rows = mobileFleetRows(
      [
        env(envA, [delivery("d1", "2026-10-26T10:00:00.000Z")]),
        env(envB, [delivery("d2", "2026-10-26T10:00:00.000Z")], false),
      ],
      LABELS,
    );
    expect(rows.map(({ key, project }) => ({ key, project }))).toEqual([
      { key: "env-a:d1", project: "Foredeck" },
    ]);
  });
});

describe("mobileFleetRowTarget", () => {
  it("opens the Work item screen of the delivery's environment, project, source and item", () => {
    expect(
      mobileFleetRowTarget({
        environmentId: envB,
        projectId: projectB,
        itemRef: { sourceId, itemId: WorkItemId.make("fd-7k3qa2") },
      }),
    ).toEqual({
      name: "WorkItem",
      params: {
        environmentId: "env-b",
        projectId: "project-b",
        sourceId: "6f9b1c2e-3d4a-4b5c-8d6e-7f8091a2b3c4",
        itemId: "fd-7k3qa2",
      },
    });
  });
});

describe("Work's independence", () => {
  it("has no mobile Work file importing Factory", () => {
    const directory = new URL("../work-management/", import.meta.url);
    const importers = NodeFS.readdirSync(directory)
      .filter((name) => /\.tsx?$/.test(name))
      .filter((name) =>
        /from\s+["'][^"']*\bfactory\b[^"']*["']|import\(\s*["'][^"']*\bfactory\b/.test(
          NodeFS.readFileSync(new URL(name, directory), "utf8"),
        ),
      );
    expect(importers).toEqual([]);
  });
});
