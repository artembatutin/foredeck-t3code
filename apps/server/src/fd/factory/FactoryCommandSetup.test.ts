import * as NodePath from "@effect/platform-node/NodePath";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { type FactoryCommand, FactoryProjectSettings } from "@t3tools/contracts/fd/factory";
import { ProjectId } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import {
  CommandResolutionCache,
  resolveSpawnCommand,
  SpawnExecutableResolution,
} from "@t3tools/shared/shell";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Schema from "effect/Schema";

import * as ProjectStore from "../../orchestration-v2/ProjectStore.ts";
import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import * as FactoryCommandSetup from "./FactoryCommandSetup.ts";
import * as FactorySettings from "./FactorySettings.ts";
import * as Factory from "./index.ts";

const projectId = ProjectId.make("project-alpha");
const decodeSettings = Schema.decodeUnknownSync(FactoryProjectSettings);

/** Every process anything here asks for; each test ends by finding none. */
const spawned: Array<unknown> = [];

/** The service on the real file system, with a process spawner that only records. */
const servicesAt = (workspaceRoot: string) =>
  FactoryCommandSetup.layer.pipe(
    Layer.provide(
      Layer.mock(ProjectStore.ProjectStoreV2)({
        // The service reads nothing else of a project.
        get: ((id: ProjectId) =>
          Effect.succeed(
            id === projectId ? Option.some({ workspaceRoot }) : Option.none(),
          )) as unknown as ProjectStore.ProjectStoreV2["Service"]["get"],
      }),
    ),
    Layer.provideMerge(
      Layer.succeed(
        ChildProcessSpawner.ChildProcessSpawner,
        ChildProcessSpawner.make((command) => {
          spawned.push(command);
          return Effect.die("Nothing here may start a process.");
        }),
      ),
    ),
  );

const checkout = (files: Readonly<Record<string, string>> = {}) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "fd-command-setup-" });
    for (const [name, text] of Object.entries(files)) {
      yield* fileSystem.writeFileString(path.join(root, name), text);
    }
    return root;
  });

const discoverAt = (root: string) =>
  Effect.flatMap(FactoryCommandSetup.FactoryCommandSetup, (setup) =>
    setup.discover(projectId),
  ).pipe(Effect.provide(servicesAt(root)));

const validateAt = (root: string, command: FactoryCommand) =>
  Effect.flatMap(FactoryCommandSetup.FactoryCommandSetup, (setup) =>
    setup.validate({ projectId, command }),
  ).pipe(Effect.provide(servicesAt(root)));

const assertNothingRan = () => assert.deepStrictEqual(spawned, []);

/** A script that writes `marker` beside itself if anything ever runs it. */
const marking = (marker: string, shebang: string) =>
  `#!${shebang}\nrequire("node:fs").writeFileSync(${JSON.stringify(marker)}, "ran");\n`;

const makeExecutable = (file: string, text: string) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    yield* fileSystem.writeFileString(file, text);
    yield* fileSystem.chmod(file, 0o755);
  });

/** The server's own directory for the effect's length, which a command's lookup must not read from. */
const serverRunningIn = <A, E, R>(directory: string, effect: Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      const previous = process.cwd();
      process.chdir(directory);
      return previous;
    }),
    () => effect,
    (previous) => Effect.sync(() => process.chdir(previous)),
  );

