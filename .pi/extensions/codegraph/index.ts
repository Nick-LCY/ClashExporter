import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

const CODEGRAPH_BIN = "codegraph";

/**
 * Run a codegraph CLI command and return stdout.
 * If codegraph is not initialized, suggests the user to init first.
 */
function runCodegraph(args: string[], cwd: string): string {
  const cmd = `${CODEGRAPH_BIN} ${args.join(" ")}`;
  try {
    return execSync(cmd, { cwd, encoding: "utf-8", maxBuffer: 10 * 1024 * 1024 });
  } catch (err: any) {
    if (err.stderr?.includes("No .codegraph directory")) {
      throw new Error(
        `CodeGraph is not initialized in this project.\n` +
        `Run \`cd ${cwd} && codegraph init\` first, or ask the user to run it.`
      );
    }
    throw new Error(`codegraph error: ${err.stderr || err.message}`);
  }
}

/**
 * Detect the project root by looking for .codegraph/ directory
 * walking up from cwd.
 */
function findCodegraphRoot(start: string): string | null {
  let dir = resolve(start);
  while (true) {
    if (existsSync(join(dir, ".codegraph"))) return dir;
    const parent = resolve(dir, "..");
    if (parent === dir) return null; // reached filesystem root
    dir = parent;
  }
}

