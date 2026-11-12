import * as PlatformNodeCrypto from "@effect/platform-node/NodeCrypto";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- hashes the log to compare with the receipt.
import * as NodeCrypto from "node:crypto";

import * as NodePath from "@effect/platform-node/NodePath";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  FactoryDeliveryId,
  FactoryProjectSettings,
  FactoryVerifyReceipt,
} from "@t3tools/contracts/fd/factory";
import * as HostProcess from "@t3tools/shared/HostProcess";
import {
  CommandResolutionCache,
  resolveSpawnCommand,
  SpawnExecutableResolution,
  type SpawnExecutableResolver,
} from "@t3tools/shared/shell";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";

import * as ServerConfig from "../../../config.ts";
import * as ProcessRunner from "../../../processRunner.ts";
import * as GitVcsDriver from "../../../vcs/GitVcsDriver.ts";
import * as VcsProcess from "../../../vcs/VcsProcess.ts";
import type { FactoryDeliverySettings } from "../FactorySettings.ts";
import * as FactoryEvidence from "./FactoryEvidence.ts";
import * as FactoryVerifyRunner from "./FactoryVerifyRunner.ts";

/** The runner on real git and processes, running commands through `processRunner`. */
const makeLayer = <E, R>(
  processRunner: Layer.Layer<ProcessRunner.ProcessRunner, E, R>,
  runner = FactoryVerifyRunner.layer,
  gitDriver = GitVcsDriver.layer,
) =>
  runner.pipe(
    Layer.provide(FactoryEvidence.layer),
    // The receipt's platform comes from the host references, not the process globals.
    Layer.provide(Layer.succeed(HostProcess.Platform, "linux")),
    Layer.provide(Layer.succeed(HostProcess.Architecture, "arm64")),
    Layer.provide(processRunner),
    Layer.provideMerge(gitDriver),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "fd-factory-verify-" })),
    Layer.provideMerge(VcsProcess.layer),
    Layer.provideMerge(PlatformNodeCrypto.layer),
    Layer.provideMerge(NodeServices.layer),
  );

const decodeSettings = Schema.decodeUnknownSync(FactoryProjectSettings);
const decodeReceiptJson = Schema.decodeUnknownSync(Schema.fromJsonString(FactoryVerifyReceipt));

/** Moves the process to `directory` with the `PATH` given, returning what to restore. */
const enterProcess = (directory: string, path: (previous: string | undefined) => string) => {
  const previous = { cwd: process.cwd(), PATH: process.env.PATH };
  process.chdir(directory);
  process.env.PATH = path(previous.PATH);
  return previous;
};

const restoreProcess = (previous: ReturnType<typeof enterProcess>) => {
  process.chdir(previous.cwd);
  process.env.PATH = previous.PATH;
};

/** Settings whose verify command runs `script` with the current Node executable. */
const nodeVerify = (
  script: string,
  limits: { readonly verifyTimeoutMinutes?: number; readonly maxFixRounds?: number } = {},
): FactoryDeliverySettings => {
  const verifyCommand = { executable: process.execPath, args: ["-e", script] };
  return { ...decodeSettings({ verifyCommand, limits }), verifyCommand };
};

const ada = ["-c", "user.name=Ada Lovelace", "-c", "user.email=ada@example.com"];
const commitArgs = [...ada, "commit", "--no-verify", "--no-gpg-sign", "-m"];

const git = (cwd: string, args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const driver = yield* GitVcsDriver.GitVcsDriver;
    const result = yield* driver.execute({ operation: "test.git", cwd, args, timeoutMs: 10_000 });
    return result.stdout.trim();
  });

/** A repository with one commit, standing in for a delivery worktree. */
const makeWorktree = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "fd-factory-verify-wt-" });
  yield* git(cwd, ["init", "-b", "main"]);
  yield* fileSystem.writeFileString(path.join(cwd, "README.md"), "root\n");
  yield* git(cwd, ["add", "README.md"]);
  yield* git(cwd, [...commitArgs, "chore: root"]);
  return cwd;
});

const evidenceDirectory = (deliveryId: string) =>
  Effect.gen(function* () {
    const { stateDir } = yield* ServerConfig.ServerConfig;
    const path = yield* Path.Path;
    return path.join(stateDir, "fd-factory", deliveryId);
  });

const exists = (path: string) => Effect.flatMap(FileSystem.FileSystem, (fs) => fs.exists(path));

const sha256 = (bytes: Uint8Array) => NodeCrypto.createHash("sha256").update(bytes).digest("hex");

/** The log's lines in sorted order: stdout and stderr interleave as they arrive. */
const sortedLines = (log: Uint8Array) =>
  new TextDecoder().decode(log).split("\n").filter(Boolean).toSorted();

const run = (deliveryId: string, worktreePath: string, settings: FactoryDeliverySettings) =>
  Effect.flatMap(FactoryVerifyRunner.FactoryVerifyRunner, (runner) =>
    runner.run({ deliveryId: FactoryDeliveryId.make(deliveryId), worktreePath, settings }),
  );

const receiptOf = (deliveryId: string, worktreePath: string, settings: FactoryDeliverySettings) =>
  Effect.gen(function* () {
    const outcome = yield* run(deliveryId, worktreePath, settings);
    assert.strictEqual(outcome.type, "receipt");
    if (outcome.type !== "receipt") throw new Error("expected a receipt");
    return outcome.receipt;
  });

/** How a failed setup says it ended, or the tag of whatever else failed. */
const endingOf = (error: { readonly _tag: string }) =>
  FactoryVerifyRunner.isFactorySetupFailedError(error) ? error.ending : error._tag;

const passing = nodeVerify(`console.log("all checks passed")`);

/** Writes and commits `added.txt` from inside the verify command. */
const commitScript = `
const { execFileSync } = require("node:child_process");
require("node:fs").writeFileSync("added.txt", "added\\n");
execFileSync("git", ["add", "added.txt"]);
execFileSync("git", ${JSON.stringify([...commitArgs, "chore: sneaked in"])});
`;

