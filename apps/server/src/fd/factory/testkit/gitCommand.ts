import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

/**
 * A test's Git arguments for `cwd`, naming a bare repository with `--git-dir`: core runs Git with
 * `safe.bareRepository=explicit`, so a bare repository opens only when named. A bare repository
 * keeps `HEAD` at its root; a checkout keeps it under `.git`.
 */
export const explicitBare = (cwd: string, args: ReadonlyArray<string>) =>
  args[0] === "init"
    ? Effect.succeed(args)
    : Effect.flatMap(FileSystem.FileSystem, (fileSystem) =>
        fileSystem.exists(`${cwd}/HEAD`).pipe(
          Effect.orElseSucceed(() => false),
          Effect.map((bare) => (bare ? ["--git-dir", cwd, ...args] : args)),
        ),
      );
