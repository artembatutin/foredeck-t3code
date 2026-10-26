import * as Cause from "effect/Cause";
import * as Exit from "effect/Exit";
import * as Rpc from "effect/rpc/Rpc";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { FACTORY_WS_METHODS, FactoryError, FactoryRpcs, FactoryTaskId } from "./index.ts";

const refused = {
  _tag: "FactoryError",
  reason: "invalid_request",
  message: "Factory refused the edited plan.",
  deliveryId: "d-1",
};
const fields = [
  { taskId: "export-csv", field: "acceptance.2.testPlan" },
  { taskId: "export-header" },
];

const updateRpc = FactoryRpcs.find(
  (candidate) => candidate._tag === FACTORY_WS_METHODS.factoryPlanUpdate,
);
if (updateRpc === undefined) throw new Error("No plan update RPC.");
const decodeUpdateExit = Schema.decodeUnknownSync(Schema.toCodecJson(Rpc.exitSchema(updateRpc)));
const encodeError = Schema.encodeSync(FactoryError);
const { fields: _fields, ...fieldsBefore } = FactoryError.fields;
/** The error as a client from before fields decodes it. */
const decodeBeforeFields = Schema.decodeUnknownSync(Schema.Struct(fieldsBefore));

/** A plan update's failure as a client decodes it off the wire. */
const updateFailure = (error: unknown): unknown => {
  const exit = decodeUpdateExit({ _tag: "Failure", cause: [{ _tag: "Fail", error }] });
  if (!Exit.isFailure(exit)) throw new Error("The update decoded as a success.");
  return Cause.squash(exit.cause);
};

describe("FactoryError fields", () => {
  it("carries the plan fields a refusal names, and none when it names none", () => {
    const decoded = updateFailure({ ...refused, fields });
    expect(decoded).toBeInstanceOf(FactoryError);
    expect((decoded as FactoryError).fields).toEqual([
      { taskId: FactoryTaskId.make("export-csv"), field: "acceptance.2.testPlan" },
      { taskId: FactoryTaskId.make("export-header") },
    ]);
    expect(encodeError(decoded as FactoryError)).toEqual({ ...refused, fields });

    const bare = updateFailure(refused) as FactoryError;
    expect(bare.message).toBe(refused.message);
    expect(bare.fields).toBeUndefined();
  });

  it("leaves out an entry this build cannot read and keeps the error", () => {
    const decoded = updateFailure({
      ...refused,
      fields: [
        { taskId: "not a task id" },
        { taskId: "export-csv", field: "f".repeat(65) },
        { field: "title" },
        "title",
        fields[1],
      ],
    }) as FactoryError;
    expect(decoded.reason).toBe("invalid_request");
    expect(decoded.fields).toEqual([{ taskId: FactoryTaskId.make("export-header") }]);
  });

  it("is dropped, without failing, by a client from before fields", () => {
    const older = decodeBeforeFields({ ...refused, fields });
    expect(older).toEqual({
      _tag: "FactoryError",
      reason: "invalid_request",
      message: refused.message,
      deliveryId: "d-1",
    });
  });
});
