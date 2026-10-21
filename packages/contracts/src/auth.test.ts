import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import {
  AuthEnvironmentScopes,
  AuthEnvironmentScope,
  authScopeRequiredResponse,
  AuthGrantScopes,
  AuthStandardClientScopes,
  authScopeResponse,
  AuthSessionState,
  AuthWorkReadScope,
  AuthWorkWriteScope,
  sessionGrantsScope,
  sessionHasLegacyPermissions,
} from "./auth.ts";

describe("authorization grants", () => {
  it("decodes legacy review credentials without offering them in new grants", () => {
    expect(Schema.decodeUnknownSync(AuthEnvironmentScopes)(["review:write"])).toEqual([
      "review:write",
    ]);
    expect(() => Schema.decodeUnknownSync(AuthGrantScopes)(["review:write"])).toThrow();
    expect(AuthStandardClientScopes).not.toContain("review:write");
  });

  // Frozen vocabulary from the client before granular scopes shipped. Do not
  // derive it from the current enum: that would hide compatibility regressions.
  const oldScopes = Schema.Array(
    Schema.Literals([
      "orchestration:read",
      "orchestration:operate",
      "terminal:operate",
      "review:write",
      "access:read",
      "access:write",
      "relay:read",
      "relay:write",
    ]),
  );

  const decodeOldScopes = Schema.decodeUnknownSync(oldScopes);

  it.each(AuthEnvironmentScope.literals)(
    "keeps %s permission errors decodable by old clients",
    (scope) => {
      const response = authScopeRequiredResponse(scope);
      expect(decodeOldScopes([response.requiredScope])).toEqual([response.requiredScope]);
      expect(response.requiredPermission).toBe(scope);
    },
  );

  it("keeps old clients able to decode grants with new permissions", () => {
    const response = authScopeResponse(AuthStandardClientScopes);
    expect(decodeOldScopes(response.scopes)).toEqual(response.scopes);
    expect(response.permissions).toEqual(AuthStandardClientScopes);
    expect(response.scopes).not.toContain("filesystem:read");
  });

  it("ignores unknown response permissions without falling back to broader scopes", () => {
    const session = Schema.decodeUnknownSync(AuthSessionState)({
      authenticated: true,
      auth: {
        policy: "loopback-browser",
        bootstrapMethods: [],
        sessionMethods: [],
        sessionCookieName: "session",
      },
      scopes: ["orchestration:operate"],
      permissions: ["future:permission"],
    });
    expect(session.permissions).toEqual([]);
    expect(sessionGrantsScope(session, "orchestration:operate")).toBe(false);
    expect(sessionGrantsScope(session, "settings:write")).toBe(false);
  });

  it.each([
    {
      label: "exact permissions over the legacy presentation",
      session: {
        authenticated: true,
        scopes: ["orchestration:operate"],
        permissions: ["filesystem:read"],
      },
      scope: "settings:write",
      expected: false,
    },
    {
      label: "a permission absent from the legacy presentation",
      session: { authenticated: true, scopes: [], permissions: ["filesystem:read"] },
      scope: "filesystem:read",
      expected: true,
    },

    {
      label: "the parent on a server that predates the split",
      session: { authenticated: true, scopes: ["orchestration:operate"], auth: {} },
      scope: "settings:write",
      expected: true,
    },
    {
      label: "only the exact scope on a server that knows the split",
      session: {
        authenticated: true,
        scopes: ["orchestration:operate"],
        auth: { serverUpdateScope: "environment:maintain" },
      },
      scope: "settings:write",
      expected: false,
    },
    {
      label: "the exact scope regardless of server version",
      session: { authenticated: true, scopes: ["settings:write"], auth: {} },
      scope: "settings:write",
      expected: true,
    },
    {
      label: "nothing for an unauthenticated session",
      session: { authenticated: false, scopes: ["orchestration:operate"], auth: {} },
      scope: "settings:write",
      expected: false,
    },
    {
      label: "no parent for scopes that were never split",
      session: { authenticated: true, scopes: ["orchestration:operate"], auth: {} },
      scope: "access:write",
      expected: false,
    },
  ] as const)("sessionGrantsScope accepts $label", ({ session, scope, expected }) => {
    expect(sessionGrantsScope(session, scope)).toBe(expected);
  });
});