it.layer(NodeServices.layer)("FactoryCommandSetup discovery", (it) => {
  describe.each([
    {
      lockfile: "pnpm-lock.yaml",
      manager: "pnpm",
      install: { executable: "pnpm", args: ["install", "--frozen-lockfile"] },
    },
    {
      lockfile: "yarn.lock",
      manager: "yarn",
      install: { executable: "yarn", args: ["install", "--frozen-lockfile"] },
    },
    {
      lockfile: "bun.lock",
      manager: "bun",
      install: { executable: "bun", args: ["install", "--frozen-lockfile"] },
    },
    {
      lockfile: "bun.lockb",
      manager: "bun",
      install: { executable: "bun", args: ["install", "--frozen-lockfile"] },
    },
    { lockfile: "package-lock.json", manager: "npm", install: { executable: "npm", args: ["ci"] } },
  ])("with $lockfile", ({ lockfile, manager, install }) => {
    it.effect("proposes its scripts through that manager, and its frozen install for setup", () =>
      Effect.gen(function* () {
        const root = yield* checkout({
          [lockfile]: "",
          "package.json": JSON.stringify({ scripts: { test: "x", "lint:fix": "y" } }),
        });
        const discovery = yield* discoverAt(root);
        assert.strictEqual(discovery.scripts, "found");
        assert.strictEqual(discovery.packageManager, manager);
        assert.deepStrictEqual(discovery.lockfiles, [lockfile]);
        assert.deepStrictEqual(discovery.proposals, [
          {
            id: "script:test",
            label: `${manager} run test`,
            source: "script",
            purpose: "any",
            command: { executable: manager, args: ["run", "test"] },
          },
          {
            id: "script:lint:fix",
            label: `${manager} run lint:fix`,
            source: "script",
            purpose: "any",
            command: { executable: manager, args: ["run", "lint:fix"] },
          },
          {
            id: "preset:install",
            label: [install.executable, ...install.args].join(" "),
            source: "preset",
            purpose: "setup",
            command: install,
          },
        ]);
        assertNothingRan();
      }),
    );
  });

  it.effect("offers only presets for a checkout without package.json", () =>
    Effect.gen(function* () {
      const discovery = yield* discoverAt(yield* checkout());
      assert.strictEqual(discovery.scripts, "no_package_json");
      assert.isNull(discovery.packageManager);
      assert.deepStrictEqual(
        discovery.proposals.map(({ id, source, purpose, command }) => [
          id,
          source,
          purpose,
          command,
        ]),
        [
          [
            "preset:cargo-test",
            "preset",
            "verify",
            { executable: "cargo", args: ["test", "--locked"] },
          ],
          ["preset:go-test", "preset", "verify", { executable: "go", args: ["test", "./..."] }],
          ["preset:pytest", "preset", "verify", { executable: "python3", args: ["-m", "pytest"] }],
          ["preset:make-test", "preset", "verify", { executable: "make", args: ["test"] }],
        ],
      );
      assertNothingRan();
    }),
  );

  it.effect("says malformed JSON could not be read, and still offers the lockfile's install", () =>
    Effect.gen(function* () {
      const root = yield* checkout({ "package.json": "{ not json", "pnpm-lock.yaml": "" });
      const discovery = yield* discoverAt(root);
      assert.strictEqual(discovery.scripts, "unreadable");
      assert.deepStrictEqual(
        discovery.proposals.map(({ id }) => id),
        ["preset:install"],
      );
    }),
  );

  it.effect("reads a package.json whose scripts are not an object as unreadable", () =>
    Effect.gen(function* () {
      const root = yield* checkout({ "package.json": JSON.stringify({ scripts: ["test"] }) });
      assert.strictEqual((yield* discoverAt(root)).scripts, "unreadable");
    }),
  );

  it.effect("tells a package.json without scripts from one it could not read", () =>
    Effect.gen(function* () {
      const root = yield* checkout({ "package.json": JSON.stringify({ name: "alpha" }) });
      const discovery = yield* discoverAt(root);
      assert.strictEqual(discovery.scripts, "none");
      assert.deepStrictEqual(discovery.proposals, []);
    }),
  );

  it.effect("runs none of the scripts it lists, however they would write", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* checkout();
      const marker = path.join(root, "marker");
      const write = `node -e "require('fs').writeFileSync(${JSON.stringify(marker)}, 'ran')"`;
      yield* fileSystem.writeFileString(
        path.join(root, "package.json"),
        JSON.stringify({ scripts: { test: write, prepare: write, postinstall: write } }),
      );
      yield* fileSystem.writeFileString(path.join(root, "package-lock.json"), "{}");

      const discovery = yield* discoverAt(root);
      for (const { command } of discovery.proposals) {
        yield* validateAt(root, command);
      }

      assert.strictEqual(discovery.proposals.length, 4);
      assert.isFalse(yield* fileSystem.exists(marker));
      assertNothingRan();
    }),
  );

  it.effect("leaves out a name no command can carry, and counts what it left out", () =>
    Effect.gen(function* () {
      const scripts = {
        test: "x",
        "--version": "looks like the manager's own option",
        " padded": "x",
        notString: 7,
        ...Object.fromEntries(Array.from({ length: 60 }, (_, at) => [`extra-${at}`, "x"])),
      };
      const root = yield* checkout({ "package.json": JSON.stringify({ scripts }) });
      const discovery = yield* discoverAt(root);
      const ids = discovery.proposals.map(({ id }) => id);
      assert.strictEqual(ids.length, 50);
      assert.include(ids, "script:test");
      assert.notInclude(ids, "script:--version");
      assert.notInclude(ids, "script: padded");
      assert.notInclude(ids, "script:notString");
      assert.strictEqual(discovery.omittedScripts, Object.keys(scripts).length - 50);
    }),
  );

  it.effect("says so when lockfiles disagree, proposing through the first", () =>
    Effect.gen(function* () {
      const root = yield* checkout({
        "yarn.lock": "",
        "package-lock.json": "{}",
        "package.json": JSON.stringify({ scripts: { test: "x" } }),
      });
      const discovery = yield* discoverAt(root);
      assert.strictEqual(discovery.packageManager, "yarn");
      assert.deepStrictEqual(discovery.lockfiles, ["yarn.lock", "package-lock.json"]);
    }),
  );

  it.effect("proposes npm for scripts with no lockfile, and no install it cannot freeze", () =>
    Effect.gen(function* () {
      const root = yield* checkout({ "package.json": JSON.stringify({ scripts: { test: "x" } }) });
      const discovery = yield* discoverAt(root);
      assert.isNull(discovery.packageManager);
      assert.deepStrictEqual(
        discovery.proposals.map(({ command }) => command),
        [{ executable: "npm", args: ["run", "test"] }],
      );
    }),
  );

  it.effect("reads no package.json that leads out of the checkout, or past its bound", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const outside = yield* checkout({
        "package.json": JSON.stringify({ scripts: { secret: "x" } }),
      });
      const linked = yield* checkout();
      yield* fileSystem.symlink(
        path.join(outside, "package.json"),
        path.join(linked, "package.json"),
      );
      const leaving = yield* discoverAt(linked);
      assert.strictEqual(leaving.scripts, "unreadable");
      assert.deepStrictEqual(leaving.proposals, []);

      const large = yield* checkout({ "package.json": " ".repeat(1024 * 1024 + 1) });
      assert.strictEqual((yield* discoverAt(large)).scripts, "unreadable");
    }),
  );

  it.effect("refuses a project this environment does not have", () =>
    Effect.gen(function* () {
      const root = yield* checkout();
      const error = yield* Effect.flip(
        Effect.flatMap(FactoryCommandSetup.FactoryCommandSetup, (setup) =>
          setup.discover(ProjectId.make("project-elsewhere")),
        ).pipe(Effect.provide(servicesAt(root))),
      );
      assert.strictEqual(error._tag, "FactoryProjectMissingError");
    }),
  );
});

