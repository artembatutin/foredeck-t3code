import { assert, describe, it } from "@effect/vitest";
import { ProviderInstanceId, type RuntimeMode } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  buildCodexTurnStartParams,
  codexThreadRuntimeParams,
  verifyCodexRepositorySandbox,
} from "../../orchestration-v2/Adapters/CodexAdapterV2.ts";
import { makeClaudeQueryOptions } from "../../orchestration-v2/Adapters/ClaudeAdapterV2.ts";

const repositories = [
  { id: "client", name: "Client", rootPath: "/work/client" },
  { id: "server", name: "Service", rootPath: "/services/server" },
  { id: "tools", name: "Tools", rootPath: "/tools" },
];
const policyFor = (runtimeMode: RuntimeMode) => ({
  runtimeMode,
  interactionMode: "default" as const,
  cwd: "/work/client",
  repositories,
});
const modelSelection = { instanceId: ProviderInstanceId.make("codex"), model: "test-model" };

describe("multi-repository provider access", () => {
  it.effect(
    "passes all sandbox roots on writable turns without changing the selected permission mode",
    () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        for (const mode of [
          "approval-required",
          "auto-accept-edits",
          "auto",
          "full-access",
        ] as const) {
          const runtimePolicy = policyFor(mode);
          const params = yield* buildCodexTurnStartParams({
            nativeThreadId: "native",
            codexInput: [],
            runtimePolicy,
            modelSelection,
          });
          const type =
            mode === "approval-required"
              ? "readOnly"
              : mode === "full-access"
                ? "dangerFullAccess"
                : "workspaceWrite";
          assert.equal(params.sandboxPolicy?.type, type);
          if (params.sandboxPolicy?.type === "workspaceWrite")
            assert.deepEqual(
              params.sandboxPolicy.writableRoots,
              repositories.map((repository) => repository.rootPath),
            );
          const thread = codexThreadRuntimeParams({ mcpSession: undefined, runtimePolicy });
          assert.equal(thread.cwd, runtimePolicy.cwd);
          assert.deepEqual(
            thread.config["sandbox_workspace_write.writable_roots"],
            repositories.map((repository) => repository.rootPath),
          );
          yield* verifyCodexRepositorySandbox(
            runtimePolicy,
            {
              cwd: runtimePolicy.cwd,
              sandbox: params.sandboxPolicy,
            },
            fileSystem,
          );
        }
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("accepts a canonical cwd returned for a filesystem alias", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "fd-provider-cwd-" });
      const alias = root + "-alias";
      yield* Effect.acquireRelease(fileSystem.symlink(root, alias), () =>
        fileSystem.remove(alias).pipe(Effect.orDie),
      );
      const policy = { ...policyFor("approval-required"), cwd: alias };
      yield* verifyCodexRepositorySandbox(
        policy,
        { cwd: yield* fileSystem.realPath(root), sandbox: { type: "readOnly" } },
        fileSystem,
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("rejects a CLI that omits a checkout, changes cwd, or broadens permissions", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const runtimePolicy = policyFor("auto-accept-edits");
      for (const response of [
        {
          cwd: runtimePolicy.cwd,
          sandbox: { type: "workspaceWrite", writableRoots: [runtimePolicy.cwd] },
        },
        {
          cwd: "/wrong",
          sandbox: {
            type: "workspaceWrite",
            writableRoots: repositories.map((repository) => repository.rootPath),
          },
        },
        { cwd: runtimePolicy.cwd, sandbox: { type: "dangerFullAccess" } },
        { thread: { cwd: runtimePolicy.cwd } },
      ]) {
        const result = yield* verifyCodexRepositorySandbox(
          runtimePolicy,
          response,
          fileSystem,
        ).pipe(Effect.result);
        assert.equal(result._tag, "Failure");
      }
      // Legacy single-checkout replies need no additional fields.
      yield* verifyCodexRepositorySandbox(
        { ...runtimePolicy, repositories: undefined },
        {},
        fileSystem,
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it("grants additional directories on new and resumed Claude queries and retains local instruction loading", () => {
    for (const resume of [false, true]) {
      const options = makeClaudeQueryOptions({
        modelSelection,
        nativeThreadId: "native",
        resume,
        cwd: "/work/client",
        repositories,
        permissionMode: "acceptEdits",
        attachmentsDir: "/attachments",
        environment: { CUSTOM: "preserved" },
      });
      assert.deepEqual(options.additionalDirectories, [
        "/work/client",
        "/services/server",
        "/tools",
        "/attachments",
      ]);
      assert.equal(options.permissionMode, "acceptEdits");
      assert.equal(options.env?.CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD, "1");
      assert.equal(options.env?.CUSTOM, "preserved");
      assert.include(JSON.stringify(options.systemPrompt), "Service");
    }
  });
});
