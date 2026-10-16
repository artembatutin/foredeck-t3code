import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import type * as ChildProcess from "effect/process/ChildProcess";
import type * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

class NativeCommandFailed extends Data.TaggedError("NativeCommandFailed")<{
  readonly code: number;
}> {}

/** stdout alone does not establish command success: Effect's string helper ignores exit status. */
export const readCommandOutput = (
  spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
  command: ChildProcess.Command,
) =>
  Effect.gen(function* () {
    const child = yield* spawner.spawn(command);
    const [output, code] = yield* Effect.all(
      [Stream.mkString(Stream.decodeText(child.stdout)), child.exitCode],
      { concurrency: "unbounded" },
    );
    if (code !== 0) return yield* Effect.fail(new NativeCommandFailed({ code }));
    return output;
  }).pipe(Effect.scoped);
