import { describe, expect, it } from "vite-plus/test";

import { WORK_CLIENT_GUARDED_RPC_SCOPES, WORK_RPC_READ_SCOPES, WORK_WS_METHODS } from "./index.ts";

describe("Work RPC scope maps", () => {
  it("cover every Work method exactly once", () => {
    const reads = Object.keys(WORK_RPC_READ_SCOPES);
    const writes = Object.keys(WORK_CLIENT_GUARDED_RPC_SCOPES);
    // The server spreads both into one table; a method in both would silently take the
    // read scope and downgrade a write.
    expect(reads.filter((method) => writes.includes(method))).toEqual([]);
    expect([...reads, ...writes].sort()).toEqual(Object.values(WORK_WS_METHODS).sort());
  });
});
