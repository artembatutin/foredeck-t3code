import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

/**
 * A spawner over the one below it that hands each command to `before` first, which can hold it or
 * change what it runs with: another process acting on a repository between two Git commands, or an
 * older Git, as a test needs one. Provide it to the Git driver, so it sees the driver's commands.
 */
export const spawningThrough = (
  before: (command: ChildProcess.StandardCommand) => Effect.Effect<ChildProcess.StandardCommand>,
) =>
  Layer.effect(
    ChildProcessSpawner.ChildProcessSpawner,
    Effect.map(ChildProcessSpawner.ChildProcessSpawner, (spawner) =>
      ChildProcessSpawner.make((command) =>
        ChildProcess.isStandardCommand(command)
          ? Effect.flatMap(before(command), spawner.spawn)
          : spawner.spawn(command),
      ),
    ),
  );

/**
 * Holds the first command whose arguments `matches` until `release`, after completing `reached`: a
 * deterministic point between two Git commands for a test to change the repository at.
 */
export const holdFirst = (matches: (args: ReadonlyArray<string>) => boolean) =>
  Effect.gen(function* () {
    const reached = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    let held = false;
    const before = (command: ChildProcess.StandardCommand) =>
      held || !matches(command.args)
        ? Effect.succeed(command)
        : Effect.sync(() => {
            held = true;
          }).pipe(
            Effect.andThen(Deferred.succeed(reached, undefined)),
            Effect.andThen(Deferred.await(release)),
            Effect.as(command),
          );
    /** Waits for the held command, runs `change`, then lets the command run. */
    const changeThere = <A, E, R>(change: Effect.Effect<A, E, R>) =>
      Deferred.await(reached).pipe(
        Effect.andThen(change),
        Effect.tap(() => Deferred.succeed(release, undefined)),
      );
    return { before, changeThere };
  });

/** The command without any `GIT_CONFIG_*` variable, as a Git before 2.31 reads none of them. */
export const ignoringConfigEnvironment = (command: ChildProcess.StandardCommand) =>
  Effect.succeed(
    ChildProcess.make(command.command, command.args, {
      ...command.options,
      env: Object.fromEntries(
        Object.entries(command.options.env ?? {}).filter(
          ([key]) => !/^GIT_CONFIG_(?:COUNT|KEY_\d+|VALUE_\d+)$/i.test(key),
        ),
      ),
    }),
  );

/**
 * The command as a Git from 2.31 to before 2.46 runs it: it reads `GIT_CONFIG_*`, so one URL pins
 * as it would, but an empty remote URL there is added to the remote's list rather than clearing it.
 * The Git running here would clear the list, so a URL that names nothing stands for that empty one:
 * the remote keeps the URLs it is configured with, and gains one. Other commands run unchanged.
 */
export const appendingRemoteUrls = (command: ChildProcess.StandardCommand) => {
  const env = command.options.env ?? {};
  const keys = Object.keys(env).filter((key) => /^GIT_CONFIG_KEY_\d+$/.test(key));
  const clearing = keys.filter(
    (key) =>
      /^remote\..+\.(?:push)?url$/i.test(env[key] ?? "") && env[key.replace("KEY", "VALUE")] === "",
  );
  if (clearing.length === 0) return Effect.succeed(command);
  return Effect.succeed(
    ChildProcess.make(command.command, command.args, {
      ...command.options,
      env: {
        ...env,
        ...Object.fromEntries(
          clearing.map((key) => [key.replace("KEY", "VALUE"), "fd-test-empty-remote-url"]),
        ),
      },
    }),
  );
};
