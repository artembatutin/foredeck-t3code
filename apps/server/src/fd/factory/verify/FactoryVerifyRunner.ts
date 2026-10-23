// @effect-diagnostics-next-line nodeBuiltinImport:off -- the log is hashed as it streams.
import * as NodeCrypto from "node:crypto";

import { type FactoryDeliveryId, FactoryVerifyReceipt } from "@t3tools/contracts/fd/factory";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as GitVcsDriver from "../../../vcs/GitVcsDriver.ts";
import type { FactoryDeliverySettings } from "../FactorySettings.ts";
import { FactoryBranchReadError, FactoryWorktreeMissingError } from "../git/branchFacts.ts";
import type { FactoryCommandOutcome, FactoryReceiptRefusal } from "../pipeline/state.ts";
import * as FactoryEvidence from "./FactoryEvidence.ts";

/** The verify command could not be started or read. Its output stays in `cause`, never the message. */
export class FactoryVerifyCommandError extends Schema.TaggedError<FactoryVerifyCommandError>()(
  "FactoryVerifyCommandError",
  { path: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return `Factory could not run the verify command in worktree ${this.path}.`;
  }
}

export type FactoryVerifyRunError =
  | FactoryWorktreeMissingError
  | FactoryBranchReadError
  | FactoryVerifyCommandError
  | FactoryEvidence.FactoryEvidenceError;

const RECEIPT_VERSION = 1;
const encodeReceipt = Schema.encodeEffect(Schema.fromJsonString(FactoryVerifyReceipt));
const OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/**
 * Identifies the settings a receipt was made under: the verify command and its timeout, the
 * settings that change what a run proves. Equal settings always hash equally.
 */
export const verifySettingsHash = (settings: FactoryDeliverySettings): string =>
  NodeCrypto.createHash("sha256")
    .update(
      JSON.stringify([
        settings.verifyCommand.executable,
        settings.verifyCommand.args,
        settings.limits.verifyTimeoutMinutes,
      ]),
    )
    .digest("hex");

/**
 * Runs a project's verify command against a delivery worktree's commit (port of Looper's
 * receipts). The command runs as an argument array with the worktree as cwd; its stdout and stderr
 * stream into `verify-<n>.log` in the delivery's evidence folder as they arrive. A run that ends,
 * fails or times out on a clean tree with HEAD unchanged becomes a receipt, also written as
 * `verify-<n>.json`; the engine decides whether it passed. A tree dirty before or after the run,
 * or a HEAD the command moved, is refused: no receipt, and the log stays for diagnosis.
 */
export class FactoryVerifyRunner extends Context.Service<
  FactoryVerifyRunner,
  {
    readonly run: (input: {
      readonly deliveryId: FactoryDeliveryId;
      readonly worktreePath: string;
      readonly settings: FactoryDeliverySettings;
    }) => Effect.Effect<FactoryCommandOutcome, FactoryVerifyRunError>;
  }
>()("t3/fd/factory/verify/FactoryVerifyRunner") {}