it.layer(NodeServices.layer)("FactoryCommandSetup validation", (it) => {
  /** A checkout with a `bin` directory as the PATH a server would run with. */
  const withPath = Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* checkout();
    const bin = path.join(root, "bin");
    yield* fileSystem.makeDirectory(bin);
    return { root, bin, marker: path.join(root, "marker") };
  });
  const onPath = <A, E, R>(bin: string, effect: Effect.Effect<A, E, R>) =>
    effect.pipe(Effect.provideService(HostProcess.Environment, { PATH: bin }));

  it.effect("finds a command on the server's PATH and does not run it", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { root, bin, marker } = yield* withPath;
      const tool = path.join(bin, "tool");
      yield* makeExecutable(tool, `#!/bin/sh\necho ran > ${JSON.stringify(marker)}\n`);

      const result = yield* onPath(bin, validateAt(root, { executable: "tool", args: ["check"] }));

      assert.strictEqual(result.status, "found");
      assert.strictEqual(result.resolvedPath, tool);
      assert.include(result.message, tool);
      assert.include(result.message, "did not run it");
      assert.isFalse(yield* fileSystem.exists(marker));
      assertNothingRan();
    }),
  );

  it.effect("says a command is not on the PATH, and what to do", () =>
    Effect.gen(function* () {
      const { root, bin } = yield* withPath;
      const result = yield* onPath(bin, validateAt(root, { executable: "absent", args: [] }));
      assert.strictEqual(result.status, "missing_executable");
      assert.isNull(result.resolvedPath);
      assert.include(result.message, "absent is not on the PATH");
      assert.include(result.message, "full path");
    }),
  );

  it.effect("finds a tool installed after a miss, when the owner checks again", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const { root, bin } = yield* withPath;
      const command = { executable: "installed-later", args: [] };
      assert.strictEqual(
        (yield* onPath(bin, validateAt(root, command))).status,
        "missing_executable",
      );
      yield* makeExecutable(path.join(bin, "installed-later"), "#!/bin/sh\n");
      assert.strictEqual((yield* onPath(bin, validateAt(root, command))).status, "found");
    }),
  );

  it.effect("judges a relative path from the checkout, telling missing from not executable", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { root, bin, marker } = yield* withPath;
      const script = path.join(root, "verify.sh");

      const missing = yield* onPath(bin, validateAt(root, { executable: "./verify.sh", args: [] }));
      assert.strictEqual(missing.status, "missing_executable");
      assert.include(missing.message, "does not exist in the project's checkout");

      yield* fileSystem.writeFileString(script, `#!/bin/sh\necho ran > ${marker}\n`);
      const plain = yield* onPath(bin, validateAt(root, { executable: "./verify.sh", args: [] }));
      assert.strictEqual(plain.status, "not_executable");
      assert.include(plain.message, "not an executable file");

      yield* fileSystem.chmod(script, 0o755);
      const found = yield* onPath(bin, validateAt(root, { executable: "./verify.sh", args: [] }));
      assert.strictEqual(found.status, "found");
      assert.strictEqual(found.resolvedPath, script);
      assert.isFalse(yield* fileSystem.exists(marker));
      assertNothingRan();
    }),
  );

  it.effect.each([
    { shebang: "/usr/bin/env fd-absent-runtime", runtime: "fd-absent-runtime" },
    { shebang: "/usr/bin/env -S fd-absent-runtime --flag", runtime: "fd-absent-runtime" },
    { shebang: "/nowhere/fd-absent-runtime", runtime: "/nowhere/fd-absent-runtime" },
  ])("says a script needs a runtime this server lacks: $shebang", ({ shebang, runtime }) =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { root, bin, marker } = yield* withPath;
      const tool = path.join(bin, "needs-runtime");
      yield* makeExecutable(tool, marking(marker, shebang));

      const result = yield* onPath(
        bin,
        validateAt(root, { executable: "needs-runtime", args: [] }),
      );

      assert.strictEqual(result.status, "missing_runtime");
      assert.strictEqual(result.resolvedPath, tool);
      assert.include(result.message, runtime);
      assert.isFalse(yield* fileSystem.exists(marker));
      assertNothingRan();
    }),
  );

  it.effect("finds a script whose runtime is on the PATH, without starting either", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { root, bin, marker } = yield* withPath;
      yield* makeExecutable(path.join(bin, "fd-present-runtime"), "#!/bin/sh\n");
      yield* makeExecutable(
        path.join(bin, "uses-runtime"),
        marking(marker, "/usr/bin/env fd-present-runtime"),
      );
      const result = yield* onPath(bin, validateAt(root, { executable: "uses-runtime", args: [] }));
      assert.strictEqual(result.status, "found");
      assert.isFalse(yield* fileSystem.exists(marker));
    }),
  );

  describe("with a relative PATH, and the server somewhere else", () => {
    const server = (name: string) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* checkout();
        yield* fileSystem.makeDirectory(path.join(root, "bin"));
        return { root, bin: path.join(root, "bin"), tool: path.join(root, "bin", name) };
      });
    const validateFrom = (from: string, root: string, executable: string, PATH = "./bin") =>
      serverRunningIn(from, validateAt(root, { executable, args: ["check"] })).pipe(
        Effect.provideService(HostProcess.Environment, { PATH }),
      );

    it.effect("finds the executable the command's directory holds, without running it", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const host = yield* server("tool");
        const target = yield* server("tool");
        const marker = path.join(target.root, "marker");
        yield* makeExecutable(target.tool, `#!/bin/sh\necho ran > ${JSON.stringify(marker)}\n`);

        const result = yield* validateFrom(host.root, target.root, "tool");

        assert.strictEqual(result.status, "found");
        assert.strictEqual(result.resolvedPath, target.tool);
        assert.isFalse(yield* fileSystem.exists(marker));
        assertNothingRan();
      }),
    );

    it.effect("reports the command's directory's executable when the server holds one too", () =>
      Effect.gen(function* () {
        const host = yield* server("tool");
        const target = yield* server("tool");
        yield* makeExecutable(host.tool, "#!/bin/sh\n");
        yield* makeExecutable(target.tool, "#!/bin/sh\n");
        const result = yield* validateFrom(host.root, target.root, "tool");
        assert.strictEqual(result.resolvedPath, target.tool);
      }),
    );

    it.effect("does not take an executable only the server's directory holds", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const host = yield* server("tool");
        const target = yield* server("tool");
        const marker = path.join(host.root, "marker");
        yield* makeExecutable(host.tool, `#!/bin/sh\necho ran > ${JSON.stringify(marker)}\n`);

        const result = yield* validateFrom(host.root, target.root, "tool");

        assert.strictEqual(result.status, "missing_executable");
        assert.isNull(result.resolvedPath);
        assert.isFalse(yield* fileSystem.exists(marker));
        assertNothingRan();
      }),
    );

    it.effect("answers for each of two checkouts in turn under the same PATH", () =>
      Effect.gen(function* () {
        const host = yield* server("tool");
        const first = yield* server("tool");
        const second = yield* server("tool");
        yield* makeExecutable(first.tool, "#!/bin/sh\n");

        const check = (root: string) => validateFrom(host.root, root, "tool");
        assert.strictEqual((yield* check(first.root)).resolvedPath, first.tool);
        assert.strictEqual((yield* check(second.root)).status, "missing_executable");

        yield* makeExecutable(second.tool, "#!/bin/sh\n");
        assert.strictEqual((yield* check(second.root)).resolvedPath, second.tool);
        assert.strictEqual((yield* check(first.root)).resolvedPath, first.tool);
      }),
    );

    it.effect("treats an empty PATH entry as the command's directory, as a run does", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const host = yield* server("tool");
        const target = yield* server("tool");
        const beside = path.join(target.root, "beside");
        yield* makeExecutable(beside, "#!/bin/sh\n");
        yield* makeExecutable(path.join(host.root, "only-on-server"), "#!/bin/sh\n");

        const found = yield* validateFrom(host.root, target.root, "beside", "/fd-nowhere:");
        assert.strictEqual(found.resolvedPath, beside);
        const missing = yield* validateFrom(
          host.root,
          target.root,
          "only-on-server",
          "/fd-nowhere:",
        );
        assert.strictEqual(missing.status, "missing_executable");
      }),
    );

    it.effect("still finds what an absolute PATH directory holds, wherever anything starts", () =>
      Effect.gen(function* () {
        const host = yield* server("tool");
        const target = yield* server("tool");
        yield* makeExecutable(host.tool, "#!/bin/sh\n");
        const result = yield* validateFrom(host.root, target.root, "tool", host.bin);
        assert.strictEqual(result.status, "found");
        assert.strictEqual(result.resolvedPath, host.tool);
      }),
    );

    describe.each([
      { name: "env", shebang: "/usr/bin/env fd-interpreter", file: "bin/fd-interpreter" },
      {
        name: "env -S",
        shebang: "/usr/bin/env -S fd-interpreter --flag",
        file: "bin/fd-interpreter",
      },
      {
        name: "env with a path",
        shebang: "/usr/bin/env ./bin/fd-interpreter",
        file: "bin/fd-interpreter",
      },
      { name: "a relative path", shebang: "bin/fd-interpreter", file: "bin/fd-interpreter" },
      { name: "a bare name", shebang: "fd-interpreter", file: "fd-interpreter" },
    ])("for a script whose interpreter is named by $name", ({ shebang, file }) => {
      const scriptIn = (root: string, marker: string) =>
        Effect.flatMap(Path.Path, (path) =>
          makeExecutable(path.join(root, "bin", "uses-it"), marking(marker, shebang)),
        );

      it.effect("finds an interpreter the command's directory holds", () =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const host = yield* server("tool");
          const target = yield* server("tool");
          const marker = path.join(target.root, "marker");
          yield* scriptIn(target.root, marker);
          yield* makeExecutable(path.join(target.root, file), "#!/bin/sh\n");

          const result = yield* validateFrom(host.root, target.root, "uses-it");

          assert.strictEqual(result.status, "found");
          assert.isFalse(yield* fileSystem.exists(marker));
          assertNothingRan();
        }),
      );

      it.effect("says the runtime is missing when only the server's directory holds it", () =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const host = yield* server("tool");
          const target = yield* server("tool");
          const marker = path.join(target.root, "marker");
          yield* scriptIn(target.root, marker);
          yield* makeExecutable(path.join(host.root, file), "#!/bin/sh\n");

          const result = yield* validateFrom(host.root, target.root, "uses-it");

          assert.strictEqual(result.status, "missing_runtime");
          assert.strictEqual(result.resolvedPath, path.join(target.root, "bin", "uses-it"));
          assert.include(result.message, "fd-interpreter");
          assert.isFalse(yield* fileSystem.exists(marker));
          assertNothingRan();
        }),
      );
    });

    it.effect.each(["fd-interpreter", "env fd-interpreter"])(
      "does not search the PATH for a shebang's own interpreter, as the system does not: %s",
      (shebang) =>
        Effect.gen(function* () {
          const path = yield* Path.Path;
          const host = yield* server("tool");
          const target = yield* server("tool");
          yield* makeExecutable(
            path.join(target.root, "bin", "uses-it"),
            marking(path.join(target.root, "marker"), shebang),
          );
          // On the PATH, which an `env` would search, and nowhere the system itself would look.
          yield* makeExecutable(path.join(target.root, "bin", "fd-interpreter"), "#!/bin/sh\n");
          yield* makeExecutable(path.join(target.root, "bin", "env"), "#!/bin/sh\n");

          const result = yield* validateFrom(host.root, target.root, "uses-it");

          assert.strictEqual(result.status, "missing_runtime");
          assertNothingRan();
        }),
    );
  });

  describe("with exactly an empty PATH, and the server somewhere else", () => {
    const check = (from: string, root: string, executable: string) =>
      serverRunningIn(from, validateAt(root, { executable, args: ["check"] })).pipe(
        Effect.provideService(HostProcess.Environment, { PATH: "" }),
      );

    it.effect("finds the executable the command's directory holds, without running it", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const host = yield* checkout();
        const target = yield* checkout();
        const marker = path.join(target, "marker");
        const tool = path.join(target, "tool");
        yield* makeExecutable(tool, `#!/bin/sh\necho ran > ${JSON.stringify(marker)}\n`);

        const result = yield* check(host, target, "tool");

        assert.strictEqual(result.status, "found");
        assert.strictEqual(result.resolvedPath, tool);
        assert.isFalse(yield* fileSystem.exists(marker));
        assertNothingRan();
      }),
    );

    it.effect("reports the command's directory's executable when the server holds one too", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const host = yield* checkout();
        const target = yield* checkout();
        yield* makeExecutable(path.join(host, "tool"), "#!/bin/sh\n");
        yield* makeExecutable(path.join(target, "tool"), "#!/bin/sh\n");
        const result = yield* check(host, target, "tool");
        assert.strictEqual(result.resolvedPath, path.join(target, "tool"));
      }),
    );

    it.effect("does not take an executable only the server's directory holds", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const host = yield* checkout();
        const target = yield* checkout();
        const marker = path.join(host, "marker");
        yield* makeExecutable(
          path.join(host, "tool"),
          `#!/bin/sh\necho ran > ${JSON.stringify(marker)}\n`,
        );

        const result = yield* check(host, target, "tool");

        assert.strictEqual(result.status, "missing_executable");
        assert.isNull(result.resolvedPath);
        assert.include(result.message, "tool is not on the PATH");
        assert.isFalse(yield* fileSystem.exists(marker));
        assertNothingRan();
      }),
    );

    it.effect("answers for each of two checkouts in turn", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const host = yield* checkout();
        const first = yield* checkout();
        const second = yield* checkout();
        const firstTool = path.join(first, "tool");
        const secondTool = path.join(second, "tool");
        yield* makeExecutable(firstTool, "#!/bin/sh\n");

        assert.strictEqual((yield* check(host, first, "tool")).resolvedPath, firstTool);
        assert.strictEqual((yield* check(host, second, "tool")).status, "missing_executable");

        yield* makeExecutable(secondTool, "#!/bin/sh\n");
        assert.strictEqual((yield* check(host, second, "tool")).resolvedPath, secondTool);
        assert.strictEqual((yield* check(host, first, "tool")).resolvedPath, firstTool);
      }),
    );

    describe.each([
      { name: "env", shebang: "/usr/bin/env fd-interpreter" },
      { name: "env -S", shebang: "/usr/bin/env -S fd-interpreter --flag" },
    ])("for a script whose interpreter is named by $name", ({ shebang }) => {
      it.effect("finds an interpreter the command's directory holds", () =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const host = yield* checkout();
          const target = yield* checkout();
          const marker = path.join(target, "marker");
          yield* makeExecutable(path.join(target, "uses-it"), marking(marker, shebang));
          yield* makeExecutable(path.join(target, "fd-interpreter"), "#!/bin/sh\n");

          const result = yield* check(host, target, "uses-it");

          assert.strictEqual(result.status, "found");
          assert.isFalse(yield* fileSystem.exists(marker));
          assertNothingRan();
        }),
      );

      it.effect("says the runtime is missing when only the server's directory holds it", () =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const host = yield* checkout();
          const target = yield* checkout();
          const marker = path.join(target, "marker");
          yield* makeExecutable(path.join(target, "uses-it"), marking(marker, shebang));
          yield* makeExecutable(path.join(host, "fd-interpreter"), "#!/bin/sh\n");

          const result = yield* check(host, target, "uses-it");

          assert.strictEqual(result.status, "missing_runtime");
          assert.strictEqual(result.resolvedPath, path.join(target, "uses-it"));
          assert.include(result.message, "fd-interpreter");
          assert.isFalse(yield* fileSystem.exists(marker));
          assertNothingRan();
        }),
      );
    });

    it.effect("still says a command is missing with no PATH at all", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const host = yield* checkout();
        const target = yield* checkout();
        yield* makeExecutable(path.join(target, "tool"), "#!/bin/sh\n");

        const result = yield* serverRunningIn(
          host,
          validateAt(target, { executable: "tool", args: [] }),
        ).pipe(Effect.provideService(HostProcess.Environment, {}));

        assert.strictEqual(result.status, "missing_executable");
        assertNothingRan();
      }),
    );

    it.effect("leaves a saved command as typed when it finds it", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const host = yield* checkout();
        const target = yield* checkout();
        yield* makeExecutable(path.join(target, "tool"), "#!/bin/sh\n");
        const saved = decodeSettings({ verifyCommand: { executable: "tool", args: ["--flag"] } });
        const settings = yield* FactorySettings.FactorySettings;
        yield* settings.set(projectId, saved);

        const result = yield* check(host, target, "tool");

        assert.strictEqual(result.resolvedPath, path.join(target, "tool"));
        assert.deepStrictEqual(yield* settings.get(projectId), saved);
        assert.deepStrictEqual((yield* settings.get(projectId)).verifyCommand, {
          executable: "tool",
          args: ["--flag"],
        });
        assertNothingRan();
      }).pipe(
        Effect.provide(
          FactorySettings.layer.pipe(
            Layer.provideMerge(Factory.layerPersistence),
            Layer.provideMerge(SqlitePersistence.layerMemory),
          ),
        ),
      ),
    );
  });

  // Simulated: the shared lookup's win32 rules over this host's files, not native Windows.
  it.effect(
    "says a bare name is missing, though a lookup from the server finds a batch script",
    () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const host = yield* checkout();
        const target = yield* checkout();
        yield* fileSystem.makeDirectory(path.join(host, "bin"));
        // Where the win32 rules ask for `.\bin\verify.cmd`, on any host: a file of that name here.
        yield* fileSystem.writeFileString(path.join(host, "bin\\verify.cmd"), "@echo off\n");

        yield* serverRunningIn(
          host,
          Effect.gen(function* () {
            assert.isTrue((yield* resolveSpawnCommand("verify", ["--check"])).shell);

            const result = yield* validateAt(target, { executable: "verify", args: ["--check"] });

            assert.strictEqual(result.status, "missing_executable");
            assert.isNull(result.resolvedPath);
            assert.include(result.message, "verify is not on the PATH");
            assertNothingRan();
          }),
        ).pipe(
          Effect.provideService(HostProcess.Platform, "win32"),
          Effect.provideService(HostProcess.Environment, { PATH: ".\\bin", PATHEXT: ".EXE;.CMD" }),
          Effect.provideService(CommandResolutionCache, new Map()),
        );
      }),
  );

  it.effect("says a Windows batch script needs a program, as the runner would refuse it", () =>
    Effect.gen(function* () {
      const root = yield* checkout();
      const result = yield* validateAt(root, { executable: "npm", args: ["test"] }).pipe(
        Effect.provideService(HostProcess.Platform, "win32"),
        Effect.provideService(SpawnExecutableResolution, (command) =>
          command === "npm" ? "C:\\Program Files\\nodejs\\npm.cmd" : undefined,
        ),
      );
      assert.strictEqual(result.status, "batch_script");
      assert.isNull(result.resolvedPath);
      assert.include(result.message, "npm resolves to a Windows batch script");
      assert.include(result.message, "the program itself");
      assertNothingRan();
    }),
  );

  it.effect("takes a program a Windows lookup resolved, as the runner would run it", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const { root, bin } = yield* withPath;
      const program = path.join(bin, "tool.exe");
      yield* makeExecutable(program, "binary");
      const result = yield* validateAt(root, { executable: "tool", args: [] }).pipe(
        Effect.provideService(HostProcess.Platform, "win32"),
        Effect.provideService(HostProcess.Environment, { PATH: bin, PATHEXT: ".EXE" }),
        Effect.provideService(SpawnExecutableResolution, () => program),
      );
      assert.strictEqual(result.status, "found");
      assert.strictEqual(result.resolvedPath, program);
    }),
  );

  describe("on Windows, where a lookup can find more than was typed", () => {
    const root = "C:\\project";
    const windowsAt = (files: ReadonlyArray<string>) => {
      const noop = FileSystem.makeNoop({});
      return FactoryCommandSetup.layer.pipe(
        Layer.provide(
          Layer.mock(ProjectStore.ProjectStoreV2)({
            get: (() =>
              Effect.succeed(
                Option.some({ workspaceRoot: root }),
              )) as unknown as ProjectStore.ProjectStoreV2["Service"]["get"],
          }),
        ),
        Layer.provide(NodePath.layerWin32),
        Layer.provide(
          FileSystem.layerNoop({
            stat: (file) =>
              files.includes(file)
                ? Effect.succeed({ type: "File" } as unknown as FileSystem.File.Info)
                : noop.stat(file),
            exists: (file) => Effect.succeed(files.includes(file)),
          }),
        ),
      );
    };
    const validateOnWindows = (
      files: ReadonlyArray<string>,
      executable: string,
      PATH = "C:\\bin",
    ) =>
      Effect.flatMap(FactoryCommandSetup.FactoryCommandSetup, (setup) =>
        setup.validate({ projectId, command: { executable, args: ["--check"] } }),
      ).pipe(
        Effect.provide(windowsAt(files)),
        Effect.provideService(HostProcess.Platform, "win32"),
        Effect.provideService(HostProcess.Environment, {
          PATH,
          PATHEXT: ".EXE;.CMD;.BAT",
        }),
      );

    it.effect.each([
      { name: "relative, found through PATHEXT", executable: ".\\verify", file: "verify.cmd" },
      { name: "relative with a forward slash", executable: "./verify", file: "verify.bat" },
      { name: "relative, in a folder", executable: "ci\\verify", file: "ci\\verify.cmd" },
      { name: "relative and named in full", executable: ".\\verify.cmd", file: "verify.cmd" },
    ])(
      "refuses a batch script in the checkout a server elsewhere would miss: $name",
      ({ executable, file }) =>
        Effect.gen(function* () {
          const result = yield* validateOnWindows([`${root}\\${file}`], executable);
          assert.strictEqual(result.status, "batch_script");
          assert.isNull(result.resolvedPath);
          assert.include(result.message, `${executable} resolves to a Windows batch script`);
          assert.include(result.message, "the program itself");
          assertNothingRan();
        }),
    );

    it.effect("refuses a batch script on the PATH only one of the lookups found", () =>
      Effect.gen(function* () {
        const result = yield* validateOnWindows(["C:\\bin\\verify.cmd"], "verify");
        assert.strictEqual(result.status, "batch_script");
      }),
    );

    it.effect("takes a program in the checkout, where a run in a worktree would start it", () =>
      Effect.gen(function* () {
        const result = yield* validateOnWindows([`${root}\\tool.exe`], ".\\tool");
        assert.strictEqual(result.status, "found");
        assert.strictEqual(result.resolvedPath, `${root}\\tool.exe`);
      }),
    );

    it.effect("says a relative file is missing from the checkout", () =>
      Effect.gen(function* () {
        const result = yield* validateOnWindows([], ".\\absent");
        assert.strictEqual(result.status, "missing_executable");
        assert.include(result.message, "does not exist in the project's checkout");
      }),
    );

    it.effect("refuses a batch script a relative PATH reaches from the checkout", () =>
      Effect.gen(function* () {
        const result = yield* validateOnWindows([`${root}\\bin\\verify.cmd`], "verify", ".\\bin");
        assert.strictEqual(result.status, "batch_script");
        assert.isNull(result.resolvedPath);
        assertNothingRan();
      }),
    );

    it.effect("takes a program a relative PATH reaches from the checkout", () =>
      Effect.gen(function* () {
        const result = yield* validateOnWindows([`${root}\\bin\\tool.exe`], "tool", ".\\bin");
        assert.strictEqual(result.status, "found");
        assert.strictEqual(result.resolvedPath, `${root}\\bin\\tool.exe`);
      }),
    );

    it.effect("takes nothing from the server's own relative PATH directory", () =>
      Effect.gen(function* () {
        const result = yield* validateOnWindows(["bin\\verify.cmd"], "verify", ".\\bin");
        assert.strictEqual(result.status, "missing_executable");
      }),
    );

    it.effect("tells the runner's lookup where a bare command would start", () =>
      Effect.gen(function* () {
        const result = yield* validateOnWindows([], "verify", ".\\bin").pipe(
          Effect.provideService(SpawnExecutableResolution, (command, _platform, env, cwd) =>
            command === "verify" && env.PATH === ".\\bin" && cwd === root
              ? `${root}\\bin\\verify.cmd`
              : undefined,
          ),
        );
        assert.strictEqual(result.status, "batch_script");
      }),
    );

    it.effect("asks the runner's lookup about the checkout's file, not the server's", () =>
      Effect.gen(function* () {
        const asked: Array<string> = [];
        const result = yield* validateOnWindows([], ".\\verify").pipe(
          Effect.provideService(SpawnExecutableResolution, (command) => {
            asked.push(command);
            return command === `${root}\\verify` ? `${root}\\verify.cmd` : undefined;
          }),
        );
        assert.strictEqual(result.status, "batch_script");
        assert.deepStrictEqual(asked, [`${root}\\verify`]);
      }),
    );
  });

  it.effect("never rewrites the saved command, however it validates", () =>
    Effect.gen(function* () {
      const root = yield* checkout();
      const saved = decodeSettings({
        verifyCommand: { executable: "./custom tool", args: ["--flag", "a b", ""] },
        setupCommand: { executable: "absent", args: [] },
      });
      const settings = yield* FactorySettings.FactorySettings;
      yield* settings.set(projectId, saved);
      for (const command of [
        saved.verifyCommand,
        saved.setupCommand,
        { executable: "something-else", args: [] },
      ]) {
        if (command !== null) yield* validateAt(root, command);
      }
      assert.deepStrictEqual(yield* settings.get(projectId), saved);
    }).pipe(
      Effect.provide(
        FactorySettings.layer.pipe(
          Layer.provideMerge(Factory.layerPersistence),
          Layer.provideMerge(SqlitePersistence.layerMemory),
        ),
      ),
    ),
  );

  it.effect("leaves a saved command as typed when a relative PATH finds it", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const host = yield* checkout();
      const root = yield* checkout();
      yield* fileSystem.makeDirectory(path.join(root, "bin"));
      yield* makeExecutable(path.join(root, "bin", "tool"), "#!/bin/sh\n");
      const saved = decodeSettings({ verifyCommand: { executable: "tool", args: ["--flag"] } });
      const settings = yield* FactorySettings.FactorySettings;
      yield* settings.set(projectId, saved);

      const result = yield* serverRunningIn(
        host,
        validateAt(root, { executable: "tool", args: ["--flag"] }),
      ).pipe(Effect.provideService(HostProcess.Environment, { PATH: "./bin" }));

      assert.strictEqual(result.status, "found");
      assert.strictEqual(result.resolvedPath, path.join(root, "bin", "tool"));
      assert.deepStrictEqual(yield* settings.get(projectId), saved);
      assert.deepStrictEqual((yield* settings.get(projectId)).verifyCommand, {
        executable: "tool",
        args: ["--flag"],
      });
    }).pipe(
      Effect.provide(
        FactorySettings.layer.pipe(
          Layer.provideMerge(Factory.layerPersistence),
          Layer.provideMerge(SqlitePersistence.layerMemory),
        ),
      ),
    ),
  );

  it.effect("refuses a project this environment does not have", () =>
    Effect.gen(function* () {
      const root = yield* checkout();
      const error = yield* Effect.flip(
        Effect.flatMap(FactoryCommandSetup.FactoryCommandSetup, (setup) =>
          setup.validate({
            projectId: ProjectId.make("project-elsewhere"),
            command: { executable: "node", args: [] },
          }),
        ).pipe(Effect.provide(servicesAt(root))),
      );
      assert.strictEqual(error._tag, "FactoryProjectMissingError");
    }),
  );
});