export default function (pi: ExtensionAPI) {
  // ── Tool 1: codegraph_explore ──────────────────────────────────
  pi.registerTool({
    name: "codegraph_explore",
    label: "CodeGraph Explore",
    description:
      "Explore a codebase area: given a natural-language question or symbol/file names, " +
      "returns relevant symbols' verbatim source grouped by file, plus call paths among them. " +
      "Call this FIRST before editing code you are not deeply familiar with.",
    promptGuidelines: [
      "Use codegraph_explore when the user asks about how something works, architecture, a bug, before making edits, or to survey a code area. " +
      "Treat the returned source as already Read — do NOT re-open those files.",
    ],
    parameters: Type.Object({
      query: Type.String({
        description:
          "Symbol names, file names, or short code terms to explore " +
          "(e.g., \"AuthService loginUser\", \"GraphTraverser BFS impact\"). " +
          "A natural-language question also works.",
      }),
      maxFiles: Type.Optional(
        Type.Number({
          description: "Maximum number of files to include source from (default: 12)",
          default: 12,
        })
      ),
      projectPath: Type.Optional(
        Type.String({
          description:
            "Absolute path to the project to query. Omit to auto-detect from current directory.",
        })
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const cwd = params.projectPath
        ? resolve(params.projectPath)
        : ctx.sessionManager?.getEntries()?.[0]
          ? process.cwd()
          : process.cwd();

      const root = findCodegraphRoot(cwd);
      const targetPath = root ?? cwd;
      const args = ["explore"];
      if (params.maxFiles) args.push("--max-files", String(params.maxFiles));
      if (root) args.push("--path", root);
      args.push("--", params.query);

      const output = runCodegraph(args, targetPath);
      return {
        content: [{ type: "text", text: output.trim() || "(no results)" }],
        details: {},
      };
    },
  });

  // ── Tool 2: codegraph_node ────────────────────────────────────
  pi.registerTool({
    name: "codegraph_node",
    label: "CodeGraph Node",
    description:
      "Get one symbol's full source with caller/callee trail, or read a file with line numbers and dependents.",
    parameters: Type.Object({
      name: Type.Optional(
        Type.String({ description: "Symbol name to inspect" })
      ),
      file: Type.Optional(
        Type.String({ description: "File path to read (with line numbers + dependents)" })
      ),
      offset: Type.Optional(
        Type.Number({ description: "File mode: 1-based start line" })
      ),
      limit: Type.Optional(
        Type.Number({ description: "File mode: maximum lines" })
      ),
      symbolsOnly: Type.Optional(
        Type.Boolean({ description: "File mode: just the symbol map + dependents" })
      ),
      projectPath: Type.Optional(
        Type.String({ description: "Absolute path to the project. Omit to auto-detect." })
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const cwd = params.projectPath
        ? resolve(params.projectPath)
        : process.cwd();
      const root = findCodegraphRoot(cwd);
      const targetPath = root ?? cwd;

      const args = ["node"];
      if (root) args.push("--path", root);
      if (params.file) {
        args.push("--file", params.file);
        if (params.offset) args.push("--offset", String(params.offset));
        if (params.limit) args.push("--limit", String(params.limit));
        if (params.symbolsOnly) args.push("--symbols-only");
      }
      if (params.name) args.push(params.name);

      const output = runCodegraph(args, targetPath);
      return {
        content: [{ type: "text", text: output.trim() || "(no results)" }],
        details: {},
      };
    },
  });

  // ── Tool 3: codegraph_query ───────────────────────────────────
  pi.registerTool({
    name: "codegraph_query",
    label: "CodeGraph Query",
    description: "Search for symbols in the codebase by name or pattern.",
    parameters: Type.Object({
      search: Type.String({
        description: "Symbol name or pattern to search for",
      }),
      projectPath: Type.Optional(
        Type.String({ description: "Absolute path to the project. Omit to auto-detect." })
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const cwd = params.projectPath ? resolve(params.projectPath) : process.cwd();
      const root = findCodegraphRoot(cwd);
      const targetPath = root ?? cwd;
      const args = ["query"];
      if (root) args.push("--path", root);
      args.push(params.search);

      const output = runCodegraph(args, targetPath);
      return {
        content: [{ type: "text", text: output.trim() || "(no results)" }],
        details: {},
      };
    },
  });

  // ── Tool 4: codegraph_status ──────────────────────────────────
  pi.registerTool({
    name: "codegraph_status",
    label: "CodeGraph Status",
    description: "Show codegraph index status and statistics for the project.",
    parameters: Type.Object({
      projectPath: Type.Optional(
        Type.String({ description: "Absolute path to the project. Omit to auto-detect." })
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const cwd = params.projectPath ? resolve(params.projectPath) : process.cwd();
      const root = findCodegraphRoot(cwd);
      if (!root) {
        return {
          content: [{ type: "text", text: "CodeGraph is not initialized in this project. Run `codegraph init` first." }],
          details: {},
        };
      }
      const output = runCodegraph(["status", root], root);
      return {
        content: [{ type: "text", text: output.trim() }],
        details: {},
      };
    },
  });

  // ── Tool 5: codegraph_files ───────────────────────────────────
  pi.registerTool({
    name: "codegraph_files",
    label: "CodeGraph Files",
    description: "Show project file structure from the codegraph index.",
    parameters: Type.Object({
      projectPath: Type.Optional(
        Type.String({ description: "Absolute path to the project. Omit to auto-detect." })
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const cwd = params.projectPath ? resolve(params.projectPath) : process.cwd();
      const root = findCodegraphRoot(cwd);
      if (!root) {
        return {
          content: [{ type: "text", text: "CodeGraph is not initialized in this project. Run `codegraph init` first." }],
          details: {},
        };
      }
      const output = runCodegraph(["files", "--path", root], root);
      return {
        content: [{ type: "text", text: output.trim() }],
        details: {},
      };
    },
  });

  // ── Tool 6: codegraph_callers ─────────────────────────────────
  pi.registerTool({
    name: "codegraph_callers",
    label: "CodeGraph Callers",
    description: "Find all functions/methods that call a specific symbol.",
    parameters: Type.Object({
      symbol: Type.String({ description: "Symbol name to find callers for" }),
      projectPath: Type.Optional(
        Type.String({ description: "Absolute path to the project. Omit to auto-detect." })
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const cwd = params.projectPath ? resolve(params.projectPath) : process.cwd();
      const root = findCodegraphRoot(cwd);
      const targetPath = root ?? cwd;
      const args = ["callers"];
      if (root) args.push("--path", root);
      args.push(params.symbol);

      const output = runCodegraph(args, targetPath);
      return {
        content: [{ type: "text", text: output.trim() || "(no callers found)" }],
        details: {},
      };
    },
  });

  // ── Tool 7: codegraph_callees ─────────────────────────────────
  pi.registerTool({
    name: "codegraph_callees",
    label: "CodeGraph Callees",
    description: "Find all functions/methods that a specific symbol calls.",
    parameters: Type.Object({
      symbol: Type.String({ description: "Symbol name to find callees for" }),
      projectPath: Type.Optional(
        Type.String({ description: "Absolute path to the project. Omit to auto-detect." })
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const cwd = params.projectPath ? resolve(params.projectPath) : process.cwd();
      const root = findCodegraphRoot(cwd);
      const targetPath = root ?? cwd;
      const args = ["callees"];
      if (root) args.push("--path", root);
      args.push(params.symbol);

      const output = runCodegraph(args, targetPath);
      return {
        content: [{ type: "text", text: output.trim() || "(no callees found)" }],
        details: {},
      };
    },
  });

  // ── Tool 8: codegraph_impact ──────────────────────────────────
  pi.registerTool({
    name: "codegraph_impact",
    label: "CodeGraph Impact",
    description: "Analyze what code is affected by changing a symbol.",
    parameters: Type.Object({
      symbol: Type.String({ description: "Symbol name to analyze impact for" }),
      projectPath: Type.Optional(
        Type.String({ description: "Absolute path to the project. Omit to auto-detect." })
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const cwd = params.projectPath ? resolve(params.projectPath) : process.cwd();
      const root = findCodegraphRoot(cwd);
      const targetPath = root ?? cwd;
      const args = ["impact"];
      if (root) args.push("--path", root);
      args.push(params.symbol);

      const output = runCodegraph(args, targetPath);
      return {
        content: [{ type: "text", text: output.trim() || "(no impact data)" }],
        details: {},
      };
    },
  });

  // ── Notify on load ────────────────────────────────────────────
  pi.on("session_start", async (_event, ctx) => {
    const root = findCodegraphRoot(process.cwd());
    if (root) {
      ctx.ui.notify(`CodeGraph loaded (indexed project: ${root})`, "info");
    } else {
      ctx.ui.notify(
        "CodeGraph extension loaded. Run `codegraph init` to index this project.",
        "info"
      );
    }
  });
}
