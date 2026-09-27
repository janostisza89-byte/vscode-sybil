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

let parserReady: Promise<Parser> | undefined;

/**
 * Cartographer Redesign Stage 1 (task 13cb479c) — Slice 3: a local,
 * one-file-at-a-time parse using web-tree-sitter, deliberately NOT the same
 * implementation as Cartographer's own server-side tree-sitter parser
 * (services/parser.py). Duplicating that logic here is accepted for now:
 * SybilKB/Cartographer's Python side is expected to move to TypeScript
 * alongside Foundry v4, so this is closer to an early migration than a
 * permanent second copy to keep in sync forever. Scope is intentionally
 * minimal — function/class declarations and same-file call sites only, one
 * language (Python) — proving the extract-and-push path end to end, not
 * matching every extraction rule Cartographer's real parser has accumulated.
 */
async function getParser(): Promise<Parser> {
  if (!parserReady) {
    parserReady = (async () => {
      // Both .wasm files are copied next to the bundled extension.js at
      // build time (esbuild.js's copyWasmAssets) — __dirname here is
      // dist/, not this source file's location, in the packaged extension.
      await Parser.init({ locateFile: (fileName: string) => path.join(__dirname, fileName) });
      const language = await Parser.Language.load(path.join(__dirname, "tree-sitter-python.wasm"));
      const parser = new Parser();
      parser.setLanguage(language);
      return parser;
    })();
  }
  return parserReady;
}

function lineOf(node: Node, end = false): number {
  return (end ? node.endPosition.row : node.startPosition.row) + 1;
}

/** Best-effort qualified name: dotted path from the nearest enclosing class, if any. */
function qualify(scopeStack: string[], name: string): string {
  return scopeStack.length ? `${scopeStack.join(".")}.${name}` : name;
}

export async function extractPythonFile(filePath: string, source: string): Promise<ExtractResult> {
  const parser = await getParser();
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
    if (node.type === "class_definition") {
      const nameNode = node.childForFieldName("name");
      if (nameNode) {
        const qualifiedName = qualify(scopeStack, nameNode.text);
        nodes.push({
          kind: "class",
          name: nameNode.text,
          qualified_name: qualifiedName,
          language: "python",
          line_start: lineOf(node),
          line_end: lineOf(node, true),
        });
        for (const child of node.namedChildren) {
          if (child) walk(child, [...scopeStack, nameNode.text], currentFn);
        }
        return;
      }
    }

    if (node.type === "function_definition") {
      const nameNode = node.childForFieldName("name");
      if (nameNode) {
        const qualifiedName = qualify(scopeStack, nameNode.text);
        nodes.push({
          kind: scopeStack.length ? "method" : "function",
          name: nameNode.text,
          qualified_name: qualifiedName,
          language: "python",
          line_start: lineOf(node),
          line_end: lineOf(node, true),
        });
        for (const child of node.namedChildren) {
          if (child) walk(child, scopeStack, qualifiedName);
        }
        return;
      }
    }

    if (node.type === "call" && currentFn) {
      const fnNode = node.childForFieldName("function");
      // Only a bare name call (foo()) is unambiguous enough to record here —
      // an attribute call (obj.method()) needs real import/type resolution
      // Cartographer's own server-side parser does and this slice doesn't
      // attempt to reproduce.
      if (fnNode && fnNode.type === "identifier") {
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
      if (child) walk(child, scopeStack, currentFn);
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
