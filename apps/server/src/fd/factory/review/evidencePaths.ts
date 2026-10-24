import type { FactoryReview } from "@t3tools/contracts/fd/factory";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import type * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";

import { validateReview } from "./validate.ts";
import type {
  FactoryReviewContext,
  FactoryReviewProblem,
  FactoryReviewValidation,
} from "./validate.ts";

/**
 * Resolving the worktree, or an evidence path for a reason other than its absence, failed. The
 * review cannot be judged, which is not the reviewer's to correct.
 */
export class FactoryEvidencePathError extends Schema.TaggedError<FactoryEvidencePathError>()(
  "FactoryEvidencePathError",
  {
    path: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Factory could not resolve ${this.path}.`;
  }
}

/**
 * Missing, through a file used as a directory, a symlink loop, or a name longer than the file
 * system allows (Node reports that one as `Unknown`): nothing to read there.
 */
const isUnresolvable = ({ reason }: PlatformError.PlatformError) =>
  reason._tag === "NotFound" ||
  reason._tag === "BadResource" ||
  (reason._tag === "Unknown" &&
    typeof reason.cause === "object" &&
    reason.cause !== null &&
    "code" in reason.cause &&
    reason.cause.code === "ENAMETOOLONG");

/**
 * Problems with the evidence paths of verified criteria: each must exist and its realpath must
 * lie inside the worktree's realpath, so a symlink cannot point a reviewer's evidence outside it.
 * Paths of failed or untested criteria are claims of absence and are not resolved.
 */
export const checkEvidencePaths = Effect.fn("checkEvidencePaths")(function* (
  worktreePath: string,
  review: FactoryReview,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fileSystem.realPath(worktreePath).pipe(
    Effect.catchTags({
      PlatformError: (cause) =>
        Effect.fail(new FactoryEvidencePathError({ path: worktreePath, cause })),
    }),
  );
  const isInside = (resolved: string) => {
    const relative = path.relative(root, resolved);
    return !(
      relative === ".." ||
      relative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relative)
    );
  };
  const problemsOf = (
    evidencePath: string,
  ): Effect.Effect<ReadonlyArray<FactoryReviewProblem>, FactoryEvidencePathError> => {
    const target = path.join(root, evidencePath);
    const quoted = JSON.stringify(evidencePath);
    return fileSystem.realPath(target).pipe(
      Effect.map((resolved): ReadonlyArray<FactoryReviewProblem> =>
        isInside(resolved)
          ? []
          : [
              {
                rule: "evidence_path_outside_worktree",
                description: `Evidence path ${quoted} resolves outside the worktree.`,
              },
            ],
      ),
      Effect.catchTags({
        PlatformError: (cause) =>
          isUnresolvable(cause)
            ? Effect.succeed([
                {
                  rule: "evidence_path_missing",
                  description: `Evidence path ${quoted} does not exist in the worktree.`,
                } as const,
              ])
            : Effect.fail(new FactoryEvidencePathError({ path: target, cause })),
      }),
    );
  };
  const paths = new Set(
    review.acceptance
      .filter((check) => check.status === "verified")
      .flatMap((check) => check.paths),
  );
  const problems = yield* Effect.forEach(paths, problemsOf, { concurrency: 8 });
  return problems.flat();
});

/**
 * `validateReview` plus the evidence path check. Path problems make the review invalid, reported
 * together with its structural problems.
 */
export const validateReviewInWorktree = Effect.fn("validateReviewInWorktree")(function* (
  worktreePath: string,
  review: FactoryReview,
  context: FactoryReviewContext,
) {
  const pathProblems = yield* checkEvidencePaths(worktreePath, review);
  const validation = validateReview(review, context);
  if (pathProblems.length === 0) return validation;
  const problems = validation.status === "invalid" ? validation.problems : [];
  const invalid: FactoryReviewValidation = {
    status: "invalid",
    problems: [...problems, ...pathProblems],
  };
  return invalid;
});
