import * as Exit from "effect/Exit";
import * as Rpc from "effect/rpc/Rpc";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  FACTORY_REPLAN_NOTE_MAX_LENGTH,
  FACTORY_WS_METHODS,
  FactoryDelivery,
  FactoryDeliveryList,
  FactoryPlanReplanInput,
  FactoryPlanUpdateInput,
  FactoryReplanNote,
  FactoryRpcs,
} from "./index.ts";

const task = (id: string) => ({
  id,
  title: `Task ${id}`,
  kind: "feature",
  summary: `Build ${id}.`,
  acceptance: [`${id} works.`],
  testPlan: [{ criterion: 1, check: `${id} is tested.`, paths: [`src/${id}.test.ts`] }],
  likelyPaths: [`src/${id}.ts`],
  risk: "normal",
});
const plan = { tasks: [task("export-csv"), task("export-header")], note: "Both touch export." };

/** A parent waiting at the plan gate, as a server from before planning's gate sends it. */
const waiting = {
  deliveryId: "d-1",
  projectId: "project-1",
  itemRef: { sourceId: "7e2aa85e-9347-44ce-b019-cb8dfd365b20", itemId: "fd-7k3qa2" },
  childIds: [],
  status: "waiting",
  stage: { name: "approve_plan", kind: "gate" },
  rounds: { fix: 0, review: 0 },
  threads: { planner: "thread-planner" },
  receipts: [],
  reviews: [],
  stageRuns: [],
  needsYou: "A plan of 2 tasks awaits your approval.",
  createdAt: "2026-10-23T08:59:00.000Z",
  updatedAt: "2026-10-23T09:12:00.000Z",
};

const decodeDelivery = Schema.decodeUnknownSync(FactoryDelivery);
const encodeDelivery = Schema.encodeSync(FactoryDelivery);
const decodeList = Schema.decodeUnknownSync(FactoryDeliveryList);

/** The snapshot schema of a client from before the plan field. */
const { plan: _plan, ...fieldsBeforePlan } = FactoryDelivery.fields;
const decodeBeforePlan = Schema.decodeUnknownSync(Schema.Struct(fieldsBeforePlan));

/** A method's result as a client decodes it off the wire. */
const resultDecoder = (tag: string) => {
  const rpc = FactoryRpcs.find((candidate) => candidate._tag === tag);
  if (rpc === undefined) throw new Error(`No Factory RPC is tagged ${tag}.`);
  const decode = Schema.decodeUnknownSync(Schema.toCodecJson(Rpc.exitSchema(rpc)));
  return (value: unknown) => {
    const exit = decode({ _tag: "Success", value });
    if (!Exit.isSuccess(exit)) throw new Error(`${tag} decoded as a failure.`);
    return exit.value;
  };
};

