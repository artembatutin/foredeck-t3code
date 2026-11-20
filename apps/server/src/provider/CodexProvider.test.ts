import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  type ModelSelection,
  ProviderDriverKind,
  ProviderInstanceId,
  providerRuntimeModeRestriction,
  type RuntimeMode,
  type ServerProvider,
} from "@t3tools/contracts";
import { CodexAppServerRequestError } from "effect-codex-app-server/errors";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as TestClock from "effect/testing/TestClock";
import * as HostProcess from "@t3tools/shared/HostProcess";

import { buildCodexTurnStartParams } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import {
  applyPreferredCodexDefaultModel,
  checkCodexProviderStatus,
  codexCustomEndpoint,
  codexRoutesSpendNativeQuota,
  CODEX_RUNTIME_MODE_POLICIES,
  codexRuntimeModeRestrictions,
  makeCodexSkillsProbe,
  mapCodexModelCapabilities,
  readCodexRuntimeModeRestrictions,
} from "./CodexProvider.ts";
import { mergeProviderSnapshot } from "./ProviderRegistry.ts";
import { hydrateCachedProvider } from "./providerStatusCache.ts";

function makeFakeCodexAppServers() {
  const helpers: Array<{
    readonly codexHome: unknown;
    readonly crash: Effect.Effect<void>;
    readonly requests: Array<unknown>;
    closed: boolean;
  }> = [];
  const spawner = ChildProcessSpawner.make((command) =>
    Effect.gen(function* () {
      const output = yield* Queue.unbounded<Uint8Array, Cause.Done>();
      const exited = yield* Deferred.make<ChildProcessSpawner.ExitCode>();
      const crash = Deferred.succeed(exited, ChildProcessSpawner.ExitCode(1)).pipe(
        Effect.andThen(Queue.end(output)),
        Effect.asVoid,
      );
      const helper = {
        codexHome: command._tag === "StandardCommand" ? command.options.env?.CODEX_HOME : undefined,
        crash,
        requests: [] as Array<unknown>,
        closed: false,
      };
      helpers.push(helper);
      yield* Effect.addFinalizer(() => Effect.sync(() => (helper.closed = true)));
      const respond = (id: unknown, result: unknown) =>
        Queue.offer(output, new TextEncoder().encode(`${JSON.stringify({ id, result })}\n`));
      return ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(900_000_000 + helpers.length),
        exitCode: Deferred.await(exited),
        isRunning: Effect.map(Deferred.isDone(exited), (done) => !done),
        kill: () => crash,
        unref: Effect.succeed(Effect.void),
        stdin: Sink.forEach((chunk: string | Uint8Array) =>
          Effect.forEach(
            (typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk))
              .split("\n")
              .filter(Boolean),
            (line) => {
              const frame = JSON.parse(line) as {
                readonly id?: number;
                readonly method: string;
                readonly params?: { readonly cwds: ReadonlyArray<string> };
              };
              if (frame.id === undefined) return Effect.void;
              if (frame.method === "initialize") {
                return respond(frame.id, {
                  codexHome: "/codex-home",
                  platformFamily: "unix",
                  platformOs: "linux",
                  userAgent: "codex/0.0.0",
                });
              }
              helper.requests.push(frame.params);
              return respond(frame.id, {
                data: (frame.params?.cwds ?? []).map((cwd) => ({
                  cwd,
                  errors: [],
                  skills: [
                    {
                      name: `skill-in-${cwd}`,
                      path: `${cwd}/SKILL.md`,
                      enabled: true,
                      description: "",
                      scope: "repo",
                    },
                  ],
                })),
              });
            },
            { discard: true },
          ),
        ),
        stdout: Stream.fromQueue(output),
        stderr: Stream.empty,
        all: Stream.empty,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
      });
    }),
  );
  return { helpers, spawner };
}

