import { ProjectId } from "@t3tools/contracts";
import type {
  FactoryCommand,
  FactoryCommandDiscovery,
  FactoryCommandProposal,
  FactoryCommandValidation,
} from "@t3tools/contracts/fd/factory";
import { CommandResolutionCache, resolveCommandPath } from "@t3tools/shared/shell";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as ProjectStore from "../../orchestration-v2/ProjectStore.ts";
import { FactoryProjectMissingError } from "./FactoryThreadEffects.ts";
import { resolveFactoryCommand } from "./verify/FactoryVerifyRunner.ts";

/** The most `package.json` Factory reads, far past any real one. */
const PACKAGE_JSON_BYTES_MAX = 1024 * 1024;
/** The scripts one answer proposes, in the file's order; the rest are counted. */
const SCRIPTS_MAX = 50;
const SCRIPT_NAME_MAX = 256;
/** A script's first line is all that names its interpreter. */
const SHEBANG_BYTES_MAX = 256;

/** In the order a checkout holding several lockfiles reads them. */
const PACKAGE_MANAGERS = [
  { name: "pnpm", lockfiles: ["pnpm-lock.yaml"], install: ["install", "--frozen-lockfile"] },
  { name: "yarn", lockfiles: ["yarn.lock"], install: ["install", "--frozen-lockfile"] },
  { name: "bun", lockfiles: ["bun.lock", "bun.lockb"], install: ["install", "--frozen-lockfile"] },
  { name: "npm", lockfiles: ["package-lock.json", "npm-shrinkwrap.json"], install: ["ci"] },
] as const;

/** For a checkout without `package.json`, whose build nothing here reads. */
const VERIFY_PRESETS: ReadonlyArray<{ readonly name: string; readonly command: FactoryCommand }> = [
  { name: "cargo-test", command: { executable: "cargo", args: ["test", "--locked"] } },
  { name: "go-test", command: { executable: "go", args: ["test", "./..."] } },
  { name: "pytest", command: { executable: "python3", args: ["-m", "pytest"] } },
  { name: "make-test", command: { executable: "make", args: ["test"] } },
];

const decodePackageJson = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({ scripts: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)) }),
  ),
);

const commandText = ({ executable, args }: FactoryCommand) => [executable, ...args].join(" ");

const proposal = (
  source: "script" | "preset",
  name: string,
  purpose: FactoryCommandProposal["purpose"],
  command: FactoryCommand,
): FactoryCommandProposal => ({
  id: `${source}:${name}`,
  label: commandText(command),
  source,
  purpose,
  command,
});

/** A name a package manager would take as its script's, not one of its own options. */
const usableScriptName = (name: string) =>
  name.length > 0 &&
  name.length <= SCRIPT_NAME_MAX &&
  name.trim() === name &&
  !name.startsWith("-") &&
  ![...name].some((character) => character < " ");

/**
 * The interpreter a script's first line names, as a lookup would take it: what `env` looks up on the
 * PATH, or the path it gives itself, which the system never looks up on the PATH even with no slash.
 * None for a binary or a script without one.
 */
const interpreterOf = (head: string): string | undefined => {
  if (!head.startsWith("#!")) return undefined;
  const [interpreter, ...rest] = (head.slice(2).split("\n", 1)[0] ?? "").trim().split(/\s+/);
  if (interpreter === undefined || interpreter.length === 0) return undefined;
  if (!/[\\/]/.test(interpreter)) return `./${interpreter}`;
  if (!interpreter.endsWith("/env")) return interpreter;
  return rest.find((word) => !word.startsWith("-") && !word.includes("="));
};

/**
 * What the Factory settings form offers and checks for a project's verify and setup commands.
 * It never runs or saves anything and reads only `package.json`, lockfile presence, and the file a
 * command resolves to. Only a delivery runs the owner's saved command, in its own worktree, through
 * [`FactoryVerifyRunner`](./verify/FactoryVerifyRunner.ts).
 */
