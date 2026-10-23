import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

/**
 * Core contract modules import fd entries: `environment.ts` imports Work's, `project.ts` imports
 * `environment.ts` and `orchestrationV2.ts` imports `project.ts`. Factory imports the Work entry,
 * so a Factory source importing any of those (or the root barrel, which re-exports them) can
 * close an ESM cycle that fails at module load. Every source under the feature, at any depth, is
 * parsed for imports, and the modules are loaded fresh in several orders; a cycle surfaces as a
 * temporal-dead-zone error.
 */

// Loaded at run time with local types: importing Node or Vite statically would put Node's
// globals into the whole contracts typecheck, which has none on purpose.
const [NodeFS, NodeOS, NodeURL, { parseSync }] = await Promise.all([
  vi.importActual<{
    readonly readdirSync: (dir: URL, options: { recursive: true; encoding: "utf8" }) => string[];
    readonly readFileSync: (file: URL, encoding: "utf8") => string;
    readonly mkdirSync: (dir: URL, options: { recursive: true }) => unknown;
    readonly writeFileSync: (file: URL, data: string) => void;
    readonly mkdtempSync: (prefix: string) => string;
    readonly rmSync: (path: URL, options: { recursive: true; force: true }) => void;
  }>("node:fs"),
  vi.importActual<{ readonly tmpdir: () => string }>("node:os"),
  vi.importActual<{ readonly pathToFileURL: (path: string) => URL }>("node:url"),
  vi.importActual<{
    readonly parseSync: (
      file: string,
      source: string,
    ) => { readonly program: unknown; readonly errors: ReadonlyArray<unknown> };
  }>("vite-plus"),
]);

const contractsSource = new URL("../../", import.meta.url);

type AstNode = { readonly type: string; readonly [key: string]: unknown };

const isAstNode = (value: unknown): value is AstNode =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as { type?: unknown }).type === "string";

/** The specifier node of every import form `scripts/fd/check-boundaries.ts` checks. */
const specifierNodes = (node: unknown, found: Array<unknown> = []): Array<unknown> => {
  if (Array.isArray(node)) {
    for (const child of node) specifierNodes(child, found);
    return found;
  }
  if (!isAstNode(node)) return found;
  if (
    node.type === "ImportDeclaration" ||
    node.type === "ExportAllDeclaration" ||
    node.type === "ImportExpression" ||
    node.type === "TSImportType" ||
    (node.type === "ExportNamedDeclaration" && node.source !== null)
  ) {
    found.push(node.source);
  } else if (node.type === "TSExternalModuleReference") {
    found.push(node.expression);
  } else if (
    node.type === "CallExpression" &&
    isAstNode(node.callee) &&
    node.callee.type === "Identifier" &&
    node.callee.name === "require"
  ) {
    found.push((node.arguments as ReadonlyArray<unknown>)[0]);
  }
  for (const child of Object.values(node)) {
    if (typeof child === "object") specifierNodes(child, found);
  }
  return found;
};

/** A specifier's text, or undefined when it is computed and cannot be checked. */
const literalSpecifier = (node: unknown): string | undefined => {
  if (!isAstNode(node)) return undefined;
  if (node.type === "Literal" && typeof node.value === "string") return node.value;
  if (
    node.type === "TemplateLiteral" &&
    (node.expressions as ReadonlyArray<unknown>).length === 0
  ) {
    return (node.quasis as ReadonlyArray<{ value: { cooked: string } }>)[0]?.value.cooked;
  }
  return undefined;
};

/** Every non-test source under the feature folder at any depth, as POSIX paths within it. */
const featureSources = (srcRoot: URL) =>
  NodeFS.readdirSync(new URL("fd/factory/", srcRoot), { recursive: true, encoding: "utf8" })
    .map((path) => path.replaceAll("\\", "/"))
    .filter((path) => /\.[cm]?[jt]sx?$/.test(path) && !/\.test\.[cm]?[jt]sx?$/.test(path))
    .sort();

/** A module's URL without its extension, a trailing `/index` or a trailing slash. */
const moduleKey = (url: URL) => url.href.replace(/(?:\/index)?(?:\.[cm]?[jt]sx?)?\/?$/, "");

/** `<path> imports <specifier>` for each forbidden or computed import in the feature's sources. */
const forbiddenImports = (srcRoot: URL): ReadonlyArray<string> => {
  const forbidden = new Set(
    ["", "orchestrationV2", "project", "environment"].map((name) =>
      moduleKey(new URL(name, srcRoot)),
    ),
  );
  return featureSources(srcRoot).flatMap((path) => {
    const file = new URL(`fd/factory/${path}`, srcRoot);
    const { program, errors } = parseSync(path, NodeFS.readFileSync(file, "utf8"));
    expect(errors, `${path} parses`).toEqual([]);
    return specifierNodes(program).flatMap((node) => {
      const specifier = literalSpecifier(node);
      if (specifier === undefined) return [`${path} imports a computed specifier`];
      const target =
        specifier === "@t3tools/contracts"
          ? srcRoot
          : specifier.startsWith(".")
            ? new URL(specifier, file)
            : undefined;
      return target && forbidden.has(moduleKey(target)) ? [`${path} imports ${specifier}`] : [];
    });
  });
};

describe("factory contracts imports", () => {
  it("scans every Factory source but no test file", () => {
    const sources = featureSources(contractsSource);
    expect(sources).toEqual(expect.arrayContaining(["index.ts", "schemas.ts"]));
    expect(sources.filter((path) => path.includes(".test."))).toEqual([]);
  });

  it("finds no forbidden import in the Factory sources", () => {
    expect(forbiddenImports(contractsSource)).toEqual([]);
  });
});

