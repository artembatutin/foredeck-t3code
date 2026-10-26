import { RegistryContext } from "@effect/atom-react";
import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import {
  type FactoryDelivery,
  FactoryDeliveryId,
  type FactoryReviewDetails,
  type FactoryReviewSummary,
  type FactoryStageRunSummary,
} from "@t3tools/contracts/fd/factory";
import { WorkItemId, WorkSourceId } from "@t3tools/contracts/fd/work-management";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { act, createElement, Fragment, type ReactNode } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

// The section's destination: supported, connected and permitted, with these deliveries.
const destination = vi.hoisted(() => ({ deliveries: undefined as unknown }));

vi.mock("./state", async () => {
  const { Atom } = await import("effect/reactivity");
  const yes = Atom.make(true).pipe(Atom.keepAlive);
  const command = { permissionAtom: () => yes };
  return {
    factoryEnvironment: {
      supported: () => yes,
      planning: () => yes,
      deliveries: () => destination.deliveries,
      start: command,
      stop: command,
      resume: command,
      cancel: command,
      updatePlan: command,
      approvePlan: command,
      rejectPlan: command,
      replan: command,
    },
  };
});
vi.mock("../../state/environments", () => ({
  useConnectedEnvironmentIds: () => ["env-1"],
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: () => () => Promise.resolve({ _tag: "Success", value: undefined }),
}));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => () => undefined }));
vi.mock("../../components/ui/button", () => ({
  Button: (props: object) => createElement("button", props),
}));
vi.mock("../../components/ui/badge", () => ({
  Badge: ({ children }: { children: ReactNode }) => createElement("span", null, children),
}));
vi.mock("../../components/ui/alert-dialog", () => {
  const Part = ({ children }: { children?: ReactNode }) => createElement(Fragment, null, children);
  return {
    AlertDialog: () => null,
    AlertDialogPopup: Part,
    AlertDialogHeader: Part,
    AlertDialogFooter: Part,
    AlertDialogTitle: Part,
    AlertDialogDescription: Part,
    AlertDialogClose: Part,
  };
});

import { FactoryItemSection } from "./FactoryItemSection";
import { factoryItemSection } from "./itemSection";

const environmentId = EnvironmentId.make("env-1");
const projectId = ProjectId.make("p1");
const itemRef = {
  sourceId: WorkSourceId.make("6f9b1c2e-3d4a-4b5c-8d6e-7f8091a2b3c4"),
  itemId: WorkItemId.make("fd-7k3qa2"),
};
const HEAD = "0123456789abcdef0123456789abcdef01234567";
const reviewer = ThreadId.make("thread-reviewer");
const ms = (offset: number) => `2026-10-25T09:00:00.${String(offset).padStart(3, "0")}Z`;

const details: FactoryReviewDetails = {
  findings: [
    {
      id: "no-header",
      severity: "high",
      required: true,
      blocking: true,
      file: "src/export.ts",
      line: 12,
      detail: "The export writes no header row.",
    },
    {
      id: "slow-join",
      severity: "medium",
      required: false,
      blocking: false,
      file: "src/join.ts",
      line: null,
      detail: "Rows are joined in a loop.",
    },
  ],
  criteria: [
    { criterion: 2, status: "failed", detail: "A comma in a name splits the row." },
    { criterion: 3, status: "untested", detail: "Nothing exports an empty table." },
  ],
  missingEvidence: ["A test that exports an empty table."],
  omitted: { findings: 4, criteria: 0, missingEvidence: 0 },
};

const review = (overrides: Partial<FactoryReviewSummary> = {}): FactoryReviewSummary => ({
  headSha: HEAD,
  verdict: "changes-required",
  blocking: true,
  findings: { high: 1, medium: 1, low: 4 },
  reviewedAt: ms(9),
  ...overrides,
});

/** A verify, the review attempt that accepted review 1, and the repair it led to. */
const attempts: Array<FactoryStageRunSummary> = [
  { stage: "verify", attempt: 1, outcome: "passed", startedAt: ms(0), finishedAt: ms(2) },
  {
    stage: "review",
    attempt: 1,
    outcome: "failed",
    threadId: reviewer,
    startedAt: ms(3),
    finishedAt: ms(9),
    reviewNumber: 1,
  },
  { stage: "repair", attempt: 1, outcome: null, startedAt: ms(9) },
];

const delivery = (overrides: Partial<FactoryDelivery>): FactoryDelivery => ({
  deliveryId: FactoryDeliveryId.make("d1"),
  projectId,
  itemRef,
  childIds: [],
  status: "running",
  stage: { name: "repair", kind: "agent" },
  rounds: { fix: 0, review: 1 },
  threads: { reviewer },
  receipts: [],
  reviews: [],
  stageRuns: attempts,
  createdAt: ms(0),
  updatedAt: ms(9),
  ...overrides,
});

const viewOf = (overrides: Partial<FactoryDelivery>) =>
  factoryItemSection({
    environmentId,
    itemRef,
    supported: true,
    connected: true,
    deliveries: [delivery(overrides)],
    started: [],
    permitted: { start: true, stop: true, resume: true, cancel: true },
  })?.delivery;

