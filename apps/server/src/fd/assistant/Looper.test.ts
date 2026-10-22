import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as ProcessRunner from "../../processRunner.ts";
import * as Looper from "./Looper.ts";

const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const encode = (value: unknown) => encodeJson(value).pipe(Effect.orDie);
const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "assistant-looper-" });
  const projectRoot = `${root}/project`;
  yield* fs.makeDirectory(projectRoot);
  const goal = "Only this project's agreed brief.";
  yield* fs.writeFileString(`${projectRoot}/goal.md`, goal);
  const profile = { provider: "author", model: "configured", effort: "high" };
  const config = {
    projectRoot,
    runtimeDir: `${root}/runtime`,
    worktree: `${root}/worktree`,
    goalPath: "goal.md",
    profiles: {
      author: profile,
      repair: profile,
      planner: profile,
      reviewer: { ...profile, provider: "independent" },
    },
  };
  const configPath = `${root}/config.json`;
  yield* fs.writeFileString(configPath, yield* encode(config));
  return { fs, root, projectRoot, goal, config, configPath };
});
const node = Layer.mergeAll(NodeServices.layer, NodeCrypto.layer);

it.effect(
  "validates configuration, exact brief and independent review before invoking supported commands",
  () => {
    const calls: ReadonlyArray<string>[] = [];
    return Effect.gen(function* () {
      const f = yield* fixture;
      const processes = Layer.mock(ProcessRunner.ProcessRunner)({
        run: (input) =>
          Effect.gen(function* () {
            calls.push(input.args);
            return {
              code: ChildProcessSpawner.ExitCode(0),
              stdout: yield* encode(
                input.args[0] === "start"
                  ? [{ configPath: input.args[2], runId: "exact-run" }]
                  : { ok: true },
              ),
              stderr: "",
              timedOut: false,
              stdoutTruncated: false,
              stderrTruncated: false,
              stdoutInvalidUtf8: false,
              stderrInvalidUtf8: false,
            };
          }),
      });
      yield* Effect.gen(function* () {
        const service = yield* Looper.Looper;
        const prepared = yield* service.prepare(f.configPath, f.projectRoot, f.goal);
        assert.deepEqual(
          calls.map((call) => call[0]),
          ["doctor", "check"],
        );
        assert.equal(yield* service.start(prepared, false), "exact-run");
        assert.deepEqual(calls.at(-1), ["start", "--config", prepared.configPath, "--json"]);
        yield* f.fs.writeFileString(`${f.projectRoot}/goal.md`, "Changed scope");
        yield* Effect.flip(service.start(prepared, false));
        assert.equal(calls.filter((call) => call[0] === "start").length, 1);
      }).pipe(Effect.provide(Looper.layer.pipe(Layer.provide(processes))));
    }).pipe(Effect.provide(node));
  },
);

it.effect(
  "missing prerequisites block execution without invoking start or substituting an executor",
  () => {
    const calls: string[] = [];
    return Effect.gen(function* () {
      const f = yield* fixture;
      const processes = Layer.mock(ProcessRunner.ProcessRunner)({
        run: (input) =>
          Effect.sync(() => {
            calls.push(input.args[0]!);
            return {
              code: ChildProcessSpawner.ExitCode(1),
              stdout: "",
              stderr: "Missing authentication",
              timedOut: false,
              stdoutTruncated: false,
              stderrTruncated: false,
              stdoutInvalidUtf8: false,
              stderrInvalidUtf8: false,
            };
          }),
      });
      yield* Effect.gen(function* () {
        const service = yield* Looper.Looper;
        yield* Effect.flip(service.prepare(f.configPath, f.projectRoot, f.goal));
        assert.deepEqual(calls, ["doctor"]);
      }).pipe(Effect.provide(Looper.layer.pipe(Layer.provide(processes))));
    }).pipe(Effect.provide(node));
  },
);

it.effect(
  "rejects another project's config and non-independent reviewers without running commands",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const processes = Layer.mock(ProcessRunner.ProcessRunner)({});
      yield* Effect.gen(function* () {
        const service = yield* Looper.Looper;
        yield* Effect.flip(service.prepare(f.configPath, f.root, f.goal));
        yield* Effect.flip(service.prepare(f.configPath, f.projectRoot, "Another brief"));
        yield* f.fs.writeFileString(
          f.configPath,
          yield* encode({
            ...f.config,
            profiles: { ...f.config.profiles, reviewer: f.config.profiles.author },
          }),
        );
        yield* Effect.flip(service.prepare(f.configPath, f.projectRoot, f.goal));
      }).pipe(Effect.provide(Looper.layer.pipe(Layer.provide(processes))));
    }).pipe(Effect.provide(node)),
);
