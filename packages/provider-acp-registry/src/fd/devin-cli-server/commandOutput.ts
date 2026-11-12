import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import type * as ChildProcess from "effect/process/ChildProcess";
import type * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

class NativeCommandFailed extends Schema.TaggedError<NativeCommandFailed>()("NativeCommandFailed", {
  code: Schema.Number,
}) {}

/** stdout alone does not establish command success: Effect's string helper ignores exit status. */
export const readCommandOutput = Effect.fn("readCommandOutput")(function* (
  spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
  command: ChildProcess.Command,
) {
  const child = yield* spawner.spawn(command);
  const [output, code] = yield* Effect.all(
    [Stream.mkString(Stream.decodeText(child.stdout)), child.exitCode],
    { concurrency: "unbounded" },
  );
  if (code !== 0) return yield* new NativeCommandFailed({ code });
  return output;
}, Effect.scoped);