const NOTES = [
  {
    key: "finding:no-header",
    label: "High",
    required: true,
    blocking: true,
    location: "src/export.ts:12",
    detail: "The export writes no header row.",
  },
  {
    key: "finding:slow-join",
    label: "Medium",
    required: false,
    blocking: false,
    location: "src/join.ts",
    detail: "Rows are joined in a loop.",
  },
  {
    key: "criterion:2",
    label: "Criterion 2 failed",
    required: false,
    blocking: true,
    location: undefined,
    detail: "A comma in a name splits the row.",
  },
  {
    key: "criterion:3",
    label: "Criterion 3 untested",
    required: false,
    blocking: true,
    location: undefined,
    detail: "Nothing exports an empty table.",
  },
  {
    key: "missing:0",
    label: "Missing evidence",
    required: false,
    blocking: true,
    location: undefined,
    detail: "A test that exports an empty table.",
  },
];

describe("Factory item section review findings", () => {
  it("lists a review's findings, criteria and missing evidence under its attempt", () => {
    const view = viewOf({ reviews: [review({ number: 1, details })] });
    expect(view?.timeline.map((row) => [row.stage, row.reviews.map(({ notes }) => notes)])).toEqual(
      [
        ["Verify", []],
        ["Review", [NOTES]],
        ["Repair", []],
      ],
    );
    const [line] = view?.timeline[1]?.reviews ?? [];
    expect(line?.text).toBe("Changes required, blocking on 0123456: 1 high, 1 medium, 4 low");
    expect(line?.omitted).toBe("Not shown: 4 more findings.");
    expect(view?.reviews).toEqual([]);
  });

  it("lists them under the delivery for a review no attempt names", () => {
    const view = viewOf({ reviews: [review({ details })] });
    expect(view?.timeline.flatMap((row) => row.reviews)).toEqual([]);
    expect(view?.reviews.map(({ notes }) => notes)).toEqual([NOTES]);
  });

  it("says how many of each list the server left out", () => {
    const view = viewOf({
      reviews: [
        review({
          number: 1,
          details: { ...details, omitted: { findings: 1, criteria: 2, missingEvidence: 1 } },
        }),
      ],
    });
    expect(view?.timeline[1]?.reviews[0]?.omitted).toBe(
      "Not shown: 1 more finding, 2 more criteria and 1 more missing evidence entry.",
    );
  });

  it.each([
    ["from a server that keeps no details", review({ number: 1 })],
    [
      "that raised nothing",
      review({
        number: 1,
        verdict: "pass",
        blocking: false,
        findings: { high: 0, medium: 0, low: 0 },
        details: {
          findings: [],
          criteria: [],
          missingEvidence: [],
          omitted: { findings: 0, criteria: 0, missingEvidence: 0 },
        },
      }),
    ],
  ])("shows no findings for a review %s", (_, summary) => {
    const [line] = viewOf({ reviews: [summary] })?.timeline[1]?.reviews ?? [];
    expect(line?.notes).toEqual([]);
    expect(line?.omitted).toBeUndefined();
  });
});

/** Reviewer text a renderer that read HTML or Markdown would turn into elements and links. */
const HOSTILE =
  '<img src=x onerror="alert(1)"> **Fix** [the docs](https://evil.example/x) <a href="https://evil.example">here</a> <script>alert(2)</script>';

let renderer: ReactTestRenderer | undefined;

afterEach(async () => {
  await act(() => renderer?.unmount());
  renderer = undefined;
  destination.deliveries = undefined;
});

describe("Factory item section reviewer text", () => {
  it("keeps the view model's text literal and renders it as a text node", async () => {
    const hostile = {
      ...details,
      findings: [{ ...details.findings[0]!, detail: HOSTILE }],
      criteria: [],
      missingEvidence: [HOSTILE],
    };
    const reviews = [review({ number: 1, details: hostile })];
    expect(viewOf({ reviews })?.timeline[1]?.reviews[0]?.notes.map(({ detail }) => detail)).toEqual(
      [HOSTILE, HOSTILE],
    );

    destination.deliveries = Atom.make(
      AsyncResult.success({ deliveries: [delivery({ reviews })] }),
    ).pipe(Atom.keepAlive);
    await act(() => {
      renderer = create(
        createElement(
          RegistryContext.Provider,
          { value: AtomRegistry.make() },
          createElement(FactoryItemSection, {
            environmentId,
            projectId,
            item: { ref: itemRef, key: "FD-12" },
          }),
        ),
      );
    });
    const root = renderer!.root;

    // Each is one element whose only child is the raw string: a text node.
    const rows = root.findAll((node) => node.children.length === 1 && node.children[0] === HOSTILE);
    expect(rows.map((row) => row.type)).toEqual(["p", "p"]);
    expect(
      root.findAll((node) => ["a", "img", "script", "strong"].includes(String(node.type))),
    ).toEqual([]);
    expect(root.findAll((node) => node.props.dangerouslySetInnerHTML !== undefined)).toEqual([]);
  });
});