it.layer(makeLayer(ProcessRunner.layer), { excludeTestServices: true })(
  "FactoryVerifyRunner",
  (it) => {
    it.effect("numbers each run's evidence under the state directory, outside the worktree", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const worktree = yield* makeWorktree;
        const directory = yield* evidenceDirectory("numbered");

        const first = yield* receiptOf("numbered", worktree, passing);
        const second = yield* receiptOf("numbered", worktree, passing);

        assert.strictEqual(first.logPath, `${directory}/verify-1.log`);
        assert.strictEqual(second.logPath, `${directory}/verify-2.log`);
        assert.deepStrictEqual((yield* fileSystem.readDirectory(directory)).toSorted(), [
          "verify-1.json",
          "verify-1.log",
          "verify-2.json",
          "verify-2.log",
        ]);
        assert.strictEqual(
          yield* git(worktree, ["status", "--porcelain=v1", "--untracked-files=all", "--ignored"]),
          "",
        );
      }),
    );

    it.effect("records a passing run on a clean worktree as a receipt and its JSON", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const worktree = yield* makeWorktree;
        const directory = yield* evidenceDirectory("passing");

        const outcome = yield* run("passing", worktree, passing);
        assert.strictEqual(outcome.type, "receipt");
        if (outcome.type !== "receipt") return;
        const { receipt } = outcome;
        assert.strictEqual(outcome.evidencePath, `${directory}/verify-1.json`);

        assert.strictEqual(receipt.version, 1);
        assert.strictEqual(receipt.headSha, yield* git(worktree, ["rev-parse", "HEAD"]));
        assert.strictEqual(receipt.tree, yield* git(worktree, ["rev-parse", "HEAD^{tree}"]));
        assert.deepStrictEqual(receipt.command, passing.verifyCommand);
        assert.strictEqual(receipt.settingsHash, FactoryVerifyRunner.verifySettingsHash(passing));
        assert.strictEqual(receipt.platform, "linux-arm64");
        assert.strictEqual(receipt.logPath, `${directory}/verify-1.log`);
        assert.strictEqual(receipt.code, 0);
        assert.strictEqual(receipt.timedOut, false);
        assert.isAtLeast(Date.parse(receipt.finishedAt), Date.parse(receipt.startedAt));
        assert.strictEqual(
          receipt.durationMs,
          Date.parse(receipt.finishedAt) - Date.parse(receipt.startedAt),
        );

        const log = yield* fileSystem.readFile(receipt.logPath);
        assert.strictEqual(new TextDecoder().decode(log), "all checks passed\n");
        assert.strictEqual(receipt.outputHash, sha256(log));
        const written = yield* fileSystem.readFileString(`${directory}/verify-1.json`);
        assert.deepStrictEqual(decodeReceiptJson(written), receipt);
      }),
    );

    it.effect("records a failing exit code with both output streams in the log", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const worktree = yield* makeWorktree;
        const settings = nodeVerify(`
          process.stdout.write("out: 2 tests failed\\n");
          process.stderr.write("err: expected 1 to be 2\\n");
          process.exitCode = 3;
        `);

        const receipt = yield* receiptOf("failing", worktree, settings);

        assert.strictEqual(receipt.code, 3);
        assert.strictEqual(receipt.timedOut, false);
        const log = yield* fileSystem.readFile(receipt.logPath);
        assert.deepStrictEqual(sortedLines(log), [
          "err: expected 1 to be 2",
          "out: 2 tests failed",
        ]);
        assert.strictEqual(receipt.outputHash, sha256(log));
        assert.isTrue(yield* exists(receipt.logPath.replace(/\.log$/, ".json")));
      }),
    );

    it.effect("streams stderr into the log in full, however large", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const worktree = yield* makeWorktree;
        const bulk = 5 * 1024 * 1024;
        const settings = nodeVerify(`
          process.stderr.write("e".repeat(${bulk}) + "\\nstderr-tail\\n");
          process.exitCode = 1;
        `);

        const receipt = yield* receiptOf("large-stderr", worktree, settings);

        assert.strictEqual(receipt.code, 1);
        const log = yield* fileSystem.readFile(receipt.logPath);
        assert.strictEqual(log.byteLength, bulk + "\nstderr-tail\n".length);
        assert.isTrue(new TextDecoder().decode(log).endsWith("e\nstderr-tail\n"));
        assert.strictEqual(receipt.outputHash, sha256(log));
      }),
    );

    it.effect("records a run ended by a signal as a receipt, keeping its output", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const worktree = yield* makeWorktree;
        const settings = nodeVerify(`
          const fs = require("node:fs");
          fs.writeSync(1, "out-before-kill\\n");
          fs.writeSync(2, "err-before-kill\\n");
          process.kill(process.pid, "SIGKILL");
        `);

        const receipt = yield* receiptOf("signalled", worktree, settings);

        assert.strictEqual(receipt.code, null);
        assert.strictEqual(receipt.timedOut, false);
        const log = yield* fileSystem.readFile(receipt.logPath);
        assert.deepStrictEqual(sortedLines(log), ["err-before-kill", "out-before-kill"]);
        assert.strictEqual(receipt.outputHash, sha256(log));
      }),
    );

    it.effect("refuses a run that commits, keeping the log without a receipt", () =>
      Effect.gen(function* () {
        const worktree = yield* makeWorktree;
        const directory = yield* evidenceDirectory("commits");

        const outcome = yield* run("commits", worktree, nodeVerify(commitScript));

        assert.deepStrictEqual(outcome, {
          type: "refused",
          refusals: ["head_changed"],
          evidencePath: `${directory}/verify-1.log`,
        });
        assert.isTrue(yield* exists(`${directory}/verify-1.log`));
        assert.isFalse(yield* exists(`${directory}/verify-1.json`));
      }),
    );

    it.effect("reports a moved HEAD and a dirty tree together", () =>
      Effect.gen(function* () {
        const worktree = yield* makeWorktree;
        const directory = yield* evidenceDirectory("commits-and-dirties");
        const settings = nodeVerify(
          `${commitScript}\nrequire("node:fs").writeFileSync("left-behind.txt", "x");`,
        );

        const outcome = yield* run("commits-and-dirties", worktree, settings);

        assert.deepStrictEqual(outcome, {
          type: "refused",
          refusals: ["head_changed", "tree_dirty"],
          evidencePath: `${directory}/verify-1.log`,
        });
        assert.isTrue(yield* exists(`${directory}/verify-1.log`));
        assert.isFalse(yield* exists(`${directory}/verify-1.json`));
      }),
    );

    it.effect("refuses a run that leaves an untracked file", () =>
      Effect.gen(function* () {
        const worktree = yield* makeWorktree;
        const directory = yield* evidenceDirectory("untracked");
        const settings = nodeVerify(`require("node:fs").writeFileSync("coverage.txt", "90%")`);

        const outcome = yield* run("untracked", worktree, settings);

        assert.deepStrictEqual(outcome, {
          type: "refused",
          refusals: ["tree_dirty"],
          evidencePath: `${directory}/verify-1.log`,
        });
        assert.isTrue(yield* exists(`${directory}/verify-1.log`));
        assert.isFalse(yield* exists(`${directory}/verify-1.json`));
      }),
    );

    it.effect("refuses a worktree that is dirty before the run without running it", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const worktree = yield* makeWorktree;
        const directory = yield* evidenceDirectory("dirty-before");
        yield* fileSystem.writeFileString(`${worktree}/README.md`, "edited\n");

        const outcome = yield* run(
          "dirty-before",
          worktree,
          nodeVerify(`require("node:fs").writeFileSync("ran.txt", "ran")`),
        );

        assert.deepStrictEqual(outcome, { type: "refused", refusals: ["tree_dirty"] });
        assert.isFalse(yield* exists(`${worktree}/ran.txt`));
        assert.isFalse(yield* exists(`${directory}/verify-1.log`));
      }),
    );

    it.effect("fails with a typed error naming only the path for a missing worktree", () =>
      Effect.gen(function* () {
        const worktree = yield* makeWorktree;
        const missing = `${worktree}/gone`;

        const error = yield* Effect.flip(run("missing-worktree", missing, passing));

        assert.strictEqual(error._tag, "FactoryWorktreeMissingError");
        assert.strictEqual(error.message, `Factory worktree ${missing} does not exist.`);
      }),
    );

    it.effect("fails with a typed error naming only the path for a missing executable", () =>
      Effect.gen(function* () {
        const worktree = yield* makeWorktree;
        const verifyCommand = { executable: "fd-factory-no-such-executable", args: ["--check"] };
        const settings = { ...decodeSettings({ verifyCommand }), verifyCommand };

        const error = yield* Effect.flip(run("missing-executable", worktree, settings));

        assert.strictEqual(error._tag, "FactoryVerifyCommandError");
        assert.strictEqual(
          error.message,
          `Factory could not run the verify command in worktree ${worktree}.`,
        );
      }),
    );

    it.effect("refuses a Windows batch-script verify command before anything runs", () =>
      Effect.gen(function* () {
        const worktree = yield* makeWorktree;
        const verifyCommand = { executable: "npm", args: ["test"] };
        const settings = { ...decodeSettings({ verifyCommand }), verifyCommand };

        const error = yield* Effect.flip(
          run("windows-shim", worktree, settings).pipe(
            Effect.provideService(HostProcess.Platform, "win32"),
            Effect.provideService(SpawnExecutableResolution, (command) =>
              command === "npm" ? "C:\\Program Files\\nodejs\\npm.cmd" : undefined,
            ),
          ),
        );

        assert.strictEqual(error._tag, "FactoryVerifyShellRequiredError");
        assert.strictEqual(
          error.message,
          `Factory runs verify commands without a shell, but the verify command for worktree ${worktree} resolves to a Windows batch script. Set the verify command to the program itself.`,
        );
        assert.isFalse(yield* exists(yield* evidenceDirectory("windows-shim")));
      }),
    );

    it.effect("runs a relative executable from the worktree, keeping it as saved", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const worktree = yield* makeWorktree;
        const name = "fd-verify-relative.sh";
        yield* fileSystem.writeFileString(
          path.join(worktree, name),
          "#!/bin/sh\necho ran-from-the-worktree\n",
        );
        yield* fileSystem.chmod(path.join(worktree, name), 0o755);
        yield* git(worktree, ["add", name]);
        yield* git(worktree, [...commitArgs, "chore: add a verify script"]);
        // Nothing of that name is where the server runs.
        assert.isFalse(yield* exists(path.join(process.cwd(), name)));
        const verifyCommand = { executable: `./${name}`, args: [] };
        const settings = { ...decodeSettings({ verifyCommand }), verifyCommand };

        const receipt = yield* receiptOf("relative", worktree, settings);

        assert.strictEqual(receipt.code, 0);
        assert.deepStrictEqual(receipt.command, verifyCommand);
        const log = yield* fileSystem.readFileString(receipt.logPath);
        assert.include(log, "ran-from-the-worktree");
      }),
    );

    describe("with a relative PATH, and the server somewhere else", () => {
      /** The server's directory and PATH for the effect's length, as a real run inherits them. */
      const serverAt = <A, E, R>(directory: string, effect: Effect.Effect<A, E, R>) =>
        Effect.acquireUseRelease(
          // Git still has to be found, by whatever follows the relative directory.
          Effect.sync(() => enterProcess(directory, (previous) => `./bin:${previous}`)),
          () => effect,
          (previous) => Effect.sync(() => restoreProcess(previous)),
        );
      const makeExecutable = (file: string, text: string) =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          yield* fileSystem.writeFileString(file, text);
          yield* fileSystem.chmod(file, 0o755);
        });
      const saying = (words: string) => `#!/bin/sh\necho ${words}\n`;
      /** A server directory holding `bin/<name>` for each of the files given. */
      const makeServer = (files: Readonly<Record<string, string>>) =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const server = yield* fileSystem.makeTempDirectoryScoped({ prefix: "fd-verify-server-" });
          yield* fileSystem.makeDirectory(path.join(server, "bin"));
          for (const [name, text] of Object.entries(files)) {
            yield* makeExecutable(path.join(server, "bin", name), text);
          }
          return server;
        });
      /** A worktree that has committed `bin/<name>` for each of the files given. */
      const makeWorktreeWith = (files: Readonly<Record<string, string>>) =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const worktree = yield* makeWorktree;
          yield* fileSystem.makeDirectory(path.join(worktree, "bin"));
          for (const [name, text] of Object.entries(files)) {
            yield* makeExecutable(path.join(worktree, "bin", name), text);
          }
          yield* git(worktree, ["add", "bin"]);
          yield* git(worktree, [...commitArgs, "chore: add tools"]);
          return worktree;
        });
      const toolCommand = { executable: "fd-relative-tool", args: ["--check"] };
      const toolSettings = {
        ...decodeSettings({ verifyCommand: toolCommand }),
        verifyCommand: toolCommand,
      };

      it.effect("verifies with the worktree's own tool, keeping the command as saved", () =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const worktree = yield* makeWorktreeWith({
            "fd-relative-tool": saying("ran-from-the-worktree"),
          });
          const server = yield* makeServer({ "fd-relative-tool": saying("ran-from-the-server") });

          const receipt = yield* serverAt(
            server,
            receiptOf("relative-path", worktree, toolSettings),
          );

          assert.strictEqual(receipt.code, 0);
          assert.deepStrictEqual(receipt.command, toolCommand);
          const log = yield* fileSystem.readFileString(receipt.logPath);
          assert.include(log, "ran-from-the-worktree");
          assert.notInclude(log, "ran-from-the-server");
        }),
      );

      it.effect("cannot start a tool only the server's directory holds", () =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const worktree = yield* makeWorktree;
          const marker = path.join(yield* fileSystem.makeTempDirectoryScoped(), "marker");
          const server = yield* makeServer({
            "fd-relative-tool": `#!/bin/sh\necho ran > ${JSON.stringify(marker)}\n`,
          });

          const error = yield* Effect.flip(
            serverAt(server, run("relative-path-server-only", worktree, toolSettings)),
          );

          assert.strictEqual(error._tag, "FactoryVerifyCommandError");
          assert.isFalse(yield* exists(marker));
        }),
      );

      it.effect("runs a script through the interpreter its env finds in the worktree", () =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const worktree = yield* makeWorktreeWith({
            "fd-relative-tool": "#!/usr/bin/env fd-relative-interpreter\n",
            "fd-relative-interpreter": saying("interpreter-from-the-worktree"),
          });
          const server = yield* makeServer({
            "fd-relative-interpreter": saying("interpreter-from-the-server"),
          });

          const receipt = yield* serverAt(
            server,
            receiptOf("relative-path-env", worktree, toolSettings),
          );

          assert.strictEqual(receipt.code, 0);
          const log = yield* fileSystem.readFileString(receipt.logPath);
          assert.include(log, "interpreter-from-the-worktree");
          assert.notInclude(log, "interpreter-from-the-server");
        }),
      );

      it.effect("cannot run a script through an interpreter only the server holds", () =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const worktree = yield* makeWorktreeWith({
            "fd-relative-tool": "#!/usr/bin/env fd-relative-interpreter\n",
          });
          const server = yield* makeServer({
            "fd-relative-interpreter": saying("interpreter-from-the-server"),
          });

          const receipt = yield* serverAt(
            server,
            receiptOf("relative-path-env-server-only", worktree, toolSettings),
          );

          assert.notStrictEqual(receipt.code, 0);
          const log = yield* fileSystem.readFileString(receipt.logPath);
          assert.notInclude(log, "interpreter-from-the-server");
        }),
      );

      it.effect("sets up with the worktree's own tool too", () =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const worktree = yield* makeWorktreeWith({
            "fd-relative-tool": saying("set-up-from-the-worktree"),
          });
          const server = yield* makeServer({});

          yield* serverAt(
            server,
            Effect.flatMap(FactoryVerifyRunner.FactoryVerifyRunner, (runner) =>
              runner.setup({
                deliveryId: FactoryDeliveryId.make("relative-path-setup"),
                worktreePath: worktree,
                command: toolCommand,
                timeoutMinutes: 1,
              }),
            ),
          );

          const directory = yield* evidenceDirectory("relative-path-setup");
          const log = yield* fileSystem.readFileString(path.join(directory, "setup-1.log"));
          assert.include(log, "set-up-from-the-worktree");
        }),
      );
    });

    it.effect("fails with a typed error and no git output when HEAD cannot be read", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const unborn = yield* fileSystem.makeTempDirectoryScoped({ prefix: "fd-factory-unborn-" });
        yield* git(unborn, ["init", "-b", "main"]);

        const error = yield* Effect.flip(run("unborn", unborn, passing));

        assert.strictEqual(error._tag, "FactoryBranchReadError");
        assert.strictEqual(error.message, `Factory could not read 'head' in worktree ${unborn}.`);
      }),
    );
  },
);

