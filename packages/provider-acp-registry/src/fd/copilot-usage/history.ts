import { UsageTokenTotals } from "@t3tools/contracts";
import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import {
  parseTimestampMs,
  tokenCount,
  totalTokens,
  type ProviderUsageReader,
  type TranscriptUsageFormat,
  type UsageRecord,
} from "@t3tools/provider-core/server/usage";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import type { AcpRegistrySettings } from "../../settings.ts";
import { count, isCopilotSettings, record } from "./usage.ts";

const State = Schema.Struct({
  sessionId: Schema.String,
  models: Schema.Record(Schema.String, UsageTokenTotals),
});
type State = { sessionId: string; models: Record<string, UsageTokenTotals> };

/** Snapshots are cumulative across resume/shutdown cycles; emit only newly observed tokens. */
function parseSnapshot(value: unknown, state: State): readonly UsageRecord[] {
  const event = record(value);
  const data = record(event.data);
  if (event.type === "session.start") {
    if (typeof data.sessionId === "string" && data.sessionId !== state.sessionId) {
      state.sessionId = data.sessionId;
      state.models = {};
    }
    return [];
  }
  if (event.agentId !== undefined) return [];
  if (event.type !== "session.shutdown" && event.type !== "session.usage_checkpoint") return [];
  const timestampMs = parseTimestampMs(event.timestamp);
  if (timestampMs === null || !state.sessionId) return [];
  const snapshot =
    event.type === "session.usage_checkpoint" ? record(data.accountingSnapshot) : data;
  const records: UsageRecord[] = [];
  for (const [model, raw] of Object.entries(record(snapshot.modelMetrics))) {
    if (!model.trim()) continue;
    const usage = record(record(raw).usage);
    const input = count(usage.inputTokens);
    const outputTokens = count(usage.outputTokens);
    if (input === undefined || outputTokens === undefined) continue;
    // Copilot input totals include cache reads and writes. Price disjoint categories.
    const cachedInputTokens = Math.min(input, tokenCount(usage.cacheReadTokens));
    const cacheCreationTokens = Math.min(
      input - cachedInputTokens,
      tokenCount(usage.cacheWriteTokens),
    );
    const current = {
      uncachedInputTokens: input - cachedInputTokens - cacheCreationTokens,
      cachedInputTokens,
      cacheCreationTokens,
      outputTokens,
      reasoningTokens: Math.min(outputTokens, tokenCount(usage.reasoningTokens)),
    };
    const previous = state.models[model];
    const totals = { ...current };
    for (const key of Object.keys(current) as Array<keyof typeof current>) {
      totals[key] = Math.max(0, current[key] - (previous?.[key] ?? 0));
      current[key] = Math.max(current[key], previous?.[key] ?? 0);
    }
    state.models[model] = current;
    totals.reasoningTokens = Math.min(totals.outputTokens, totals.reasoningTokens);
    if (totalTokens(totals) === 0) continue;
    records.push({
      provider: "copilot",
      timestampMs,
      model,
      sessionId: state.sessionId,
      totals,
      reportedCostUsd: null,
      speed: "standard",
      dedupeKey: `${state.sessionId}:${typeof event.id === "string" ? event.id : event.timestamp}:${model}`,
    });
  }
  return records;
}

export const copilotUsageFormat: TranscriptUsageFormat<State> = {
  selectFields: {
    type: true,
    id: true,
    timestamp: true,
    agentId: true,
    data: { sessionId: true, modelMetrics: true, accountingSnapshot: { modelMetrics: true } },
  },
  usageMarkers: ["session.start", "session.shutdown", "session.usage_checkpoint"],
  state: { initial: () => ({ sessionId: "", models: {} }), schema: State },
  sharedSessionsAcrossFiles: true,
  parseLine: (line, state) => {
    try {
      return parseSnapshot(JSON.parse(line), state);
    } catch {
      return [];
    }
  },
  parseProjected: parseSnapshot,
};

export const copilotUsageReader: ProviderUsageReader<AcpRegistrySettings, Path.Path> = {
  kind: "transcripts",
  provider: "copilot",
  format: copilotUsageFormat,
  directories: Effect.fn("copilotUsage.directories")(function* ({ config, environment }) {
    if (config === undefined || !isCopilotSettings(config)) return [];
    const path = yield* Path.Path;
    const hostHome = yield* HostProcess.HomeDirectory;
    const home = environment.HOME?.trim() || environment.USERPROFILE?.trim() || hostHome;
    const configuredHome = environment.COPILOT_HOME?.trim();
    // Relative overrides depend on the project cwd and cannot be discovered reliably.
    const dir = configuredHome ? expandHomePath(configuredHome, home) : path.join(home, ".copilot");
    if (!path.isAbsolute(dir)) return [];
    return [{ dir: path.join(dir, "session-state"), fileName: "events.jsonl" }];
  }),
};
