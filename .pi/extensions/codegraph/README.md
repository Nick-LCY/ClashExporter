# CodeGraph Pi Extension

Integrates [CodeGraph](https://github.com/colbymchenry/codegraph) code intelligence into Pi as custom tools.

## Prerequisites

- [CodeGraph](https://github.com/colbymchenry/codegraph) installed (`npm install -g @colbymchenry/codegraph-linux-x64`)
- A project initialized with `codegraph init` in the project root

## Tools Registered

| Tool | Description |
|------|-------------|
| `codegraph_explore` | **Primary tool.** Explore symbols + source + call paths. Call FIRST before edits. |
| `codegraph_node` | Get one symbol's source with caller/callee trail, or read a file with dependents. |
| `codegraph_query` | Search for symbols in the codebase. |
| `codegraph_status` | Show index status and statistics. |
| `codegraph_files` | Show project file structure from the index. |
| `codegraph_callers` | Find all callers of a symbol. |
| `codegraph_callees` | Find all callees of a symbol. |
| `codegraph_impact` | Analyze impact of changing a symbol. |

## Usage

1. **Initialize CodeGraph** in your project:
   ```bash
   cd your-project
   codegraph init
   ```

2. **Start Pi** in the project directory:
   ```bash
   pi
   ```

3. The LLM will have access to all `codegraph_*` tools automatically.

## How It Works

Instead of using MCP protocol (which Pi doesn't natively support), this extension wraps CodeGraph's CLI commands via `child_process.execSync()` and registers them as Pi custom tools using `pi.registerTool()`.
