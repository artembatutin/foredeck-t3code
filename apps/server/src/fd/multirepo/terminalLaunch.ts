import { RepositoryTargetError, type RepositoryTarget } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

/** Called under the terminal session lock before a launch can replace an existing shell. */
export function assertTerminalLaunchLocation(
  input: {
    readonly cwd?: string | undefined;
    readonly repositoryTarget?: RepositoryTarget | undefined;
  },
  existing: { readonly cwd: string },
) {
  return input.repositoryTarget && input.cwd !== undefined && input.cwd !== existing.cwd
    ? Effect.fail(
        new RepositoryTargetError({
          detail:
            "This terminal belongs to another directory. Open a new terminal for the selected repository.",
        }),
      )
    : Effect.void;
}

/** A retained transcript keeps its launch directory across server restarts. */
export function makeTerminalLocations(
  fs: import("effect/FileSystem").FileSystem,
  path: import("effect/Path").Path,
) {
  const locationPath = (historyPath: string) => `${historyPath}.repository-cwd`;
  const prepare = Effect.fn("RepositoryTerminal.prepare")(
    function* (
      historyPath: string,
      input: {
        readonly cwd?: string | undefined;
        readonly repositoryTarget?: RepositoryTarget | undefined;
      },
    ) {
      if (input.cwd === undefined) return;
      const file = locationPath(historyPath);
      if (yield* fs.exists(file)) {
        const cwd = yield* fs.readFileString(file);
        if (cwd !== input.cwd)
          return yield* new RepositoryTargetError({
            detail:
              "This retained terminal belongs to another repository directory. Open a new terminal for the selected repository.",
          });
      } else if (input.repositoryTarget !== undefined) {
        yield* fs.makeDirectory(path.dirname(file), { recursive: true });
        yield* fs.writeFileString(file, input.cwd);
      }
    },
    Effect.mapError((cause) => new RepositoryTargetError({ detail: cause.message, cause })),
  );
  return {
    prepare,
    forget: (historyPath: string) => fs.remove(locationPath(historyPath), { force: true }),
  };
}