describe("FactoryVerifyRunner through a recording process runner", () => {
  const requested: Array<ProcessRunner.ProcessRunInput> = [];
  // Opens once both of the command's lines have reached the runner's chunk callbacks; after that
  // only the timeout can end the run, and the test clock decides when it fires.
  const outputDelivered = Deferred.makeUnsafe<void>();
  const observedRunner = Layer.effect(
    ProcessRunner.ProcessRunner,
    Effect.map(ProcessRunner.make(), (runner) =>
      ProcessRunner.ProcessRunner.of({
        run: (input) => {
          requested.push(input);
          let seen = "";
          const observe =
            (forward: ProcessRunner.ProcessRunInput["onStdoutChunk"]) => (chunk: Uint8Array) => {
              forward?.(chunk);
              seen += new TextDecoder().decode(chunk);
              if (seen.includes("out-before-timeout") && seen.includes("err-before-timeout")) {
                Deferred.doneUnsafe(outputDelivered, Effect.void);
              }
            };
          return runner.run({
            ...input,
            onStdoutChunk: observe(input.onStdoutChunk),
            onStderrChunk: observe(input.onStderrChunk),
          });
        },
      }),
    ),
  );

  it.layer(makeLayer(observedRunner))((it) => {
    it.effect("keeps the output written before the timeout and records a timed-out receipt", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const worktree = yield* makeWorktree;
        const settings = nodeVerify(
          `
          const fs = require("node:fs");
          fs.writeSync(1, "out-before-timeout\\n");
          fs.writeSync(2, "err-before-timeout\\n");
          setInterval(() => {}, 1000);
        `,
          { verifyTimeoutMinutes: 7 },
        );

        const running = yield* Effect.forkChild(receiptOf("timed-out", worktree, settings));
        yield* Deferred.await(outputDelivered);
        yield* TestClock.adjust("6 minutes");
        assert.isUndefined(running.pollUnsafe());
        yield* TestClock.adjust("1 minute");
        const receipt = yield* Fiber.join(running);

        assert.strictEqual(receipt.timedOut, true);
        assert.strictEqual(receipt.code, null);
        assert.strictEqual(receipt.durationMs, 7 * 60_000);
        const log = yield* fileSystem.readFile(receipt.logPath);
        assert.deepStrictEqual(sortedLines(log), ["err-before-timeout", "out-before-timeout"]);
        assert.strictEqual(receipt.outputHash, sha256(log));

        const input = requested.at(-1);
        assert.strictEqual(input?.command, process.execPath);
        assert.deepStrictEqual(input?.args, settings.verifyCommand.args);
        assert.strictEqual(input?.cwd, worktree);
        assert.strictEqual(input?.timeoutBehavior, "timedOutResult");
        assert.isTrue(
          Duration.equals(Duration.fromInputUnsafe(input?.timeout ?? 0), Duration.minutes(7)),
        );
      }),
    );

    it.effect("hands the process runner the executable a Windows lookup resolved", () =>
      Effect.gen(function* () {
        const worktree = yield* makeWorktree;
        // Only the lookup knows this name; it resolves to a program, not a batch script.
        const verifyCommand = {
          executable: "fd-factory-verify-tool",
          args: ["-e", `console.log("resolved")`],
        };
        const settings = { ...decodeSettings({ verifyCommand }), verifyCommand };

        const receipt = yield* receiptOf("windows-exe", worktree, settings).pipe(
          Effect.provideService(HostProcess.Platform, "win32"),
          Effect.provideService(SpawnExecutableResolution, (command) =>
            command === "fd-factory-verify-tool" ? process.execPath : undefined,
          ),
        );

        assert.strictEqual(receipt.code, 0);
        assert.deepStrictEqual(receipt.command, verifyCommand);
        assert.strictEqual(requested.at(-1)?.command, process.execPath);
        assert.deepStrictEqual(requested.at(-1)?.args, verifyCommand.args);
      }),
    );
  });
});

