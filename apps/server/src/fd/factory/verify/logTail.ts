import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";

import { FactoryEvidenceError } from "./FactoryEvidence.ts";

/** How much of a failed verify log its fingerprint and the fix-verify prompt use. */
const TAIL_BYTES = 6 * 1024;

const decoder = new TextDecoder();

/**
 * The end of a verify log: its last 6 KiB, from the first full line when the log is longer.
 * Only that much is read, however long the log grew.
 */
export const readLogTail = Effect.fn("FactoryEvidence.readLogTail")(function* (logPath: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  return yield* Effect.gen(function* () {
    const file = yield* fileSystem.open(logPath, { flag: "r" });
    const size = BigInt((yield* file.stat).size);
    const start = size > BigInt(TAIL_BYTES) ? size - BigInt(TAIL_BYTES) : 0n;
    const bytes = yield* file.readAlloc(Number(size - start), { position: start });
    const text = decoder.decode(Option.getOrElse(bytes, () => new Uint8Array()));
    // A cut log starts mid-line, maybe mid-character.
    const whole = start > 0n && text.includes("\n") ? text.slice(text.indexOf("\n") + 1) : text;
    return whole.trimEnd();
  }).pipe(
    Effect.scoped,
    Effect.catchTags({
      PlatformError: (cause) =>
        Effect.fail(new FactoryEvidenceError({ operation: "read", path: logPath, cause })),
    }),
  );
});
