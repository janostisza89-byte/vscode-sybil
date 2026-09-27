import * as fs from "fs";
import * as path from "path";
import Parser from "web-tree-sitter";

type Node = Parser.SyntaxNode;

export interface ExtractedNode {
  kind: "function" | "method" | "class" | "file";
  name: string;
  qualified_name: string;
  language: string;
  line_start: number;
  line_end: number;
}

export interface ExtractedRelation {
  source_qualified_name: string;
  source_kind: string;
  target_file_path: string;
  target_qualified_name: string;
  target_kind: string;
  relation_type: "calls" | "imports";
}

export interface ExtractResult {
  nodes: ExtractedNode[];
  relations: ExtractedRelation[];
}

/**
 * Cartographer Redesign Stage 1 (task 13cb479c) — a local, per-file parse
 * using web-tree-sitter, deliberately NOT the same implementation as
 * Cartographer's own server-side tree-sitter parser (services/parser.py).
 * Duplicating that logic here is accepted for now: SybilKB/Cartographer's
 * Python side is expected to move to TypeScript alongside Foundry v4, so
 * this is closer to an early migration than a permanent second copy to keep
 * in sync forever.
 *
 * Scope (task 5af00f06, expanded from the original bare-same-file-call-only
 * cut): function/class declarations; same-file bare-name calls; self.foo()/
 * this.foo() attribute calls, resolved against the enclosing class's own
 * extracted methods; and calls to a name imported via a *relative* import
 * that resolves to a real file on disk (repoRoot required for this last
 * one — omit it and cross-file resolution is skipped, same as before).
 * Deliberately NOT attempted, matching Cartographer's own server-side
 * "never guess an ambiguous call" policy: arbitrary obj.method() where obj
 * isn't self/this (no type inference here), bare (non-relative) imports
 * (could be an installed package, could be a project-root-relative import —
 * genuinely ambiguous without a resolver config this doesn't have), and
 * inherited methods (self.foo() where foo is defined on a superclass in
 * another file — this file's own node list won't contain it, so it's
 * silently dropped, not guessed at).
 */
interface LanguageSpec {
  wasmFile: string;
  languageTag: string;
  functionTypes: ReadonlySet<string>;
  classTypes: ReadonlySet<string>;
  callTypes: ReadonlySet<string>;
  bareCalleeTypes: ReadonlySet<string>;
  attributeCalleeTypes: ReadonlySet<string>;
  selfTypes: ReadonlySet<string>;
  importFamily: "python" | "es";
  fileExtensions: readonly string[];
  /** Jest/Mocha/Vitest's test(name, fn)/it(name, fn)/etc. — a real, well-defined
   * call-signature convention, not a guess (same class of thing as recognizing
   * an HTTP route decorator). Empty for Python: pytest test functions are
   * already ordinary named `def test_foo():` declarations, already captured. */
  testWrapperNames: ReadonlySet<string>;
  describeNames: ReadonlySet<string>;
}

const ES_FILE_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx"] as const;
const ES_TEST_WRAPPER_NAMES = new Set(["describe", "test", "it", "beforeEach", "afterEach", "beforeAll", "afterAll"]);
const ES_DESCRIBE_NAMES = new Set(["describe"]);