describe("verifySettingsHash", () => {
  const base = nodeVerify(`console.log("ok")`, { verifyTimeoutMinutes: 30 });

  it("is equal for identical settings and ignores settings a run does not use", () => {
    const same = nodeVerify(`console.log("ok")`, { verifyTimeoutMinutes: 30, maxFixRounds: 5 });
    assert.strictEqual(
      FactoryVerifyRunner.verifySettingsHash(same),
      FactoryVerifyRunner.verifySettingsHash(base),
    );
  });

  it("changes with the verify arguments or the verify timeout", () => {
    const hashes = [
      base,
      nodeVerify(`console.log("ok!")`, { verifyTimeoutMinutes: 30 }),
      nodeVerify(`console.log("ok")`, { verifyTimeoutMinutes: 31 }),
    ].map(FactoryVerifyRunner.verifySettingsHash);
    assert.strictEqual(new Set(hashes).size, hashes.length);
  });
});

describe("a relative executable on Windows", () => {
  const worktree = "C:\\work\\tree";
  const started: Array<ProcessRunner.ProcessRunInput> = [];
  const noProcess = Layer.mock(ProcessRunner.ProcessRunner)({
    run: (input) => {
      started.push(input);
      return Effect.die("A batch script must not start.");
    },
  });
  /** A lookup that sees only the worktree's batch script, as a server elsewhere would need it to. */
  const seeingTheWorktree = <A, E, R>(effect: Effect.Effect<A, E, R>, asked: Array<string>) =>
    effect.pipe(
      Effect.provideService(HostProcess.Platform, "win32"),
      Effect.provideService(SpawnExecutableResolution, (command) => {
        asked.push(command);
        return command === `${worktree}\\verify` ? `${worktree}\\verify.cmd` : undefined;
      }),
    );
  const relative = { executable: ".\\verify", args: ["--check"] };

  it.layer(
    makeLayer(noProcess, FactoryVerifyRunner.layer.pipe(Layer.provide(NodePath.layerWin32))),
  )("resolves against the worktree, as validation does", (it) => {
    it.effect("refuses a verify command that is a batch script there, before anything runs", () =>
      Effect.gen(function* () {
        const asked: Array<string> = [];
        const settings = {
          ...decodeSettings({ verifyCommand: relative }),
          verifyCommand: relative,
        };
        const error = yield* Effect.flip(
          seeingTheWorktree(run("windows-relative", worktree, settings), asked),
        );
        assert.strictEqual(error._tag, "FactoryVerifyShellRequiredError");
        assert.deepStrictEqual(asked, [`${worktree}\\verify`]);
        assert.deepStrictEqual(started, []);
      }),
    );

    /** A lookup that finds the script a relative PATH reaches, only from where the run starts. */
    const onARelativePath = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      effect.pipe(
        Effect.provideService(HostProcess.Platform, "win32"),
        Effect.provideService(HostProcess.Environment, { PATH: ".\\bin", PATHEXT: ".EXE;.CMD" }),
        Effect.provideService(SpawnExecutableResolution, (command, _platform, env, cwd) =>
          command === "verify" && env.PATH === ".\\bin" && cwd === worktree
            ? `${worktree}\\bin\\verify.cmd`
            : undefined,
        ),
      );
    const bare = { executable: "verify", args: ["--check"] };

    it.effect("refuses a verify command a relative PATH finds is a batch script there", () =>
      Effect.gen(function* () {
        const settings = { ...decodeSettings({ verifyCommand: bare }), verifyCommand: bare };
        const error = yield* Effect.flip(
          onARelativePath(run("windows-relative-path", worktree, settings)),
        );
        assert.strictEqual(error._tag, "FactoryVerifyShellRequiredError");
        assert.deepStrictEqual(started, []);
      }),
    );

    it.effect("refuses a setup command a relative PATH finds is a batch script there", () =>
      Effect.gen(function* () {
        const error = yield* Effect.flip(
          onARelativePath(
            Effect.flatMap(FactoryVerifyRunner.FactoryVerifyRunner, (runner) =>
              runner.setup({
                deliveryId: FactoryDeliveryId.make("windows-relative-path-setup"),
                worktreePath: worktree,
                command: bare,
                timeoutMinutes: 1,
              }),
            ),
          ),
        );
        assert.strictEqual(error._tag, "FactorySetupFailedError");
        assert.deepStrictEqual(started, []);
      }),
    );

    it.effect("refuses a setup command that is a batch script there, before anything runs", () =>
      Effect.gen(function* () {
        const asked: Array<string> = [];
        const error = yield* Effect.flip(
          seeingTheWorktree(
            Effect.flatMap(FactoryVerifyRunner.FactoryVerifyRunner, (runner) =>
              runner.setup({
                deliveryId: FactoryDeliveryId.make("windows-setup"),
                worktreePath: worktree,
                command: relative,
                timeoutMinutes: 1,
              }),
            ),
            asked,
          ),
        );
        assert.strictEqual(error._tag, "FactorySetupFailedError");
        assert.deepStrictEqual(asked, [`${worktree}\\verify`]);
        assert.deepStrictEqual(started, []);
      }),
    );
  });
});