it.effect("reuses one Codex skills helper per launch until it idles out", () =>
  Effect.gen(function* () {
    const { helpers, spawner } = makeFakeCodexAppServers();
    const providerScope = yield* Scope.make();
    const probe = yield* makeCodexSkillsProbe().pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      Scope.provide(providerScope),
    );
    const read = (cwd: string, homePath = "/home-a") =>
      probe({ binaryPath: "codex", homePath, cwd, environment: {} }).pipe(
        Effect.map((skills) => skills.map((skill) => skill.name)),
      );

    assert.deepStrictEqual(yield* read("/alpha"), ["skill-in-/alpha"]);
    assert.deepStrictEqual(yield* read("/beta"), ["skill-in-/beta"]);
    assert.strictEqual(helpers.length, 1);
    assert.deepStrictEqual(helpers[0]!.requests, [
      { cwds: ["/alpha"], forceReload: true },
      { cwds: ["/beta"], forceReload: true },
    ]);

    // Another home is another launch identity; the previous helper retires at once.
    assert.deepStrictEqual(yield* read("/alpha", "/home-b"), ["skill-in-/alpha"]);
    assert.strictEqual(helpers.length, 2);
    assert.strictEqual(helpers[0]!.closed, true);
    assert.strictEqual(helpers[1]!.codexHome, "/home-b");

    // A helper that exits is replaced within the same read.
    yield* helpers[1]!.crash;
    assert.deepStrictEqual(yield* read("/beta", "/home-b"), ["skill-in-/beta"]);
    assert.strictEqual(helpers.length, 3);

    yield* TestClock.adjust("29 seconds");
    assert.strictEqual(helpers[2]!.closed, false);
    yield* TestClock.adjust("1 second");
    assert.strictEqual(helpers[2]!.closed, true);
    assert.deepStrictEqual(yield* read("/alpha", "/home-b"), ["skill-in-/alpha"]);
    assert.strictEqual(helpers.length, 4);

    yield* Scope.close(providerScope, Exit.void);
    assert.strictEqual(helpers[3]!.closed, true);
  }).pipe(Effect.provideService(HostProcess.Platform, "linux")),
);

it("maps current Codex model capability fields", () => {
  const capabilities = mapCodexModelCapabilities({
    additionalSpeedTiers: [],
    defaultReasoningEffort: "super-high",
    description: "Test model",
    displayName: "GPT Test",
    hidden: false,
    id: "gpt-test",
    isDefault: true,
    model: "gpt-test",
    availableAccessPrograms: { cyber: ["standard", "daybreakBlue"] },
    defaultServiceTier: "flex",
    serviceTiers: [
      {
        id: "priority",
        name: "Fast",
        description: "Lower latency responses.",
      },
      {
        id: "flex",
        name: "Flex",
        description: "Lower-cost asynchronous routing.",
      },
    ],
    supportedReasoningEfforts: [
      {
        description: "Maximum reasoning",
        reasoningEffort: "super-high",
      },
    ],
  });

  assert.deepStrictEqual(capabilities.optionDescriptors, [
    {
      id: "reasoningEffort",
      label: "Reasoning",
      type: "select",
      options: [{ id: "super-high", label: "super-high", isDefault: true }],
      currentValue: "super-high",
    },
    {
      id: "serviceTier",
      label: "Service Tier",
      type: "select",
      options: [
        { id: "default", label: "Standard" },
        {
          id: "priority",
          label: "Fast",
          description: "Lower latency responses.",
        },
        {
          id: "flex",
          label: "Flex",
          description: "Lower-cost asynchronous routing.",
          isDefault: true,
        },
      ],
      currentValue: "flex",
    },
    {
      id: "cyberAccessProgram",
      label: "Cyber Access",
      type: "select",
      options: [
        { id: "standard", label: "Standard", isDefault: true },
        { id: "daybreakBlue", label: "Daybreak Blue" },
      ],
      currentValue: "standard",
    },
  ]);
});