const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const git = yield* GitVcsDriver.GitVcsDriver;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const evidence = yield* FactoryEvidence.FactoryEvidence;
  const platform = `${yield* HostProcess.Platform}-${yield* HostProcess.Architecture}`;

  const readWorktree = Effect.fn("FactoryVerifyRunner.readWorktree")(function* (path: string) {
    const exists = yield* fileSystem.exists(path).pipe(
      Effect.catchTags({
        PlatformError: (cause) =>
          Effect.fail(new FactoryBranchReadError({ operation: "worktree", path, cause })),
      }),
    );
    if (!exists) return yield* new FactoryWorktreeMissingError({ path });

    const read = (operation: string, args: ReadonlyArray<string>) =>
      git
        .execute({
          operation: `FactoryVerifyRunner.${operation}`,
          cwd: path,
          args,
          timeoutMs: 30_000,
          maxOutputBytes: 1_000_000,
        })
        .pipe(
          Effect.map((result) => result.stdout.trim()),
          Effect.catchTags({
            GitCommandError: (cause) =>
              Effect.fail(new FactoryBranchReadError({ operation, path, cause })),
          }),
        );

    const [headSha = "", tree = ""] = (yield* read("head", ["rev-parse", "HEAD", "HEAD^{tree}"]))
      .split("\n")
      .map((line) => line.trim());
    if (!OBJECT_ID.test(headSha) || !OBJECT_ID.test(tree)) {
      return yield* new FactoryBranchReadError({ operation: "head", path });
    }
    // No optional locks: reading status must not rewrite the worktree's index.
    const status = yield* read("status", [
      "--no-optional-locks",
      "status",
      "--porcelain=v1",
      "--untracked-files=all",
    ]);
    return { headSha, tree, clean: status === "" };
  });

  /**
   * Runs the command with stdout and stderr merged into a new log as they arrive, hashing the log
   * as it is written. Nothing is buffered until exit, so output written before a timeout or a
   * signal stays in the log. The process runner is not used because it holds stderr until the
   * process exits and drops it on a timeout.
   */
  const runLogged = (input: {
    readonly settings: FactoryDeliverySettings;
    readonly cwd: string;
    readonly logPath: string;
  }) =>
    Effect.gen(function* () {
      const writeFailed = (cause: unknown) =>
        new FactoryEvidence.FactoryEvidenceError({
          operation: "write",
          path: input.logPath,
          cause,
        });
      const commandFailed = (cause: unknown) =>
        new FactoryVerifyCommandError({ path: input.cwd, cause });
      // `wx`: a log is never overwritten, even by a concurrent run that picked the same number.
      const log = yield* fileSystem
        .open(input.logPath, { flag: "wx" })
        .pipe(Effect.mapError(writeFailed));
      const hash = NodeCrypto.createHash("sha256");
      // Uninterruptible so a timeout never leaves a chunk hashed but unwritten, or the reverse.
      const append = (bytes: Uint8Array) =>
        log.writeAll(bytes).pipe(
          Effect.tap(() => Effect.sync(() => hash.update(bytes))),
          Effect.uninterruptible,
          Effect.mapError(writeFailed),
        );

      const { executable, args } = input.settings.verifyCommand;
      // None when the timeout ended the run; closing its scope kills the process group.
      const exit = yield* Effect.gen(function* () {
        const resolved = yield* resolveSpawnCommand(executable, args);
        const child = yield* spawner
          .spawn(
            ChildProcess.make(resolved.command, resolved.args, {
              cwd: input.cwd,
              shell: resolved.shell,
            }),
          )
          .pipe(Effect.mapError(commandFailed));
        yield* child.all.pipe(Stream.mapError(commandFailed), Stream.runForEach(append));
        return yield* child.exitCode.pipe(
          Effect.map((code): number | null => code),
          // Reading the exit code fails only when a signal ended the process: a result, not an error.
          Effect.catchTags({ PlatformError: () => Effect.succeed(null) }),
        );
      }).pipe(
        Effect.scoped,
        Effect.timeoutOption(Duration.minutes(input.settings.limits.verifyTimeoutMinutes)),
      );
      return {
        code: Option.getOrNull(exit),
        timedOut: Option.isNone(exit),
        outputHash: hash.digest("hex"),
      };
    }).pipe(Effect.scoped);

  return FactoryVerifyRunner.of({
    run: Effect.fn("FactoryVerifyRunner.run")(function* (input) {
      const before = yield* readWorktree(input.worktreePath);
      // A run proves a commit only on a clean tree; a dirty one is refused before it runs.
      if (!before.clean) {
        return { type: "refused", refusals: ["tree_dirty"] } satisfies FactoryCommandOutcome;
      }

      const files = yield* evidence.nextRun(input.deliveryId, "verify");
      const logPath = files.file("log");
      const startedAt = yield* DateTime.now;
      const result = yield* runLogged({
        settings: input.settings,
        cwd: input.worktreePath,
        logPath,
      });
      const finishedAt = yield* DateTime.now;

      const after = yield* readWorktree(input.worktreePath);
      const refusals: Array<FactoryReceiptRefusal> = [];
      if (after.headSha !== before.headSha) refusals.push("head_changed");
      if (!after.clean) refusals.push("tree_dirty");
      if (refusals.length > 0) return { type: "refused", refusals } satisfies FactoryCommandOutcome;

      const { executable, args } = input.settings.verifyCommand;
      const receipt: FactoryVerifyReceipt = {
        version: RECEIPT_VERSION,
        headSha: before.headSha,
        tree: before.tree,
        command: { executable, args: [...args] },
        settingsHash: verifySettingsHash(input.settings),
        platform,
        startedAt: DateTime.formatIso(startedAt),
        finishedAt: DateTime.formatIso(finishedAt),
        logPath,
        code: result.code,
        timedOut: result.timedOut,
        durationMs: Math.max(
          0,
          DateTime.toEpochMillis(finishedAt) - DateTime.toEpochMillis(startedAt),
        ),
        outputHash: result.outputHash,
      };
      const receiptPath = files.file("json");
      yield* encodeReceipt(receipt).pipe(
        Effect.flatMap((json) => fileSystem.writeFileString(receiptPath, json, { flag: "wx" })),
        Effect.mapError(
          (cause) =>
            new FactoryEvidence.FactoryEvidenceError({
              operation: "write",
              path: receiptPath,
              cause,
            }),
        ),
      );
      return { type: "receipt", receipt } satisfies FactoryCommandOutcome;
    }),
  });
});

export const layer = Layer.effect(FactoryVerifyRunner, make);