describe("with exactly an empty PATH, and the server somewhere else", () => {
  /** Git keeps the PATH this process started with; only what the runner starts has the empty one. */
  const gitOnItsOwnPath = Layer.effect(
    GitVcsDriver.GitVcsDriver,
    Effect.map(GitVcsDriver.GitVcsDriver, (git) => {
      const { PATH } = process.env;
      return GitVcsDriver.GitVcsDriver.of({
        ...git,
        execute: (input) => git.execute({ ...input, env: { ...input.env, PATH } }),
      });
    }),
  ).pipe(Layer.provide(GitVcsDriver.layer));

  /** The server's directory and exactly `PATH=` for the effect's length, as a real run inherits. */
  const serverAt = <A, E, R>(directory: string, effect: Effect.Effect<A, E, R>) =>
    Effect.acquireUseRelease(
      Effect.sync(() => enterProcess(directory, () => "")),
      () => effect,
      (previous) => Effect.sync(() => restoreProcess(previous)),
    );

  const holding = (directory: string, files: Readonly<Record<string, string>>) =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      for (const [name, text] of Object.entries(files)) {
        yield* fileSystem.writeFileString(path.join(directory, name), text);
        yield* fileSystem.chmod(path.join(directory, name), 0o755);
      }
    });
  const makeServer = (files: Readonly<Record<string, string>>) =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const server = yield* fileSystem.makeTempDirectoryScoped({ prefix: "fd-empty-path-server-" });
      yield* holding(server, files);
      return server;
    });
  /** A worktree committing each file given, done before anything narrows the PATH. */
  const makeWorktreeHolding = (files: Readonly<Record<string, string>>) =>
    Effect.gen(function* () {
      const worktree = yield* makeWorktree;
      yield* holding(worktree, files);
      yield* git(worktree, ["add", "."]);
      yield* git(worktree, [...commitArgs, "chore: add tools"]);
      return worktree;
    });

  const tool = "fd-empty-path-tool";
  const interpreter = "fd-empty-path-interpreter";
  const command = { executable: tool, args: ["--check"] };
  const settings = { ...decodeSettings({ verifyCommand: command }), verifyCommand: command };
  /** A script that says who it is, what PATH it was given and which arguments it received. */
  const saying = (words: string) => `#!/bin/sh\necho "${words} PATH=[$PATH] $*"\n`;
  const usingInterpreter = `#!/usr/bin/env ${interpreter}\n`;
  const marking = (marker: string) => `#!/bin/sh\necho ran > ${JSON.stringify(marker)}\n`;

  const setup = (deliveryId: string, worktreePath: string) =>
    Effect.flatMap(FactoryVerifyRunner.FactoryVerifyRunner, (runner) =>
      runner.setup({
        deliveryId: FactoryDeliveryId.make(deliveryId),
        worktreePath,
        command,
        timeoutMinutes: 1,
      }),
    );
  const setupLog = (deliveryId: string) =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      return yield* fileSystem.readFileString(
        path.join(yield* evidenceDirectory(deliveryId), "setup-1.log"),
      );
    });

  it.layer(makeLayer(ProcessRunner.layer, FactoryVerifyRunner.layer, gitOnItsOwnPath), {
    excludeTestServices: true,
  })("a real run", (it) => {
    it.effect("verifies with the worktree's own tool, keeping the command as saved", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const worktree = yield* makeWorktreeHolding({ [tool]: saying("ran-from-the-worktree") });
        const server = yield* makeServer({ [tool]: saying("ran-from-the-server") });
        const saved = structuredClone(settings);

        const receipt = yield* serverAt(server, receiptOf("empty-path", worktree, settings));

        assert.strictEqual(receipt.code, 0);
        assert.deepStrictEqual(receipt.command, command);
        assert.deepStrictEqual(settings, saved);
        assert.strictEqual(
          yield* fileSystem.readFileString(receipt.logPath),
          "ran-from-the-worktree PATH=[] --check\n",
        );
      }),
    );

    it.effect("cannot verify with a tool only the server's directory holds", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const worktree = yield* makeWorktree;
        const marker = path.join(yield* fileSystem.makeTempDirectoryScoped(), "marker");
        const server = yield* makeServer({ [tool]: marking(marker) });

        const error = yield* Effect.flip(
          serverAt(server, run("empty-path-server-only", worktree, settings)),
        );

        assert.strictEqual(error._tag, "FactoryVerifyCommandError");
        assert.isFalse(yield* exists(marker));
      }),
    );

    it.effect("verifies through the interpreter its env finds in the worktree", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const worktree = yield* makeWorktreeHolding({
          [tool]: usingInterpreter,
          [interpreter]: saying("interpreter-from-the-worktree"),
        });
        const server = yield* makeServer({
          [interpreter]: saying("interpreter-from-the-server"),
        });

        const receipt = yield* serverAt(server, receiptOf("empty-path-env", worktree, settings));

        assert.strictEqual(receipt.code, 0);
        assert.deepStrictEqual(receipt.command, command);
        const log = yield* fileSystem.readFileString(receipt.logPath);
        assert.include(log, "interpreter-from-the-worktree PATH=[]");
        assert.notInclude(log, "interpreter-from-the-server");
      }),
    );

    it.effect("cannot verify through an interpreter only the server's directory holds", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const worktree = yield* makeWorktreeHolding({ [tool]: usingInterpreter });
        const server = yield* makeServer({
          [interpreter]: saying("interpreter-from-the-server"),
        });

        const receipt = yield* serverAt(
          server,
          receiptOf("empty-path-env-server-only", worktree, settings),
        );

        assert.notStrictEqual(receipt.code, 0);
        assert.notInclude(
          yield* fileSystem.readFileString(receipt.logPath),
          "interpreter-from-the-server",
        );
      }),
    );

    it.effect("sets up with the worktree's own tool", () =>
      Effect.gen(function* () {
        const worktree = yield* makeWorktreeHolding({ [tool]: saying("set-up-from-the-worktree") });
        const server = yield* makeServer({ [tool]: saying("set-up-from-the-server") });

        yield* serverAt(server, setup("empty-path-setup", worktree));

        assert.strictEqual(
          yield* setupLog("empty-path-setup"),
          "set-up-from-the-worktree PATH=[] --check\n",
        );
      }),
    );

    it.effect("cannot set up with a tool only the server's directory holds", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const worktree = yield* makeWorktree;
        const marker = path.join(yield* fileSystem.makeTempDirectoryScoped(), "marker");
        const server = yield* makeServer({ [tool]: marking(marker) });

        const error = yield* Effect.flip(
          serverAt(server, setup("empty-path-setup-server-only", worktree)),
        );

        assert.strictEqual(endingOf(error), "not_run");
        assert.isFalse(yield* exists(marker));
      }),
    );

    it.effect("sets up through the interpreter its env finds in the worktree", () =>
      Effect.gen(function* () {
        const worktree = yield* makeWorktreeHolding({
          [tool]: usingInterpreter,
          [interpreter]: saying("interpreter-from-the-worktree"),
        });
        const server = yield* makeServer({
          [interpreter]: saying("interpreter-from-the-server"),
        });

        yield* serverAt(server, setup("empty-path-setup-env", worktree));

        const log = yield* setupLog("empty-path-setup-env");
        assert.include(log, "interpreter-from-the-worktree PATH=[]");
        assert.notInclude(log, "interpreter-from-the-server");
      }),
    );

    it.effect("cannot set up through an interpreter only the server's directory holds", () =>
      Effect.gen(function* () {
        const worktree = yield* makeWorktreeHolding({ [tool]: usingInterpreter });
        const server = yield* makeServer({
          [interpreter]: saying("interpreter-from-the-server"),
        });

        const error = yield* Effect.flip(
          serverAt(server, setup("empty-path-setup-env-server-only", worktree)),
        );

        assert.strictEqual(endingOf(error), "exited");
        assert.notInclude(
          yield* setupLog("empty-path-setup-env-server-only"),
          "interpreter-from-the-server",
        );
      }),
    );
  });
});