it("uses standard routing when the catalog has no default service tier", () => {
  const capabilities = mapCodexModelCapabilities({
    additionalSpeedTiers: ["fast"],
    defaultReasoningEffort: "medium",
    defaultServiceTier: null,
    description: "Test model",
    displayName: "GPT Test",
    hidden: false,
    id: "gpt-test",
    isDefault: true,
    model: "gpt-test",
    serviceTiers: [
      {
        id: "priority",
        name: "Fast",
        description: "1.5x speed, increased usage",
      },
      {
        id: "ultrafast",
        name: "Ultrafast",
        description: "The fastest available responses for latency-sensitive work.",
      },
    ],
    supportedReasoningEfforts: [],
  });

  assert.deepStrictEqual(capabilities.optionDescriptors, [
    {
      id: "serviceTier",
      label: "Service Tier",
      type: "select",
      options: [
        { id: "default", label: "Standard", isDefault: true },
        {
          id: "priority",
          label: "Fast",
          description: "1.5x speed, increased usage",
        },
        {
          id: "ultrafast",
          label: "Ultrafast",
          description: "Even faster, more expensive",
        },
      ],
      currentValue: "default",
    },
  ]);
});

it("marks the most preferred available model as default", () => {
  const models = applyPreferredCodexDefaultModel([
    { slug: "gpt-5.6-terra", name: "GPT-5.6-Terra", isCustom: false, capabilities: null },
    { slug: "gpt-5.4", name: "GPT-5.4", isCustom: false, isDefault: true, capabilities: null },
  ]);

  assert.deepStrictEqual(
    models.map((model) => ({ slug: model.slug, isDefault: model.isDefault })),
    [
      { slug: "gpt-5.6-terra", isDefault: true },
      { slug: "gpt-5.4", isDefault: undefined },
    ],
  );
});

it("ranks qualified Codex models while preserving their wire ids", () => {
  const models = applyPreferredCodexDefaultModel([
    {
      slug: "openai.gpt-5.6-luna",
      name: "Luna",
      isCustom: false,
      isDefault: true,
      capabilities: null,
    },
    { slug: "openai.gpt-5.6-sol", name: "Sol", isCustom: false, capabilities: null },
  ]);
  assert.deepStrictEqual(
    models.filter((model) => model.isDefault).map((model) => model.slug),
    ["openai.gpt-5.6-sol"],
  );
});

it("ignores custom models that shadow a preferred slug", () => {
  const models = applyPreferredCodexDefaultModel([
    { slug: "gpt-5.6-sol", name: "gpt-5.6-sol", isCustom: true, capabilities: null },
    { slug: "gpt-5.4", name: "GPT-5.4", isCustom: false, isDefault: true, capabilities: null },
  ]);

  assert.deepStrictEqual(models.find((model) => model.isDefault)?.slug, "gpt-5.4");
});

it("reports native quota only for an OpenAI login on a native route", () => {
  const chatgpt = { type: "chatgpt", email: "a@example.com", planType: "pro" } as const;
  const hub = {
    model_provider: "hub",
    model_providers: { hub: { base_url: "https://hub.example.com/v1" } },
  };
  const cases = [
    ["default route", chatgpt, true, {}, true],
    ["openai base url", chatgpt, true, { openai_base_url: "https://chatgpt.com/x" }, true],
    ["openai proxy url", chatgpt, true, { openai_base_url: "https://proxy.example.com" }, false],
    ["custom provider", chatgpt, true, hub, false],
    ["unknown provider id", chatgpt, true, { model_provider: "missing" }, false],
    ["unreadable config", chatgpt, true, null, false],
    ["login not required", chatgpt, false, {}, false],
    ["api key", { type: "apiKey" }, true, {}, false],
  ] as const;
  for (const [name, account, requiresOpenaiAuth, config, expected] of cases) {
    assert.strictEqual(
      codexRoutesSpendNativeQuota({ account, requiresOpenaiAuth }, config),
      expected,
      name,
    );
  }
  // The custom endpoint is what a usage-limit hub is matched against.
  assert.strictEqual(codexCustomEndpoint(hub), "https://hub.example.com");
  assert.strictEqual(
    codexCustomEndpoint({ openai_base_url: "http://127.0.0.1:8317/v1" }),
    "http://127.0.0.1:8317",
  );
  assert.strictEqual(codexCustomEndpoint({ openai_base_url: "https://chatgpt.com/x" }), undefined);
  assert.strictEqual(codexCustomEndpoint({}), undefined);
});

