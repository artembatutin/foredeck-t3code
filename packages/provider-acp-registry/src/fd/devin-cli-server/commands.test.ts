import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { ProviderInstanceId, ProviderDriverKind } from "@t3tools/contracts";
import { writeFakeCli } from "@t3tools/provider-testing/fakeCli";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import type * as Acp from "effect-acp/compat";
import { DEFAULT_DEVIN_SETTINGS } from "../devin/index.ts";
import {
  devinModelSupportsImages,
  normalizeDevinCommands,
  prepareDevinPrompt,
  prepareDevinWorkspacePrompt,
  readDevinWorkspaceSkills,
} from "./commands.ts";

const commands: ReadonlyArray<Acp.AvailableCommand> = [
  { name: "plan", description: "Native planning", input: { type: "text", hint: "[prompt]" } },
  { name: "compact", description: "Compact" },
  { name: "plan", description: "Colliding skill", _meta: { "cognition.ai/category": "Skills" } },
  {
    name: "review",
    description: "Review workspace",
    input: { type: "text", hint: "<target>" },
    _meta: { "cognition.ai/category": "Skills" },
  },
];
describe("native commands", () => {
  it("separates skill advertisements and keeps native built-ins on collisions", () => {
    const result = normalizeDevinCommands(commands);
    expect(result.slashCommands.map((command) => command.name)).toEqual(["plan", "compact"]);
    expect(result.slashCommands[0]?.input?.hint).toBe("[prompt]");
    expect(result.skills.map((skill) => skill.name)).toEqual(["review"]);
  });
  it("dispatches known dollar mentions as native commands with arguments and leading context", () => {
    expect(prepareDevinPrompt("Check this $review src --strict", commands)).toBe(
      "/review src --strict\n\nCheck this",
    );
    expect(prepareDevinPrompt("  /plan inspect src", commands)).toBe("/plan inspect src");
    expect(prepareDevinPrompt("$HOME $plan $missing", commands)).toBe("$HOME $plan $missing");
    expect(prepareDevinPrompt("$review second $missing", commands)).toBe("/review second $missing");
  });
});
it.effect(
  "discovers fresh workspace skills, trigger restrictions and errors without starting ACP",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "native-skills-" });
      const commandPath = writeFakeCli({
        directory: cwd,
        name: "devin",
        source: `
    if (process.argv.slice(2).join(' ') !== 'skills list --json') process.exit(2);
    process.stdout.write(JSON.stringify([
      {name:'review',base_dir:process.cwd()+'/.agents/skills/review',triggers:['user','model']},
      {name:'plan',base_dir:'/global/plan',triggers:['user']},
      {name:'auto',base_dir:'/global/auto',triggers:['model']},
      {name:'bad',base_dir:'/global/bad',triggers:['user'],errors:['invalid']}
    ]));
  `,
      });
      const provider: Parameters<typeof readDevinWorkspaceSkills>[3] = {
        instanceId: ProviderInstanceId.make("native"),
        driver: ProviderDriverKind.make("devin"),
        installed: true,
        enabled: true,
        status: "ready",
        version: null,
        checkedAt: "2026-10-15T00:00:00Z",
        auth: { status: "unknown" },
        models: [],
        slashCommands: [],
        skills: [],
      };
      const result = yield* readDevinWorkspaceSkills(
        { ...DEFAULT_DEVIN_SETTINGS, commandPath },
        process.env,
        cwd,
        provider,
      );
      expect(result.slashCommandsPending).toBe(false);
      expect(
        yield* prepareDevinWorkspacePrompt({ ...DEFAULT_DEVIN_SETTINGS, commandPath }, process.env)(
          "$review src",
          [],
          cwd,
        ),
      ).toBe("/review src");
      expect(result.skills).toMatchObject([
        { name: "review", scope: "project", userInvocable: true, enabled: true },
        { name: "auto", scope: "user", userInvocable: false },
        { name: "bad", enabled: false },
      ]);
      writeFakeCli({ directory: cwd, name: "devin", source: "process.stdout.write('[]')" });
      expect(
        (yield* readDevinWorkspaceSkills(
          { ...DEFAULT_DEVIN_SETTINGS, commandPath },
          process.env,
          cwd,
          provider,
        )).skills,
      ).toEqual([]);
      writeFakeCli({ directory: cwd, name: "devin", source: "process.exit(2)" });
      expect(
        (yield* readDevinWorkspaceSkills(
          { ...DEFAULT_DEVIN_SETTINGS, commandPath },
          process.env,
          cwd,
          provider,
        )).slashCommandsPending,
      ).toBe(true);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

it("honors the selected native model's image capability", () => {
  const options: ReadonlyArray<Acp.SessionConfigOption> = [
    {
      id: "model",
      name: "Model",
      category: "model",
      type: "select",
      currentValue: "text",
      options: [
        { value: "text", name: "Text", _meta: { "cognition.ai/supportsImages": false } },
        { value: "vision", name: "Vision", _meta: { "cognition.ai/supportsImages": true } },
      ],
    },
  ];
  expect(devinModelSupportsImages(options, "default")).toBe(false);
  expect(devinModelSupportsImages(options, "vision")).toBe(true);
  expect(devinModelSupportsImages(options, "custom")).toBe(true);
});
