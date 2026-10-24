import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { FactoryReview } from "@t3tools/contracts/fd/factory";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { checkEvidencePaths, validateReviewInWorktree } from "./evidencePaths.ts";
import type { FactoryReviewContext } from "./validate.ts";

const decodeReview = Schema.decodeUnknownSync(FactoryReview);

type Check = FactoryReview["acceptance"][number];

const reviewWith = (acceptance: ReadonlyArray<Partial<Check> & { paths: string[] }>) =>
  decodeReview({
    verdict: "pass",
    findings: [],
    acceptance: acceptance.map((entry, index) => ({
      criterion: index + 1,
      status: "verified",
      evidence: "The focused test covers it.",
      ...entry,
    })),
    missing_evidence: [],
  });

const context: FactoryReviewContext = { criteriaCount: null, blockingSeverities: ["high"] };

/** A worktree with `src/a.ts`, and a directory outside it holding `secret.txt`. */
const makeDirectories = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const worktree = yield* fileSystem.makeTempDirectoryScoped({ prefix: "fd-factory-review-wt-" });
  const outside = yield* fileSystem.makeTempDirectoryScoped({ prefix: "fd-factory-review-out-" });
  yield* fileSystem.makeDirectory(path.join(worktree, "src"));
  yield* fileSystem.writeFileString(path.join(worktree, "src", "a.ts"), "export {};\n");
  yield* fileSystem.writeFileString(path.join(outside, "secret.txt"), "outside\n");
  return { worktree, outside };
});

describe("checkEvidencePaths", () => {
  it.effect("accepts existing files and symlinks that stay inside the worktree", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { worktree } = yield* makeDirectories;
      yield* fileSystem.symlink(path.join(worktree, "src", "a.ts"), path.join(worktree, "link.ts"));
      // A name starting with ".." is inside the worktree, not a parent directory.
      yield* fileSystem.writeFileString(path.join(worktree, "..notes.md"), "notes\n");
      const review = reviewWith([
        { paths: ["src/a.ts", "src"] },
        { paths: ["link.ts", "..notes.md"] },
      ]);

      assert.deepStrictEqual(yield* checkEvidencePaths(worktree, review), []);
      assert.deepStrictEqual(yield* validateReviewInWorktree(worktree, review, context), {
        status: "passing",
        findings: { high: 0, medium: 0, low: 0 },
      });
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("makes the review invalid for a missing file, naming the path", () =>
    Effect.gen(function* () {
      const { worktree } = yield* makeDirectories;
      const review = reviewWith([{ paths: ["src/a.ts", "src/missing.test.ts"] }]);

      assert.deepStrictEqual(yield* validateReviewInWorktree(worktree, review, context), {
        status: "invalid",
        problems: [
          {
            rule: "evidence_path_missing",
            description: 'Evidence path "src/missing.test.ts" does not exist in the worktree.',
          },
        ],
      });
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("makes the review invalid for a symlink resolving outside the worktree", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { worktree, outside } = yield* makeDirectories;
      yield* fileSystem.symlink(path.join(outside, "secret.txt"), path.join(worktree, "leak.txt"));
      yield* fileSystem.symlink(outside, path.join(worktree, "src", "out"));
      const review = reviewWith([{ paths: ["leak.txt"] }, { paths: ["src/out/secret.txt"] }]);

      assert.deepStrictEqual(yield* validateReviewInWorktree(worktree, review, context), {
        status: "invalid",
        problems: [
          {
            rule: "evidence_path_outside_worktree",
            description: 'Evidence path "leak.txt" resolves outside the worktree.',
          },
          {
            rule: "evidence_path_outside_worktree",
            description: 'Evidence path "src/out/secret.txt" resolves outside the worktree.',
          },
        ],
      });
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("does not resolve the paths of failed or untested criteria", () =>
    Effect.gen(function* () {
      const { worktree } = yield* makeDirectories;
      const review = reviewWith([
        { paths: ["src/a.ts"] },
        { status: "untested", paths: ["src/missing.test.ts"] },
        { status: "failed", paths: ["src/also-missing.test.ts"] },
      ]);

      assert.deepStrictEqual(yield* checkEvidencePaths(worktree, review), []);
      const validation = yield* validateReviewInWorktree(worktree, review, context);
      assert.strictEqual(validation.status, "blocking");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("reports path problems together with structural problems", () =>
    Effect.gen(function* () {
      const { worktree } = yield* makeDirectories;
      const review = reviewWith([
        { criterion: 1, paths: ["src/missing.test.ts"] },
        { criterion: 1, paths: ["src/a.ts"] },
      ]);

      const validation = yield* validateReviewInWorktree(worktree, review, context);
      assert.deepStrictEqual(
        validation.status === "invalid" && validation.problems.map((problem) => problem.rule),
        ["repeated_criterion", "evidence_path_missing"],
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("fails with a typed error when the worktree does not exist", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const { worktree } = yield* makeDirectories;
      const gone = path.join(worktree, "gone");
      const error = yield* Effect.flip(
        checkEvidencePaths(gone, reviewWith([{ paths: ["src/a.ts"] }])),
      );
      assert.strictEqual(error._tag, "FactoryEvidencePathError");
      assert.strictEqual(error.path, gone);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
