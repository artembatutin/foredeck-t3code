import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as ServerConfig from "../../../config.ts";
import * as GitVcsDriver from "../../../vcs/GitVcsDriver.ts";
import * as VcsProcess from "../../../vcs/VcsProcess.ts";
import { FactoryBranchUnavailableError, freshBranchName } from "./freshBranch.ts";

const layer = GitVcsDriver.layer.pipe(
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "fd-factory-branch-" })),
  Layer.provideMerge(VcsProcess.layer),
  Layer.provideMerge(NodeServices.layer),
);

const base = "work/fd-aaaaaa-add-the-export-button";
const isUnavailable = Schema.is(FactoryBranchUnavailableError);

const git = (cwd: string, args: ReadonlyArray<string>) =>
  Effect.flatMap(GitVcsDriver.GitVcsDriver, (driver) =>
    driver.execute({ operation: "test.git", cwd, args, timeoutMs: 10_000 }),
  ).pipe(Effect.map((result) => result.stdout.trim()));

const ada = ["-c", "user.name=Ada Lovelace", "-c", "user.email=ada@example.com"];

/** A repository with one commit on `main`, the project's canonical checkout. */
const repository = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "fd-factory-branch-repo-" });
  yield* git(cwd, ["init", "-b", "main"]);
  yield* git(cwd, [
    ...ada,
    "commit",
    "--no-verify",
    "--no-gpg-sign",
    "--allow-empty",
    "-m",
    "chore: root",
  ]);
  return cwd;
});

const fresh = (cwd: string, taken: ReadonlyArray<string> = []) =>
  freshBranchName({ cwd, base, taken });

describe("freshBranchName", () => {
  it.effect("keeps the item's branch name while nothing holds it", () =>
    Effect.gen(function* () {
      const cwd = yield* repository;
      assert.strictEqual(yield* fresh(cwd), base);
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.effect("skips names a local branch, a remote-tracking branch or a tag holds", () =>
    Effect.gen(function* () {
      const cwd = yield* repository;
      // A thread started from the item outside Factory, and a pushed and a tagged earlier try.
      yield* git(cwd, ["branch", base]);
      yield* git(cwd, ["update-ref", `refs/remotes/origin/${base}-2`, "HEAD"]);
      yield* git(cwd, ["update-ref", `refs/tags/${base}-3`, "HEAD"]);
      assert.strictEqual(yield* fresh(cwd), `${base}-4`);
      // A longer name that only starts like a candidate holds none of them.
      yield* git(cwd, ["branch", `${base}-40-other`]);
      assert.strictEqual(yield* fresh(cwd), `${base}-4`);
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.effect("skips names earlier deliveries recorded, even before their branch exists", () =>
    Effect.gen(function* () {
      const cwd = yield* repository;
      // An earlier delivery cancelled before its launch created its branch.
      assert.strictEqual(yield* fresh(cwd, [base]), `${base}-2`);
      yield* git(cwd, ["branch", `${base}-2`]);
      assert.strictEqual(yield* fresh(cwd, [base]), `${base}-3`);
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.effect(
    "leaves a repository Git cannot read to the launch, still skipping recorded names",
    () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const plain = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "fd-factory-branch-dir-",
        });
        for (const cwd of [plain, path.join(plain, "missing")]) {
          assert.strictEqual(yield* fresh(cwd), base);
          assert.strictEqual(yield* fresh(cwd, [base, `${base}-2`]), `${base}-3`);
        }
      }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.effect("fails once every numbered name is held", () =>
    Effect.gen(function* () {
      const cwd = yield* repository;
      const taken = [base, ...Array.from({ length: 99 }, (_, index) => `${base}-${index + 2}`)];
      const error = yield* Effect.flip(fresh(cwd, taken));
      assert.isTrue(isUnavailable(error));
      assert.strictEqual(error.base, base);
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );
});
