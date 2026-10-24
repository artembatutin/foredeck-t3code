// @effect-diagnostics nodeBuiltinImport:off - the test needs a fresh Node process per module load.
import * as NodeChildProcess from "node:child_process";
import { assert, it } from "@effect/vitest";

// Vitest's module runner tolerates import cycles that native ESM rejects while initializing a
// module, so each module is loaded first, alone, in a fresh Node process: the entry the server
// imports, and every Factory module another entry might import first.
it.each([
  "index.ts",
  "FactoryReactor.ts",
  "FactoryService.ts",
  "FactorySettings.ts",
  "FactoryThreadEffects.ts",
  "FactoryWorker.ts",
])(
  "loads %s first in a fresh Node process",
  (file) => {
    const child = NodeChildProcess.spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        `await import(${JSON.stringify(new URL(`./${file}`, import.meta.url).href)});`,
      ],
      { encoding: "utf8" },
    );
    assert.equal(child.error, undefined);
    assert.equal(child.stderr, "");
    assert.equal(child.status, 0);
  },
  60_000,
);
