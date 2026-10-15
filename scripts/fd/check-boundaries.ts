// @effect-diagnostics nodeBuiltinImport:off - This synchronous Git hook checks an index snapshot before the formatter runs; it does not start an application runtime.
import * as NodeChildProcess from "node:child_process";
import * as NodePath from "node:path";
import * as NodeProcess from "node:process";
import * as NodeURL from "node:url";
import ts from "typescript-legacy";

const policyPath = "scripts/fd/integration-files.json";
const protectedPath = /^(?:apps|packages|infra|native)\//;
const sourceFile = /\.[cm]?[jt]sx?$/;
const fdPath =
  /^(?:(?:apps|packages|infra)\/[^/]+\/(?:src|assets|public)\/fd\/[^/]+\/|packages\/fd-[^/]+\/|native\/fd\/)/;

const git = (cwd: string, args: string[]) =>
  NodeChildProcess.execFileSync("git", ["--literal-pathspecs", ...args], {
    cwd,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });

const entries = (output: string) => output.split("\0").filter(Boolean);

/** Compare mode and object identity too: a symlink is not an upstream source file. */
const treeEntries = (cwd: string, tree: string, paths: string[]) =>
  new Map(
    entries(git(cwd, ["ls-tree", "-rz", tree, "--", ...paths])).map((entry) => {
      const tab = entry.indexOf("\t");
      return [entry.slice(tab + 1), entry.slice(0, tab)];
    }),
  );

function readPolicy(content: string): Set<string> {
  const policy: unknown = JSON.parse(content);
  if (typeof policy !== "object" || policy === null || !("integrationFiles" in policy)) {
    throw new Error(`${policyPath} must contain an integrationFiles object.`);
  }
  const files = policy.integrationFiles;
  if (typeof files !== "object" || files === null || Array.isArray(files)) {
    throw new Error("integrationFiles must map exact repository paths to reasons.");
  }
  for (const [path, reason] of Object.entries(files)) {
    if (
      !protectedPath.test(path) ||
      NodePath.posix.normalize(path) !== path ||
      /[\\*?{}]/.test(path) ||
      typeof reason !== "string" ||
      !reason.trim()
    ) {
      throw new Error(`Invalid integration file ${path}: use an exact path and a nonempty reason.`);
    }
  }
  return new Set(Object.keys(files));
}

function workspace(path: string) {
  return path.match(/^(?:apps|packages|infra)\/[^/]+/)?.[0];
}

function fdFeature(path: string) {
  return (
    path.match(/^(.+\/src\/fd\/[^/]+)(?:\/|$)/)?.[1] ??
    path.match(/^(packages\/fd-[^/]+)(?:\/|$)/)?.[1]
  );
}

/** Resolve the repo's relative imports, web alias and workspace package conventions. */
function importTarget(file: string, specifier: string) {
  const source = specifier.split(/[?#]/)[0] ?? specifier;
  if (source.startsWith("."))
    return NodePath.posix.normalize(NodePath.posix.join(NodePath.posix.dirname(file), source));
  if (source.startsWith("~/") && file.startsWith("apps/web/"))
    return NodePath.posix.normalize(`apps/web/src/${source.slice(2)}`);
  if (source === "t3" || source.startsWith("t3/")) return `apps/server/src/${source.slice(3)}`;
  if (source === "t3code-relay" || source.startsWith("t3code-relay/"))
    return `infra/relay/src/${source.slice(13)}`;
  const match = source.match(/^@t3tools\/([^/]+)(?:\/(.*))?$/);
  if (!match) return undefined;
  const [, name, subpath = ""] = match;
  const group = ["web", "desktop", "mobile", "marketing"].includes(name ?? "")
    ? "apps"
    : "packages";
  return NodePath.posix.normalize(`${group}/${name}/src/${subpath}`).replace(/\/$/, "");
}

function importViolations(file: string, content: string, integrations: Set<string>) {
  const errors: string[] = [];
  const fromFeature = fdFeature(file);
  const ast = ts.createSourceFile(file, content, ts.ScriptTarget.Latest, true);
  const check = (node: ts.Node, argument: ts.Node | undefined) => {
    if (!argument || !ts.isStringLiteralLike(argument)) {
      if (fromFeature) errors.push(`${file}: fd modules must use literal module specifiers.`);
      return;
    }
    const target = importTarget(file, argument.text);
    if (!target) return;
    const toFeature = fdFeature(target);
    if (!fromFeature && !toFeature) return;
    const fromWorkspace = workspace(file);
    const toWorkspace = workspace(target);
    const line = ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1;
    const fail = (message: string) => errors.push(`${file}:${line}: ${message}`);
    if (toWorkspace !== fromWorkspace) {
      if (!toWorkspace?.startsWith("packages/") || argument.text.startsWith(".")) {
        fail(
          "Use shared package exports; fd must not cross into another app or private workspace source.",
        );
        return;
      }
    }
    if (!toFeature) return;
    if (!fromFeature && !integrations.has(file)) {
      fail(`Declare this integration file in ${policyPath} before importing fd.`);
    }
    if (fromFeature === toFeature) return;
    const relative = target.slice(toFeature.length).replace(/^\//, "");
    const isPackage = toFeature.startsWith("packages/fd-");
    const entry = isPackage ? "src" : "";
    if (
      relative !== entry &&
      !new RegExp(`^${entry ? `${entry}/` : ""}index(?:\\.[cm]?[jt]sx?|\\.css)?$`).test(relative)
    ) {
      fail("Import the fd feature's index entry point; its implementation files are private.");
    }
  };
  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      if (node.moduleSpecifier) check(node, node.moduleSpecifier);
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
      check(node, node.argument.literal);
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference)
    ) {
      check(node, node.moduleReference.expression);
    } else if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === "require"))
    ) {
      check(node, node.arguments[0]);
    }
    ts.forEachChild(node, visit);
  };
  visit(ast);
  return errors;
}

