import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { WORK_MANAGEMENT_CAPABILITY } from "@t3tools/contracts/fd/work-management";
import * as SourceControlRateLimit from "@t3tools/source-control-core/server/SourceControlRateLimit";
import * as GitHubApi from "@t3tools/source-control-github/server/GitHubApi";
import { FetchHttpClient } from "effect/http";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import * as ProjectStore from "../../orchestration-v2/ProjectStore.ts";
import * as ThreadLaunch from "../../orchestration-v2/ThreadLaunchService.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import {
  layerAdapters,
  layerLive,
  layerPersistence,
  WorkService,
  workItemNotes,
  workItemScopeFingerprint,
} from "./index.ts";
import { WorkSourceAdapterRegistry } from "./sources/WorkSourceAdapter.ts";
import { owner } from "./testkit/fakes.ts";

describe("work-management composition", () => {
  it("exports the scope fingerprint, which a Markdown task's Notes never change", () => {
    const item = (body: string) => ({
      kind: "markdown" as const,
      title: "Add the export button",
      body,
      bodyTruncated: false,
      bodyFidelity: "exact" as const,
    });
    const noted = item("Export CSV.\n\n## Notes\n- 2026-10-20T10:40:00Z (owner) Looks right.\n");
    assert.strictEqual(
      workItemScopeFingerprint(noted),
      workItemScopeFingerprint(item("Export CSV.\n")),
    );
    assert.strictEqual(
      workItemNotes(noted),
      "## Notes\n- 2026-10-20T10:40:00Z (owner) Looks right.\n",
    );
  });

  it.effect("ships exactly the source kinds the capability advertises", () =>
    Effect.gen(function* () {
      const registry = yield* WorkSourceAdapterRegistry;
      assert.deepStrictEqual(
        [...registry.kinds].sort(),
        [...WORK_MANAGEMENT_CAPABILITY.sourceKinds].sort(),
      );
      for (const kind of registry.kinds) {
        assert.strictEqual(registry.get(kind)?.kind, kind);
      }
    }).pipe(
      Effect.provide(
        layerAdapters.pipe(
          Layer.provide(NodeServices.layer),
          Layer.provide(Layer.mock(GitHubApi.GitHubApi)({})),
          Layer.provide(SourceControlRateLimit.layer),
          Layer.provide(FetchHttpClient.layer),
        ),
      ),
    ),
  );

  it.effect("builds the live service over the persistence layer", () =>
    Effect.gen(function* () {
      const work = yield* WorkService.WorkService;
      assert.deepStrictEqual(yield* work.listSources(owner, { includeDisconnected: true }), {
        sources: [],
      });
    }).pipe(
      Effect.provide(
        layerLive.pipe(
          Layer.provideMerge(layerPersistence),
          Layer.provideMerge(SqlitePersistence.layerMemory),
          Layer.provide(Layer.mock(ProjectStore.ProjectStoreV2)({})),
          Layer.provide(Layer.mock(ServerSecretStore.ServerSecretStore)({})),
          Layer.provide(Layer.mock(ThreadLaunch.ThreadLaunchService)({})),
          Layer.provide(ServerSettings.layerTest()),
          Layer.provide(Layer.mock(GitHubApi.GitHubApi)({})),
          Layer.provide(SourceControlRateLimit.layer),
          Layer.provide(FetchHttpClient.layer),
          Layer.provide(NodeServices.layer),
        ),
      ),
    ),
  );
});
