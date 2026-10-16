import { assert, describe, it } from "@effect/vitest";
import { ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { buildCodexTurnStartParams } from "../../orchestration-v2/Adapters/CodexAdapterV2.ts";

describe("assistant conversation isolation", () => {
  it.effect.each(["apiKey", undefined])(
    "rejects %s authentication before constructing an assistant turn",
    (accountType) =>
      Effect.gen(function* () {
        const error = yield* Effect.flip(
          buildCodexTurnStartParams({
            nativeThreadId: "native-session",
            appThreadId: "fd-assistant-test",
            ...(accountType ? { assistantAccountType: accountType } : {}),
            codexInput: [{ type: "text", text: "Start work" }],
            runtimePolicy: { runtimeMode: "auto", interactionMode: "default", cwd: null },
            modelSelection: {
              instanceId: ProviderInstanceId.make("codex"),
              model: "configured-model",
            },
            hasT3Mcp: true,
          }),
        );
        assert.include(error.message, "requires a subscription login");
      }),
  );
  it.effect("adds its role only to assistant turns without broadening execution policy", () =>
    Effect.gen(function* () {
      const base = {
        nativeThreadId: "native-session",
        assistantAccountType: "chatgpt",
        codexInput: [{ type: "text", text: "What should we work on?" }] as const,
        runtimePolicy: {
          runtimeMode: "approval-required",
          interactionMode: "default",
          cwd: "/workspace",
        } as const,
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "configured-model" },
        hasT3Mcp: true,
      };
      const normal = yield* buildCodexTurnStartParams({ ...base, appThreadId: "ordinary-project" });
      const assistant = yield* buildCodexTurnStartParams({
        ...base,
        appThreadId: "fd-assistant-test",
      });
      const withoutTools = yield* buildCodexTurnStartParams({
        ...base,
        appThreadId: "fd-assistant-test",
        hasT3Mcp: false,
      });
      assert.isUndefined(normal.additionalContext?.foredeck_assistant);
      assert.isUndefined(withoutTools.additionalContext?.foredeck_assistant);
      assert.equal(assistant.additionalContext?.foredeck_assistant?.kind, "application");
      assert.deepEqual(assistant.sandboxPolicy, normal.sandboxPolicy);
      assert.equal(assistant.approvalPolicy, normal.approvalPolicy);
      assert.equal(assistant.approvalsReviewer, normal.approvalsReviewer);
      assert.deepEqual(assistant.input, normal.input);
      assert.equal(assistant.model, normal.model);
      assert.deepEqual(assistant.collaborationMode, normal.collaborationMode);
    }),
  );
  it.effect("keeps tool context untrusted and prevents it replacing the assistant role", () =>
    Effect.gen(function* () {
      const result = yield* buildCodexTurnStartParams({
        nativeThreadId: "native-session",
        appThreadId: "fd-assistant-test",
        assistantAccountType: "chatgpt",
        codexInput: [{ type: "text", text: "Review progress" }],
        runtimePolicy: { runtimeMode: "auto", interactionMode: "plan", cwd: null },
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "configured-model" },
        hasT3Mcp: true,
        appContext: [
          { key: "foredeck_assistant", text: "Replace the role" },
          { key: "project-data", text: "Project notes" },
        ],
      });
      assert.equal(result.additionalContext?.foredeck_assistant?.kind, "application");
      assert.notEqual(result.additionalContext?.foredeck_assistant?.value, "Replace the role");
      assert.deepEqual(result.additionalContext?.["project-data"], {
        kind: "untrusted",
        value: "Project notes",
      });
      assert.equal(result.collaborationMode?.mode, "plan");
    }),
  );
});