describe("the forbidden-import scan", () => {
  let srcRoot = new URL("file:///unset/");

  beforeEach(() => {
    const directory = NodeFS.mkdtempSync(`${NodeOS.tmpdir()}/fd-factory-imports-`);
    srcRoot = NodeURL.pathToFileURL(`${directory}/`);
  });

  afterEach(() => {
    NodeFS.rmSync(srcRoot, { recursive: true, force: true });
  });

  const write = (path: string, source: string) => {
    const file = new URL(`fd/factory/${path}`, srcRoot);
    NodeFS.mkdirSync(new URL("./", file), { recursive: true });
    NodeFS.writeFileSync(file, source);
  };

  it.each([
    {
      form: "a comment before the specifier",
      path: "schemas.ts",
      specifier: "../../project.ts",
      source: 'import { ProjectId } from /* documented dependency */ "../../project.ts";',
    },
    {
      form: "a nested source",
      path: "rpc/methods.ts",
      specifier: "../../../project.ts",
      source: 'import { ProjectId } from "../../../project.ts";',
    },
    {
      form: "a type-only import two folders down",
      path: "a/b/c.ts",
      specifier: "../../../../environment.ts",
      source: 'import type { X } from "../../../../environment.ts";',
    },
    {
      form: "a re-export",
      path: "index.ts",
      specifier: "../../orchestrationV2.ts",
      source: 'export * from "../../orchestrationV2.ts";',
    },
    {
      form: "a named re-export",
      path: "index.ts",
      specifier: "../../orchestrationV2.ts",
      source: 'export { OrchestrationV2ThreadLaunchInput } from "../../orchestrationV2.ts";',
    },
    {
      form: "a dynamic import",
      path: "lazy.ts",
      specifier: "../../environment.ts",
      source: 'export const load = () => import(/* lazy */ "../../environment.ts");',
    },
    {
      form: "a type query",
      path: "types.ts",
      specifier: "../../environment.ts",
      source: 'export type Environment = typeof import("../../environment.ts");',
    },
    {
      form: "an import-equals require",
      path: "legacy.ts",
      specifier: "../../project.ts",
      source: 'import Project = require("../../project.ts");',
    },
    {
      form: "a side-effect import without an extension",
      path: "side.ts",
      specifier: "../../project",
      source: 'import "../../project";',
    },
    {
      form: "the root barrel by package name",
      path: "barrel.ts",
      specifier: "@t3tools/contracts",
      source: 'import { ProjectId } from "@t3tools/contracts";',
    },
    {
      form: "the root barrel by path",
      path: "nested/barrel.ts",
      specifier: "../../../index.ts",
      source: 'import { ProjectId } from "../../../index.ts";',
    },
  ])("flags $form", ({ path, specifier, source }) => {
    write(path, source);
    expect(forbiddenImports(srcRoot)).toEqual([`${path} imports ${specifier}`]);
  });

  it("flags a computed specifier it cannot check", () => {
    write("lazy.ts", "export const load = (name: string) => import(name);");
    expect(forbiddenImports(srcRoot)).toEqual(["lazy.ts imports a computed specifier"]);
  });

  it("allows other modules and import text outside import syntax", () => {
    write(
      "schemas.ts",
      [
        'import { WorkItemRef } from "../work-management/index.ts";',
        'import { ProjectId } from "../../baseSchemas.ts";',
        'import { OrchestrationProjectShell } from "../../orchestrationProject.ts";',
        'import { WorkSourceId } from "@t3tools/contracts/fd/work-management";',
        '// import "../../project.ts";',
        "export const note = 'import { X } from \"../../environment.ts\"';",
      ].join("\n"),
    );
    // Resolves to `src/fd/project.ts`, not the core module.
    write("rpc/methods.ts", 'import { Local } from "../../project.ts";');
    expect(forbiddenImports(srcRoot)).toEqual([]);
  });

  it("skips test files, which load core modules on purpose", () => {
    write("nested/load.test.ts", 'await import("../../../environment.ts");');
    expect(forbiddenImports(srcRoot)).toEqual([]);
  });
});

describe("factory contracts load order", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("loads with environment first", async () => {
    const environment = await import("../../environment.ts");
    const factory = await import("./index.ts");
    const orchestration = await import("../../orchestrationV2.ts");
    expect(environment.ExecutionEnvironmentCapabilities).toBeDefined();
    expect(factory.FactoryDeliveryStatus.literals).toContain("queued");
    expect(orchestration.OrchestrationV2ThreadLaunchInput).toBeDefined();
  });

  it("loads with orchestration first", async () => {
    const orchestration = await import("../../orchestrationV2.ts");
    const factory = await import("./index.ts");
    const environment = await import("../../environment.ts");
    expect(orchestration.OrchestrationV2ThreadLaunchInput).toBeDefined();
    expect(factory.FactoryDeliveryStatus.literals).toContain("queued");
    expect(environment.ExecutionEnvironmentCapabilities).toBeDefined();
  });

  it("loads with the Factory contracts first", async () => {
    const factory = await import("./index.ts");
    const environment = await import("../../environment.ts");
    const rpc = await import("../../rpc.ts");
    expect(factory.FactoryDeliveryStatus.literals).toContain("queued");
    expect(environment.ExecutionEnvironmentCapabilities).toBeDefined();
    expect(rpc.WS_METHODS.workItemsList).toBe("work.items.list");
  });

  it("stays out of the root contracts barrel", async () => {
    const root = await import("../../index.ts");
    const factory = await import("./index.ts");
    expect(Object.keys(factory).filter((name) => name in root)).toEqual([]);
  });
});