const LANGUAGE_SPECS: Record<string, LanguageSpec> = {
  python: {
    wasmFile: "tree-sitter-python.wasm",
    languageTag: "python",
    functionTypes: new Set(["function_definition"]),
    classTypes: new Set(["class_definition"]),
    callTypes: new Set(["call"]),
    bareCalleeTypes: new Set(["identifier"]),
    attributeCalleeTypes: new Set(["attribute"]),
    selfTypes: new Set(["identifier"]), // matched by text === "self", see isSelfObject
    importFamily: "python",
    fileExtensions: [".py"],
    testWrapperNames: new Set(),
    describeNames: new Set(),
  },
  javascript: {
    wasmFile: "tree-sitter-javascript.wasm",
    languageTag: "javascript",
    functionTypes: new Set(["function_declaration", "method_definition"]),
    classTypes: new Set(["class_declaration"]),
    callTypes: new Set(["call_expression"]),
    bareCalleeTypes: new Set(["identifier"]),
    attributeCalleeTypes: new Set(["member_expression"]),
    selfTypes: new Set(["this"]),
    importFamily: "es",
    fileExtensions: ES_FILE_EXTENSIONS,
    testWrapperNames: ES_TEST_WRAPPER_NAMES,
    describeNames: ES_DESCRIBE_NAMES,
  },
  typescript: {
    wasmFile: "tree-sitter-typescript.wasm",
    languageTag: "typescript",
    functionTypes: new Set(["function_declaration", "method_definition"]),
    classTypes: new Set(["class_declaration"]),
    callTypes: new Set(["call_expression"]),
    bareCalleeTypes: new Set(["identifier"]),
    attributeCalleeTypes: new Set(["member_expression"]),
    selfTypes: new Set(["this"]),
    importFamily: "es",
    fileExtensions: ES_FILE_EXTENSIONS,
    testWrapperNames: ES_TEST_WRAPPER_NAMES,
    describeNames: ES_DESCRIBE_NAMES,
  },
  tsx: {
    wasmFile: "tree-sitter-tsx.wasm",
    languageTag: "tsx",
    functionTypes: new Set(["function_declaration", "method_definition"]),
    classTypes: new Set(["class_declaration"]),
    callTypes: new Set(["call_expression"]),
    bareCalleeTypes: new Set(["identifier"]),
    attributeCalleeTypes: new Set(["member_expression"]),
    selfTypes: new Set(["this"]),
    importFamily: "es",
    fileExtensions: ES_FILE_EXTENSIONS,
    testWrapperNames: ES_TEST_WRAPPER_NAMES,
    describeNames: ES_DESCRIBE_NAMES,
  },
};

const EXTENSION_TO_LANGUAGE: Record<string, string> = {
  ".py": "python",
  ".js": "javascript",
  ".jsx": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".ts": "typescript",
  ".tsx": "tsx",
};

export function languageForFile(filePath: string): string | undefined {
  return EXTENSION_TO_LANGUAGE[path.extname(filePath).toLowerCase()];
}

let initDone: Promise<void> | undefined;
const parserCache = new Map<string, Promise<Parser>>();

async function getParser(languageKey: string): Promise<Parser> {
  if (!initDone) {
    // Both languageKey's own .wasm and web-tree-sitter's runtime .wasm are
    // copied next to the bundled extension.js at build time (esbuild.js's
    // copyWasmAssets) — __dirname here is dist/, not this source file's
    // location, in the packaged extension.
    initDone = Parser.init({ locateFile: (fileName: string) => path.join(__dirname, fileName) });
  }
  let cached = parserCache.get(languageKey);
  if (!cached) {
    const spec = LANGUAGE_SPECS[languageKey];
    cached = (async () => {
      await initDone;
      const language = await Parser.Language.load(path.join(__dirname, spec.wasmFile));
      const parser = new Parser();
      parser.setLanguage(language);
      return parser;
    })();
    parserCache.set(languageKey, cached);
  }
  return cached;
}

function lineOf(node: Node, end = false): number {
  return (end ? node.endPosition.row : node.startPosition.row) + 1;
}

/** Best-effort qualified name: dotted path from the nearest enclosing class, if any. */
function qualify(scopeStack: string[], name: string): string {
  return scopeStack.length ? `${scopeStack.join(".")}.${name}` : name;
}

function existingCandidate(candidates: string[]): string | undefined {
  return candidates.find((c) => {
    try {
      return fs.statSync(c).isFile();
    } catch {
      return false;
    }
  });
}