export class FactoryCommandSetup extends Context.Service<
  FactoryCommandSetup,
  {
    /** The commands the project's canonical checkout offers, and how its read went. */
    readonly discover: (
      projectId: ProjectId,
    ) => Effect.Effect<
      FactoryCommandDiscovery,
      FactoryProjectMissingError | ProjectStore.ProjectStoreV2Error
    >;
    /**
     * What resolving the command in this server's environment finds, as a verify run resolves it. A
     * relative path or PATH directory is judged from the canonical checkout, the nearest thing to a
     * delivery's worktree, where the run reads it, and never from the server's own directory.
     */
    readonly validate: (input: {
      readonly projectId: ProjectId;
      readonly command: FactoryCommand;
    }) => Effect.Effect<
      FactoryCommandValidation,
      FactoryProjectMissingError | ProjectStore.ProjectStoreV2Error
    >;
  }
>()("t3/fd/factory/FactoryCommandSetup") {}

const make = Effect.gen(function* () {
  const projects = yield* ProjectStore.ProjectStoreV2;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const context = yield* Effect.context<FileSystem.FileSystem | Path.Path>();

  const workspaceRootOf = Effect.fn("FactoryCommandSetup.workspaceRootOf")(function* (
    projectId: ProjectId,
  ) {
    const project = Option.getOrUndefined(yield* projects.get(projectId));
    if (project === undefined) return yield* new FactoryProjectMissingError({ projectId });
    return project.workspaceRoot;
  });

  /**
   * `package.json` as text: absent, or not a regular bounded file inside the checkout. A symlink out
   * of the checkout is someone else's file, and nothing here should read it.
   */
  const readPackageJson = Effect.fn("FactoryCommandSetup.readPackageJson")(
    function* (root: string) {
      const file = path.join(root, "package.json");
      if (!(yield* fileSystem.exists(file))) return { type: "absent" } as const;
      const [real, realRoot] = yield* Effect.all([
        fileSystem.realPath(file),
        fileSystem.realPath(root),
      ]);
      const info = yield* fileSystem.stat(real);
      if (
        !real.startsWith(`${realRoot}${path.sep}`) ||
        info.type !== "File" ||
        info.size > BigInt(PACKAGE_JSON_BYTES_MAX)
      ) {
        return { type: "unreadable" } as const;
      }
      return { type: "text", text: yield* fileSystem.readFileString(real) } as const;
    },
    Effect.orElseSucceed(() => ({ type: "unreadable" }) as const),
  );

  const lockfilesIn = Effect.fn("FactoryCommandSetup.lockfilesIn")(function* (root: string) {
    const present: Array<string> = [];
    for (const { lockfiles } of PACKAGE_MANAGERS) {
      for (const lockfile of lockfiles) {
        const found = yield* fileSystem
          .exists(path.join(root, lockfile))
          .pipe(Effect.orElseSucceed(() => false));
        if (found) present.push(lockfile);
      }
    }
    return present;
  });

  /** An executable's interpreter, if its script names one this environment does not have. */
  const missingRuntime = Effect.fn("FactoryCommandSetup.missingRuntime")(
    function* (resolvedPath: string, root: string) {
      const bytes = yield* Effect.scoped(
        Effect.flatMap(fileSystem.open(resolvedPath, { flag: "r" }), (file) =>
          file.readAlloc(SHEBANG_BYTES_MAX),
        ),
      );
      const runtime = Option.match(bytes, {
        onNone: () => undefined,
        onSome: (head) => interpreterOf(new TextDecoder().decode(head)),
      });
      if (runtime === undefined) return undefined;
      return (yield* resolveCommandPath(runtime, { cwd: root })) === null ? runtime : undefined;
    },
    Effect.orElseSucceed(() => undefined),
  );

  const validate: FactoryCommandSetup["Service"]["validate"] = Effect.fn(
    "FactoryCommandSetup.validate",
  )(
    function* ({ projectId, command }) {
      const root = yield* workspaceRootOf(projectId);
      const { executable, args } = command;
      const batchScript = {
        status: "batch_script",
        resolvedPath: null,
        message: `${executable} resolves to a Windows batch script, which runs only through a shell, and Factory runs commands without one. Set the executable to the program itself, such as node with the script's path as an argument.`,
      } satisfies FactoryCommandValidation;
      const resolved = yield* resolveFactoryCommand(command, root);
      if (resolved.shell) return batchScript;
      const resolvedPath = yield* resolveCommandPath(resolved.command, { cwd: root });
      if (resolvedPath === null) {
        if (!executable.includes("/") && !executable.includes("\\")) {
          return {
            status: "missing_executable",
            resolvedPath: null,
            message: `${executable} is not on the PATH this server runs with. Install it where the server runs, or set the executable to its full path.`,
          } satisfies FactoryCommandValidation;
        }
        const present = yield* fileSystem
          .exists(resolved.command)
          .pipe(Effect.orElseSucceed(() => false));
        return present
          ? ({
              status: "not_executable",
              resolvedPath: null,
              message: `${executable} exists but is not an executable file. Make it executable, or set the executable to its interpreter, such as node, with its path as an argument.`,
            } satisfies FactoryCommandValidation)
          : ({
              status: "missing_executable",
              resolvedPath: null,
              message: `${executable} does not exist in the project's checkout. Check the path. A delivery runs it from its own worktree, so a file its setup command creates can still be right.`,
            } satisfies FactoryCommandValidation);
      }
      // This lookup can find what the first did not, such as a batch script through PATHEXT, so what
      // it found is judged the way a run would judge that file.
      const found = yield* resolveFactoryCommand({ executable: resolvedPath, args }, root);
      if (found.shell) return batchScript;
      const runtime = yield* missingRuntime(resolvedPath, root);
      if (runtime !== undefined) {
        return {
          status: "missing_runtime",
          resolvedPath,
          message: `${executable} is at ${resolvedPath}, but its script needs ${runtime}, which this server cannot find. Install ${runtime} where the server runs, or set the executable to the full path of the runtime with the script as an argument.`,
        } satisfies FactoryCommandValidation;
      }
      return {
        status: "found",
        resolvedPath,
        message: `Found ${resolvedPath} on this server. Factory did not run it, so this does not say the command passes.`,
      } satisfies FactoryCommandValidation;
    },
    Effect.provideService(CommandResolutionCache, new Map()),
    Effect.provideContext(context),
  );

  const discover: FactoryCommandSetup["Service"]["discover"] = Effect.fn(
    "FactoryCommandSetup.discover",
  )(function* (projectId) {
    const root = yield* workspaceRootOf(projectId);
    const lockfiles = yield* lockfilesIn(root);
    const manager = PACKAGE_MANAGERS.find((candidate) =>
      candidate.lockfiles.some((lockfile) => lockfiles.includes(lockfile)),
    );
    const install =
      manager === undefined
        ? []
        : [
            proposal("preset", "install", "setup", {
              executable: manager.name,
              args: [...manager.install],
            }),
          ];
    const read = yield* readPackageJson(root);
    const answer = (
      scripts: FactoryCommandDiscovery["scripts"],
      proposals: ReadonlyArray<FactoryCommandProposal>,
      omittedScripts = 0,
    ): FactoryCommandDiscovery => ({
      scripts,
      packageManager: manager?.name ?? null,
      lockfiles,
      proposals,
      omittedScripts,
    });
    if (read.type === "absent") {
      return answer("no_package_json", [
        ...install,
        ...VERIFY_PRESETS.map(({ name, command }) => proposal("preset", name, "verify", command)),
      ]);
    }
    const parsed = read.type === "text" ? decodePackageJson(read.text) : Option.none();
    if (Option.isNone(parsed)) return answer("unreadable", install);
    const entries = Object.entries(parsed.value.scripts ?? {});
    if (entries.length === 0) return answer("none", install);
    const usable = entries
      .filter(([name, body]) => typeof body === "string" && usableScriptName(name))
      .map(([name]) => name);
    const listed = usable.slice(0, SCRIPTS_MAX);
    // Without a lockfile any Node install still has npm, and it reads the same scripts.
    const runner = manager?.name ?? "npm";
    return answer(
      "found",
      [
        ...listed.map((name) =>
          proposal("script", name, "any", { executable: runner, args: ["run", name] }),
        ),
        ...install,
      ],
      entries.length - listed.length,
    );
  });

  return FactoryCommandSetup.of({ discover, validate });
});

export const layer = Layer.effect(FactoryCommandSetup, make);