describe("Work grants", () => {
  const work = [AuthWorkReadScope, AuthWorkWriteScope] as const;

  // Frozen vocabulary from the release before Work grants.
  const preWorkDenial = Schema.Struct({
    requiredScope: Schema.Literals([
      "orchestration:read",
      "orchestration:operate",
      "settings:write",
      "providers:manage",
      "environment:maintain",
      "preview:operate",
      "diagnostics:read",
      "terminal:read",
      "terminal:operate",
      "filesystem:read",
      "filesystem:write",
      "review:write",
      "source-control:write",
      "access:read",
      "access:write",
      "relay:read",
      "relay:write",
    ]),
    requiredPermission: Schema.optionalKey(Schema.String),
  });
  const decodePreWorkDenial = Schema.decodeUnknownSync(preWorkDenial);
  const decodeEnvironmentScopes = Schema.decodeSync(AuthEnvironmentScopes);
  const decodeGrantScopes = Schema.decodeSync(AuthGrantScopes);
  const decodeSession = Schema.decodeSync(AuthSessionState);

  it("decodes as environment and grant scopes", () => {
    expect(decodeEnvironmentScopes(work)).toEqual(work);
    expect(decodeGrantScopes(work)).toEqual(work);
  });

  it("stays out of the legacy scopes presentation", () => {
    const response = authScopeResponse(["orchestration:read", ...work]);
    expect(response.scopes).toEqual(["orchestration:read"]);
    expect(response.permissions).toEqual(["orchestration:read", ...work]);
  });

  it.each(work)("keeps a %s denial decodable without its label granting Work", (scope) => {
    const response = authScopeRequiredResponse(scope);
    expect(decodePreWorkDenial(response)).toEqual({
      requiredScope: response.requiredScope,
      requiredPermission: scope,
    });
    expect(response.requiredScope).not.toBe(scope);
    const label = [response.requiredScope];
    for (const session of [
      { authenticated: true, scopes: label, permissions: label },
      { authenticated: true, scopes: label, auth: {} },
    ]) {
      expect(sessionGrantsScope(session, scope)).toBe(false);
    }
  });

  it("are part of the standard client scopes, so a new pairing carries Work", () => {
    for (const scope of work) {
      expect(AuthStandardClientScopes).toContain(scope);
      expect(
        sessionGrantsScope(
          { authenticated: true, scopes: [], permissions: AuthStandardClientScopes },
          scope,
        ),
      ).toBe(true);
    }
  });

  it.each([
    { label: "orchestration", permissions: ["orchestration:read", "orchestration:operate"] },
    { label: "settings", permissions: ["settings:write"] },
    { label: "filesystem", permissions: ["filesystem:read", "filesystem:write"] },
    { label: "explicitly empty", permissions: [] },
  ] as const)("are denied to $label grants", ({ permissions }) => {
    for (const scope of work) {
      expect(sessionGrantsScope({ authenticated: true, scopes: [], permissions }, scope)).toBe(
        false,
      );
    }
  });

  it.each([
    { label: "a pre-granular server", auth: {} },
    { label: "a first granular-scope server", auth: { serverUpdateScope: "environment:maintain" } },
  ] as const)("are denied to legacy-only grants from $label", ({ auth }) => {
    const session = {
      authenticated: true,
      scopes: [
        "orchestration:read",
        "orchestration:operate",
        "terminal:operate",
        "access:read",
        "access:write",
        "relay:read",
        "relay:write",
      ],
      auth,
    } as const;
    for (const scope of work) expect(sessionGrantsScope(session, scope)).toBe(false);
  });

  it("does not let write imply read", () => {
    const session = { authenticated: true, scopes: [], permissions: [AuthWorkWriteScope] };
    expect(sessionGrantsScope(session, AuthWorkWriteScope)).toBe(true);
    expect(sessionGrantsScope(session, AuthWorkReadScope)).toBe(false);
  });

  it("leaves auth responses without Work unchanged", () => {
    const session = decodeSession({
      authenticated: true,
      auth: {
        policy: "remote-reachable",
        bootstrapMethods: ["one-time-token"],
        sessionMethods: ["bearer-access-token"],
        sessionCookieName: "session",
        serverUpdateScope: "environment:maintain",
      },
      scopes: ["orchestration:read"],
      permissions: ["orchestration:read", "filesystem:read"],
    });
    expect(session.scopes).toEqual(["orchestration:read"]);
    expect(session.permissions).toEqual(["orchestration:read", "filesystem:read"]);
    expect(sessionGrantsScope(session, "filesystem:read")).toBe(true);
  });
});

describe("legacy permission notice", () => {
  it.each(["orchestration:read", "orchestration:operate", "terminal:operate"] as const)(
    "recognizes an old %s grant on an upgraded server",
    (scope) =>
      expect(sessionHasLegacyPermissions({ authenticated: true, permissions: [scope] })).toBe(true),
  );
  it("waits for a new server and an authenticated session", () => {
    expect(
      sessionHasLegacyPermissions({ authenticated: true, scopes: ["orchestration:operate"] }),
    ).toBe(false);
    expect(
      sessionHasLegacyPermissions({ authenticated: false, permissions: ["orchestration:operate"] }),
    ).toBe(false);
  });
  it("skips new grants and old grants that lost no implied permissions", () => {
    for (const permissions of [
      AuthStandardClientScopes,
      ["orchestration:read", "filesystem:read"] as const,
      ["access:read"] as const,
      [],
    ]) {
      expect(sessionHasLegacyPermissions({ authenticated: true, permissions })).toBe(false);
    }
  });
});
