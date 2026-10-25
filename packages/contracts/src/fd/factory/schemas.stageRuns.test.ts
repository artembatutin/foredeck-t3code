import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";
import * as Rpc from "effect/rpc/Rpc";
import { describe, expect, it } from "vite-plus/test";

import {
  FACTORY_WS_METHODS,
  FactoryDelivery,
  FactoryDeliveryList,
  FactoryRpcs,
  FactoryStageRunSummary,
} from "./index.ts";

const finished = {
  stage: "author",
  attempt: 1,
  outcome: "passed",
  threadId: "thread-author",
  startedAt: "2026-10-23T09:00:00.000Z",
  finishedAt: "2026-10-23T09:10:00.000Z",
};
const active = {
  stage: "review",
  attempt: 1,
  outcome: null,
  threadId: "thread-reviewer",
  startedAt: "2026-10-23T09:12:00.000Z",
};

/** A snapshot as a server before stage attempts sends it: no `stageRuns` key at all. */
const oldServerSnapshot = {
  deliveryId: "d-1",
  projectId: "project-1",
  itemRef: { sourceId: "7e2aa85e-9347-44ce-b019-cb8dfd365b20", itemId: "fd-7k3qa2" },
  childIds: [],
  status: "running",
  stage: { name: "review", kind: "agent" },
  rounds: { fix: 0, review: 0 },
  threads: { author: "thread-author", reviewer: "thread-reviewer" },
  receipts: [],
  reviews: [],
  createdAt: "2026-10-23T08:59:00.000Z",
  updatedAt: "2026-10-23T09:12:00.000Z",
};

const decodeDelivery = Schema.decodeUnknownSync(FactoryDelivery);
const decodeList = Schema.decodeUnknownSync(FactoryDeliveryList);
const encodeDelivery = Schema.encodeSync(FactoryDelivery);
const decodeSummary = Schema.decodeUnknownSync(FactoryStageRunSummary);

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
const decodeGetResult = resultDecoder(FACTORY_WS_METHODS.factoryDeliveriesGet);
const decodeListResult = resultDecoder(FACTORY_WS_METHODS.factoryDeliveriesList);

describe("FactoryDelivery stage attempts", () => {
  it("decodes a snapshot from a server that sends no attempts as having none", () => {
    const decoded = decodeDelivery(oldServerSnapshot);
    expect(decoded.stageRuns).toEqual([]);
    expect(decoded).toEqual({ ...oldServerSnapshot, stageRuns: [] });
  });

  it("keeps finished and active attempts in the order sent", () => {
    const decoded = decodeDelivery({ ...oldServerSnapshot, stageRuns: [finished, active] });
    expect(decoded.stageRuns).toEqual([finished, active]);
    expect(decoded.stageRuns[1]).not.toHaveProperty("finishedAt");
    expect(encodeDelivery(decoded).stageRuns).toEqual([finished, active]);
  });

  it("reads a stage or outcome from a newer server as unknown", () => {
    const decoded = decodeDelivery({
      ...oldServerSnapshot,
      stageRuns: [
        { ...finished, stage: "deploy", outcome: "skipped" },
        { ...finished, stage: "verify", attempt: 2, outcome: "flaky" },
        { ...active, stage: "canary" },
      ],
    });
    expect(
      decoded.stageRuns.map(({ stage, attempt, outcome }) => [stage, attempt, outcome]),
    ).toEqual([
      ["unknown", 1, "unknown"],
      ["verify", 2, "unknown"],
      ["unknown", 1, null],
    ]);
  });

  it("drops an attempt it cannot read and keeps the rest of the delivery", () => {
    const unreadable = [
      { ...finished, attempt: 0 },
      { ...finished, startedAt: 1_766_480_400_000 },
      { ...finished, stage: 7 },
      { ...finished, outcome: undefined },
      "author passed",
    ];
    const decoded = decodeDelivery({
      ...oldServerSnapshot,
      stageRuns: [...unreadable, finished, active],
    });
    expect(decoded.stageRuns).toEqual([finished, active]);
    expect(decoded.threads).toEqual(oldServerSnapshot.threads);
    expect(decoded.status).toBe("running");
  });

  it("drops an unreadable attempt without failing the list around its delivery", () => {
    const decoded = decodeList({
      deliveries: [
        { ...oldServerSnapshot, deliveryId: "d-2", stageRuns: [{ ...finished, attempt: -1 }] },
        oldServerSnapshot,
      ],
    });
    expect(decoded.deliveries.map(({ deliveryId, stageRuns }) => [deliveryId, stageRuns])).toEqual([
      ["d-2", []],
      ["d-1", []],
    ]);
  });

  it("drops fields of an attempt this build does not know, such as evidence", () => {
    const decoded = decodeSummary({
      ...finished,
      runId: "run-1",
      evidencePath: "/home/owner/.t3/userdata/fd-factory/d-1/verify-1.json",
      fingerprint: "fingerprint-1",
    });
    expect(decoded).toEqual(finished);
  });
});

describe("FactoryDelivery stage attempts in RPC results", () => {
  const unreadableReceipt = { headSha: "abc1234" };

  it("drops an unreadable attempt from a delivery read without failing the read", () => {
    const delivery = decodeGetResult({
      ...oldServerSnapshot,
      receipts: [unreadableReceipt],
      stageRuns: [{ ...finished, attempt: 0 }, { ...finished, stage: "deploy" }, active],
    }) as FactoryDelivery;
    expect(delivery.stageRuns).toEqual([{ ...finished, stage: "unknown" }, active]);
    expect(delivery.receipts).toEqual([]);
  });

  it("keeps a listed delivery whose attempt or receipt it cannot read", () => {
    const list = decodeListResult({
      deliveries: [
        { ...oldServerSnapshot, deliveryId: "d-3", stageRuns: [{ ...finished, attempt: 0 }] },
        { ...oldServerSnapshot, deliveryId: "d-2", receipts: [unreadableReceipt] },
        { ...oldServerSnapshot, deliveryId: "" },
        { ...oldServerSnapshot, stageRuns: [finished] },
      ],
    }) as FactoryDeliveryList;
    expect(list.deliveries.map(({ deliveryId, stageRuns }) => [deliveryId, stageRuns])).toEqual([
      ["d-3", []],
      ["d-2", []],
      ["d-1", [finished]],
    ]);
  });
});