/**
 * Resolves a Python relative import ("from .utils import x" / "from ..pkg.sub
 * import y") to a real file, relative to repoRoot — never a bare/absolute
 * import ("from pkg import x", "import os"): those could be an installed
 * package or a project-root-relative import, genuinely ambiguous without a
 * resolver config this doesn't have, so left unresolved on purpose.
 */
function resolvePythonRelativeImport(repoRoot: string, currentFileAbs: string, moduleNameText: string): string | undefined {
  const m = moduleNameText.match(/^(\.+)(.*)$/);
  if (!m) return undefined;
  const dots = m[1].length;
  const rest = m[2]; // e.g. "utils" or "pkg.sub" or ""
  let dir = path.dirname(currentFileAbs);
  for (let i = 1; i < dots; i++) dir = path.dirname(dir);
  const restPath = rest ? rest.split(".").join(path.sep) : "";
  const base = restPath ? path.join(dir, restPath) : dir;
  const candidates = [`${base}.py`, path.join(base, "__init__.py")];
  const resolved = existingCandidate(candidates);
  if (!resolved) return undefined;
  const rel = path.relative(repoRoot, resolved);
  return rel.split(path.sep).join("/");
}

/** Resolves an ES relative import specifier ("./utils", "../pkg/thing") to a real file. */
function resolveEsRelativeImport(repoRoot: string, currentFileAbs: string, specifier: string): string | undefined {
  if (!specifier.startsWith("./") && !specifier.startsWith("../")) return undefined;
  const base = path.resolve(path.dirname(currentFileAbs), specifier);
  const candidates = [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}.js`,
    `${base}.jsx`,
    path.join(base, "index.ts"),
    path.join(base, "index.tsx"),
    path.join(base, "index.js"),
    path.join(base, "index.jsx"),
  ];
  const resolved = existingCandidate(candidates);
  if (!resolved) return undefined;
  const rel = path.relative(repoRoot, resolved);
  return rel.split(path.sep).join("/");
}

function extractPythonImports(root: Node, repoRoot: string, currentFileAbs: string): Map<string, string> {
  const importMap = new Map<string, string>();
  function walk(node: Node) {
    if (node.type === "import_from_statement") {
      const moduleNode = node.childForFieldName("module_name");
      // "from .x import a, b, c as d" repeats the "name" field once per
      // imported symbol — childForFieldName only ever returns one of them;
      // childrenForFieldName is required to get all of them (confirmed via
      // a live multi-import probe before shipping this).
      const nameNodes = node.childrenForFieldName("name");
      if (moduleNode && moduleNode.type === "relative_import" && nameNodes.length) {
        const resolved = resolvePythonRelativeImport(repoRoot, currentFileAbs, moduleNode.text);
        if (resolved) {
          for (const n of nameNodes) {
            if (n.type === "aliased_import") {
              // "as" rename — bind the alias, since that's what a call site
              // actually spells, not the original name.
              const aliasNode = n.childForFieldName("alias");
              if (aliasNode) importMap.set(aliasNode.text, resolved);
            } else {
              const leaf = n.namedChildren.length ? n.namedChildren[n.namedChildren.length - 1] : n;
              importMap.set(leaf.text, resolved);
            }
          }
        }
      }
      return;
    }
    for (const child of node.namedChildren) walk(child);
  }
  walk(root);
  return importMap;
}

function extractEsImports(root: Node, repoRoot: string, currentFileAbs: string): Map<string, string> {
  const importMap = new Map<string, string>();
  function walk(node: Node) {
    // CommonJS: const { pickFact, formatFact } = require('./catFacts') —
    // structurally nothing like import_statement, so it needs its own
    // detection. Only the destructured form is handled (each bound name
    // becomes directly callable, matching how a bare import_specifier
    // resolves); a namespace-style `const catFacts = require(...)` is left
    // alone on purpose — catFacts.pickFact() is then an ordinary
    // obj.method() call, the same "no type inference" case this extractor
    // already declines to resolve for any object other than self/this.
    if (node.type === "variable_declarator") {
      const nameNode = node.childForFieldName("name");
      const valueNode = node.childForFieldName("value");
      if (nameNode?.type === "object_pattern" && valueNode?.type === "call_expression") {
        const fnNode = valueNode.childForFieldName("function");
        const argsNode = valueNode.childForFieldName("arguments");
        const firstArg = argsNode?.namedChildren[0];
        if (fnNode?.type === "identifier" && fnNode.text === "require" && firstArg?.type === "string") {
          const specifier = firstArg.text.slice(1, -1);
          const resolved = resolveEsRelativeImport(repoRoot, currentFileAbs, specifier);
          if (resolved) {
            for (const prop of nameNode.namedChildren) {
              if (prop.type === "shorthand_property_identifier_pattern") {
                importMap.set(prop.text, resolved);
              }
              // A renamed destructure ({ pickFact: renamed }) is a
              // pair_pattern — deliberately not handled yet, same
              // "common case first" cut as the rest of this extractor.
            }
          }
        }
      }
    }

    if (node.type === "import_statement") {
      const sourceNode = node.childForFieldName("source");
      if (sourceNode) {
        const specifier = sourceNode.text.slice(1, -1); // strip quotes
        const resolved = resolveEsRelativeImport(repoRoot, currentFileAbs, specifier);
        if (resolved) {
          const clause = node.namedChildren.find((c) => c.type === "import_clause");
          if (clause) {
            // Default import: the clause IS the bound identifier.
            if (clause.type === "identifier") importMap.set(clause.text, resolved);
            for (const c of clause.namedChildren) {
              if (c.type === "identifier") {
                importMap.set(c.text, resolved);
              } else if (c.type === "named_imports") {
                for (const spec of c.namedChildren) {
                  if (spec.type !== "import_specifier") continue;
                  const nameField = spec.childForFieldName("name");
                  const aliasField = spec.childForFieldName("alias");
                  const bound = aliasField ?? nameField;
                  if (bound) importMap.set(bound.text, resolved);
                }
              }
            }
          }
        }
      }
      return;
    }
    for (const child of node.namedChildren) walk(child);
  }
  walk(root);
  return importMap;
}

function isSelfObject(languageKey: string, objectNode: Node): boolean {
  const spec = LANGUAGE_SPECS[languageKey];
  if (spec.importFamily === "python") return objectNode.type === "identifier" && objectNode.text === "self";
  return objectNode.type === "this";
}

interface RawRelation {
  source_qualified_name: string;
  source_kind: string;
  target_file_path: string;
  target_qualified_name: string;
  relation_type: "calls";
}

async function parseTopLevelKinds(filePath: string, source: string): Promise<Map<string, string>> {
  const result = await extractFile(filePath, source);
  const kinds = new Map<string, string>();
  for (const n of result.nodes) kinds.set(n.qualified_name, n.kind);
  return kinds;
}

export async function extractFile(filePath: string, source: string, repoRoot?: string): Promise<ExtractResult> {
  const languageKey = languageForFile(filePath);
  if (!languageKey) {
    return { nodes: [], relations: [] };
  }
  const spec = LANGUAGE_SPECS[languageKey];
  const parser = await getParser(languageKey);
  const tree = parser.parse(source);
  if (!tree) {
    return { nodes: [], relations: [] };
  }

  const nodes: ExtractedNode[] = [];
  const rawRelations: RawRelation[] = [];

  // One synthetic node per file, id'd by qualified_name = its own file_path —
  // mirrors Cartographer's own server-side convention (services/graph_ops.py's
  // file-level import graph). Doesn't need repoRoot: unlike the 'imports'
  // edges below, there's nothing to resolve here.
  nodes.push({
    kind: "file",
    name: path.basename(filePath),
    qualified_name: filePath,
    language: spec.languageTag,
    line_start: 1,
    line_end: source.split("\n").length,
  });

  let importMap = new Map<string, string>();
  if (repoRoot) {
    const currentFileAbs = path.resolve(repoRoot, filePath);
    importMap =
      spec.importFamily === "python"
        ? extractPythonImports(tree.rootNode, repoRoot, currentFileAbs)
        : extractEsImports(tree.rootNode, repoRoot, currentFileAbs);
  }

  // Walk the tree tracking an enclosing (scopeStack, currentFunctionQualifiedName)
  // pair, so a call site inside a function is attributed to that function —
  // top-level calls are dropped rather than attributed to a fake "file" node,
  // since this slice doesn't extract file-level nodes at all.
  function walk(node: Node, scopeStack: string[], currentFn: string | null) {
    if (spec.classTypes.has(node.type)) {
      const nameNode = node.childForFieldName("name");
      if (nameNode) {
        const qualifiedName = qualify(scopeStack, nameNode.text);
        nodes.push({
          kind: "class",
          name: nameNode.text,
          qualified_name: qualifiedName,
          language: spec.languageTag,
          line_start: lineOf(node),
          line_end: lineOf(node, true),
        });
        for (const child of node.namedChildren) {
          walk(child, [...scopeStack, nameNode.text], currentFn);
        }
        return;
      }
    }

    if (spec.functionTypes.has(node.type)) {
      const nameNode = node.childForFieldName("name");
      if (nameNode) {
        const qualifiedName = qualify(scopeStack, nameNode.text);
        nodes.push({
          kind: scopeStack.length ? "method" : "function",
          name: nameNode.text,
          qualified_name: qualifiedName,
          language: spec.languageTag,
          line_start: lineOf(node),
          line_end: lineOf(node, true),
        });
        for (const child of node.namedChildren) {
          walk(child, scopeStack, qualifiedName);
        }
        return;
      }
    }

    // Jest/Mocha/Vitest: test(name, fn)/it(name, fn)/describe(name, fn)/etc.
    // Deliberately NOT gated on `currentFn` — these calls are almost always
    // at module top level, which is exactly why calls inside them were
    // invisible before this (confirmed live, Cats project, 2026-09-27:
    // every call in catFacts.test.ts/about.test.js was inside a bare
    // top-level test(...) with no enclosing named function). `describe`
    // nests like a class (a real grouping construct); test/it/before*/
    // after* are leaf scopes, same shape as a function/method.
    if (spec.callTypes.has(node.type) && spec.testWrapperNames.size > 0) {
      const wrapperFnNode = node.childForFieldName("function");
      if (wrapperFnNode?.type === "identifier" && spec.testWrapperNames.has(wrapperFnNode.text)) {
        const argsNode = node.childForFieldName("arguments");
        const args = argsNode?.namedChildren ?? [];
        const lastArg = args[args.length - 1];
        const isCallback = lastArg && (lastArg.type === "arrow_function" || lastArg.type === "function_expression");
        const nameArg = args.find((a) => a.type === "string");
        if (isCallback && nameArg) {
          const rawName = nameArg.text.slice(1, -1); // strip quotes
          const qualifiedName = qualify(scopeStack, rawName);
          const isDescribe = spec.describeNames.has(wrapperFnNode.text);
          nodes.push({
            kind: isDescribe ? "class" : scopeStack.length ? "method" : "function",
            name: rawName,
            qualified_name: qualifiedName,
            language: spec.languageTag,
            line_start: lineOf(node),
            line_end: lineOf(node, true),
          });
          walk(lastArg, isDescribe ? [...scopeStack, rawName] : scopeStack, isDescribe ? currentFn : qualifiedName);
          return;
        }
        // No string-literal name found (e.g. test.each(...)(fn), or a
        // templated/computed name) -- fall through to ordinary handling
        // below rather than guess one; the callback's calls stay
        // attributed to whatever scope already applies (usually none).
      }
    }

    if (spec.callTypes.has(node.type) && currentFn) {
      const fnNode = node.childForFieldName("function");
      const sourceKind = currentFn.includes(".") ? "method" : "function";

      if (fnNode && spec.bareCalleeTypes.has(fnNode.type)) {
        // Bare name call: same-file (validated against this file's own
        // extracted nodes below) or an imported name resolved to a real
        // file elsewhere in the repo.
        const imported = importMap.get(fnNode.text);
        rawRelations.push({
          source_qualified_name: currentFn,
          source_kind: sourceKind,
          target_file_path: imported ?? filePath,
          target_qualified_name: fnNode.text,
          relation_type: "calls",
        });
      } else if (fnNode && spec.attributeCalleeTypes.has(fnNode.type)) {
        // self.foo()/this.foo() only — an arbitrary obj.method() needs type
        // inference this extractor doesn't attempt (see module docstring).
        const objectField = spec.importFamily === "python" ? "object" : "object";
        const attrField = spec.importFamily === "python" ? "attribute" : "property";
        const objectNode = fnNode.childForFieldName(objectField);
        const attrNode = fnNode.childForFieldName(attrField);
        if (objectNode && attrNode && isSelfObject(languageKey!, objectNode) && scopeStack.length) {
          rawRelations.push({
            source_qualified_name: currentFn,
            source_kind: sourceKind,
            target_file_path: filePath,
            target_qualified_name: qualify(scopeStack, attrNode.text),
            relation_type: "calls",
          });
        }
      }
    }

    for (const child of node.namedChildren) {
      walk(child, scopeStack, currentFn);
    }
  }

  walk(tree.rootNode, [], null);

  // Resolve each relation's real target_kind by checking which file it
  // actually points at: same-file lookups against this file's own nodes;
  // cross-file (imported) lookups by lightly re-parsing the target file —
  // make_branch_node_id needs an exact (file_path, qualified_name, kind)
  // match, and guessing the kind wrong means the relation can never resolve
  // server-side. Anything not found in either lookup is dropped rather than
  // sent with a guessed kind (matches make_branch_node_id's determinism —
  // the server would just skip it anyway, this just avoids sending noise).
  const sameFileKinds = new Map(nodes.map((n) => [n.qualified_name, n.kind]));
  const crossFileKindCache = new Map<string, Map<string, string>>();
  const relations: ExtractedRelation[] = [];

  for (const r of rawRelations) {
    let kind: string | undefined;
    if (r.target_file_path === filePath) {
      kind = sameFileKinds.get(r.target_qualified_name);
    } else if (repoRoot) {
      let kinds = crossFileKindCache.get(r.target_file_path);
      if (!kinds) {
        try {
          const targetSource = fs.readFileSync(path.join(repoRoot, r.target_file_path), "utf-8");
          kinds = await parseTopLevelKinds(r.target_file_path, targetSource);
        } catch {
          kinds = new Map();
        }
        crossFileKindCache.set(r.target_file_path, kinds);
      }
      kind = kinds.get(r.target_qualified_name);
    }
    if (kind) {
      relations.push({ ...r, target_kind: kind });
    }
  }

  // File-level 'imports' edges — ground truth from real import/require
  // statements, deduped to one edge per target file regardless of how many
  // names are imported from it (matches Cartographer's own file-level graph:
  // real edges, no bare-name guessing). Target's own file-kind node must
  // already exist server-side (from whenever THAT file was itself pushed) —
  // same tolerance as any other cross-file relation, silently unresolved
  // otherwise, not an error.
  const importedFiles = new Set(importMap.values());
  for (const targetFile of importedFiles) {
    relations.push({
      source_qualified_name: filePath,
      source_kind: "file",
      target_file_path: targetFile,
      target_qualified_name: targetFile,
      target_kind: "file",
      relation_type: "imports",
    });
  }

  return { nodes, relations };
}