/** Read an immutable snapshot of the index, not unstaged files or a symlinked .git directory. */
export function checkBoundaries(cwd: string, base?: string) {
  const head = git(cwd, ["rev-parse", "--verify", "HEAD"]).trim();
  const snapshot = base ? head : git(cwd, ["write-tree"]).trim();
  const comparison = base
    ? git(cwd, [
        "merge-base",
        head,
        git(cwd, ["rev-parse", "--verify", "--end-of-options", `${base}^{commit}`]).trim(),
      ]).trim()
    : head;
  const paths = entries(
    git(cwd, ["diff", "--name-only", "--no-renames", "-z", comparison, snapshot]),
  );
  if (paths.length === 0) return [];
  const integrations = readPolicy(git(cwd, ["show", `${snapshot}:${policyPath}`]));
  const protectedFiles = paths.filter((path) => protectedPath.test(path));
  const tree = treeEntries(cwd, snapshot, paths);
  let upstream = new Map<string, string>();
  let oldUpstream = new Map<string, string>();
  if (protectedFiles.some((path) => !fdPath.test(path) && !integrations.has(path))) {
    const ref = NodeChildProcess.spawnSync(
      "git",
      ["rev-parse", "--verify", "refs/remotes/upstream/main"],
      { cwd, encoding: "utf8" },
    );
    if (ref.status === 0) {
      const tip = ref.stdout.trim();
      upstream = treeEntries(cwd, tip, protectedFiles);
      const oldBase = git(cwd, ["merge-base", comparison, tip]).trim();
      oldUpstream = treeEntries(cwd, oldBase, protectedFiles);
    }
  }
  const errors: string[] = [];
  for (const path of paths) {
    const entry = tree.get(path);
    // A pure upstream update is not a new customization. Conflicted resolutions and
    // modified upstream files still need an explicit integration reason.
    const unchangedUpstream = entry !== undefined && entry === upstream.get(path);
    const deletedUpstream = !entry && oldUpstream.has(path) && !upstream.has(path);
    if (
      protectedPath.test(path) &&
      !fdPath.test(path) &&
      !integrations.has(path) &&
      !unchangedUpstream &&
      !deletedUpstream
    ) {
      errors.push(
        `${path}: keep fork implementation under fd, or declare this exact integration file and its reason in ${policyPath}.`,
      );
    }
    if (!entry || !sourceFile.test(path) || unchangedUpstream) continue;
    if (entry.startsWith("120000 ")) {
      errors.push(`${path}: source symlinks cannot be checked; use a regular source file.`);
      continue;
    }
    errors.push(...importViolations(path, git(cwd, ["show", `${snapshot}:${path}`]), integrations));
  }
  return errors;
}

if (
  NodeProcess.argv[1] &&
  NodeURL.fileURLToPath(import.meta.url) === NodePath.resolve(NodeProcess.argv[1])
) {
  try {
    const args = NodeProcess.argv.slice(2);
    if (
      args.length &&
      !(args.length === 1 && args[0] === "--staged") &&
      !(args.length === 2 && args[0] === "--base")
    ) {
      throw new Error("Usage: node scripts/fd/check-boundaries.ts [--staged | --base <ref>]");
    }
    const errors = checkBoundaries(NodeProcess.cwd(), args[0] === "--base" ? args[1] : undefined);
    if (errors.length) throw new Error(errors.join("\n"));
    NodeProcess.stdout.write("fd boundaries passed.\n");
  } catch (error) {
    NodeProcess.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    NodeProcess.exit(1);
  }
}
