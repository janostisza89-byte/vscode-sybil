import * as path from "path";
import Parser from "web-tree-sitter";

type Node = Parser.SyntaxNode;

export interface ExtractedNode {
  kind: "function" | "method" | "class";
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
  relation_type: "calls";
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
 * in sync forever. Scope is intentionally minimal — function/class
 * declarations and same-file bare-name call sites only, across four
 * languages — proving the extract-and-push path end to end, not matching
 * every extraction rule Cartographer's real parser has accumulated.
 */
interface LanguageSpec {
  wasmFile: string;
  languageTag: string;
  functionTypes: ReadonlySet<string>;
  classTypes: ReadonlySet<string>;
  callTypes: ReadonlySet<string>;
  bareCalleeTypes: ReadonlySet<string>;
}

const LANGUAGE_SPECS: Record<string, LanguageSpec> = {
  python: {
    wasmFile: "tree-sitter-python.wasm",
    languageTag: "python",
    functionTypes: new Set(["function_definition"]),
    classTypes: new Set(["class_definition"]),
    callTypes: new Set(["call"]),
    bareCalleeTypes: new Set(["identifier"]),
  },
  javascript: {
    wasmFile: "tree-sitter-javascript.wasm",
    languageTag: "javascript",
    functionTypes: new Set(["function_declaration", "method_definition"]),
    classTypes: new Set(["class_declaration"]),
    callTypes: new Set(["call_expression"]),
    bareCalleeTypes: new Set(["identifier"]),
  },
  typescript: {
    wasmFile: "tree-sitter-typescript.wasm",
    languageTag: "typescript",
    functionTypes: new Set(["function_declaration", "method_definition"]),
    classTypes: new Set(["class_declaration"]),
    callTypes: new Set(["call_expression"]),
    bareCalleeTypes: new Set(["identifier"]),
  },
  tsx: {
    wasmFile: "tree-sitter-tsx.wasm",
    languageTag: "tsx",
    functionTypes: new Set(["function_declaration", "method_definition"]),
    classTypes: new Set(["class_declaration"]),
    callTypes: new Set(["call_expression"]),
    bareCalleeTypes: new Set(["identifier"]),
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

export async function extractFile(filePath: string, source: string): Promise<ExtractResult> {
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
  const relations: ExtractedRelation[] = [];

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

    if (spec.callTypes.has(node.type) && currentFn) {
      const fnNode = node.childForFieldName("function");
      // Only a bare name call (foo()) is unambiguous enough to record here —
      // an attribute/member call (obj.method(), self.method()) needs real
      // import/type resolution Cartographer's own server-side parser does
      // and this slice doesn't attempt to reproduce.
      if (fnNode && spec.bareCalleeTypes.has(fnNode.type)) {
        relations.push({
          source_qualified_name: currentFn,
          source_kind: currentFn.includes(".") ? "method" : "function",
          target_file_path: filePath,
          target_qualified_name: fnNode.text,
          target_kind: "function",
          relation_type: "calls",
        });
      }
    }

    for (const child of node.namedChildren) {
      walk(child, scopeStack, currentFn);
    }
  }

  walk(tree.rootNode, [], null);

  // A recorded call's target_qualified_name is only a bare name guess — drop
  // any relation whose target isn't actually among this file's own extracted
  // nodes, rather than sending a target the server will just skip anyway
  // (matches make_branch_node_id's determinism: same file_path+qualified_name
  // +kind must exist for the ingest endpoint to resolve it).
  const knownNames = new Set(nodes.map((n) => n.qualified_name));
  const resolvedRelations = relations.filter((r) => knownNames.has(r.target_qualified_name));

  return { nodes, relations: resolvedRelations };
}