const statusOf = (
  restrictions: ReadonlyArray<{ readonly runtimeMode: RuntimeMode; readonly status: string }>,
) => Object.fromEntries(restrictions.map(({ runtimeMode, status }) => [runtimeMode, status]));

it("refuses Supervised under a host allowing only never and on-request", () => {
  const restrictions = codexRuntimeModeRestrictions({
    requirements: { allowedApprovalPolicies: ["never", "on-request"] },
  });
  assert.deepStrictEqual(statusOf(restrictions), {
    "approval-required": "disallowed",
    "auto-accept-edits": "allowed",
    auto: "allowed",
    "full-access": "unknown",
  });
  assert.include(
    restrictions.find(({ runtimeMode }) => runtimeMode === "approval-required")?.detail,
    "never, on-request",
  );
});

it("allows every mode when the host sets no requirements", () => {
  for (const response of [{}, { requirements: null }, { requirements: {} }]) {
    assert.deepStrictEqual(statusOf(codexRuntimeModeRestrictions(response)), {
      "approval-required": "allowed",
      "auto-accept-edits": "allowed",
      auto: "allowed",
      "full-access": "allowed",
    });
  }
});

it("refuses a mode whose sandbox the host does not allow", () => {
  const restrictions = codexRuntimeModeRestrictions({
    requirements: { allowedSandboxModes: ["read-only", "workspace-write"] },
  });
  assert.strictEqual(statusOf(restrictions)["full-access"], "disallowed");
  assert.strictEqual(statusOf(restrictions)["auto-accept-edits"], "allowed");
});

it("stays unknown where a granular policy could be what the host means", () => {
  const restrictions = codexRuntimeModeRestrictions({
    requirements: {
      allowedApprovalPolicies: [
        "never",
        {
          granular: {
            mcp_elicitations: true,
            rules: true,
            sandbox_approval: true,
          },
        },
      ],
    },
  });
  assert.deepStrictEqual(statusOf(restrictions), {
    "approval-required": "unknown",
    "auto-accept-edits": "unknown",
    auto: "unknown",
    "full-access": "unknown",
  });
});

it("allows full access where the host lists the granular policy it sends", () => {
  const restrictions = codexRuntimeModeRestrictions({
    requirements: {
      allowedApprovalPolicies: [
        { granular: { mcp_elicitations: true, rules: false, sandbox_approval: false } },
      ],
    },
  });
  assert.strictEqual(statusOf(restrictions)["full-access"], "allowed");
  assert.strictEqual(statusOf(restrictions).auto, "unknown");
});

const readFails = {
  request: () =>
    Effect.fail(new CodexAppServerRequestError({ code: -32601, errorMessage: "Method not found" })),
} as unknown as Parameters<typeof readCodexRuntimeModeRestrictions>[0];

it.effect("reports every mode unknown when the host's requirements cannot be read", () =>
  Effect.gen(function* () {
    const restrictions = yield* readCodexRuntimeModeRestrictions(readFails);
    assert.deepStrictEqual(statusOf(restrictions), {
      "approval-required": "unknown",
      "auto-accept-edits": "unknown",
      auto: "unknown",
      "full-access": "unknown",
    });
  }),
);

it.effect("reads the requirements with the app server's own method", () => {
  const asked: Array<unknown> = [];
  const client = {
    request: (method: string, params: unknown) => {
      asked.push([method, params]);
      return Effect.succeed({ requirements: { allowedApprovalPolicies: ["never"] } });
    },
  } as unknown as Parameters<typeof readCodexRuntimeModeRestrictions>[0];
  return Effect.gen(function* () {
    const restrictions = yield* readCodexRuntimeModeRestrictions(client);
    assert.deepStrictEqual(asked, [["configRequirements/read", undefined]]);
    assert.strictEqual(statusOf(restrictions)["full-access"], "unknown");
    assert.strictEqual(statusOf(restrictions).auto, "disallowed");
  });
});

