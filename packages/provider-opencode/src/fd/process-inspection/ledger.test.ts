import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as OpenCodeServerLedger from "../../server/OpenCodeServerLedger.ts";

const deniedSpawner = (cause: Error) =>
  ChildProcessSpawner.make(() => {
    throw cause;
  });

describe("process inspection unavailable", () => {
  it.live.each(["EPERM", "EACCES"])(
    "starts without deleting orphan records when process inspection throws %s",
    (code) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const stateDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-denied-inspection-" });
        const directory = path.join(stateDir, "opencode-servers");
        const entryPath = path.join(directory, "123.json");
        const entry = JSON.stringify({
          version: 1,
          pgid: 123,
          pid: 123,
          startTime: "previous-child",
          command: "opencode serve",
          port: 4096,
          stateDir,
          owner: { pid: 456, startTime: "previous-owner" },
        });
        yield* fs.makeDirectory(directory);
        yield* fs.writeFileString(entryPath, entry);

        const ledger = yield* OpenCodeServerLedger.make({ stateDir });
        yield* ledger.reapOrphans;

        expect(yield* fs.readFileString(entryPath)).toBe(entry);
      }).pipe(
        Effect.provideService(
          ChildProcessSpawner.ChildProcessSpawner,
          deniedSpawner(Object.assign(new Error("spawn /bin/ps denied"), { code })),
        ),
        Effect.provideService(HostProcess.Platform, "darwin"),
        Effect.provide(NodeServices.layer),
      ),
  );

  it.live("preserves unexpected process-inspection defects", () => {
    const cause = new TypeError("invalid process inspection");
    return OpenCodeServerLedger.make({ stateDir: "/unused" }).pipe(
      Effect.as("unexpected success"),
      Effect.catchDefect((defect) => Effect.succeed(defect)),
      Effect.map((result) => {
        expect(result).toBe(cause);
      }),
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, deniedSpawner(cause)),
      Effect.provideService(HostProcess.Platform, "darwin"),
      Effect.provide(NodeServices.layer),
    );
  });
});
