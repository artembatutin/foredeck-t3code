import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Crypto from "effect/Crypto";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as ProcessRunner from "../../processRunner.ts";

const Profile = Schema.Struct({
  provider: Schema.String,
  model: Schema.String,
  effort: Schema.String,
});
const Config = Schema.Struct({
  kind: Schema.optional(Schema.Literal("development")),
  projectRoot: Schema.String,
  runtimeDir: Schema.String,
  worktree: Schema.String,
  goalPath: Schema.String,
  profiles: Schema.Struct({
    author: Profile,
    repair: Profile,
    reviewer: Profile,
    planner: Profile,
  }),
});
export const Prepared = Schema.Struct({
  configPath: Schema.String,
  projectRoot: Schema.String,
  runtimeDir: Schema.String,
  worktree: Schema.String,
  configHash: Schema.String,
  goalHash: Schema.String,
});
export type Prepared = typeof Prepared.Type;
export const Status = Schema.Struct({
  runId: Schema.String,
  status: Schema.String,
  stage: Schema.String,
  configPath: Schema.optional(Schema.String),
  projectRoot: Schema.optional(Schema.String),
  updatedAt: Schema.String,
  lastError: Schema.NullOr(Schema.String),
  runDir: Schema.String,
});
export type Status = typeof Status.Type;
const decodeConfig = Schema.decodeUnknownEffect(Schema.fromJsonString(Config));
const decodeStatus = Schema.decodeUnknownEffect(Schema.fromJsonString(Status));
const decodeAcknowledgment = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Array(Schema.Struct({ configPath: Schema.String, runId: Schema.String })),
  ),
);

class LooperError extends Schema.TaggedError<LooperError>()("LooperError", {
  operation: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message() {
    return `Looper ${this.operation} failed. Inspect its configuration, doctor and recorded status; no executor was substituted.`;
  }
}
export class Looper extends Context.Service<
  Looper,
  {
    readonly prepare: (
      configPath: string,
      projectRoot: string,
      brief: string,
    ) => Effect.Effect<Prepared, LooperError>;
    readonly start: (config: Prepared, resume: boolean) => Effect.Effect<string, LooperError>;
    readonly inspect: (config: Prepared) => Effect.Effect<Status | null, LooperError>;
    readonly stop: (config: Prepared, runId: string) => Effect.Effect<void, LooperError>;
  }
>()("t3/fd/assistant/Looper") {}
const wrap =
  (operation: string) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(Effect.mapError((cause) => new LooperError({ operation, cause })));
const make = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const hash = (text: string) =>
    crypto
      .digest("SHA-256", new TextEncoder().encode(text))
      .pipe(
        Effect.map((bytes) =>
          Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(""),
        ),
      );
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const process = yield* ProcessRunner.ProcessRunner;
  const home = yield* HostProcess.HomeDirectory;
  const run = Effect.fn(function* (args: ReadonlyArray<string>, cwd: string) {
    const options = { args, cwd, timeout: "30 seconds", maxOutputBytes: 128_000 } as const;
    const result = yield* process.run({ command: "looper", ...options }).pipe(
      Effect.catchTags({
        ProcessSpawnError: () =>
          process.run({ command: path.join(home, ".local", "bin", "looper"), ...options }),
      }),
    );
    if (result.code !== 0 || result.timedOut)
      return yield* new LooperError({ operation: args[0] ?? "command" });
    return result.stdout;
  });
  const inspect = Effect.fn(function* (config: Prepared) {
    const statusPath = path.join(config.runtimeDir, "status.json");
    if (!(yield* fs.exists(statusPath))) return null;
    const status = yield* fs.readFileString(statusPath).pipe(Effect.flatMap(decodeStatus));
    if (status.configPath !== config.configPath || status.projectRoot !== config.projectRoot)
      return yield* new LooperError({ operation: "status identity" });
    return status;
  });
  const checkSnapshot = Effect.fn(function* (prepared: Prepared) {
    const text = yield* fs.readFileString(prepared.configPath);
    const config = yield* decodeConfig(text);
    const goal = yield* fs.readFileString(path.resolve(prepared.projectRoot, config.goalPath));
    if ((yield* hash(text)) !== prepared.configHash || (yield* hash(goal)) !== prepared.goalHash)
      return yield* new LooperError({ operation: "configuration changed since authorization" });
  });
  return Looper.of({
    prepare: (configPath, projectRoot, brief) =>
      Effect.gen(function* () {
        if (!path.isAbsolute(configPath))
          return yield* new LooperError({ operation: "absolute configuration path required" });
        const text = yield* fs.readFileString(configPath);
        const config = yield* decodeConfig(text);
        const root = yield* fs.realPath(path.resolve(path.dirname(configPath), config.projectRoot));
        if (root !== (yield* fs.realPath(projectRoot)))
          return yield* new LooperError({ operation: "project identity" });
        if (
          config.profiles.author.provider === config.profiles.reviewer.provider ||
          config.profiles.repair.provider === config.profiles.reviewer.provider
        )
          return yield* new LooperError({ operation: "independent reviewer required" });
        if (path.isAbsolute(config.goalPath) || config.goalPath.split(/[\\/]/).includes(".."))
          return yield* new LooperError({ operation: "project-local goal required" });
        const goal = yield* fs.readFileString(path.resolve(root, config.goalPath));
        if (goal.trim() !== brief.trim())
          return yield* new LooperError({
            operation: "goal must match the authoritative assignment brief exactly",
          });
        const worktree = path.resolve(root, config.worktree),
          runtimeDir = path.resolve(path.dirname(configPath), config.runtimeDir);
        if (worktree === root || runtimeDir === root || worktree === runtimeDir)
          return yield* new LooperError({ operation: "isolated worktree and runtime required" });
        const prepared = {
          configPath: yield* fs.realPath(configPath),
          projectRoot: root,
          runtimeDir,
          worktree,
          configHash: yield* hash(text),
          goalHash: yield* hash(goal),
        };
        if (yield* fs.exists(path.join(runtimeDir, "status.json")))
          return yield* new LooperError({ operation: "new assignment requires a fresh runtime" });
        yield* run(["doctor", "--config", prepared.configPath, "--json"], root);
        yield* run(["check", "--config", prepared.configPath, "--json"], root);
        return prepared;
      }).pipe(wrap("preflight")),
    start: (config, resume) =>
      Effect.gen(function* () {
        yield* checkSnapshot(config);
        yield* run(["doctor", "--config", config.configPath, "--json"], config.projectRoot);
        yield* run(["check", "--config", config.configPath, "--json"], config.projectRoot);
        yield* checkSnapshot(config);
        const output = yield* run(
          [resume ? "resume" : "start", "--config", config.configPath, "--json"],
          config.projectRoot,
        );
        const result = yield* decodeAcknowledgment(output);
        const acknowledged = result.find((item) => item.configPath === config.configPath);
        if (!acknowledged) return yield* new LooperError({ operation: "launch acknowledgment" });
        return acknowledged.runId;
      }).pipe(wrap("launch")),
    inspect: (config) => inspect(config).pipe(wrap("inspect")),
    stop: (config, runId) =>
      Effect.gen(function* () {
        yield* checkSnapshot(config);
        const status = yield* inspect(config);
        if (!status || status.runId !== runId)
          return yield* new LooperError({ operation: "stop run identity" });
        if (["completed", "blocked", "stopped", "error"].includes(status.status)) return;
        yield* run(["stop", "--config", config.configPath, "--json"], config.projectRoot);
      }).pipe(wrap("stop")),
  });
});
export const layer = Layer.effect(Looper, make);
