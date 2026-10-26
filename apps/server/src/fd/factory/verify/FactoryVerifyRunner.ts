// @effect-diagnostics-next-line nodeBuiltinImport:off -- the log is hashed as it streams.
import * as NodeCrypto from "node:crypto";

import {
  type FactoryCommand,
  type FactoryDeliveryId,
  FactoryVerifyReceipt,
} from "@t3tools/contracts/fd/factory";
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
import type * as GitVcsDriver from "../../../vcs/GitVcsDriver.ts";
import type { FactoryDeliverySettings } from "../FactorySettings.ts";
import type { FactoryBranchReadError, FactoryWorktreeMissingError } from "../git/branchFacts.ts";
import { readWorktreeState } from "../git/worktreeState.ts";
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

/**
 * The project's setup command did not succeed, so no author turn was started. The message names
 * only how it ended; its output stays in its log and the failure in `cause`.
 */
export class FactorySetupFailedError extends Schema.TaggedError<FactorySetupFailedError>()(
  "FactorySetupFailedError",
  {
    ending: Schema.Literals(["exited", "timed_out", "signaled", "not_run"]),
    /** The exit code of a command that exited. */
    code: Schema.optional(Schema.Number),
    /** The timeout a command that timed out ran under. */
    timeoutMinutes: Schema.optional(Schema.Number),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    switch (this.ending) {
      case "exited":
        return `The setup command exited with code ${this.code}.`;
      case "timed_out":
        return `The setup command did not finish within ${this.timeoutMinutes} minutes.`;
      case "signaled":
        return "A signal ended the setup command.";
      case "not_run":
        return "Factory could not start the setup command; check its executable.";
    }
  }
}

export const isFactorySetupFailedError = Schema.is(FactorySetupFailedError);

export type FactoryVerifyRunError =
  | FactoryWorktreeMissingError
  | FactoryBranchReadError
  | FactoryVerifyCommandError
  | FactoryVerifyShellRequiredError
  | FactoryEvidence.FactoryEvidenceError;

const RECEIPT_VERSION = 1;
const encodeReceipt = Schema.encodeEffect(Schema.fromJsonString(FactoryVerifyReceipt));
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
 * for diagnosis. The project's setup command runs the same way before an author's first turn.
 */
export class FactoryVerifyRunner extends Context.Service<
  FactoryVerifyRunner,
  {
    readonly run: (input: {
      readonly deliveryId: FactoryDeliveryId;
      readonly worktreePath: string;
      readonly settings: FactoryDeliverySettings;
    }) => Effect.Effect<FactoryCommandOutcome, FactoryVerifyRunError>;
    /**
     * Runs the setup command in the worktree, its output streamed into `setup-<n>.log` in the
     * delivery's evidence folder, under the timeout given (the project's verify timeout). Only an
     * exit code of 0 succeeds; the tree is left to the author's settle check.
     */
    readonly setup: (input: {
      readonly deliveryId: FactoryDeliveryId;
      readonly worktreePath: string;
      readonly command: FactoryCommand;
      readonly timeoutMinutes: number;
    }) => Effect.Effect<void, FactorySetupFailedError | FactoryEvidence.FactoryEvidenceError>;
  }
>()("t3/fd/factory/verify/FactoryVerifyRunner") {}

const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const processRunner = yield* ProcessRunner.ProcessRunner;
  const evidence = yield* FactoryEvidence.FactoryEvidence;
  const platform = `${yield* HostProcess.Platform}-${yield* HostProcess.Architecture}`;
  const gitContext = yield* Effect.context<FileSystem.FileSystem | GitVcsDriver.GitVcsDriver>();
  const readWorktree = (path: string) =>
    readWorktreeState(path).pipe(Effect.provideContext(gitContext));

  /**
   * Runs the command, appending its stdout and stderr chunks to a new log in arrival order and
   * hashing the log as it is written. Both streams reach the log through the process runner's
   * chunk callbacks, never its buffered result, so output written before a timeout, a signal or
   * past the buffered limit stays in the log and nothing is appended twice.
   */
  const runLogged = <E>(input: {
    /** The resolved, shell-free executable to run. */
    readonly executable: string;
    readonly args: ReadonlyArray<string>;
    readonly timeoutMinutes: number;
    readonly cwd: string;
    readonly logPath: string;
    /** The error for a command that could not be run or read. */
    readonly failed: (cause: ProcessRunner.ProcessRunError) => E;
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
          args: input.args,
          cwd: input.cwd,
          timeout: Duration.minutes(input.timeoutMinutes),
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
              : Effect.fail(input.failed(cause)),
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
        executable: resolved.command,
        args: input.settings.verifyCommand.args,
        timeoutMinutes: input.settings.limits.verifyTimeoutMinutes,
        cwd: input.worktreePath,
        logPath,
        failed: (cause) => new FactoryVerifyCommandError({ path: input.worktreePath, cause }),
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
    setup: Effect.fn("FactoryVerifyRunner.setup")(function* (input) {
      const { command, timeoutMinutes } = input;
      // A Windows batch script runs only through a shell, which Factory never uses.
      const resolved = yield* resolveSpawnCommand(command.executable, command.args);
      if (resolved.shell) return yield* new FactorySetupFailedError({ ending: "not_run" });
      const files = yield* evidence.nextRun(input.deliveryId, "setup");
      const { code, timedOut } = yield* runLogged({
        executable: resolved.command,
        args: command.args,
        timeoutMinutes,
        cwd: input.worktreePath,
        logPath: files.file("log"),
        failed: (cause) => new FactorySetupFailedError({ ending: "not_run", cause }),
      });
      if (timedOut) {
        return yield* new FactorySetupFailedError({ ending: "timed_out", timeoutMinutes });
      }
      if (code === null) return yield* new FactorySetupFailedError({ ending: "signaled" });
      if (code !== 0) return yield* new FactorySetupFailedError({ ending: "exited", code });
    }),
  });
});

export const layer = Layer.effect(FactoryVerifyRunner, make);