describe("FactoryDelivery plan", () => {
  it("decodes a snapshot with the plan it waits on, and one without any", () => {
    const planned = decodeDelivery({ ...waiting, plan });
    expect(planned.plan).toEqual(plan);
    expect(encodeDelivery(planned)).toEqual({ ...waiting, plan });

    const unplanned = decodeDelivery(waiting);
    expect(unplanned.plan).toBeUndefined();
    expect(encodeDelivery(unplanned)).not.toHaveProperty("plan");
  });

  it("keeps a plan without a note", () => {
    const { note: _note, ...withoutNote } = plan;
    expect(decodeDelivery({ ...waiting, plan: withoutNote }).plan).toEqual(withoutNote);
  });

  it("is dropped, without failing, by a client from before the plan field", () => {
    const wire = encodeDelivery(decodeDelivery({ ...waiting, plan }));
    expect(wire.plan).toEqual(plan);
    const older = decodeBeforePlan(wire);
    expect(older).not.toHaveProperty("plan");
    expect(older.status).toBe("waiting");
    expect(older.needsYou).toBe(waiting.needsYou);
  });

  it.each([
    ["a task kind this build does not know", { tasks: [{ ...task("a"), kind: "perf" }] }],
    [
      "more tasks than the contract allows",
      { tasks: Array.from({ length: 51 }, (_, i) => task(`t${i}`)) },
    ],
    ["a note past its bound", { tasks: [task("a")], note: "n".repeat(8001) }],
    ["a criterion past its bound", { tasks: [{ ...task("a"), acceptance: ["c".repeat(2001)] }] }],
    ["no tasks list", { note: "Nothing." }],
  ])("leaves out a plan with %s and keeps the snapshot", (_name, unreadable) => {
    const decoded = decodeDelivery({ ...waiting, plan: unreadable });
    expect(decoded.plan).toBeUndefined();
    expect(decoded.status).toBe("waiting");
    expect(decodeList({ deliveries: [{ ...waiting, plan: unreadable }] }).deliveries).toHaveLength(
      1,
    );
  });

  it("reaches a client through the get and list results, readable or not", () => {
    const decodeGet = resultDecoder(FACTORY_WS_METHODS.factoryDeliveriesGet);
    const decodeListResult = resultDecoder(FACTORY_WS_METHODS.factoryDeliveriesList);
    expect(decodeGet({ ...waiting, plan })).toMatchObject({ plan });
    const unreadable = { ...waiting, plan: { tasks: [{ ...task("a"), risk: "extreme" }] } };
    expect((decodeGet(unreadable) as FactoryDelivery).plan).toBeUndefined();
    const listed = decodeListResult({ deliveries: [{ ...waiting, plan }, unreadable] }) as {
      readonly deliveries: ReadonlyArray<FactoryDelivery>;
    };
    expect(listed.deliveries.map((delivery) => delivery.plan)).toEqual([plan, undefined]);
  });

  it("answers each plan action with the delivery's snapshot, plan included", () => {
    for (const tag of [
      FACTORY_WS_METHODS.factoryPlanUpdate,
      FACTORY_WS_METHODS.factoryPlanReject,
      FACTORY_WS_METHODS.factoryPlanReplan,
    ]) {
      expect(resultDecoder(tag)({ ...waiting, plan })).toMatchObject({ plan });
    }
  });
});

describe("Factory plan action payloads", () => {
  const decodeUpdate = Schema.decodeUnknownSync(FactoryPlanUpdateInput);
  const decodeReplan = Schema.decodeUnknownSync(FactoryPlanReplanInput);
  const decodeNote = Schema.decodeUnknownSync(FactoryReplanNote);

  it("carries an edited plan as sent, for the server to judge", () => {
    expect(decodeUpdate({ deliveryId: "d-1", plan })).toEqual({ deliveryId: "d-1", plan });
    // No plan fails the request's decoding: the server refuses a bad edit as invalid_request.
    for (const edited of [
      { tasks: [] },
      { tasks: [{ id: "a" }] },
      { tasks: [{ ...task("a"), title: "  " }] },
      { tasks: [{ ...task("a"), risk: "extreme" }] },
      "none",
      null,
    ]) {
      expect(decodeUpdate({ deliveryId: "d-1", plan: edited }).plan).toEqual(edited);
    }
    expect(() => decodeUpdate({ deliveryId: "not a delivery id", plan })).toThrow();
  });

  it("carries any replan note as sent, for the server to trim and bound", () => {
    const tooLong = "n".repeat(FACTORY_REPLAN_NOTE_MAX_LENGTH + 1);
    for (const note of ["", "  \n ", tooLong, "  Split the export.\n"]) {
      expect(decodeReplan({ deliveryId: "d-1", note })).toEqual({ deliveryId: "d-1", note });
    }
  });

  it("names the note rule the server applies: nonblank and bounded, trimmed", () => {
    expect(decodeNote("  Split the export.\n")).toBe("Split the export.");
    const longest = "n".repeat(FACTORY_REPLAN_NOTE_MAX_LENGTH);
    expect(decodeNote(longest)).toBe(longest);
    for (const note of ["", "  \n ", `${longest}n`, null]) {
      expect(() => decodeNote(note)).toThrow();
    }
  });
});