it.effect("judges each mode by the policy the adapter really sends for it", () =>
  Effect.gen(function* () {
    const modelSelection = {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-test",
    } as ModelSelection;
    for (const [runtimeMode, expected] of Object.entries(CODEX_RUNTIME_MODE_POLICIES)) {
      const params = yield* buildCodexTurnStartParams({
        nativeThreadId: "native-thread",
        codexInput: [],
        modelSelection,
        runtimePolicy: {
          runtimeMode: runtimeMode as RuntimeMode,
          interactionMode: "default",
          cwd: "/workspace",
        },
      });
      assert.deepStrictEqual(params.approvalPolicy, expected.approvalPolicy, runtimeMode);
      const sandbox = (params.sandboxPolicy as { readonly type: string }).type;
      assert.strictEqual(
        {
          readOnly: "read-only",
          workspaceWrite: "workspace-write",
          dangerFullAccess: "danger-full-access",
        }[sandbox],
        expected.sandboxMode,
        runtimeMode,
      );
    }
  }).pipe(Effect.orDie),
);

const codexSettings = {
  enabled: true,
  binaryPath: "codex",
  homePath: "",
  launchArgs: "",
  customModels: [],
  shadowHomePath: "",
} as unknown as Parameters<typeof checkCodexProviderStatus>[0];

const account = {
  account: { type: "apiKey" },
  requiresOpenaiAuth: false,
} as const;

it.effect("carries the restriction on the snapshot, apart from the modes it offers", () =>
  Effect.gen(function* () {
    const draft = yield* checkCodexProviderStatus(codexSettings, () =>
      Effect.succeed({
        account,
        version: "1.0.0",
        models: [],
        skills: [],
        runtimeModeRestrictions: codexRuntimeModeRestrictions({
          requirements: { allowedApprovalPolicies: ["never", "on-request"] },
        }),
      }),
    );
    assert.strictEqual(
      statusOf(draft.runtimeModeRestrictions ?? [])["approval-required"],
      "disallowed",
    );
    // A mode missing from this list would run as another one, which is what this field avoids.
    assert.isUndefined(draft.supportedRuntimeModes);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("leaves the snapshot's restriction out when a probe could not ask", () =>
  Effect.gen(function* () {
    const draft = yield* checkCodexProviderStatus(codexSettings, () =>
      Effect.succeed({ account, version: "1.0.0", models: [], skills: [] }),
    );
    assert.isUndefined(draft.runtimeModeRestrictions);
  }).pipe(Effect.provide(NodeServices.layer)),
);

/** A provider's snapshot as the registry that clients and Factory read holds it. */
const registered = (
  runtimeModeRestrictions?: ServerProvider["runtimeModeRestrictions"],
): ServerProvider => ({
  instanceId: ProviderInstanceId.make("codex"),
  driver: ProviderDriverKind.make("codex"),
  enabled: true,
  installed: true,
  version: "1.0.0",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-11-01T00:00:00.000Z",
  models: [],
  slashCommands: [],
  skills: [],
  ...(runtimeModeRestrictions === undefined ? {} : { runtimeModeRestrictions }),
});

const refused = [{ runtimeMode: "approval-required", status: "disallowed" }] as const;
const supervisedIn = (provider: ServerProvider) =>
  providerRuntimeModeRestriction(provider, "approval-required").status;

it("takes what the host says from the registry's newest snapshot alone", () => {
  const before = registered(refused);
  assert.strictEqual(supervisedIn(mergeProviderSnapshot(undefined, before)), "disallowed");
  assert.strictEqual(
    supervisedIn(
      mergeProviderSnapshot(
        before,
        registered([{ runtimeMode: "approval-required", status: "allowed" }]),
      ),
    ),
    "allowed",
  );
  // A probe that could not ask must not keep refusing on what an earlier one read.
  assert.strictEqual(supervisedIn(mergeProviderSnapshot(before, registered())), "unknown");
});

it("refuses nothing on a cached snapshot before a probe has asked this boot", () => {
  const hydrated = hydrateCachedProvider({
    cachedProvider: registered(refused),
    fallbackProvider: registered(),
  });
  assert.strictEqual(supervisedIn(hydrated), "unknown");
});
