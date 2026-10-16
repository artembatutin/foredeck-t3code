import { readCommandOutput } from "./commandOutput.ts";
import type { ServerProvider, ServerProviderSkill } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as FileSystem from "effect/FileSystem";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import type * as AcpSchema from "effect-acp/compat";
import { normalizeAcpRegistryCommands } from "../../server/probe.ts";
import type { DevinSettings } from "../devin/index.ts";

const isSkill = (command: AcpSchema.AvailableCommand) =>
  command._meta?.["cognition.ai/category"] === "Skills";

/** Built-in commands win native naming collisions; never offer a skill that invokes a mode instead. */
export function normalizeDevinCommands(commands: ReadonlyArray<AcpSchema.AvailableCommand>) {
  const reserved = new Set(
    commands.filter((command) => !isSkill(command)).map((command) => command.name),
  );
  return normalizeAcpRegistryCommands(
    commands.flatMap((command) =>
      isSkill(command)
        ? reserved.has(command.name)
          ? []
          : [{ ...command, name: `$${command.name}` }]
        : [command],
    ),
  );
}

/** Only advertised, unambiguous skills become native slash invocations. Preserve every argument. */
export function prepareDevinPrompt(
  text: string,
  commands: ReadonlyArray<AcpSchema.AvailableCommand>,
): string {
  if (text.trimStart().startsWith("/")) return text.trimStart();
  const names = new Set(normalizeDevinCommands(commands).skills.map((skill) => skill.name));
  const mentions = [...text.matchAll(/(^|\s)\$([a-zA-Z0-9][a-zA-Z0-9:_-]*)(?=\s|$)/g)];
  const mention = mentions.find((match) => names.has(match[2] ?? ""));
  if (!mention) return text;
  const start = (mention.index ?? 0) + (mention[1]?.length ?? 0);
  const end = (mention.index ?? 0) + mention[0].length;
  const leading = text.slice(0, start).trim();
  return `/${mention[2]}${text.slice(end)}${leading ? `\n\n${leading}` : ""}`;
}

const decodeSkills = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Array(
      Schema.Struct({
        name: Schema.String,
        description: Schema.optional(Schema.String),
        base_dir: Schema.String,
        triggers: Schema.Array(Schema.String),
        errors: Schema.optional(Schema.Array(Schema.String)),
      }),
    ),
  ),
);

const readSkills = Effect.fn("DevinDriver.readSkills")(function* (
  settings: DevinSettings,
  environment: NodeJS.ProcessEnv,
  cwd: string,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  return yield* readCommandOutput(
    spawner,
    ChildProcess.make(settings.commandPath, ["skills", "list", "--json"], {
      env: environment,
      cwd,
    }),
  ).pipe(
    Effect.flatMap(decodeSkills),
    Effect.timeout("10 seconds"),
    Effect.orElseSucceed(() => null),
  );
});

/** The native help registry can refresh before ACP sends a new advertisement. */
export const prepareDevinWorkspacePrompt = (
  settings: DevinSettings,
  environment: NodeJS.ProcessEnv,
) =>
  Effect.fn("DevinDriver.preparePrompt")(function* (
    text: string,
    commands: ReadonlyArray<AcpSchema.AvailableCommand>,
    cwd: string,
  ) {
    const prepared = prepareDevinPrompt(text, commands);
    if (prepared !== text || !/(^|\s)\$[a-zA-Z0-9]/.test(text)) return prepared;
    const skills = yield* readSkills(settings, environment, cwd);
    return prepareDevinPrompt(text, [
      ...commands,
      ...(skills ?? [])
        .filter((skill) => skill.triggers.includes("user") && (skill.errors?.length ?? 0) === 0)
        .map((skill) => ({
          name: skill.name,
          description: skill.description ?? "",
          _meta: { "cognition.ai/category": "Skills" },
        })),
    ]);
  });

/** Read-only, workspace-aware discovery. */
export const readDevinWorkspaceSkills = Effect.fn("DevinDriver.workspaceSkills")(function* (
  settings: DevinSettings,
  environment: NodeJS.ProcessEnv,
  cwd: string,
  provider: ServerProvider,
) {
  const fs = yield* FileSystem.FileSystem;
  const canonicalCwd = yield* fs.realPath(cwd).pipe(Effect.orElseSucceed(() => cwd));
  const skills = yield* readSkills(settings, environment, cwd);
  if (skills === null) return { ...provider, skills: [], slashCommandsPending: true };
  // These documented mode/context commands exist even before the first ACP advertisement.
  const reserved = new Set([
    "plan",
    "ask",
    "compact",
    "context",
    "help",
    ...provider.slashCommands.map((command) => command.name),
  ]);
  const seen = new Set<string>();
  const discovered: Array<ServerProviderSkill> = [];
  for (const skill of skills) {
    if (
      !/^[a-zA-Z0-9][a-zA-Z0-9:_-]{0,127}$/.test(skill.name) ||
      seen.has(skill.name) ||
      reserved.has(skill.name)
    )
      continue;
    seen.add(skill.name);
    discovered.push({
      name: skill.name,
      ...(skill.description?.trim()
        ? { description: skill.description.trim().slice(0, 1024) }
        : {}),
      path: `${skill.base_dir}/SKILL.md`,
      scope: skill.base_dir.startsWith(`${canonicalCwd}/`) ? "project" : "user",
      enabled: (skill.errors?.length ?? 0) === 0,
      userInvocable: skill.triggers.includes("user"),
      userInvocationOnly: !skill.triggers.includes("model"),
    });
    if (discovered.length === 128) break;
  }
  return { ...provider, skills: discovered, slashCommandsPending: false };
});

export function devinModelSupportsImages(
  options: ReadonlyArray<AcpSchema.SessionConfigOption>,
  model: string,
): boolean {
  const option = options.find((entry) => entry.category === "model" && entry.type === "select");
  if (!option || option.type !== "select") return true;
  const choices = option.options.flatMap((entry) => ("value" in entry ? [entry] : entry.options));
  const selected = choices.find(
    (entry) => entry.value === (model === "default" ? option.currentValue : model),
  );
  return selected?._meta?.["cognition.ai/supportsImages"] !== false;
}
