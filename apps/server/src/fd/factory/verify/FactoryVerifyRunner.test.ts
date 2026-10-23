// @effect-diagnostics-next-line nodeBuiltinImport:off -- hashes the log to compare with the receipt.
import * as NodeCrypto from "node:crypto";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  FactoryDeliveryId,
  FactoryProjectSettings,
  FactoryVerifyReceipt,
} from "@t3tools/contracts/fd/factory";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as ServerConfig from "../../../config.ts";
import * as ProcessRunner from "../../../processRunner.ts";
import * as GitVcsDriver from "../../../vcs/GitVcsDriver.ts";
import * as VcsProcess from "../../../vcs/VcsProcess.ts";
import type { FactoryDeliverySettings } from "../FactorySettings.ts";
import * as FactoryEvidence from "./FactoryEvidence.ts";
import * as FactoryVerifyRunner from "./FactoryVerifyRunner.ts";

const makeLayer = <E, R>(processRunner: Layer.Layer<ProcessRunner.ProcessRunner, E, R>) =>
  FactoryVerifyRunner.layer.pipe(
    Layer.provide(FactoryEvidence.layer),
    // The receipt's platform comes from the host references, not the process globals.
    Layer.provide(Layer.succeed(HostProcess.Platform, "linux")),
    Layer.provide(Layer.succeed(HostProcess.Architecture, "arm64")),
    Layer.provide(processRunner),
    Layer.provideMerge(GitVcsDriver.layer),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "fd-factory-verify-" })),
    Layer.provideMerge(VcsProcess.layer),
    Layer.provideMerge(NodeServices.layer),
  );

const decodeSettings = Schema.decodeUnknownSync(FactoryProjectSettings);
const decodeReceiptJson = Schema.decodeUnknownSync(Schema.fromJsonString(FactoryVerifyReceipt));

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

        const receipt = yield* receiptOf("passing", worktree, passing);

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
        assert.strictEqual(
          new TextDecoder().decode(log),
          "out: 2 tests failed\nerr: expected 1 to be 2\n",
        );
        assert.strictEqual(receipt.outputHash, sha256(log));
        assert.isTrue(yield* exists(receipt.logPath.replace(/\.log$/, ".json")));
      }),
    );

    it.effect("records a run ended by a signal as a receipt without an exit code", () =>
      Effect.gen(function* () {
        const worktree = yield* makeWorktree;
        const receipt = yield* receiptOf(
          "signalled",
          worktree,
          nodeVerify(`process.kill(process.pid, "SIGKILL")`),
        );
        assert.strictEqual(receipt.code, null);
        assert.strictEqual(receipt.timedOut, false);
      }),
    );

    it.effect("refuses a run that commits, keeping the log without a receipt", () =>
      Effect.gen(function* () {
        const worktree = yield* makeWorktree;
        const directory = yield* evidenceDirectory("commits");

        const outcome = yield* run("commits", worktree, nodeVerify(commitScript));

        assert.deepStrictEqual(outcome, { type: "refused", refusals: ["head_changed"] });
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

        assert.deepStrictEqual(outcome, { type: "refused", refusals: ["tree_dirty"] });
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

describe("FactoryVerifyRunner timeouts", () => {
  const requested: Array<ProcessRunner.ProcessRunInput> = [];
  // The real process runner with a short timeout, recording what the verify runner asked for.
  const shortTimeout = Layer.effect(
    ProcessRunner.ProcessRunner,
    Effect.map(ProcessRunner.make(), (runner) =>
      ProcessRunner.ProcessRunner.of({
        run: (input) => {
          requested.push(input);
          return runner.run({ ...input, timeout: "300 millis" });
        },
      }),
    ),
  );

  it.layer(makeLayer(shortTimeout), { excludeTestServices: true })((it) => {
    it.effect("records a run past its timeout as a timed-out receipt", () =>
      Effect.gen(function* () {
        const worktree = yield* makeWorktree;
        const settings = nodeVerify(`setInterval(() => {}, 1000)`, { verifyTimeoutMinutes: 7 });

        const receipt = yield* receiptOf("timed-out", worktree, settings);

        assert.strictEqual(receipt.timedOut, true);
        assert.strictEqual(receipt.code, null);
        const [input] = requested;
        assert.strictEqual(input?.command, process.execPath);
        assert.deepStrictEqual(input?.args, settings.verifyCommand.args);
        assert.strictEqual(input?.cwd, worktree);
        assert.strictEqual(input?.timeoutBehavior, "timedOutResult");
        assert.isTrue(
          Duration.equals(Duration.fromInputUnsafe(input?.timeout ?? 0), Duration.minutes(7)),
        );
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
