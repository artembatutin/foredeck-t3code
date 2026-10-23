import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { AcpRegistrySettings } from "../../settings.ts";
import { copilotUsageFormat, copilotUsageReader } from "./history.ts";

const decodeSettings = Schema.decodeUnknownSync(AcpRegistrySettings);

const usage = (inputTokens = 1000, outputTokens = 100) => ({
  inputTokens,
  outputTokens,
  cacheReadTokens: 600,
  cacheWriteTokens: 100,
  reasoningTokens: 25,
});
const snapshot = (id: string, metrics: Record<string, unknown>, type = "session.shutdown") => ({
  id,
  type,
  timestamp: "2026-10-23T12:00:00Z",
  data:
    type === "session.shutdown"
      ? { modelMetrics: metrics }
      : { accountingSnapshot: { modelMetrics: metrics } },
});
const start = () => {
  const state = copilotUsageFormat.state!.initial();
  copilotUsageFormat.parseLine(
    JSON.stringify({ type: "session.start", data: { sessionId: "session-1" } }),
    state,
  );
  return state;
};

describe("Copilot usage history", () => {
  it("prices each model from disjoint token counts, ignoring premium request and credit amounts", () => {
    const state = start();
    const records = copilotUsageFormat.parseProjected(
      snapshot("first", {
        "claude-sonnet-4.6": { usage: usage(), requests: { cost: 3 }, totalNanoAiu: 1e9 },
        "gpt-5.4": { usage: usage(1500, 200) },
      }),
      state,
    );
    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({
      provider: "copilot",
      sessionId: "session-1",
      reportedCostUsd: null,
      totals: {
        uncachedInputTokens: 300,
        cachedInputTokens: 600,
        cacheCreationTokens: 100,
        outputTokens: 100,
        reasoningTokens: 25,
      },
    });
    expect(records[1]?.model).toBe("gpt-5.4");
  });

  it("counts only new usage after checkpoints, shutdowns, and a cached-reader restart", () => {
    const state = start();
    const first = snapshot("checkpoint", { model: { usage: usage() } }, "session.usage_checkpoint");
    expect(copilotUsageFormat.parseProjected(first, state)).toHaveLength(1);
    const codec = copilotUsageFormat.state!.schema;
    const resumed = Schema.decodeUnknownSync(codec)(Schema.encodeSync(codec)(state));
    expect(
      copilotUsageFormat.parseProjected(
        snapshot("shutdown", { model: { usage: usage() } }),
        resumed,
      ),
    ).toEqual([]);
    const next = copilotUsageFormat.parseProjected(
      snapshot("later", { model: { usage: usage(1300, 150) } }),
      resumed,
    );
    expect(next[0]?.totals).toEqual({
      uncachedInputTokens: 300,
      cachedInputTokens: 0,
      cacheCreationTokens: 0,
      outputTokens: 50,
      reasoningTokens: 0,
    });
    expect(copilotUsageFormat.parseProjected(first, resumed)).toEqual([]);
  });

  it("ignores incomplete, malformed, child, and ephemeral usage without double counting", () => {
    const state = start();
    expect(copilotUsageFormat.parseLine("{broken", state)).toEqual([]);
    expect(
      copilotUsageFormat.parseProjected({ type: "assistant.usage", data: usage() }, state),
    ).toEqual([]);
    expect(
      copilotUsageFormat.parseProjected(
        { ...snapshot("child", { model: { usage: usage() } }), agentId: "child" },
        state,
      ),
    ).toEqual([]);
    expect(copilotUsageFormat.parseProjected(snapshot("empty", { model: {} }), state)).toEqual([]);
    expect(
      copilotUsageFormat.parseProjected(
        snapshot("invalid", { model: { usage: usage(-1) } }),
        state,
      ),
    ).toEqual([]);
    expect(
      copilotUsageFormat.parseProjected(
        { ...snapshot("bad-time", { model: { usage: usage() } }), timestamp: "bad" },
        state,
      ),
    ).toEqual([]);
    expect(
      copilotUsageFormat.parseProjected(snapshot("real", { model: { usage: usage() } }), state),
    ).toHaveLength(1);
  });

  it.effect("discovers only Copilot instances and respects their home overrides", () =>
    Effect.gen(function* () {
      if (copilotUsageReader.kind !== "transcripts") throw new Error("Expected transcript reader");
      const reader = copilotUsageReader;
      const directories = (
        config: unknown,
        environment = { HOME: "/users/test", COPILOT_HOME: "~/alternate" },
      ) =>
        reader.directories({
          instanceId: ProviderInstanceId.make("test"),
          config: decodeSettings(config),
          environment,
          configured: true,
        });
      expect(yield* directories({ agentId: "github-copilot-cli" })).toEqual([
        { dir: "/users/test/alternate/session-state", fileName: "events.jsonl" },
      ]);
      expect(
        yield* directories(
          { source: "local", commandPath: "/bin/copilot" },
          { HOME: "/users/test", COPILOT_HOME: "" },
        ),
      ).toEqual([{ dir: "/users/test/.copilot/session-state", fileName: "events.jsonl" }]);
      expect(yield* directories({ agentId: "other-agent" })).toEqual([]);
      expect(
        yield* directories(
          { agentId: "github-copilot-cli" },
          { HOME: "/users/test", COPILOT_HOME: "relative" },
        ),
      ).toEqual([]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
