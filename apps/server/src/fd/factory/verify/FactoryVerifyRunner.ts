// @effect-diagnostics-next-line nodeBuiltinImport:off -- the log is hashed as it streams.
import * as NodeCrypto from "node:crypto";

import { type FactoryDeliveryId, FactoryVerifyReceipt } from "@t3tools/contracts/fd/factory";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import type * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as ProcessRunner from "../../../processRunner.ts";
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

/**
 * The verify command resolved to a Windows batch script, which runs only through `cmd.exe`.
 * Factory runs verify commands without a shell, so the owner has to name the program itself.
 */
export class FactoryVerifyShellRequiredError extends Schema.TaggedError<FactoryVerifyShellRequiredError>()(
  "FactoryVerifyShellRequiredError",
  { path: Schema.String },
) {
  override get message(): string {
    return `Factory runs verify commands without a shell, but the verify command for worktree ${this.path} resolves to a Windows batch script. Set the verify command to the program itself.`;
  }
}

export type FactoryVerifyRunError =
  | FactoryWorktreeMissingError
  | FactoryBranchReadError
  | FactoryVerifyCommandError
  | FactoryVerifyShellRequiredError
  | FactoryEvidence.FactoryEvidenceError;

const RECEIPT_VERSION = 1;
const encodeReceipt = Schema.encodeEffect(Schema.fromJsonString(FactoryVerifyReceipt));
const OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
/** The process runner's own buffers; the log receives every chunk through its callbacks. */
const BUFFERED_OUTPUT_BYTES = 64 * 1024;

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
 * receipts). The command runs as an argument array with the worktree as cwd, never through a
 * shell; its stdout and stderr stream into `verify-<n>.log` in the delivery's evidence folder as
 * they arrive. A run that ends, fails or times out on a clean tree with HEAD unchanged becomes a
 * receipt, also written as `verify-<n>.json`; the engine decides whether it passed. A tree dirty
 * before or after the run, or a HEAD the command moved, is refused: no receipt, and the log stays
 * for diagnosis.
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
  const processRunner = yield* ProcessRunner.ProcessRunner;
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
   * Runs the command, appending its stdout and stderr chunks to a new log in arrival order and
   * hashing the log as it is written. Both streams reach the log through the process runner's
   * chunk callbacks, never its buffered result, so output written before a timeout, a signal or
   * past the buffered limit stays in the log and nothing is appended twice.
   */
  const runLogged = (input: {
    readonly settings: FactoryDeliverySettings;
    /** The resolved, shell-free executable to run. */
    readonly executable: string;
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
      // `wx`: a log is never overwritten, even by a concurrent run that picked the same number.
      const log = yield* fileSystem
        .open(input.logPath, { flag: "wx" })
        .pipe(Effect.mapError(writeFailed));
      const hash = NodeCrypto.createHash("sha256");
      const append = (bytes: Uint8Array) =>
        log.writeAll(bytes).pipe(
          Effect.tap(() => Effect.sync(() => hash.update(bytes))),
          Effect.mapError(writeFailed),
        );

      // The callbacks are synchronous, so they queue chunks for a writer outside the process
      // runner's scope; its timeout cannot interrupt a write.
      const chunks = yield* Queue.unbounded<Uint8Array, Cause.Done>();
      const writer = yield* Stream.fromQueue(chunks).pipe(
        Stream.runForEach(append),
        Effect.forkScoped,
      );
      const queueChunk = (chunk: Uint8Array) => {
        Queue.offerUnsafe(chunks, chunk);
      };
      const result = yield* processRunner
        .run({
          command: input.executable,
          args: input.settings.verifyCommand.args,
          cwd: input.cwd,
          timeout: Duration.minutes(input.settings.limits.verifyTimeoutMinutes),
          timeoutBehavior: "timedOutResult",
          maxOutputBytes: BUFFERED_OUTPUT_BYTES,
          outputMode: "truncate",
          onStdoutChunk: queueChunk,
          onStderrChunk: queueChunk,
        })
        .pipe(
          Effect.map((output) => ({
            code: output.code === null ? null : Number(output.code),
            timedOut: output.timedOut,
          })),
          Effect.catch((cause) =>
            // The exit code read fails only when a signal ended the process: a result, not an error.
            cause._tag === "ProcessReadError" && cause.stream === "exitCode"
              ? Effect.succeed({ code: null, timedOut: false })
              : Effect.fail(new FactoryVerifyCommandError({ path: input.cwd, cause })),
          ),
        );
      yield* Queue.end(chunks);
      yield* Fiber.join(writer);
      return { ...result, outputHash: hash.digest("hex") };
    }).pipe(Effect.scoped);

  return FactoryVerifyRunner.of({
    run: Effect.fn("FactoryVerifyRunner.run")(function* (input) {
      // On Windows the process runner hands `.cmd` and `.bat` files to `cmd.exe` as one command
      // line. Refuse those before anything runs, and pass on the resolved path so the process
      // runner cannot resolve the command differently.
      const resolved = yield* resolveSpawnCommand(
        input.settings.verifyCommand.executable,
        input.settings.verifyCommand.args,
      );
      if (resolved.shell) {
        return yield* new FactoryVerifyShellRequiredError({ path: input.worktreePath });
      }

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
        executable: resolved.command,
        cwd: input.worktreePath,
        logPath,
      });
      const finishedAt = yield* DateTime.now;

      const after = yield* readWorktree(input.worktreePath);
      const refusals: Array<FactoryReceiptRefusal> = [];
      if (after.headSha !== before.headSha) refusals.push("head_changed");
      if (!after.clean) refusals.push("tree_dirty");
      if (refusals.length > 0) {
        return { type: "refused", refusals, evidencePath: logPath } satisfies FactoryCommandOutcome;
      }

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
      return {
        type: "receipt",
        receipt,
        evidencePath: receiptPath,
      } satisfies FactoryCommandOutcome;
    }),
  });
});

export const layer = Layer.effect(FactoryVerifyRunner, make);