// Simulated: the shared lookup's win32 rules over this host's files, under the real process runner
// with only its child spawner replaced. None of this is native Windows execution.
describe("a bare command on simulated Windows, through the real process runner", () => {
  const spawned: Array<{
    readonly command: string;
    readonly args: ReadonlyArray<string>;
    readonly cwd: string | undefined;
    readonly shell: boolean | string | undefined;
  }> = [];
  const finished = ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(1),
    exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
    unref: Effect.succeed(Effect.void),
    stdin: Sink.drain,
    stdout: Stream.empty,
    stderr: Stream.empty,
    all: Stream.empty,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
  });
  // Its own layer, since `ProcessRunner.layer` is memoized with the one the Git services build.
  const realRunner = Layer.effect(ProcessRunner.ProcessRunner, ProcessRunner.make()).pipe(
    Layer.provide(
      Layer.succeed(
        ChildProcessSpawner.ChildProcessSpawner,
        ChildProcessSpawner.make((child) =>
          Effect.sync(() => {
            // Reads the command's private fields, as the process runner's own tests do.
            const { command, args, options } = child as unknown as {
              readonly command: string;
              readonly args: ReadonlyArray<string>;
              readonly options: {
                readonly cwd?: string;
                readonly shell?: boolean | string;
              };
            };
            spawned.push({ command, args, cwd: options.cwd, shell: options.shell });
            return finished;
          }),
        ),
      ),
    ),
  );

  const windows = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.provideService(HostProcess.Platform, "win32"),
      Effect.provideService(CommandResolutionCache, new Map()),
    );
  const command = { executable: "verify", args: ["--check"] };
  const settings = { ...decodeSettings({ verifyCommand: command }), verifyCommand: command };
  const setup = (deliveryId: string, worktreePath: string) =>
    Effect.flatMap(FactoryVerifyRunner.FactoryVerifyRunner, (runner) =>
      runner.setup({
        deliveryId: FactoryDeliveryId.make(deliveryId),
        worktreePath,
        command,
        timeoutMinutes: 1,
      }),
    );

  /** The server in a directory only a lookup with no `cwd` can find its batch script from. */
  const serverWithBatchScript = <A, E, R>(worktree: string, effect: Effect.Effect<A, E, R>) =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const server = yield* fileSystem.makeTempDirectoryScoped({ prefix: "fd-windows-server-" });
      yield* fileSystem.makeDirectory(path.join(server, "bin"));
      // Where the win32 rules ask for `.\bin\verify.cmd`, on any host: a file of that name here.
      yield* fileSystem.writeFileString(path.join(server, "bin\\verify.cmd"), "@echo off\n");
      return yield* Effect.acquireUseRelease(
        Effect.sync(() => {
          const previous = process.cwd();
          process.chdir(server);
          return previous;
        }),
        () =>
          Effect.gen(function* () {
            // The defect's two lookups, as they stand before the run: a miss from where the
            // command starts, and the batch script from the server's directory.
            assert.deepStrictEqual(
              yield* resolveSpawnCommand("verify", ["--check"], { cwd: worktree }),
              { command: "verify", args: ["--check"], shell: false },
            );
            assert.isTrue((yield* resolveSpawnCommand("verify", ["--check"])).shell);
            return yield* effect;
          }),
        (previous) => Effect.sync(() => process.chdir(previous)),
      );
    }).pipe(
      Effect.provideService(HostProcess.Environment, { PATH: ".\\bin", PATHEXT: ".EXE;.CMD" }),
      windows,
    );

  /** A lookup from the worktree finding `found`; the server's batch script for one with no `cwd`. */
  const findingInWorktree =
    (worktree: string, found: string): SpawnExecutableResolver =>
    (executable, _platform, _env, cwd) => {
      if (executable !== "verify") return undefined;
      if (cwd === worktree) return found;
      return cwd === undefined ? "bin\\verify.cmd" : undefined;
    };
  const program = "C:\\fd-target\\bin\\verify.exe";
  const batchScript = "C:\\fd-target\\bin\\verify.cmd";

  it.layer(makeLayer(realRunner), { excludeTestServices: true })(
    "refuses before any child starts",
    (it) => {
      it.effect("refuses a verify command a lookup from the worktree misses", () =>
        Effect.gen(function* () {
          spawned.length = 0;
          const worktree = yield* makeWorktree;

          const error = yield* Effect.flip(
            serverWithBatchScript(worktree, run("windows-miss", worktree, settings)),
          );

          assert.strictEqual(error._tag, "FactoryVerifyCommandError");
          assert.strictEqual(
            error.message,
            `Factory could not run the verify command in worktree ${worktree}.`,
          );
          assert.deepStrictEqual(spawned, []);
          assert.isFalse(yield* exists(yield* evidenceDirectory("windows-miss")));
        }),
      );

      it.effect("refuses a setup command a lookup from the worktree misses", () =>
        Effect.gen(function* () {
          spawned.length = 0;
          const worktree = yield* makeWorktree;

          const error = yield* Effect.flip(
            serverWithBatchScript(worktree, setup("windows-setup-miss", worktree)),
          );

          assert.strictEqual(endingOf(error), "not_run");
          assert.deepStrictEqual(spawned, []);
          assert.isFalse(yield* exists(yield* evidenceDirectory("windows-setup-miss")));
        }),
      );

      it.effect("refuses a verify command that is a batch script in the worktree", () =>
        Effect.gen(function* () {
          spawned.length = 0;
          const worktree = yield* makeWorktree;

          const error = yield* Effect.flip(
            run("windows-target-batch", worktree, settings).pipe(
              Effect.provideService(
                SpawnExecutableResolution,
                findingInWorktree(worktree, batchScript),
              ),
              windows,
            ),
          );

          assert.strictEqual(error._tag, "FactoryVerifyShellRequiredError");
          assert.deepStrictEqual(spawned, []);
        }),
      );

      it.effect("refuses a setup command that is a batch script in the worktree", () =>
        Effect.gen(function* () {
          spawned.length = 0;
          const worktree = yield* makeWorktree;

          const error = yield* Effect.flip(
            setup("windows-setup-target-batch", worktree).pipe(
              Effect.provideService(
                SpawnExecutableResolution,
                findingInWorktree(worktree, batchScript),
              ),
              windows,
            ),
          );

          assert.strictEqual(endingOf(error), "not_run");
          assert.deepStrictEqual(spawned, []);
        }),
      );

      it.effect("verifies with the program the worktree's lookup found, without a shell", () =>
        Effect.gen(function* () {
          spawned.length = 0;
          const worktree = yield* makeWorktree;

          const receipt = yield* receiptOf("windows-target-program", worktree, settings).pipe(
            Effect.provideService(SpawnExecutableResolution, findingInWorktree(worktree, program)),
            windows,
          );

          assert.strictEqual(receipt.code, 0);
          assert.deepStrictEqual(receipt.command, command);
          assert.deepStrictEqual(spawned, [
            { command: program, args: command.args, cwd: worktree, shell: false },
          ]);
        }),
      );

      it.effect("sets up with the program the worktree's lookup found, without a shell", () =>
        Effect.gen(function* () {
          spawned.length = 0;
          const worktree = yield* makeWorktree;

          yield* setup("windows-setup-target-program", worktree).pipe(
            Effect.provideService(SpawnExecutableResolution, findingInWorktree(worktree, program)),
            windows,
          );

          assert.deepStrictEqual(spawned, [
            { command: program, args: command.args, cwd: worktree, shell: false },
          ]);
        }),
      );
    },
  );
});
