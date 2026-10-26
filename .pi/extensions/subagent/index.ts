/**
 * Subagent Tool - Delegate tasks to specialized agents
 *
 * Spawns a separate `pi` process for each subagent invocation,
 * giving it an isolated context window.
 *
 * Supports three modes:
 *   - Single: { agent: "name", task: "..." }
 *   - Parallel: { tasks: [{ agent: "name", task: "..." }, ...] }
 *   - Chain: { chain: [{ agent: "name", task: "... {previous} ..." }, ...] }
 *
 * Uses JSON mode to capture structured output from subagents.
 *
 * Idle arbitration protocol (added by the watchdog)
 * -------------------------------------------------
 * When a sub-process stops producing stdout / stderr for too long
 * (default 600s, see `IDLE_TIMEOUT_MS`), the parent freezes the
 * entire process group with SIGSTOP and returns a fact-only snapshot
 * to the calling LLM. The parent then decides what to do via a
 * follow-up subagent call carrying one of three mutually-exclusive
 * parameters:
 *
 *   - `resume: <suspensionId>` — thaw the process group, re-arm the
 *     watchdog, and continue collecting events until the process
 *     exits. Returns the final transcript.
 *   - `kill:   <suspensionId>` — thaw, then SIGKILL the entire
 *     process group, and return the partial transcript as a failed
 *     result.
 *   - `inspect: { id: <suspensionId>, lines?: number }` — return a
 *     larger tail of stdout/stderr events without touching the
 *     frozen process. Pure read.
 *
 * The full contract is documented in the `description` string passed
 * to `registerTool` so the LLM sees it without reading source.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as readline from "node:readline";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { Message, Usage } from "@earendil-works/pi-ai";
import { StringEnum } from "@earendil-works/pi-ai";
import { getBuiltinModel } from "@earendil-works/pi-ai/providers/all";
import {
	CONFIG_DIR_NAME,
	type ExtensionAPI,
	getAgentDir,
	getMarkdownTheme,
	loadSkills,
	withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { type AgentConfig, type AgentScope, discoverAgents } from "./agents.ts";
import { resolveDefaultTimeoutS } from "../bash-guard/index.ts";
import {
	type InFlightToolCall,
	type Job,
	type JobKind,
	type SingleResultLite,
	type Suspension,
	type SuspensionId,
	attachSignalListener,
	detachAbortListener,
	extractInFlight,
	freezeProcessGroup,
	getAllSuspensions,
	getSiblingSuspensions,
	getSuspension,
	isPosixSuspendSupported,
	killProcessGroup,
	newParallelGroupId,
	newSuspensionId,
	reAttachAbortListener,
	registerSuspension,
	signalDescendants,
	summarizeTail,
	thawProcessGroup,
	unregisterSuspension,
} from "./suspensions.ts";

const MAX_PARALLEL_TASKS = 8;
const MAX_CONCURRENCY = 4;
const COLLAPSED_ITEM_COUNT = 10;
const PER_TASK_OUTPUT_CAP = 50 * 1024;

/**
 * Idle watchdog timeout in milliseconds. 600s = 10 minutes. Tuned to
 * sit comfortably above the bash-guard default of 300s (5 minutes) so
 * that any command whose own timeout fires will produce a stderr /
 * stdout event long before the watchdog triggers — preventing false
 * positives on perfectly healthy long commands.
 *
 * Override via the `SUBAGENT_IDLE_TIMEOUT_MS` environment variable for
 * tighter test loops. Non-numeric / non-positive values fall back to
 * the default.
 */
const DEFAULT_IDLE_TIMEOUT_MS = 600_000;
const ENV_IDLE_TIMEOUT = "SUBAGENT_IDLE_TIMEOUT_MS";

function resolveIdleTimeoutMs(): number {
	const raw = process.env[ENV_IDLE_TIMEOUT];
	if (raw === undefined || raw === null || raw === "") return DEFAULT_IDLE_TIMEOUT_MS;
	const n = Number(raw);
	if (!Number.isFinite(n) || n <= 0) return DEFAULT_IDLE_TIMEOUT_MS;
	return n;
}

/** Default number of tail events included in the `idle_suspended` snapshot. */
const DEFAULT_TAIL_LINES = 10;
/** Default number of tail events returned by `inspect` when caller omits `lines`. */
const DEFAULT_INSPECT_LINES = 50;
/** Default number of trailing work steps returned by `transcript` when caller omits `lines`. */
const DEFAULT_TRANSCRIPT_LINES = 10;
/** Hard upper bound on `transcript.lines` to bound output size. */
const MAX_TRANSCRIPT_LINES = 50;
/** Preview length for tool-call argument fields (bash command, file path, etc.). */
const TRANSCRIPT_ARG_PREVIEW_LEN = 100;
/** Preview length for the task description in the transcript header line. */
const TRANSCRIPT_TASK_PREVIEW_LEN = 80;

export function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	return `${(count / 1000000).toFixed(1)}M`;
}

function formatUsageStats(
	usage: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		cost: number;
		contextTokens?: number;
		turns?: number;
	},
	model?: string,
): string {
	const parts: string[] = [];
	if (usage.turns) parts.push(`${usage.turns} turn${usage.turns > 1 ? "s" : ""}`);
	if (usage.input) parts.push(`↑${formatTokens(usage.input)}`);
	if (usage.output) parts.push(`↓${formatTokens(usage.output)}`);
	if (usage.cacheRead) parts.push(`R${formatTokens(usage.cacheRead)}`);
	if (usage.cacheWrite) parts.push(`W${formatTokens(usage.cacheWrite)}`);
	if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
	if (usage.contextTokens && usage.contextTokens > 0) {
		parts.push(`ctx:${formatTokens(usage.contextTokens)}`);
	}
	if (model) parts.push(model);
	return parts.join(" ");
}

/* -------------------------------------------------------------------------- */
/*                       Usage surfacing for the LLM                          */
/* -------------------------------------------------------------------------- */

/**
 * Resolve a model's `contextWindow` via the pi-ai builtin catalog.
 *
 * The catalog is the source of truth for model metadata — rather
 * than hardcoding `claude-opus-4-7 → 1_000_000` etc., we ask
 * `getBuiltinModel(provider, model)`. If either id is missing /
 * unknown, or the catalog has no entry for the pair, we fall back
 * to `undefined` and let `usageLine` render `(window unknown)`.
 *
 * `getBuiltinModel` is imported from `@earendil-works/pi-ai/providers/all`
 * — `getModel` in pi-ai 0.81.x is still an `@deprecated`
 * re-export, so we sidestep the deprecated path and pull the
 * catalog entry directly from `providers/all`.
 *
 * Two normalization steps are needed because sub-processes
 * report `msg.model` as `provider/model` (e.g. `minimax-cn/MiniMax-M3`)
 * while the catalog + remote store key models by bare id:
 *
 *   1. Strip a leading `provider/` prefix from `model` before any
 *      lookup.
 *   2. If the builtin catalog misses (the model is from a remote
 *      provider such as minimax-cn whose catalog lives in
 *      `~/.pi/agent/models-store.json` rather than the bundled
 *      builtin catalog), fall back to scanning that store. The
 *      store is loaded once at module level and cached; any read
 *      or parse failure keeps the unknown-downgrade behavior.
 */
export function getContextWindowFor(provider: string | undefined, model: string | undefined): number | undefined {
	if (!provider || !model) return undefined;
	const prefix = `${provider}/`;
	const bareId = model.startsWith(prefix) ? model.slice(prefix.length) : model;
	try {
		const entry = getBuiltinModel(provider as Parameters<typeof getBuiltinModel>[0], bareId);
		if (entry?.contextWindow !== undefined) return entry.contextWindow;
	} catch {
		// fall through to remote store lookup
	}
	// Fallback: remote provider catalog at ~/.pi/agent/models-store.json.
	// Shape: { [providerId]: { models: [ { id, contextWindow, ... } ] } }
	return lookupContextWindowInStore(provider, bareId);
}

/** Lazy-loaded remote model store. `null` while not yet loaded; `false`
 *  after a load attempt failed (so we don't keep retrying on every call). */
let modelsStore: Record<string, { models?: Array<{ id?: string; contextWindow?: number }> }> | null | undefined;

function loadModelsStore(): Record<string, { models?: Array<{ id?: string; contextWindow?: number }> }> | null {
	if (modelsStore !== undefined) return modelsStore ?? null;
	try {
		const raw = fs.readFileSync(path.join(os.homedir(), ".pi", "agent", "models-store.json"), "utf8");
		const parsed = JSON.parse(raw);
		modelsStore = parsed && typeof parsed === "object" ? (parsed as Record<string, { models?: Array<{ id?: string; contextWindow?: number }> }>) : null;
	} catch {
		modelsStore = null;
	}
	return modelsStore ?? null;
}

function lookupContextWindowInStore(provider: string, bareId: string): number | undefined {
	const store = loadModelsStore();
	if (!store) return undefined;
	const entry = store[provider];
	const models = entry?.models;
	if (!Array.isArray(models)) return undefined;
	for (const m of models) {
		if (m && m.id === bareId) return m.contextWindow;
	}
	return undefined;
}

/**
 * Render a single result's usage as one line, intended to be
 * appended to the textual `content` of a final `AgentToolResult`
 * so the calling LLM can see what each sub-agent consumed.
 *
 * Format:
 *   `[subagent usage] <agent> · <model> · <n> turn[s] · ↑<input> ↓<output> · ctx <tokens>/<window> (<pct>%) · $<cost>`
 *
 * When the catalog does not know the model, the context section
 * degrades to `ctx <tokens> (window unknown)`. When `usage.turns`
 * is 0 (the agent never produced an assistant message, e.g. an
 * "unknown agent" error result), the line still renders so the LLM
 * sees a zero-turn marker.
 *
 * Accepts both `SingleResult` and the structurally-identical
 * `SingleResultLite` shape (used by the resume / kill path).
 */
export function usageLine(
	r: {
		agent: string;
		model?: string;
		provider?: string;
		usage: { input: number; output: number; cost: number; contextTokens: number; turns: number };
	},
	contextWindow?: number,
): string {
	const u = r.usage;
	const turns = `${u.turns} turn${u.turns === 1 ? "" : "s"}`;
	const inOut = `↑${formatTokens(u.input)} ↓${formatTokens(u.output)}`;
	const cost = `$${u.cost.toFixed(4)}`;
	let ctx: string;
	if (contextWindow && contextWindow > 0) {
		const pct = u.contextTokens > 0 ? Math.round((u.contextTokens / contextWindow) * 100) : 0;
		ctx = `ctx ${formatTokens(u.contextTokens)}/${formatTokens(contextWindow)} (${pct}%)`;
	} else {
		ctx = `ctx ${formatTokens(u.contextTokens)} (window unknown)`;
	}
	const modelLabel = r.model ?? "?";
	return `[subagent usage] ${r.agent} · ${modelLabel} · ${turns} · ${inOut} · ${ctx} · ${cost}`;
}

/**
 * Append one `[subagent usage] ...` line per result to the given
 * text, separated from the prior content by a blank line. Returns
 * the original text unchanged when `results` is empty.
 */
export function appendUsageLines(text: string, results: ReadonlyArray<SingleResult | SingleResultLite>): string {
	if (results.length === 0) return text;
	const lines = results.map((r) => usageLine(r, getContextWindowFor(r.provider, r.model)));
	return `${text}\n\n${lines.join("\n")}`;
}

/**
 * Aggregate an array of results into a single `Usage` object,
 * suitable for the structured `AgentToolResult.usage` field.
 *
 * `totalTokens` is set to the SUM of every result's last-known
 * contextTokens (i.e. the running total of context size across
 * all sub-agents at their final assistant message). It is NOT a
 * "context budget" — for multi-result tools the LLM gets the sum
 * so it can sanity-check whether the cumulative call ran close
 * to overflowing.
 *
 * `UsageStats` has no per-component cost breakdown, so the
 * summed cost is reported as `cost.total` while the per-component
 * fields (input / output / cacheRead / cacheWrite) are all
 * left at 0. pi-ai's downstream code reads `total`; the
 * breakdown is informational.
 */
export function aggregateUsageToUsage(results: ReadonlyArray<SingleResult | SingleResultLite>): Usage {
	const input = results.reduce((s, r) => s + (r.usage.input || 0), 0);
	const output = results.reduce((s, r) => s + (r.usage.output || 0), 0);
	const cacheRead = results.reduce((s, r) => s + (r.usage.cacheRead || 0), 0);
	const cacheWrite = results.reduce((s, r) => s + (r.usage.cacheWrite || 0), 0);
	const totalTokens = results.reduce((s, r) => s + (r.usage.contextTokens || 0), 0);
	const costTotal = results.reduce((s, r) => s + (r.usage.cost || 0), 0);
	// We don't track per-component cost in `UsageStats`, so split
	// the total proportionally to token share — or just pin all
	// four to the total when there's only one component. Simpler:
	// when there is exactly one result, mirror its cost.total into
	// `total` and leave the per-component breakdown as 0 (the
	// per-provider assistant messages never made it through to
	// here anyway). For multi-result, set `total` to the sum and
	// pin everything else to 0 too — pi-ai's downstream code
	// reads `total`, the breakdown is informational.
	const cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: costTotal };
	return { input, output, cacheRead, cacheWrite, totalTokens, cost };
}

function formatToolCall(
	toolName: string,
	args: Record<string, unknown>,
	themeFg: (color: any, text: string) => string,
): string {
	const shortenPath = (p: string) => {
		const home = os.homedir();
		return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
	};

	switch (toolName) {
		case "bash": {
			const command = (args.command as string) || "...";
			const preview = command.length > 60 ? `${command.slice(0, 60)}...` : command;
			return themeFg("muted", "$ ") + themeFg("toolOutput", preview);
		}
		case "read": {
			const rawPath = (args.file_path || args.path || "...") as string;
			const filePath = shortenPath(rawPath);
			const offset = args.offset as number | undefined;
			const limit = args.limit as number | undefined;
			let text = themeFg("accent", filePath);
			if (offset !== undefined || limit !== undefined) {
				const startLine = offset ?? 1;
				const endLine = limit !== undefined ? startLine + limit - 1 : "";
				text += themeFg("warning", `:${startLine}${endLine ? `-${endLine}` : ""}`);
			}
			return themeFg("muted", "read ") + text;
		}
		case "write": {
			const rawPath = (args.file_path || args.path || "...") as string;
			const filePath = shortenPath(rawPath);
			const content = (args.content || "") as string;
			const lines = content.split("\n").length;
			let text = themeFg("muted", "write ") + themeFg("accent", filePath);
			if (lines > 1) text += themeFg("dim", ` (${lines} lines)`);
			return text;
		}
		case "edit": {
			const rawPath = (args.file_path || args.path || "...") as string;
			return themeFg("muted", "edit ") + themeFg("accent", shortenPath(rawPath));
		}
		case "ls": {
			const rawPath = (args.path || ".") as string;
			return themeFg("muted", "ls ") + themeFg("accent", shortenPath(rawPath));
		}
		case "find": {
			const pattern = (args.pattern || "*") as string;
			const rawPath = (args.path || ".") as string;
			return themeFg("muted", "find ") + themeFg("accent", pattern) + themeFg("dim", ` in ${shortenPath(rawPath)}`);
		}
		case "grep": {
			const pattern = (args.pattern || "") as string;
			const rawPath = (args.path || ".") as string;
			return (
				themeFg("muted", "grep ") +
				themeFg("accent", `/${pattern}/`) +
				themeFg("dim", ` in ${shortenPath(rawPath)}`)
			);
		}
		default: {
			const argsStr = JSON.stringify(args);
			const preview = argsStr.length > 50 ? `${argsStr.slice(0, 50)}...` : argsStr;
			return themeFg("accent", toolName) + themeFg("dim", ` ${preview}`);
		}
	}
}

interface UsageStats {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	contextTokens: number;
	turns: number;
}

interface SingleResult {
	agent: string;
	agentSource: "user" | "project" | "unknown";
	task: string;
	exitCode: number;
	messages: Message[];
	stderr: string;
	usage: UsageStats;
	model?: string;
	/** Provider id from the first assistant message. Mirrors
	 *  `AssistantMessage.provider` in `@earendil-works/pi-ai`. Used
	 *  by `usageLine` to resolve `contextWindow` via
	 *  `getBuiltinModel(provider, model)`. */
	provider?: string;
	stopReason?: string;
	errorMessage?: string;
	step?: number;
}

interface SubagentDetails {
	mode: "single" | "parallel" | "chain";
	agentScope: AgentScope;
	projectAgentsDir: string | null;
	results: SingleResult[];
	/**
	 * One snapshot per suspended sub-process. Empty for normal
	 * (non-suspended) results — the factory below guarantees
	 * `suspensions: []` rather than leaving the field undefined so
	 * `renderResult` (which reads `.suspensions.length` /
	 * `.suspensions[i]`) never has to do an existence check on
	 * every render. The defensive `?.` it keeps is purely an
	 * extra-paranoid belt-and-braces guard for tool results that
	 * might have come from a future codepath.
	 */
	suspensions: SuspendedSnapshot["suspensions"];
}

interface SuspendedSnapshot {
	mode: "single" | "parallel" | "chain";
	results: SingleResult[];
	/** One snapshot per suspended sub-process, identified by
	 *  `suspensionId`. Parallel mode may have several; single/chain
	 *  at most one. */
	suspensions: Array<{
		suspensionId: string;
		idleMs: number;
		runningCommand: string | null;
		requestedTimeout: number | null;
		tail: ReturnType<typeof summarizeTail>;
	}>;
}

function getFinalOutput(messages: Message[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role === "assistant") {
			for (const part of msg.content) {
				if (part.type === "text") return part.text;
			}
		}
	}
	return "";
}

function isFailedResult(result: SingleResult): boolean {
	return result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted";
}

function getResultOutput(result: SingleResult): string {
	if (isFailedResult(result)) {
		return result.errorMessage || result.stderr || getFinalOutput(result.messages) || "(no output)";
	}
	return getFinalOutput(result.messages) || "(no output)";
}

function truncateParallelOutput(output: string): string {
	const byteLength = Buffer.byteLength(output, "utf8");
	if (byteLength <= PER_TASK_OUTPUT_CAP) return output;

	let truncated = output.slice(0, PER_TASK_OUTPUT_CAP);
	while (Buffer.byteLength(truncated, "utf8") > PER_TASK_OUTPUT_CAP) {
		truncated = truncated.slice(0, -1);
	}
	return `${truncated}\n\n[Output truncated: ${byteLength - Buffer.byteLength(truncated, "utf8")} bytes omitted. Full output preserved in tool details.]`;
}

type DisplayItem = { type: "text"; text: string } | { type: "toolCall"; name: string; args: Record<string, any> };

function getDisplayItems(messages: Message[]): DisplayItem[] {
	const items: DisplayItem[] = [];
	for (const msg of messages) {
		if (msg.role === "assistant") {
			for (const part of msg.content) {
				if (part.type === "text") items.push({ type: "text", text: part.text });
				else if (part.type === "toolCall") items.push({ type: "toolCall", name: part.name, args: part.arguments });
			}
		}
	}
	return items;
}

async function mapWithConcurrencyLimit<TIn, TOut>(
	items: TIn[],
	concurrency: number,
	fn: (item: TIn, index: number) => Promise<TOut>,
): Promise<TOut[]> {
	if (items.length === 0) return [];
	const limit = Math.max(1, Math.min(concurrency, items.length));
	const results: TOut[] = new Array(items.length);
	let nextIndex = 0;
	const workers = new Array(limit).fill(null).map(async () => {
		while (true) {
			const current = nextIndex++;
			if (current >= items.length) return;
			results[current] = await fn(items[current], current);
		}
	});
	await Promise.all(workers);
	return results;
}

async function writePromptToTempFile(agentName: string, prompt: string): Promise<{ dir: string; filePath: string }> {
	const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-"));
	const safeName = agentName.replace(/[^\w.-]+/g, "_");
	const filePath = path.join(tmpDir, `prompt-${safeName}.md`);
	await withFileMutationQueue(filePath, async () => {
		await fs.promises.writeFile(filePath, prompt, { encoding: "utf-8", mode: 0o600 });
	});
	return { dir: tmpDir, filePath };
}

function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
	if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}

	const execName = path.basename(process.execPath).toLowerCase();
	const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
	if (!isGenericRuntime) {
		return { command: process.execPath, args };
	}

	return { command: "pi", args };
}

/**
 * Resolve an agent's skill whitelist to concrete skill file paths.
 */
function resolveSkillPaths(
	agentSkills: string[],
	cwd: string,
): { paths: string[]; missing: string[]; available: string[] } {
	const result = loadSkills({
		cwd,
		agentDir: getAgentDir(),
		skillPaths: [],
		includeDefaults: true,
	});

	const byName = new Map<string, string>();
	for (const skill of result.skills) byName.set(skill.name, skill.filePath);
	const available = Array.from(byName.keys()).sort();

	const paths: string[] = [];
	const missing: string[] = [];
	const seen = new Set<string>();

	for (const entry of agentSkills) {
		const trimmed = entry.trim();
		if (!trimmed) continue;

		const looksLikePath = trimmed.includes(path.sep) || trimmed.startsWith(".") || trimmed.startsWith("~");
		let resolved: string | undefined;
		if (looksLikePath) {
			const expanded = trimmed.startsWith("~") ? path.join(os.homedir(), trimmed.slice(1)) : trimmed;
			const abs = path.isAbsolute(expanded) ? expanded : path.resolve(cwd, expanded);
			if (fs.existsSync(abs)) resolved = abs;
		} else {
			resolved = byName.get(trimmed);
		}

		if (!resolved) {
			missing.push(trimmed);
		} else if (!seen.has(resolved)) {
			seen.add(resolved);
			paths.push(resolved);
		}
	}

	return { paths, missing, available };
}

/**
 * Resolve an agent's tool configuration to a concrete tool list.
 */
function resolveTools(agent: AgentConfig, allToolNames: string[]): string[] {
	let resolved: string[];

	if (agent.tools) {
		resolved = [];
		for (const tool of agent.tools) {
			if (tool.endsWith("*")) {
				const prefix = tool.slice(0, -1);
				const matches = allToolNames.filter((t) => t.startsWith(prefix));
				resolved.push(...matches);
			} else {
				resolved.push(tool);
			}
		}
		resolved = [...new Set(resolved)];
	} else {
		resolved = [...allToolNames];
	}

	if (agent.toolsDeny && agent.toolsDeny.length > 0) {
		resolved = resolved.filter((t) => !agent.toolsDeny!.includes(t));
	}

	resolved = resolved.filter((t) => t !== "subagent");

	return resolved;
}

type OnUpdateCallback = (partial: AgentToolResult<SubagentDetails | SuspendedSnapshot>) => void;

/* -------------------------------------------------------------------------- */
/*                     Exception safety net (P3)                             */
/* -------------------------------------------------------------------------- */

/**
 * Settle state for a tool Promise. Lifted to a plain object so the
 * same flag is visible across every callback that closes over the
 * Promise's `resolve` (close, error, watchdog timer, abort handler,
 * data handlers). Any callback that wants to settle the Promise
 * MUST check `settled.done` before doing so and SET it before calling
 * `resolve` — otherwise a re-entrant close/error/event would
 * double-resolve.
 */
interface SettledState {
	done: boolean;
}

/**
 * Safely invoke a callback that may throw. If the callback throws,
 * settle the Promise with `errorValue()` and log the full stack
 * trace to stderr. This is the host-liveness safety net: any
 * unexpected failure inside a proc event handler, watchdog timer,
 * or arbiter helper must NOT crash the host pi process — the worst
 * case outcome is the tool call returns an error result.
 *
 * Idempotent: respects `settled.done`. If the Promise has already
 * settled, the call is a no-op (so a late proc event arriving after
 * we already settled can't overwrite the resolution).
 *
 * `errorValue` is evaluated lazily — it captures the current
 * closure state at the time of the throw, so the synthetic failure
 * result carries the most up-to-date `currentResult` / `partial`
 * instead of a stale snapshot.
 */
function safeSettle<T>(
	settled: SettledState,
	resolve: (value: T) => void,
	context: string,
	errorValue: () => T,
	body: () => void,
): void {
	if (settled.done) return;
	try {
		body();
	} catch (err) {
		if (settled.done) return;
		settled.done = true;
		const stack = err instanceof Error ? (err.stack ?? err.message) : String(err);
		console.error(`[subagent] ${context} threw: ${stack}`);
		try {
			resolve(errorValue());
		} catch (resolveErr) {
			const innerStack =
				resolveErr instanceof Error ? (resolveErr.stack ?? resolveErr.message) : String(resolveErr);
			console.error(
				`[subagent] resolve() in ${context} also threw: ${innerStack}\n` +
					`Original error: ${stack}`,
			);
		}
	}
}

/** Build a synthetic failed SingleResult from a partial result plus
 *  an error context. Used by error paths that catch an unexpected
 *  callback throw and need to produce an isError tool result that's
 *  still shape-compatible with the success path's SingleResult. */
function makeFailedSingleResult(
	base: SingleResult,
	errorMessage: string,
): SingleResult {
	return {
		...base,
		exitCode: -1,
		stopReason: "aborted",
		errorMessage,
	};
}

/** Build a synthetic abort result for the cold path of
 *  `runSingleAgent`. The base result is whatever messages had been
 *  collected so far; we mark it aborted and stamp the error. */
function makeColdAbortResult(currentResult: SingleResult, context: string): SingleResult {
	return makeFailedSingleResult(
		currentResult,
		`Subagent internal error (${context}); the sub-process was abandoned. See host stderr for the full stack trace.`,
	);
}

/* -------------------------------------------------------------------------- */
/*                     SingleResult <-> SingleResultLite                      */
/* -------------------------------------------------------------------------- */

function liteToSingle(lite: SingleResultLite): SingleResult {
	return {
		agent: lite.agent,
		agentSource: lite.agentSource,
		task: lite.task,
		exitCode: lite.exitCode,
		messages: lite.messages,
		stderr: lite.stderr,
		usage: lite.usage,
		model: lite.model,
		provider: lite.provider,
		stopReason: lite.stopReason,
		errorMessage: lite.errorMessage,
		step: lite.step,
	};
}

function singleToLite(r: SingleResult): SingleResultLite {
	return {
		agent: r.agent,
		agentSource: r.agentSource,
		task: r.task,
		exitCode: r.exitCode,
		messages: r.messages,
		stderr: r.stderr,
		usage: r.usage,
		model: r.model,
		provider: r.provider,
		stopReason: r.stopReason,
		errorMessage: r.errorMessage,
		step: r.step,
	};
}

/* -------------------------------------------------------------------------- */
/*                              runSingleAgent                                */
/* -------------------------------------------------------------------------- */

/**
 * Union returned from `runSingleAgent`. Either the process exited and
 * we have a normal transcript, OR the idle watchdog froze it and we
 * have a suspension id to refer back to.
 *
 * `suspended` means "tool call returns early with a snapshot; caller
 * must invoke `resume`/`kill`/`inspect` later to finish the job".
 */
type SingleRunOutcome =
	| { kind: "exit"; result: SingleResult }
	| { kind: "suspended"; id: SuspensionId; snapshot: SingleResult; lastEventAtMs: number };

async function runSingleAgent(
	defaultCwd: string,
	agents: AgentConfig[],
	agentName: string,
	task: string,
	cwd: string | undefined,
	step: number | undefined,
	signal: AbortSignal | undefined,
	onUpdate: OnUpdateCallback | undefined,
	makeDetails: (results: SingleResult[], suspensions?: SuspendedSnapshot["suspensions"]) => SubagentDetails | SuspendedSnapshot,
	allToolNames: string[],
	modelOverride: string | undefined,
	job: Job,
	stepNumber: number,
): Promise<SingleRunOutcome> {
	const agent = agents.find((a) => a.name === agentName);

	if (!agent) {
		const available = agents.map((a) => `"${a.name}"`).join(", ") || "none";
		const errResult: SingleResult = {
			agent: agentName,
			agentSource: "unknown",
			task,
			exitCode: 1,
			messages: [],
			stderr: `Unknown agent: "${agentName}". Available agents: ${available}.`,
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
			step,
		};
		return { kind: "exit", result: errResult };
	}

	const effectiveCwd = cwd ?? defaultCwd;
	const effectiveModel = modelOverride ?? agent.model;
	const idleTimeoutMs = resolveIdleTimeoutMs();

	const args: string[] = ["--mode", "json", "-p", "--no-session"];
	if (effectiveModel) args.push("--model", effectiveModel);
	const resolvedTools = resolveTools(agent, allToolNames);
	if (resolvedTools.length > 0) {
		args.push("--tools", resolvedTools.join(","));
	} else {
		args.push("--no-tools");
	}

	args.push("--no-skills");
	if (agent.skills && agent.skills.length > 0) {
		const { paths, missing, available } = resolveSkillPaths(agent.skills, effectiveCwd);
		if (missing.length > 0) {
			const avail = available.length > 0 ? available.join(", ") : "none";
			const errResult: SingleResult = {
				agent: agentName,
				agentSource: agent.source,
				task,
				exitCode: 1,
				messages: [],
				stderr: `Unknown skills for agent "${agentName}": ${missing.map((m) => `"${m}"`).join(", ")}. Available skills: ${avail}.`,
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
				step,
			};
			return { kind: "exit", result: errResult };
		}
		for (const p of paths) args.push("--skill", p);
	}

	let tmpPromptDir: string | null = null;
	let tmpPromptPath: string | null = null;

	const currentResult: SingleResult = {
		agent: agentName,
		agentSource: agent.source,
		task,
		exitCode: 0,
		messages: [],
		stderr: "",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
		model: effectiveModel,
		step,
	};
	// `provider` is set lazily when the first assistant message
	// arrives (see processLine below); the final ToolResult uses it
	// together with `model` to resolve `contextWindow` via
	// `getBuiltinModel(provider, model)`.

	const emitUpdate = () => {
		if (onUpdate) {
			onUpdate({
				content: [{ type: "text", text: getFinalOutput(currentResult.messages) || "(running...)" }],
				details: makeDetails([currentResult]),
			});
		}
	};

	try {
		// Build the per-spawn `--append-system-prompt` payload. We always
		// inject the bash-guard runtime note (so the child knows its bash
		// calls carry a default timeout) and append it after the agent's
		// own systemPrompt when one exists. We deliberately take the
		// minimal-invasive route here: instead of forking a separate
		// injection channel for the note, we reuse the existing
		// writePromptToTempFile helper. That means we now ALWAYS create a
		// tmp file when spawning (previously we only created one when the
		// agent had a non-empty systemPrompt) — the runtime note is
		// always non-empty, so the file is never empty. The cleanup logic
		// in the `finally` block below is unchanged: it removes the tmp
		// file / dir if either pointer is set, so this change does not
		// leak temp files.
		const trimmedSystemPrompt = agent.systemPrompt.trim();
		const promptContent = trimmedSystemPrompt
			? `${agent.systemPrompt}\n\n${SUBAGENT_BASH_GUARD_RUNTIME_NOTE}`
			: SUBAGENT_BASH_GUARD_RUNTIME_NOTE;
		const tmp = await writePromptToTempFile(agent.name, promptContent);
		tmpPromptDir = tmp.dir;
		tmpPromptPath = tmp.filePath;
		args.push("--append-system-prompt", tmpPromptPath);

		args.push(`Task: ${task}`);
		let wasAborted = false;

		let lastEventAtMs = Date.now();

		const outcome = await new Promise<SingleRunOutcome>((resolve) => {
			const invocation = getPiInvocation(args);
			const invocationStr = `${invocation.command} ${invocation.args.join(" ")}`;
			const proc = spawn(invocation.command, invocation.args, {
				cwd: effectiveCwd,
				shell: false,
				stdio: ["ignore", "pipe", "pipe"],
				detached: true,
			});
			let buffer = "";

			// P3 host-liveness safety net (see `safeSettle`): every
			// proc event handler, the watchdog timer, the abort
			// handler, and the resume / finalize paths must go
			// through `safeSettle` so an unexpected throw becomes
			// an isError result instead of crashing the host pi
			// process. The `settled` flag is the shared re-entrancy
			// guard for the Promise's `resolve`.
			const settled: SettledState = { done: false };

			const settleError = (context: string): SingleRunOutcome => ({
				kind: "exit",
				result: makeColdAbortResult(
					{ ...currentResult },
					`${context}: ${(() => {
						// The error string is captured by the
						// outer `safeSettle`; here we just craft a
						// generic message that points the user at
						// stderr. The actual stack trace is logged
						// separately by `safeSettle`.
						return "see host stderr for the original throw";
					})()}`,
				),
			});

			let suspended = false;
			let idleTimer: NodeJS.Timeout | null = null;
			const armWatchdog = () => {
				if (suspended) return;
				if (idleTimer) clearTimeout(idleTimer);
				idleTimer = setTimeout(() => {
					safeSettle<SingleRunOutcome>(
						settled,
						resolve,
						"cold watchdog timer",
						() => settleError("cold watchdog timer"),
						() => {
							idleTimer = null;
							if (proc.exitCode !== null) {
								disarmWatchdog();
								return;
							}
							const frozen = freezeProcessGroup(proc);
							if (!frozen) {
								currentResult.exitCode = -1;
								currentResult.stopReason = "aborted";
								wasAborted = true;
								killProcessGroup(proc);
								settled.done = true;
								resolve({ kind: "exit", result: { ...currentResult } });
								return;
							}

							const suspendedAtMs = Date.now();
							const id = newSuspensionId();
							const inFlight: InFlightToolCall | null = extractInFlight(currentResult.messages);
							const partialLite: SingleResultLite = {
								...currentResult,
								step: stepNumber,
							};
							const suspension: Suspension = {
								id,
								proc,
								inFlight,
								messages: currentResult.messages,
								stderr: currentResult.stderr,
								invocation: invocationStr,
								job,
								partialResult: partialLite,
								lastEventAtMs,
								originalSignal: signal,
								activeAbortHandler: abortHandler,
								cancelled: false,
							};
							detachAbortListener(signal, abortHandler);
							suspended = true;
							suspension.activeAbortHandler = null;
							registerSuspension(suspension);
							const snapshotResult: SingleResult = {
								...currentResult,
								step: stepNumber,
							};
							settled.done = true;
							resolve({
								kind: "suspended",
								id,
								snapshot: snapshotResult,
								lastEventAtMs,
							});
							void suspendedAtMs;
						},
					);
				}, idleTimeoutMs);
			};

			const disarmWatchdog = () => {
				if (idleTimer) {
					clearTimeout(idleTimer);
					idleTimer = null;
				}
			};

			const processLine = (line: string) => {
				if (!line.trim()) return;
				let event: any;
				try {
					event = JSON.parse(line);
				} catch {
					return;
				}

				if (event.type === "message_end" && event.message) {
					const msg = event.message as Message;
					currentResult.messages.push(msg);

					if (msg.role === "assistant") {
						currentResult.usage.turns++;
						const usage = msg.usage;
						if (usage) {
							currentResult.usage.input += usage.input || 0;
							currentResult.usage.output += usage.output || 0;
							currentResult.usage.cacheRead += usage.cacheRead || 0;
							currentResult.usage.cacheWrite += usage.cacheWrite || 0;
							currentResult.usage.cost += usage.cost?.total || 0;
							currentResult.usage.contextTokens = usage.totalTokens || 0;
						}
						if (!currentResult.model && msg.model) currentResult.model = msg.model;
						if (!currentResult.provider && msg.provider) currentResult.provider = msg.provider;
						if (msg.stopReason) currentResult.stopReason = msg.stopReason;
						if (msg.errorMessage) currentResult.errorMessage = msg.errorMessage;
					}
					emitUpdate();
				}

				if (event.type === "tool_result_end" && event.message) {
					currentResult.messages.push(event.message as Message);
					emitUpdate();
				}
			};

			proc.stdout.on("data", (data) => {
				safeSettle<SingleRunOutcome>(
					settled,
					resolve,
					"cold stdout data handler",
					() => settleError("cold stdout data handler"),
					() => {
						if (settled.done) return;
						if (suspended) return;
						lastEventAtMs = Date.now();
						armWatchdog();
						buffer += data.toString();
						const lines = buffer.split("\n");
						buffer = lines.pop() || "";
						for (const line of lines) processLine(line);
					},
				);
			});

			proc.stderr.on("data", (data) => {
				safeSettle<SingleRunOutcome>(
					settled,
					resolve,
					"cold stderr data handler",
					() => settleError("cold stderr data handler"),
					() => {
						if (settled.done) return;
						if (suspended) return;
						lastEventAtMs = Date.now();
						armWatchdog();
						currentResult.stderr += data.toString();
					},
				);
			});

			proc.on("close", (code, signal) => {
				safeSettle<SingleRunOutcome>(
					settled,
					resolve,
					"cold close handler",
					() => settleError("cold close handler"),
					() => {
						if (settled.done) return;
						if (suspended) return;
						disarmWatchdog();
						if (buffer.trim()) processLine(buffer);
						if (code === null) {
							currentResult.exitCode = -1;
							currentResult.stopReason = currentResult.stopReason ?? "aborted";
							currentResult.errorMessage = currentResult.errorMessage ??
								(signal ? `Process terminated by signal ${signal}` : "Process terminated by signal");
						} else {
							currentResult.exitCode = code;
						}
						settled.done = true;
						resolve({ kind: "exit", result: { ...currentResult } });
					},
				);
			});

			proc.on("error", (err) => {
				safeSettle<SingleRunOutcome>(
					settled,
					resolve,
					"cold error handler",
					() => settleError("cold error handler"),
					() => {
						if (settled.done) return;
						if (suspended) return;
						disarmWatchdog();
						currentResult.exitCode = 1;
						if (!currentResult.stopReason) currentResult.stopReason = "error";
						if (!currentResult.errorMessage) {
							currentResult.errorMessage = err ? (err as Error).message : "Child process errored";
						}
						settled.done = true;
						resolve({ kind: "exit", result: { ...currentResult } });
					},
				);
			});

			const abortHandler = (() => {
				const h = () => {
					safeSettle<SingleRunOutcome>(
						settled,
						resolve,
						"cold abort handler",
						() => settleError("cold abort handler"),
						() => {
							if (settled.done) return;
							if (proc.exitCode !== null) return;
							if (suspended) return;
							wasAborted = true;
							// Polite SIGTERM: walk the ppid tree first so
							// `setsid` grand-children in their own pgid
							// receive the polite shutdown too. Group-level
							// SIGTERM alone would orphan them. The 5s
							// SIGKILL fallback uses `killProcessGroup`
							// which already walks the tree.
							if (proc.pid) {
								signalDescendants(proc, "SIGTERM");
								try {
									process.kill(-proc.pid, "SIGTERM");
								} catch {
									/* swallow */
								}
							}
							setTimeout(() => {
								if (proc.exitCode === null && proc.signalCode === null) killProcessGroup(proc);
							}, 5000);
						},
					);
				};
				return h;
			})();
			if (signal) {
				if (signal.aborted) abortHandler();
				else signal.addEventListener("abort", abortHandler, { once: true });
			}

			armWatchdog();
		});

		if (outcome.kind === "exit") {
			if (wasAborted && outcome.result.stopReason !== "aborted") {
				outcome.result.stopReason = "aborted";
			}
			return outcome;
		}
		return outcome;
	} finally {
		if (tmpPromptPath)
			try {
				fs.unlinkSync(tmpPromptPath);
			} catch {
				/* ignore */
			}
		if (tmpPromptDir)
			try {
				fs.rmdirSync(tmpPromptDir);
			} catch {
				/* ignore */
			}
	}
}

const TaskItem = Type.Object({
	agent: Type.String({ description: "Name of the agent to invoke" }),
	task: Type.String({ description: "Task to delegate to the agent" }),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
	model: Type.Optional(Type.String({ description: "Override the agent's frontmatter model for this task" })),
});

const ChainItem = Type.Object({
	agent: Type.String({ description: "Name of the agent to invoke" }),
	task: Type.String({ description: "Task with optional {previous} placeholder for prior output" }),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
	model: Type.Optional(Type.String({ description: "Override the agent's frontmatter model for this step" })),
});

const AgentScopeSchema = StringEnum(["user", "project", "both"] as const, {
	description: 'Which agent directories to use. Default: "both" (user + project).',
	default: "both",
});

const InspectParams = Type.Object({
	id: Type.String({ description: "Suspension id to inspect" }),
	lines: Type.Optional(Type.Number({ description: `Number of tail lines to return (default ${DEFAULT_INSPECT_LINES})`, default: DEFAULT_INSPECT_LINES })),
});

/**
 * Read-only query parameters for the `transcript` mode.
 *
 * `transcript` reads the host session's persistent jsonl (via the
 * `PI_SESSION_FILE` env var) and renders the last N work steps of a
 * previously-completed subagent invocation. It does NOT spawn, resume,
 * or kill any process — purely diagnostic, useful when an interrupt
 * (Esc / kill / suspended-then-failed) happened in a prior turn and
 * the LLM only got a one-line summary back.
 *
 * Filtering
 * ---------
 * - `only: "interrupted"` (default) — picks results where any result
 *   in the entry satisfies `exitCode !== 0 || stopReason !== "stop"
 *   || suspensions.length > 0`. This is the default because the use
 *   case for transcript is "I aborted a subagent; show me what it
 *   was doing before I killed it."
 * - `only: "all"` — no filter; pick by `agent` / `index`.
 *
 * Indexing
 * --------
 * - `index: 0` (default) — the most recent match.
 * - `index: 1` — the second-most-recent match. And so on.
 *
 * The matcher walks the jsonl in chronological order and keeps only
 * the matching entries; the index picks the n-th from the END (so
 * `index: 0` is the LAST match, `index: 1` the one before it).
 */
const TranscriptParams = Type.Object({
	lines: Type.Optional(
		Type.Number({
			description: `Number of trailing work steps to render (default ${DEFAULT_TRANSCRIPT_LINES}, max ${MAX_TRANSCRIPT_LINES})`,
			default: DEFAULT_TRANSCRIPT_LINES,
		}),
	),
	agent: Type.Optional(Type.String({ description: "Filter by agent name (matches the agent field of any result in the entry)" })),
	index: Type.Optional(
		Type.Number({
			description: "Which match to inspect (0 = most recent, default 0). 1 = second-most-recent, etc.",
			default: 0,
		}),
	),
	only: Type.Optional(
		StringEnum(["interrupted", "all"] as const, {
			description: "Filter set. 'interrupted' (default) selects entries that exited non-zero or have any non-stop stopReason or any suspensions. 'all' selects every subagent toolResult.",
			default: "interrupted",
		}),
	),
});

const SubagentParams = Type.Object({
	agent: Type.Optional(Type.String({ description: "Name of the agent to invoke (for single mode)" })),
	task: Type.Optional(Type.String({ description: "Task to delegate (for single mode)" })),
	tasks: Type.Optional(Type.Array(TaskItem, { description: "Array of {agent, task} for parallel execution" })),
	chain: Type.Optional(Type.Array(ChainItem, { description: "Array of {agent, task} for sequential execution" })),
	agentScope: Type.Optional(AgentScopeSchema),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process (single mode)" })),
	model: Type.Optional(Type.String({ description: "Override the agent's frontmatter model. Used directly in single mode; acts as the default for parallel/chain tasks that don't set their own `model`" })),
	resume: Type.Optional(Type.String({ description: "Suspension id to resume — thaws the frozen process group and continues collecting events" })),
	kill: Type.Optional(Type.String({ description: "Suspension id to kill — thaws the frozen process group, SIGKILLs it, returns the partial transcript" })),
	inspect: Type.Optional(InspectParams),
	transcript: Type.Optional(
		TranscriptParams,
	),
});

/* -------------------------------------------------------------------------- */
/*                              Tool description                               */
/* -------------------------------------------------------------------------- */

/** Effective default timeout applied to every bash call by the
 *  bash-guard extension when no `timeout` parameter is passed. Resolved
 *  once at module load so both the tool description and the per-spawn
 *  runtime note agree, and so the BASH_GUARD_DEFAULT_TIMEOUT_S env
 *  override is honored by both. Kept as a module-level `const` (not a
 *  getter) so SUBAGENT_DESCRIPTION is evaluated eagerly and the runtime
 *  note below is a plain string template. */
const SUBAGENT_DEFAULT_BASH_TIMEOUT_S = resolveDefaultTimeoutS();

/**
 * Factual note appended to the child's `--append-system-prompt` file so
 * the sub-agent knows up front that bash calls carry a default timeout.
 *
 * Coupled with `bash-guard` (../bash-guard/index.ts): both sides call
 * `resolveDefaultTimeoutS()` at module load so the value stays in lock
 * step with the BASH_GUARD_DEFAULT_TIMEOUT_S env override. If you tweak
 * the wording here, mirror the rationale in bash-guard's tool_result
 * hint — they are the same fact at two layers (pre-declaration vs.
 * post-mortem teaching).
 */
const SUBAGENT_BASH_GUARD_RUNTIME_NOTE =
	`Runtime note: the bash tool enforces a default timeout of ${SUBAGENT_DEFAULT_BASH_TIMEOUT_S} seconds when no "timeout" parameter is passed. For long-running commands (builds, test suites), pass an explicit "timeout" in seconds.`;

const SUBAGENT_DESCRIPTION = [
	"Delegate tasks to specialized subagents with isolated context.",
	"Modes: single (agent + task), parallel (tasks array), chain (sequential with {previous} placeholder).",
	`Loads agents from both ${path.join(getAgentDir(), "agents")} (user) and ${CONFIG_DIR_NAME}/agents (project). Project agents load without a confirmation prompt.`,
	"A `model` passed at runtime overrides the agent's frontmatter model (frontmatter is only the default). Top-level `model` applies in single mode and is the default for parallel/chain; per-item `model` overrides per-task.",
	"",
	"Idle arbitration protocol: a sub-process that produces no stdout/stderr for ~10 minutes is frozen via SIGSTOP (whole process group, including its bash subprocesses) and the tool call returns a snapshot with `status:\"idle_suspended\"`. To finish the job, call this tool again with one of three mutually-exclusive parameters:",
	"  - `resume: <suspensionId>` — thaw the process group, re-arm the watchdog, and continue collecting events until the process exits; returns the final transcript.",
	"  - `kill:   <suspensionId>` — thaw then SIGKILL the whole process group; returns the partial transcript as a failed result.",
	"  - `inspect: { id: <suspensionId>, lines?: number }` — return more tail lines of the frozen process without touching it.",
	"The snapshot exposes `suspensionId`, `idleMs`, `runningCommand` (the in-flight bash command, if any), `requestedTimeout` (the timeout the agent asked for), and a `tail` array of recent events.",
	"`resume` / `kill` / `inspect` cannot be combined with `agent` / `task` / `tasks` / `chain`; pick exactly one mode per call.",
	"",
	"Post-mortem transcript (read-only): when a subagent was interrupted (Esc abort / kill / suspended-then-failed) in a prior turn and the host returned only a one-line summary, call this tool with `transcript` to render the last N work steps of that subagent straight from the host session's persistent jsonl. Pure read — no process is touched, no registry mutation. Schema: `transcript: { lines?: number = 10 (max 50), agent?: string, index?: number = 0 (0 = most recent), only?: \"interrupted\" | \"all\" = \"interrupted\" }`. Use it after `kill` / abort to see what the agent was doing before it died.",
	"`transcript` cannot be combined with `agent` / `task` / `tasks` / `chain` / `resume` / `kill` / `inspect`; pick exactly one mode per call. Requires the host session to have a persistent file (env var `PI_SESSION_FILE` must be set); ephemeral sessions (e.g. `--no-session`) have no on-disk history to read.",
	`Sub-agent bash calls carry a ${SUBAGENT_DEFAULT_BASH_TIMEOUT_S}s default timeout (bash-guard); when delegating long-running commands, instruct the agent to pass an explicit "timeout".`,
].join(" ");

/* -------------------------------------------------------------------------- */
/*                              Arbitration helpers                           */
/* -------------------------------------------------------------------------- */

function buildSuspendedSnapshot(
	mode: "single" | "parallel" | "chain",
	suspensions: Array<{
		suspensionId: string;
		snapshot: SingleResult;
		lastEventAtMs: number;
	}>,
): SuspendedSnapshot["suspensions"] {
	const now = Date.now();
	return suspensions.map((s) => {
		const inFlight = extractInFlight(s.snapshot.messages);
		return {
			suspensionId: s.suspensionId,
			idleMs: now - s.lastEventAtMs,
			runningCommand: inFlight?.command ?? null,
			requestedTimeout: inFlight?.timeout ?? null,
			tail: summarizeTail(s.snapshot.messages, s.snapshot.stderr, DEFAULT_TAIL_LINES),
		};
	});
}

/* -------------------------------------------------------------------------- */
/*                                  Tool                                      */
/* -------------------------------------------------------------------------- */

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "subagent",
		label: "Subagent",
		description: SUBAGENT_DESCRIPTION,
		parameters: SubagentParams,

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const agentScope: AgentScope = params.agentScope ?? "both";
			const discovery = discoverAgents(ctx.cwd, agentScope);
			const agents = discovery.agents;
			const allToolNames = pi.getAllTools().map((t) => t.name);

			const hasChain = (params.chain?.length ?? 0) > 0;
			const hasTasks = (params.tasks?.length ?? 0) > 0;
			const hasSingle = Boolean(params.agent && params.task);
			const hasResume = typeof params.resume === "string";
			const hasKill = typeof params.kill === "string";
			const hasInspect = params.inspect !== undefined;
			const hasTranscript = params.transcript !== undefined;
			const arbitrationCount = Number(hasResume) + Number(hasKill) + Number(hasInspect);
			const modeCount = Number(hasChain) + Number(hasTasks) + Number(hasSingle) + Number(hasTranscript);

			const available = agents.map((a) => `${a.name} (${a.source})`).join(", ") || "none";
			const makeDetails =
				(mode: "single" | "parallel" | "chain", suspensions?: SuspendedSnapshot["suspensions"]) =>
				(results: SingleResult[]): SubagentDetails | SuspendedSnapshot => {
					return {
						mode,
						agentScope,
						projectAgentsDir: discovery.projectAgentsDir,
						results,
						suspensions: suspensions ?? [],
					};
				};

			if (arbitrationCount > 1) {
				return {
					content: [
						{
							type: "text",
							text: "Invalid parameters: `resume`, `kill`, and `inspect` are mutually exclusive. Pick exactly one.",
						},
					],
					details: makeDetails("single")([]),
				};
			}
			if (arbitrationCount === 1 && modeCount > 0) {
				return {
					content: [
						{
							type: "text",
							text: "Invalid parameters: arbitration parameters (`resume`/`kill`/`inspect`) cannot be combined with execution modes (`agent`/`task`/`tasks`/`chain`/`transcript`).",
						},
					],
					details: makeDetails("single")([]),
				};
			}
			if (hasTranscript && modeCount > 1) {
				return {
					content: [
						{
							type: "text",
							text: "Invalid parameters: `transcript` (read-only post-mortem) cannot be combined with execution modes (`agent`/`task`/`tasks`/`chain`).",
						},
					],
					details: makeDetails("single")([]),
				};
			}

			if (hasResume) return handleResume(params.resume as string, signal, onUpdate, ctx, agents, allToolNames, agentScope, discovery, makeDetails, params.model);
			if (hasKill) return handleKill(params.kill as string, ctx, makeDetails);
			if (hasInspect) return handleInspect(params.inspect!, ctx, makeDetails);
			if (hasTranscript) return handleTranscript(params.transcript!, makeDetails);

			if (modeCount !== 1) {
				return {
					content: [
						{
							type: "text",
							text: `Invalid parameters. Provide exactly one mode.\nAvailable agents: ${available}`,
						},
					],
					details: makeDetails("single")([]),
				};
			}

			if (params.chain && params.chain.length > 0) {
				return runChain(params.chain, ctx, signal, onUpdate, agents, allToolNames, agentScope, discovery, makeDetails, params.model);
			}

			if (params.tasks && params.tasks.length > 0) {
				return runParallel(params.tasks, ctx, signal, onUpdate, agents, allToolNames, agentScope, discovery, makeDetails, params.model);
			}

			if (params.agent && params.task) {
				return runSingle(params.agent, params.task, params.cwd, ctx, signal, onUpdate, agents, allToolNames, agentScope, discovery, makeDetails, params.model);
			}

			return {
				content: [{ type: "text", text: `Invalid parameters. Available agents: ${available}` }],
				details: makeDetails("single")([]),
			};
		},

		renderCall(args, theme, _context) {
			const scope: AgentScope = args.agentScope ?? "both";
			if (args.resume) {
				return new Text(
					theme.fg("toolTitle", theme.bold("subagent ")) +
						theme.fg("accent", `resume`) +
						theme.fg("muted", ` ${args.resume}`),
					0,
					0,
				);
			}
			if (args.kill) {
				return new Text(
					theme.fg("toolTitle", theme.bold("subagent ")) +
						theme.fg("accent", `kill`) +
						theme.fg("muted", ` ${args.kill}`),
					0,
					0,
				);
			}
			if (args.inspect) {
				const lines = args.inspect.lines ?? DEFAULT_INSPECT_LINES;
				return new Text(
					theme.fg("toolTitle", theme.bold("subagent ")) +
						theme.fg("accent", `inspect`) +
						theme.fg("muted", ` ${args.inspect.id} (${lines} lines)`),
					0,
					0,
				);
			}
			if (args.transcript) {
				const lines = args.transcript.lines ?? DEFAULT_TRANSCRIPT_LINES;
				const only = args.transcript.only ?? "interrupted";
				const agent = args.transcript.agent ? ` agent=${args.transcript.agent}` : "";
				const index = args.transcript.index ? ` idx=${args.transcript.index}` : "";
				return new Text(
					theme.fg("toolTitle", theme.bold("subagent ")) +
						theme.fg("accent", `transcript`) +
						theme.fg("muted", ` only=${only} lines=${lines}${agent}${index}`),
					0,
					0,
				);
			}
			if (args.chain && args.chain.length > 0) {
				let text =
					theme.fg("toolTitle", theme.bold("subagent ")) +
					theme.fg("accent", `chain (${args.chain.length} steps)`) +
					theme.fg("muted", ` [${scope}]`);
				for (let i = 0; i < Math.min(args.chain.length, 3); i++) {
					const step = args.chain[i];
					const cleanTask = step.task.replace(/\{previous\}/g, "").trim();
					const preview = cleanTask.length > 40 ? `${cleanTask.slice(0, 40)}...` : cleanTask;
					text +=
						"\n  " +
						theme.fg("muted", `${i + 1}.`) +
						" " +
						theme.fg("accent", step.agent) +
						theme.fg("dim", ` ${preview}`);
				}
				if (args.chain.length > 3) text += `\n  ${theme.fg("muted", `... +${args.chain.length - 3} more`)}`;
				return new Text(text, 0, 0);
			}
			if (args.tasks && args.tasks.length > 0) {
				let text =
					theme.fg("toolTitle", theme.bold("subagent ")) +
					theme.fg("accent", `parallel (${args.tasks.length} tasks)`) +
					theme.fg("muted", ` [${scope}]`);
				for (const t of args.tasks.slice(0, 3)) {
					const preview = t.task.length > 40 ? `${t.task.slice(0, 40)}...` : t.task;
					text += `\n  ${theme.fg("accent", t.agent)}${theme.fg("dim", ` ${preview}`)}`;
				}
				if (args.tasks.length > 3) text += `\n  ${theme.fg("muted", `... +${args.tasks.length - 3} more`)}`;
				return new Text(text, 0, 0);
			}
			const agentName = args.agent || "...";
			const preview = args.task ? (args.task.length > 60 ? `${args.task.slice(0, 60)}...` : args.task) : "...";
			let text =
				theme.fg("toolTitle", theme.bold("subagent ")) +
				theme.fg("accent", agentName) +
				theme.fg("muted", ` [${scope}]`);
			text += `\n  ${theme.fg("dim", preview)}`;
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded }, theme, _context) {
			const details = result.details as SubagentDetails | SuspendedSnapshot | undefined;
			if (
				!details ||
				(details.results.length === 0 && (details.suspensions?.length ?? 0) === 0)
			) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
			}
			const suspensions = details.suspensions ?? [];

			const mdTheme = getMarkdownTheme();

			const renderDisplayItems = (items: DisplayItem[], limit?: number) => {
				const toShow = limit ? items.slice(-limit) : items;
				const skipped = limit && items.length > limit ? items.length - limit : 0;
				let text = "";
				if (skipped > 0) text += theme.fg("muted", `... ${skipped} earlier items\n`);
				for (const item of toShow) {
					if (item.type === "text") {
						const preview = expanded ? item.text : item.text.split("\n").slice(0, 3).join("\n");
						text += `${theme.fg("toolOutput", preview)}\n`;
					} else {
						text += `${theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme))}\n`;
					}
				}
				return text.trimEnd();
			};

			if (suspensions.length > 0) {
				if (details.mode === "single" && details.results.length <= 1) {
					const r = details.results[0] ?? null;
					const susp = suspensions[0]!;
					const icon = theme.fg("warning", "⏸");
					const header = `${icon} ${theme.fg("toolTitle", theme.bold(r?.agent ?? "subagent"))} ${theme.fg("warning", "[idle_suspended]")}`;
					let text = header;
					text += `\n${theme.fg("muted", `suspensionId: ${susp.suspensionId}`)}`;
					text += `\n${theme.fg("muted", `idleMs: ${susp.idleMs}`)}`;
					text += `\n${theme.fg("muted", `runningCommand: ${susp.runningCommand ?? "(none)"}`)}`;
					if (susp.requestedTimeout !== null) text += `\n${theme.fg("muted", `requestedTimeout: ${susp.requestedTimeout}s`)}`;
					text += `\n${theme.fg("muted", "─── tail ───")}`;
					for (const e of susp.tail) {
						const prefix =
							e.kind === "assistant_text"
								? "text"
								: e.kind === "assistant_tool_call"
									? "tool"
									: e.kind === "stderr"
										? "stderr"
										: "result";
						text += `\n${theme.fg("dim", `[${prefix}] `)}${theme.fg("toolOutput", e.summary)}`;
					}
					text += `\n${theme.fg("muted", "(resume/kill/inspect with the suspensionId to proceed)")}`;
					return new Text(text, 0, 0);
				}

				let text = `${theme.fg("warning", "⏸")} ${theme.fg("toolTitle", theme.bold(`${details.mode} suspended`))}`;
				for (let i = 0; i < suspensions.length; i++) {
					const susp = suspensions[i]!;
					text += `\n\n${theme.fg("muted", `─── suspension ${i + 1} ───`)}`;
					text += `\n${theme.fg("muted", `id: ${susp.suspensionId}`)}`;
					text += `\n${theme.fg("muted", `idleMs: ${susp.idleMs}`)}`;
					text += `\n${theme.fg("muted", `runningCommand: ${susp.runningCommand ?? "(none)"}`)}`;
					for (const e of susp.tail) {
						const prefix =
							e.kind === "assistant_text"
								? "text"
								: e.kind === "assistant_tool_call"
									? "tool"
									: e.kind === "stderr"
										? "stderr"
										: "result";
						text += `\n${theme.fg("dim", `[${prefix}] `)}${theme.fg("toolOutput", e.summary)}`;
					}
				}
				return new Text(text, 0, 0);
			}

			if (details.mode === "single" && details.results.length === 1) {
				const r = details.results[0];
				const isError = isFailedResult(r);
				const icon = isError ? theme.fg("error", "✗") : theme.fg("success", "✓");
				const displayItems = getDisplayItems(r.messages);

				if (expanded) {
					const container = new Container();
					let header = `${icon} ${theme.fg("toolTitle", theme.bold(r.agent))}${theme.fg("muted", ` (${r.agentSource})`)}`;
					if (isError && r.stopReason) header += ` ${theme.fg("error", `[${r.stopReason}]`)}`;
					container.addChild(new Text(header, 0, 0));
					if (isError && r.errorMessage)
						container.addChild(new Text(theme.fg("error", `Error: ${r.errorMessage}`), 0, 0));
					container.addChild(new Spacer(1));
					container.addChild(new Text(theme.fg("muted", "─── Task ───"), 0, 0));
					container.addChild(new Text(theme.fg("dim", r.task), 0, 0));
					container.addChild(new Spacer(1));
					container.addChild(new Text(theme.fg("muted", "─── Output ───"), 0, 0));
					if (displayItems.length === 0) {
						container.addChild(new Text(theme.fg("muted", "(no output)"), 0, 0));
					} else {
						for (const item of displayItems) {
							if (item.type === "text") {
								if (item.text.trim()) {
									container.addChild(new Spacer(1));
									container.addChild(new Markdown(item.text.trim(), 0, 0, mdTheme));
								}
							} else {
								container.addChild(
									new Text(
										theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme)),
										0,
										0,
									),
								);
							}
						}
					}
					const usageStr = formatUsageStats(r.usage, r.model);
					if (usageStr) {
						container.addChild(new Spacer(1));
						container.addChild(new Text(theme.fg("dim", usageStr), 0, 0));
					}
					return container;
				}

				let text = `${icon} ${theme.fg("toolTitle", theme.bold(r.agent))}${theme.fg("muted", ` (${r.agentSource})`)}`;
				if (isError && r.stopReason) text += ` ${theme.fg("error", `[${r.stopReason}]`)}`;
				if (isError && r.errorMessage) text += `\n${theme.fg("error", `Error: ${r.errorMessage}`)}`;
				else if (displayItems.length === 0) text += `\n${theme.fg("muted", "(no output)")}`;
				else {
					text += `\n${renderDisplayItems(displayItems, COLLAPSED_ITEM_COUNT)}`;
					if (displayItems.length > COLLAPSED_ITEM_COUNT) text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
				}
				const usageStr = formatUsageStats(r.usage, r.model);
				if (usageStr) text += `\n${theme.fg("dim", usageStr)}`;
				return new Text(text, 0, 0);
			}

			const aggregateUsage = (results: SingleResult[]) => {
				const total = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
				for (const r of results) {
					total.input += r.usage.input;
					total.output += r.usage.output;
					total.cacheRead += r.usage.cacheRead;
					total.cacheWrite += r.usage.cacheWrite;
					total.cost += r.usage.cost;
					total.turns += r.usage.turns;
				}
				return total;
			};

			if (details.mode === "chain") {
				const successCount = details.results.filter((r) => r.exitCode === 0).length;
				const icon = successCount === details.results.length ? theme.fg("success", "✓") : theme.fg("error", "✗");

				if (expanded) {
					const container = new Container();
					container.addChild(
						new Text(
							icon +
								" " +
								theme.fg("toolTitle", theme.bold("chain ")) +
								theme.fg("accent", `${successCount}/${details.results.length} steps`),
							0,
							0,
						),
					);

					for (const r of details.results) {
						const rIcon = r.exitCode === 0 ? theme.fg("success", "✓") : theme.fg("error", "✗");
						const displayItems = getDisplayItems(r.messages);

						container.addChild(new Spacer(1));
						container.addChild(
							new Text(
								`${theme.fg("muted", `─── Step ${r.step}: `) + theme.fg("accent", r.agent)} ${rIcon}`,
								0,
								0,
							),
						);
						container.addChild(new Text(theme.fg("muted", "Task: ") + theme.fg("dim", r.task), 0, 0));

						for (const item of displayItems) {
							if (item.type === "text") {
								if (item.text.trim()) {
									container.addChild(new Spacer(1));
									container.addChild(new Markdown(item.text.trim(), 0, 0, mdTheme));
								}
							} else {
								container.addChild(
									new Text(
										theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme)),
										0,
										0,
									),
								);
							}
						}

						const stepUsage = formatUsageStats(r.usage, r.model);
						if (stepUsage) container.addChild(new Text(theme.fg("dim", stepUsage), 0, 0));
					}

					const usageStr = formatUsageStats(aggregateUsage(details.results));
					if (usageStr) {
						container.addChild(new Spacer(1));
						container.addChild(new Text(theme.fg("dim", `Total: ${usageStr}`), 0, 0));
					}
					return container;
				}

				let text =
					icon +
					" " +
					theme.fg("toolTitle", theme.bold("chain ")) +
					theme.fg("accent", `${successCount}/${details.results.length} steps`);
				for (const r of details.results) {
					const rIcon = r.exitCode === 0 ? theme.fg("success", "✓") : theme.fg("error", "✗");
					const displayItems = getDisplayItems(r.messages);
					text += `\n\n${theme.fg("muted", `─── Step ${r.step}: `)}${theme.fg("accent", r.agent)} ${rIcon}`;
					if (displayItems.length === 0) text += `\n${theme.fg("muted", "(no output)")}`;
					else text += `\n${renderDisplayItems(displayItems, 5)}`;
				}
				const usageStr = formatUsageStats(aggregateUsage(details.results));
				if (usageStr) text += `\n\n${theme.fg("dim", `Total: ${usageStr}`)}`;
				text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
				return new Text(text, 0, 0);
			}

			if (details.mode === "parallel") {
				const running = details.results.filter((r) => r.exitCode === -1).length;
				const successCount = details.results.filter((r) => r.exitCode !== -1 && !isFailedResult(r)).length;
				const failCount = details.results.filter((r) => r.exitCode !== -1 && isFailedResult(r)).length;
				const isRunning = running > 0;
				const icon = isRunning
					? theme.fg("warning", "⏳")
					: failCount > 0
						? theme.fg("warning", "◐")
						: theme.fg("success", "✓");
				const status = isRunning
					? `${successCount + failCount}/${details.results.length} done, ${running} running`
					: `${successCount}/${details.results.length} tasks`;

				if (expanded && !isRunning) {
					const container = new Container();
					container.addChild(
						new Text(
							`${icon} ${theme.fg("toolTitle", theme.bold("parallel "))}${theme.fg("accent", status)}`,
							0,
							0,
						),
					);

					for (const r of details.results) {
						const rIcon = isFailedResult(r) ? theme.fg("error", "✗") : theme.fg("success", "✓");
						const displayItems = getDisplayItems(r.messages);

						container.addChild(new Spacer(1));
						container.addChild(
							new Text(`${theme.fg("muted", "─── ") + theme.fg("accent", r.agent)} ${rIcon}`, 0, 0),
						);
						container.addChild(new Text(theme.fg("muted", "Task: ") + theme.fg("dim", r.task), 0, 0));

						for (const item of displayItems) {
							if (item.type === "text") {
								if (item.text.trim()) {
									container.addChild(new Spacer(1));
									container.addChild(new Markdown(item.text.trim(), 0, 0, mdTheme));
								}
							} else {
								container.addChild(
									new Text(
										theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme)),
										0,
										0,
									),
								);
							}
						}

						const taskUsage = formatUsageStats(r.usage, r.model);
						if (taskUsage) container.addChild(new Text(theme.fg("dim", taskUsage), 0, 0));
					}

					const usageStr = formatUsageStats(aggregateUsage(details.results));
					if (usageStr) {
						container.addChild(new Spacer(1));
						container.addChild(new Text(theme.fg("dim", `Total: ${usageStr}`), 0, 0));
					}
					return container;
				}

				let text = `${icon} ${theme.fg("toolTitle", theme.bold("parallel "))}${theme.fg("accent", status)}`;
				for (const r of details.results) {
					const rIcon =
						r.exitCode === -1
							? theme.fg("warning", "⏳")
							: isFailedResult(r)
								? theme.fg("error", "✗")
								: theme.fg("success", "✓");
					const displayItems = getDisplayItems(r.messages);
					text += `\n\n${theme.fg("muted", "─── ")}${theme.fg("accent", r.agent)} ${rIcon}`;
					if (displayItems.length === 0)
						text += `\n${theme.fg("muted", r.exitCode === -1 ? "(running...)" : "(no output)")}`;
					else text += `\n${renderDisplayItems(displayItems, 5)}`;
				}
				if (!isRunning) {
					const usageStr = formatUsageStats(aggregateUsage(details.results));
					if (usageStr) text += `\n\n${theme.fg("dim", `Total: ${usageStr}`)}`;
				}
				if (!expanded) text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
				return new Text(text, 0, 0);
			}

			const text = result.content[0];
			return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
		},
	});
}

/* -------------------------------------------------------------------------- */
/*                       Transcript (read-only post-mortem)                   */
/* -------------------------------------------------------------------------- */

/**
 * One subagent toolResult entry as parsed from a host session's
 * persistent jsonl file. Shape mirrors the `details` payload that
 * the tool itself returns — same `results` / `suspensions` keys,
 * same `mode`. We keep `lineNumber` for debugging / error messages
 * (e.g. "Found 3 matching entries in <file> at lines 412, 891, 1520")
 * and `timestamp` for chronological ordering / filtering if needed.
 *
 * `results` and `suspensions` are taken straight from the entry's
 * `details` — they share the SingleResult / SuspendedSnapshot
 * shape that the tool emits in-process. We do NOT re-validate the
 * shape (the jsonl is a write-once source of truth from this same
 * extension), but we do defend against `details` being undefined
 * or malformed by checking the entry-level discriminator before
 * storing it.
 */
export interface SubagentJsonlEntry {
	lineNumber: number;
	timestamp: string;
	mode: "single" | "parallel" | "chain";
	results: SingleResult[];
	suspensions: SuspendedSnapshot["suspensions"];
}

/**
 * Options accepted by `renderTranscript`. Mirrors the typebox
 * `TranscriptParams` schema 1:1 so the LLM-facing parameter shape
 * and the pure-render shape stay in lockstep. Defaults match the
 * schema defaults (handled at the schema layer via typebox
 * `default`, but `renderTranscript` is also safe when called
 * directly with any subset of these fields).
 */
export interface RenderTranscriptOpts {
	lines?: number;
	agent?: string;
	index?: number;
	only?: "interrupted" | "all";
}

/**
 * Parse a host session's persistent jsonl file streamingly (line
 * by line — NEVER read the whole file into memory) and collect
 * every entry whose message is a subagent toolResult.
 *
 * Why streaming? Host sessions can grow into the tens of
 * megabytes (we have observed 10MB+ files for long agentic
 * sessions). Loading the entire file as one string + parsing as
 * one JSON would be O(N) memory in the file size and would
 * defeat the "post-mortem on a large session" use case. Reading
 * line by line keeps memory at O(1) in the file size — at any
 * moment we only hold the current line buffer plus the
 * accumulated entries.
 *
 * The streamer is intentionally permissive about parse failures
 * on individual lines (a single corrupted line must not abort the
 * whole read — we'd lose every subsequent entry). The parser
 * silently skips lines that:
 *   - are empty or whitespace-only
 *   - fail JSON.parse (returns invalid JSON)
 *   - are JSON but have the wrong shape (no `message` object,
 *     `message.role !== "toolResult"`, `message.toolName !==
 *     "subagent"`, missing `details.results`, etc.)
 *
 * Tolerant parsing is the right call here because the only
 * consumer is the post-mortem tool, not a correctness-critical
 * path. A skipped line is preferable to an empty transcript for
 * a session that was 99% intact.
 */
export async function parseSubagentEntries(sessionFilePath: string): Promise<SubagentJsonlEntry[]> {
	const entries: SubagentJsonlEntry[] = [];
	const stream = fs.createReadStream(sessionFilePath, { encoding: "utf8" });
	const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
	let lineNumber = 0;
	try {
		for await (const rawLine of rl) {
			lineNumber++;
			const line = rawLine.trim();
			if (!line) continue;
			let parsed: any;
			try {
				parsed = JSON.parse(line);
			} catch {
				continue;
			}
			const message = parsed?.message;
			if (!message || typeof message !== "object") continue;
			if (message.role !== "toolResult") continue;
			if (message.toolName !== "subagent") continue;
			const details = message.details;
			if (!details || typeof details !== "object") continue;
			const mode = details.mode;
			if (mode !== "single" && mode !== "parallel" && mode !== "chain") continue;
			const results = Array.isArray(details.results) ? (details.results as SingleResult[]) : [];
			const suspensions = Array.isArray(details.suspensions)
				? (details.suspensions as SuspendedSnapshot["suspensions"])
				: [];
			entries.push({
				lineNumber,
				timestamp: typeof parsed.timestamp === "string" ? parsed.timestamp : "",
				mode,
				results,
				suspensions,
			});
		}
	} finally {
		rl.close();
		stream.destroy();
	}
	return entries;
}

/**
 * Predicate that matches the user spec's definition of an
 * "interrupted" entry: any result in the entry that exited
 * non-zero, has a non-stop stopReason, OR the entry itself
 * carries one or more suspension snapshots.
 *
 * The disjunctive form mirrors the in-process `isFailedResult`
 * + suspension-frozen check that the watch dog uses; a parallel
 * invocation with one suspended sibling qualifies as interrupted
 * even if every other sibling exited cleanly, because the
 * surviving sibling's SIGSTOP is itself the "freeze" signal the
 * parent LLM needs to understand.
 */
export function isInterruptedEntry(entry: SubagentJsonlEntry): boolean {
	if (entry.suspensions.length > 0) return true;
	for (const r of entry.results) {
		if (r.exitCode !== 0) return true;
		if (r.stopReason && r.stopReason !== "stop") return true;
	}
	return false;
}

/**
 * Render a one-line preview of a tool-call argument for the
 * transcript body. Mirrors `formatToolCall`'s dispatch but is
 * text-only (no theme) because the transcript output goes back
 * to the LLM verbatim, not to the TUI.
 *
 *   bash → command (first 100 chars)
 *   read / write / edit → file_path (first 100 chars)
 *   anything else → JSON.stringify(arguments) (first 100 chars)
 *
 * The 100-char cap matches the user spec's "关键参数前 100 字符".
 * Newlines are flattened to single spaces so the rendered output
 * stays one line per step (the transcript body is parsed back by
 * the LLM as a list; embedded newlines would either break
 * downstream parsers or require extra escaping).
 */
export function previewToolCallArgs(name: string, args: Record<string, unknown>): string {
	const cap = (s: string) => {
		const flat = s.replace(/\s+/g, " ").trim();
		return flat.length > TRANSCRIPT_ARG_PREVIEW_LEN
			? `${flat.slice(0, TRANSCRIPT_ARG_PREVIEW_LEN)}...`
			: flat;
	};
	switch (name) {
		case "bash": {
			const cmd = typeof args.command === "string" ? args.command : "";
			return cap(cmd);
		}
		case "read":
		case "write":
		case "edit": {
			const p = args.file_path ?? args.path;
			return cap(typeof p === "string" ? p : "");
		}
		default: {
			try {
				return cap(JSON.stringify(args));
			} catch {
				return cap(String(args));
			}
		}
	}
}

/**
 * Render a one-line preview of an assistant text block for the
 * transcript body. Takes the FIRST non-empty line only and caps
 * at `TRANSCRIPT_ARG_PREVIEW_LEN` (100) characters, per the user
 * spec. Empty strings are surfaced as the literal "(empty)" so
 * the LLM sees an explicit marker instead of guessing why a
 * step has no visible content.
 */
export function previewTextBlock(text: string): string {
	const firstLine = text.split("\n").find((l) => l.trim().length > 0) ?? "";
	if (!firstLine) return "(empty)";
	const flat = firstLine.replace(/\s+/g, " ").trim();
	return flat.length > TRANSCRIPT_ARG_PREVIEW_LEN
		? `${flat.slice(0, TRANSCRIPT_ARG_PREVIEW_LEN)}...`
		: flat;
}

/**
 * Flatten a subagent entry's `messages` array into the same
 * `[text, toolCall]` items that `getDisplayItems` produces
 * (which the tool renderer uses for the in-process view). Reused
 * here so the transcript output matches what the LLM would have
 * seen if the entry's display had been expanded in the TUI.
 *
 * Step numbering is 1-based across the FLATTENED list, matching
 * the user spec's "#1, #2, ..." convention.
 */
function flattenEntrySteps(entry: SubagentJsonlEntry): DisplayItem[] {
	const items: DisplayItem[] = [];
	for (const r of entry.results) {
		for (const msg of r.messages) {
			if (msg.role !== "assistant") continue;
			for (const part of msg.content) {
				if (part.type === "text") items.push({ type: "text", text: part.text });
				else if (part.type === "toolCall") items.push({ type: "toolCall", name: part.name, args: part.arguments });
			}
		}
	}
	return items;
}

/**
 * Pick one subagent entry out of `entries` according to the
 * filter+index contract documented on `TranscriptParams`. Returns
 * `{ kind: "found", entry }` on success, or
 * `{ kind: "no_session_file", reason }` /
 * `{ kind: "no_matches", totalMatches, totalAfterFilter }` /
 * `{ kind: "index_out_of_range", totalMatches, requested }` on
 * the three failure paths the user spec requires.
 *
 * `only: "interrupted"` uses `isInterruptedEntry`. `only: "all"`
 * passes through. `agent` filters by membership in the entry's
 * results list (case-sensitive match against `r.agent`). The
 * index counts from 0 = most recent (i.e. the LAST match in
 * chronological order, since the jsonl is in write order).
 */
export type PickResult =
	| { kind: "found"; entry: SubagentJsonlEntry }
	| { kind: "no_matches"; totalMatches: number }
	| { kind: "index_out_of_range"; totalMatches: number; requested: number };

export function pickSubagentEntry(
	entries: ReadonlyArray<SubagentJsonlEntry>,
	opts: RenderTranscriptOpts,
): PickResult {
	const only = opts.only ?? "interrupted";
	const matches = entries.filter((e) => {
		if (only === "interrupted" && !isInterruptedEntry(e)) return false;
		if (opts.agent !== undefined) {
			const want = opts.agent;
			if (!e.results.some((r) => r.agent === want)) return false;
		}
		return true;
	});
	if (matches.length === 0) {
		return { kind: "no_matches", totalMatches: 0 };
	}
	const index = opts.index ?? 0;
	// matches is in chronological (write) order; "most recent" is
	// the LAST element, "second-most-recent" the one before, etc.
	const target = matches[matches.length - 1 - index];
	if (!target) {
		return { kind: "index_out_of_range", totalMatches: matches.length, requested: index };
	}
	return { kind: "found", entry: target };
}

/**
 * Pure render of a single subagent entry to the transcript text
 * the LLM receives. The exported surface is intentionally
 * side-effect-free so the validation script can call it directly
 * with synthetic entries; `handleTranscript` (the execute()
 * dispatch) is just a thin shell that loads `entries` via
 * `parseSubagentEntries`, calls `pickSubagentEntry`, and either
 * formats the success path via this function or surfaces the
 * failure message verbatim.
 *
 * The output shape (per user spec):
 *
 *     [transcript] <agent> · <model> · stopReason=<x> exit=<n> · <m> msgs · task: <first 80 chars>...
 *     最后 <N> 步：
 *       #<i> [<tool|text>] <preview>
 *       #<i+1> ...
 *     [subagent usage] <agent> · <model> · <turns> · ↑<in> ↓<out> · ctx <ctx>/<window> (<pct>%) · $<cost>
 *
 * `lines` is clamped to `[1, MAX_TRANSCRIPT_LINES]` to guard
 * against LLM-supplied nonsense (negative numbers, NaN, 10000)
 * — clamping to 1 instead of erroring matches the "best effort"
 * posture of the rest of the read-only path; the LLM can always
 * re-call with a different value if it wants more.
 */
export function renderTranscript(
	entry: SubagentJsonlEntry,
	opts: RenderTranscriptOpts,
): string {
	const lines = Math.max(
		1,
		Math.min(
			MAX_TRANSCRIPT_LINES,
			Math.floor(opts.lines ?? DEFAULT_TRANSCRIPT_LINES),
		),
	);

	// Header: derive display values from the entry's first result.
	// Multi-result entries (parallel / chain) get the first agent's
	// name; the usage line at the bottom carries per-agent totals
	// via appendUsageLines. This keeps the header one logical
	// "who" line and leaves the per-agent accounting to the
	// existing tool-shaped usage helper.
	const first = entry.results[0];
	const agentLabel = first?.agent ?? "(unknown agent)";
	const modelLabel = first?.model ?? "?";
	const providerLabel = first?.provider ?? "";
	const stopReason = first?.stopReason ?? "(none)";
	const exitCode = first?.exitCode ?? 0;
	const msgCount = entry.results.reduce((s, r) => s + (r.messages?.length ?? 0), 0);
	const taskPreview = first?.task
		? (() => {
				const flat = first.task.replace(/\s+/g, " ").trim();
				return flat.length > TRANSCRIPT_TASK_PREVIEW_LEN
					? `${flat.slice(0, TRANSCRIPT_TASK_PREVIEW_LEN)}...`
					: flat;
			})()
		: "(no task)";

	const header =
		`[transcript] ${agentLabel}` +
		` · ${providerLabel ? providerLabel + "/" : ""}${modelLabel}` +
		` · stopReason=${stopReason} exit=${exitCode}` +
		` · ${msgCount} msgs` +
		` · task: ${taskPreview}`;

	// Body: flatten, take the last `lines` steps, render as
	// `#<step> [<kind>] <preview>`. Step numbers are 1-based and
	// computed BEFORE the tail slice so they remain stable if the
	// LLM scrolls through (e.g. "last 10 of 45 steps" gives
	// steps #36..#45, not #1..#10).
	const items = flattenEntrySteps(entry);
	const tail = items.slice(-lines);
	const skipped = items.length - tail.length;
	let body = `最后 ${tail.length} 步：\n`;
	if (skipped > 0) body += `  ... 省略前面 ${skipped} 步\n`;
	const startStep = items.length - tail.length;
	for (let i = 0; i < tail.length; i++) {
		const stepNum = startStep + i + 1;
		const item = tail[i]!;
		if (item.type === "text") {
			body += `  #${stepNum} [text] ${previewTextBlock(item.text)}\n`;
		} else {
			body += `  #${stepNum} [${item.name}] ${previewToolCallArgs(item.name, item.args)}\n`;
		}
	}

	// Trailing usage line in the existing format. Empty-results
	// entries (e.g. an entry whose results all got stripped by a
	// prior compaction) get no usage line — `appendUsageLines`
	// short-circuits on empty input.
	const usageText = appendUsageLines("", entry.results).trim();
	const parts = [header, body.trimEnd()];
	if (usageText) parts.push(usageText);
	return parts.join("\n\n");
}

/**
 * Build the user-facing error text for the three failure paths.
 * Kept as a tiny named function (rather than inlined) so the
 * "Available agents" suggestion in the no-matches path can be
 * derived from the entries that DID exist in the file (helping
 * the LLM notice e.g. that it filtered for `worker` when the
 * session only ever ran `researcher`).
 */
function transcriptFailureText(
	kind: "no_session_file" | "no_matches" | "index_out_of_range",
	opts: RenderTranscriptOpts,
	allEntries: ReadonlyArray<SubagentJsonlEntry>,
	pickOutcome: PickResult | null,
): string {
	if (kind === "no_session_file") {
		return (
			`[transcript] 无法读取会话持久化文件：当前会话没有设置 PI_SESSION_FILE 环境变量，\n` +
			`可能是 ephemeral 模式（启动时带 --no-session）。事后查询需要先结束会话再重开。`
		);
	}
	const only = opts.only ?? "interrupted";
	const agentPart = opts.agent ? `, agent='${opts.agent}'` : "";
	const onlyPart = only === "interrupted" ? "（含 suspended 快照的）" : "（全部）";
	if (kind === "no_matches") {
		const seenAgents = Array.from(new Set(allEntries.flatMap((e) => e.results.map((r) => r.agent)))).sort();
		const hint =
			seenAgents.length > 0
				? `\n会话里出现过的 agent：${seenAgents.join(", ")}。`
				: "";
		const onlyHint =
			only === "interrupted"
				? `\n提示：把 only 改为 'all' 可以看到所有 subagent 调用（包括成功退出的）。`
				: "";
		return (
			`[transcript] 在当前会话里没有找到匹配的 subagent 调用。\n` +
			`筛选条件：only='${only}'${agentPart}。${hint}${onlyHint}`
		);
	}
	// kind === "index_out_of_range"
	const requested = pickOutcome && pickOutcome.kind === "index_out_of_range" ? pickOutcome.requested : (opts.index ?? 0);
	const total =
		pickOutcome && pickOutcome.kind === "index_out_of_range" ? pickOutcome.totalMatches : 0;
	return (
		`[transcript] 索引越界：请求的第 ${requested} 个匹配（0 = 最近）超过可用匹配数（${total}）。\n` +
		`提示：把 index 调小，或放宽 only/agent 过滤。`
	);
}

/**
 * Synchronous shell around `parseSubagentEntries` +
 * `pickSubagentEntry` + `renderTranscript`. Reads the host
 * session file (env var `PI_SESSION_FILE`) and renders the
 * matching entry.
 *
 * Pure read-only: does not touch any process, does not mutate
 * the suspension registry, does not write to disk. Safe to call
 * alongside any other subagent operation.
 */
async function handleTranscript(
	transcriptParams: RenderTranscriptOpts,
	_makeDetails: (mode: "single" | "parallel" | "chain", suspensions?: SuspendedSnapshot["suspensions"]) => (results: SingleResult[]) => SubagentDetails | SuspendedSnapshot,
): Promise<AgentToolResult<SubagentDetails | SuspendedSnapshot>> {
	const sessionFile = process.env.PI_SESSION_FILE;
	if (!sessionFile) {
		return {
			content: [{ type: "text", text: transcriptFailureText("no_session_file", transcriptParams, [], null) }],
			details: _makeDetails("single")([]),
		};
	}
	if (!fs.existsSync(sessionFile)) {
		return {
			content: [
				{
					type: "text",
					text:
						`[transcript] PI_SESSION_FILE 指向的文件不存在：${sessionFile}\n` +
						`可能是上一次会话被清理过，或者路径写错。`,
				},
			],
			details: _makeDetails("single")([]),
		};
	}

	let entries: SubagentJsonlEntry[];
	try {
		entries = await parseSubagentEntries(sessionFile);
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		return {
			content: [
				{
					type: "text",
					text: `[transcript] 解析会话文件失败：${msg}\n文件路径：${sessionFile}`,
				},
			],
			details: _makeDetails("single")([]),
		};
	}

	const picked = pickSubagentEntry(entries, transcriptParams);
	if (picked.kind !== "found") {
		const text =
			picked.kind === "no_matches"
				? transcriptFailureText("no_matches", transcriptParams, entries, picked)
				: transcriptFailureText("index_out_of_range", transcriptParams, entries, picked);
		return {
			content: [{ type: "text", text }],
			details: _makeDetails("single")([]),
		};
	}

	const text = renderTranscript(picked.entry, transcriptParams);
	return {
		content: [{ type: "text", text }],
		// Pass an empty results array on purpose: `renderResult`'s
		// early-return (index.ts:1541) fires when both
		// `details.results.length === 0` and
		// `details.suspensions.length === 0`, which short-circuits
		// straight to the text payload without iterating the
		// normal-mode (single/parallel/chain) render branches. That
		// matters for two reasons:
		//   1. TUI responsiveness — the normal-mode branches walk
		//      `getDisplayItems` + `formatToolCall` + markdown
		//      theme render for every step in the entry, which on
		//      a long-running subagent is hundreds of items and
		//      causes visible lag when the user collapses/expands
		//      the result. The text-only path is one allocation +
		//      one paint.
		//   2. Correctness — the transcript body already encodes
		//      every step with a `#<n> [<kind>] <preview>` line,
		//      so re-running it through the TUI's collapsed/expanded
		//      renderer would either duplicate it or replace it
		//      with a thinner view. The empty-details fast path
		//      keeps the textual transcript the single source of
		//      truth and avoids the two representations drifting.
		details: _makeDetails(picked.entry.mode)([]),
	};
}

/* -------------------------------------------------------------------------- */
/*                          Arbitration handler bodies                         */
/* -------------------------------------------------------------------------- */

function handleInspect(
	inspectParams: { id: string; lines?: number },
	ctx: { cwd: string },
	makeDetails: (mode: "single" | "parallel" | "chain", suspensions?: SuspendedSnapshot["suspensions"]) => (results: SingleResult[]) => SubagentDetails | SuspendedSnapshot,
): AgentToolResult<SubagentDetails | SuspendedSnapshot> {
	const lines = inspectParams.lines ?? DEFAULT_INSPECT_LINES;
	const susp = getSuspension(inspectParams.id);
	if (!susp) {
		return {
			content: [
				{
					type: "text",
					text: `No active suspension with id "${inspectParams.id}". It may have been resumed, killed, or never existed.`,
				},
			],
			details: makeDetails("single")([]),
		};
	}
	const tail = summarizeTail(susp.messages, susp.stderr, lines);
	const inFlightLive = extractInFlight(susp.messages);
	const idleMs = Date.now() - susp.lastEventAtMs;
	const text = JSON.stringify(
		{
			status: "idle_inspect",
			suspensionId: susp.id,
			idleMs,
			runningCommand: inFlightLive?.command ?? null,
			requestedTimeout: inFlightLive?.timeout ?? null,
			tail,
		},
		null,
		2,
	);
	return {
		content: [{ type: "text", text }],
		details: makeDetails("single")([liteToSingle(susp.partialResult)]),
	};
}

/**
 * P1: rebuild a sibling suspension's `completedResults` after
 * `handleKill` removes a task from the same parallel group.
 *
 * Pre-fix, the kill result was NOT propagated to siblings. When a
 * sibling later resumed, its cursor walk over `completedResults`
 * would consume the wrong entry (the killed task's slot was
 * skipped, so the cursor advanced by one, and the next iteration
 * would either reuse a sibling's slot or underflow `completedResults`
 * entirely → `liteToSingle(undefined)` → `TypeError: Cannot read
 * properties of undefined (reading 'agent')` at
 * `liteToSingle(index.ts:450)` → the close handler that called
 * `finalizeAndContinue` re-threw synchronously, and the host pi
 * process crashed because the throw was uncaught inside the
 * ChildProcess event emitter.
 *
 * The fix: at kill time, walk every sibling's `completedResults`
 * and rebuild it so that, for each task index `i` in [0, N):
 *   - if `i === killedIndex` → insert the kill result at this
 *     position;
 *   - if `i` is a still-suspended sibling's index → skip (it
 *     remains absent from `completedResults`; the resume handler
 *     will fill it in when that sibling resumes);
 *   - otherwise → consume the next entry from the sibling's old
 *     `completedResults` (which lists completed (not-suspended)
 *     tasks in order).
 *
 * The cursor walk in `finalizeAndContinue` (parallel branch) is the
 * mirror of this rebuild: it walks `tasks`, consuming one entry
 * from `completedResults` for each non-self / non-still-suspended
 * slot. By keeping the two walks consistent, the rebuilt array
 * lines up with the cursor arithmetic and the merged result lands
 * the kill result at the killed index.
 *
 * Returns the new `completedResults` array; the caller assigns it
 * back to the sibling's `job.completedResults` in place.
 */
function mergeKillResultIntoSibling(
	oldCompleted: SingleResultLite[],
	killedIndex: number,
	killResult: SingleResultLite,
	stillSuspendedIndices: Set<number>,
	tasksLength: number,
): SingleResultLite[] {
	const out: SingleResultLite[] = [];
	let cursor = 0;
	for (let i = 0; i < tasksLength; i++) {
		if (i === killedIndex) {
			out.push(killResult);
		} else if (stillSuspendedIndices.has(i)) {
			// Skip: this slot is still-occupied by a sibling
			// suspension that has not yet resumed. The resume
			// handler will fill it in when that sibling's
			// finalize runs.
		} else {
			if (cursor < oldCompleted.length) {
				out.push(oldCompleted[cursor]!);
				cursor++;
			}
			// If cursor overflows, the slot is genuinely missing;
			// P2's defensive fallback in `finalizeAndContinue` will
			// synthesize a placeholder so the cursor walk never
			// produces `undefined` for `liteToSingle`.
		}
	}
	return out;
}

function handleKill(
	id: string,
	ctx: { cwd: string },
	makeDetails: (mode: "single" | "parallel" | "chain", suspensions?: SuspendedSnapshot["suspensions"]) => (results: SingleResult[]) => SubagentDetails | SuspendedSnapshot,
): AgentToolResult<SubagentDetails | SuspendedSnapshot> {
	const susp = getSuspension(id);
	if (!susp) {
		return {
			content: [
				{
					type: "text",
					text: `No active suspension with id "${id}". It may have been resumed, killed, or never existed.`,
				},
			],
			details: makeDetails("single")([]),
		};
	}

	susp.cancelled = true;

	thawProcessGroup(susp.proc);

	killProcessGroup(susp.proc);
	setTimeout(() => killProcessGroup(susp.proc), 100);

	const partial: SingleResult = {
		...susp.partialResult,
		exitCode: -1,
		stopReason: "aborted",
	};

	// P1: propagate the kill result into sibling suspensions'
	// `completedResults` so a later resume's cursor walk lands the
	// kill result at the killed index instead of skipping the slot
	// (which would cause an `undefined` → `liteToSingle(undefined)`
	// crash inside the resume handler's `finalizeAndContinue`).
	const killLite = singleToLite(partial);
	if (susp.job.kind === "parallel" && susp.job.groupId) {
		const killedIndex = susp.job.index;
		const siblings = getSiblingSuspensions(susp.job.groupId, susp.id);
		const stillSuspendedIndices = new Set<number>(
			siblings
				.map((s) => (s.job.kind === "parallel" ? s.job.index : -1))
				.filter((idx) => idx >= 0),
		);
		for (const sib of siblings) {
			if (sib.job.kind !== "parallel") continue;
			sib.job.completedResults = mergeKillResultIntoSibling(
				sib.job.completedResults,
				killedIndex,
				killLite,
				stillSuspendedIndices,
				sib.job.tasks.length,
			);
		}
	}

	unregisterSuspension(susp.id);
	return {
		content: [
			{
				type: "text",
				text: appendUsageLines(
					`Killed suspended sub-agent ${susp.partialResult.agent}. Partial transcript follows:\n\n${getFinalOutput(partial.messages) || "(no output)"}`,
					[partial],
				),
			},
		],
		details: makeDetails("single")([partial]),
		usage: aggregateUsageToUsage([partial]),
	};
}

/** Map a `Job` discriminator onto the `makeDetails` mode key. Used
 *  by `handleResume` to build the correct suspended-render details
 *  regardless of whether we re-froze on the first or the second leg. */
function resumeMode(job: Job): "single" | "chain" | "parallel" {
	return job.kind;
}

function handleResume(
	id: string,
	signal: AbortSignal | undefined,
	onUpdate: OnUpdateCallback | undefined,
	ctx: { cwd: string },
	agents: AgentConfig[],
	allToolNames: string[],
	agentScope: AgentScope,
	discovery: { projectAgentsDir: string | null },
	makeDetails: (mode: "single" | "parallel" | "chain", suspensions?: SuspendedSnapshot["suspensions"]) => (results: SingleResult[]) => SubagentDetails | SuspendedSnapshot,
	modelOverride: string | undefined,
): Promise<AgentToolResult<SubagentDetails | SuspendedSnapshot>> {
	const susp = getSuspension(id);
	if (!susp) {
		return Promise.resolve({
			content: [
				{
					type: "text",
					text: `No active suspension with id "${id}". It may have been resumed, killed, or never existed.`,
				},
			],
			details: makeDetails("single")([]),
		});
	}

	const thawed = thawProcessGroup(susp.proc);
	if (!thawed && isPosixSuspendSupported()) {
		const partial: SingleResult = {
			...susp.partialResult,
			exitCode: -1,
			stopReason: "aborted",
		};
		unregisterSuspension(susp.id);
		return Promise.resolve({
			content: [
				{
					type: "text",
					text: appendUsageLines(
						`Failed to thaw suspended sub-agent ${susp.partialResult.agent} (SIGCONT error).`,
						[partial],
					),
				},
			],
			details: makeDetails("single")([partial]),
			usage: aggregateUsageToUsage([partial]),
		});
	}

	const proc = susp.proc;
	const idleTimeoutMs = resolveIdleTimeoutMs();

	return new Promise<AgentToolResult<SubagentDetails | SuspendedSnapshot>>((resolve) => {
		let buffer = "";
		const partialLite = susp.partialResult;
		const partial: SingleResult = liteToSingle(partialLite);
		partial.exitCode = 0;

		let lastEventAtMs = Date.now();
		let resumedSuspended = false;
		let activeAbortHandler: (() => void) | null = null;

		// P3 host-liveness safety net (see `safeSettle`): every
		// callback that closes over `resolve` MUST go through
		// `safeSettle` so an unexpected throw resolves the Promise
		// with an isError result instead of crashing the host pi
		// process. `finalized` is the additional guard for paths
		// that resolve via `finalizeAndContinue` (which sets
		// `finalized = true` before resolving — late events see
		// that and return early).
		const settled: SettledState = { done: false };
		const settleError = (context: string): AgentToolResult<SubagentDetails | SuspendedSnapshot> => {
			const failed: SingleResult = {
				...partial,
				exitCode: -1,
				stopReason: "aborted",
				errorMessage: `Subagent internal error (${context}); the resume leg was abandoned. See host stderr for the full stack trace.`,
			};
			return {
				content: [
					{
						type: "text",
						text: appendUsageLines(
							`Agent ${failed.agent}: ${failed.errorMessage ?? "internal error"}`,
							[failed],
						),
					},
				],
				details: makeDetails(resumeMode(susp.job))([failed]),
				isError: true,
				usage: aggregateUsageToUsage([failed]),
			};
		};

		let idleTimer: NodeJS.Timeout | null = null;
		const armWatchdog = () => {
			if (resumedSuspended) return;
			if (idleTimer) clearTimeout(idleTimer);
			idleTimer = setTimeout(() => {
				safeSettle<AgentToolResult<SubagentDetails | SuspendedSnapshot>>(
					settled,
					resolve,
					"resume watchdog timer",
					() => settleError("resume watchdog timer"),
					() => {
						if (settled.done) return;
						idleTimer = null;
						if (proc.exitCode !== null) {
							disarmWatchdog();
							return;
						}
						const frozen = freezeProcessGroup(proc);
						if (!frozen) {
							partial.exitCode = -1;
							partial.stopReason = "aborted";
							killProcessGroup(proc);
							finalized = true;
							unregisterSuspension(susp.id);
							settled.done = true;
							resolve({
								content: [
									{
										type: "text",
										text: appendUsageLines(
											`Resumed sub-agent re-froze then was force-killed (no SIGSTOP on win32). Partial transcript follows:\n\n${getFinalOutput(partial.messages) || "(no output)"}`,
											[partial],
										),
									},
								],
								details: makeDetails(resumeMode(susp.job))([partial]),
								usage: aggregateUsageToUsage([partial]),
							});
							return;
						}
						const newId = newSuspensionId();
						const inFlight = extractInFlight(partial.messages);
						const suspension2: Suspension = {
							id: newId,
							proc,
							inFlight,
							messages: partial.messages,
							stderr: partial.stderr,
							invocation: susp.invocation,
							job: susp.job,
							partialResult: singleToLite(partial),
							lastEventAtMs,
							originalSignal: susp.originalSignal,
							activeAbortHandler,
							cancelled: false,
						};
						detachAbortListener(susp.originalSignal, activeAbortHandler);
						suspension2.activeAbortHandler = null;
						activeAbortHandler = null;
						resumedSuspended = true;
						finalized = true;
						registerSuspension(suspension2);
						unregisterSuspension(susp.id);
						settled.done = true;
						resolve({
							content: [
								{
									type: "text",
									text: appendUsageLines(
										JSON.stringify(
											{
												status: "idle_suspended",
												suspensionId: newId,
												idleMs: Date.now() - lastEventAtMs,
												runningCommand: inFlight?.command ?? null,
												requestedTimeout: inFlight?.timeout ?? null,
												tail: summarizeTail(partial.messages, partial.stderr, DEFAULT_TAIL_LINES),
											},
											null,
											2,
										),
										[partial],
									),
								},
							],
							details: makeDetails(resumeMode(susp.job))([partial]),
							usage: aggregateUsageToUsage([partial]),
						});
					},
				);
			}, idleTimeoutMs);
		};
		const disarmWatchdog = () => {
			if (idleTimer) {
				clearTimeout(idleTimer);
				idleTimer = null;
			}
		};

		const processLine = (line: string) => {
			if (!line.trim()) return;
			let event: any;
			try {
				event = JSON.parse(line);
			} catch {
				return;
			}
			if (event.type === "message_end" && event.message) {
				const msg = event.message as Message;
				partial.messages.push(msg);
				if (msg.role === "assistant") {
					partial.usage.turns++;
					const usage = msg.usage;
					if (usage) {
						partial.usage.input += usage.input || 0;
						partial.usage.output += usage.output || 0;
						partial.usage.cacheRead += usage.cacheRead || 0;
						partial.usage.cacheWrite += usage.cacheWrite || 0;
						partial.usage.cost += usage.cost?.total || 0;
						partial.usage.contextTokens = usage.totalTokens || 0;
					}
					if (!partial.model && msg.model) partial.model = msg.model;
					if (!partial.provider && msg.provider) partial.provider = msg.provider;
					if (msg.stopReason) partial.stopReason = msg.stopReason;
					if (msg.errorMessage) partial.errorMessage = msg.errorMessage;
				}
				if (onUpdate) {
					onUpdate({
						content: [{ type: "text", text: getFinalOutput(partial.messages) || "(running...)" }],
						details: makeDetails(resumeMode(susp.job))([partial]),
					});
				}
			}
			if (event.type === "tool_result_end" && event.message) {
				partial.messages.push(event.message as Message);
				if (onUpdate) {
					onUpdate({
						content: [{ type: "text", text: getFinalOutput(partial.messages) || "(running...)" }],
						details: makeDetails(resumeMode(susp.job))([partial]),
					});
				}
			}
		};

		// Strip cold-path stdout/stderr listeners. Node preserves
		// EventEmitter listeners across SIGSTOP, so the cold-path
		// ones are still attached. They bail on their own
		// `suspended` flag, but they still fire — and accumulate
		// across resume cycles (N-W1). Remove them and attach
		// fresh ones for THIS leg.
		proc.stdout?.removeAllListeners("data");
		proc.stderr?.removeAllListeners("data");

		const onStdoutData = (data: Buffer) => {
			safeSettle<AgentToolResult<SubagentDetails | SuspendedSnapshot>>(
				settled,
				resolve,
				"resume stdout data handler",
				() => settleError("resume stdout data handler"),
				() => {
					if (settled.done) return;
					if (resumedSuspended) return;
					lastEventAtMs = Date.now();
					armWatchdog();
					buffer += data.toString();
					const lines = buffer.split("\n");
					buffer = lines.pop() || "";
					for (const line of lines) processLine(line);
				},
			);
		};
		const onStderrData = (data: Buffer) => {
			safeSettle<AgentToolResult<SubagentDetails | SuspendedSnapshot>>(
				settled,
				resolve,
				"resume stderr data handler",
				() => settleError("resume stderr data handler"),
				() => {
					if (settled.done) return;
					if (resumedSuspended) return;
					lastEventAtMs = Date.now();
					armWatchdog();
					partial.stderr += data.toString();
				},
			);
		};

		proc.stdout?.on("data", onStdoutData);
		proc.stderr?.on("data", onStderrData);

		// Strip cold-path close/error listeners for the same
		// accumulation reason (N-W1 / N-C3).
		proc.removeAllListeners("close");
		proc.removeAllListeners("error");

		let finalized = false;

		const finalizeAndContinue = (result: SingleResult, job: Job) => {
			// P3: wrap the entire body in safeSettle so an
			// unexpected throw inside the arbiter (e.g. the
			// `liteToSingle(undefined)` crash fixed by P1, or any
			// future invariant violation) ends up as an isError
			// tool result instead of crashing the host pi process.
			// The intra-body `resolve(...)` calls are part of the
			// wrapped body — safeSettle captures the throw, logs
			// the stack to stderr, and falls back to a synthetic
			// failure result.
			//
			// N-W5: if handleKill already responded, drop the
			// late close/error event BEFORE evaluating any
			// resolve-arg expressions.
			//
			// N-R1: handleKill set `cancelled = true` and killed
			// the proc group, then unregistered the suspension.
			// The resume leg is still pending — without resolving
			// here, the parent's tool call hangs forever. Return a
			// fact-only summary built from whatever events the
			// resume handler collected before the kill landed.
			safeSettle<AgentToolResult<SubagentDetails | SuspendedSnapshot>>(
				settled,
				resolve,
				"finalizeAndContinue",
				() => settleError("finalizeAndContinue"),
				() => {
					if (settled.done) return;
					if (susp.cancelled) {
						if (!finalized) {
							finalized = true;
							disarmWatchdog();
						}
						settled.done = true;
						resolve({
							content: [
								{
									type: "text",
									text: appendUsageLines(
										`Resumed sub-agent was killed while resuming. Partial transcript:\n\n${getFinalOutput(result.messages) || "(no output)"}`,
										[result],
									),
								},
							],
							details: makeDetails(resumeMode(susp.job))([result]),
							usage: aggregateUsageToUsage([result]),
						});
						return;
					}
					if (finalized) return;
					finalized = true;
					disarmWatchdog();
					unregisterSuspension(susp.id);

					// N-W2: detach the abort handler we re-attached at
					// the top of handleResume so it does not leak into
					// the user's AbortSignal for the rest of the
					// parent's life.
					if (activeAbortHandler) {
						detachAbortListener(susp.originalSignal, activeAbortHandler);
						activeAbortHandler = null;
					}

					if (job.kind === "single") {
						const isError = isFailedResult(result);
						const out = getFinalOutput(result.messages) || "(no output)";
						settled.done = true;
						resolve({
							content: isError
								? [
										{
											type: "text",
											text: appendUsageLines(`Agent ${result.stopReason || "failed"}: ${out}`, [result]),
										},
									]
								: [{ type: "text", text: appendUsageLines(out, [result]) }],
							details: makeDetails("single")([result]),
							isError,
							usage: aggregateUsageToUsage([result]),
						});
						return;
					}
					if (job.kind === "chain") {
						const allResults: SingleResult[] = [...job.results.map(liteToSingle), result];
						const previousOutput = getFinalOutput(result.messages);
						// The Promise is passed to resolve; if
						// `runChainRemaining` rejects, the outer
						// tool framework will surface it as an
						// error. We do not resolve here
						// synchronously: `runChainRemaining` is
						// async and itself contains proc I/O.
						// Surface rejection as a tool error by
						// chaining `.catch` into an isError result.
						settled.done = true;
						resolve(
							runChainRemaining(
								job.steps.slice(job.index + 1),
								job.index + 1,
								previousOutput,
								allResults,
								job.steps,
								ctx,
								signal,
								onUpdate,
								agents,
								allToolNames,
								agentScope,
								discovery,
								makeDetails,
								modelOverride,
							).catch((err) => {
								// P3: `runChainRemaining` rejected
								// (e.g. a downstream proc handler
								// threw unexpectedly). Convert the
								// rejection into an isError tool
								// result so the host doesn't crash.
								const stack = err instanceof Error ? (err.stack ?? err.message) : String(err);
								console.error(`[subagent] runChainRemaining rejected: ${stack}`);
								const failed: SingleResult = {
									...result,
									exitCode: -1,
									stopReason: "aborted",
									errorMessage: `Chain continuation failed: ${err instanceof Error ? err.message : String(err)}`,
								};
								return {
									content: [
										{
											type: "text",
											text: appendUsageLines(
												`Chain stopped at step ${job.index + 1} (${result.agent}): ${failed.errorMessage ?? "internal error"}`,
												allResults,
											),
										},
									],
									details: makeDetails("chain")([...allResults]),
									isError: true,
									usage: aggregateUsageToUsage(allResults),
								} satisfies AgentToolResult<SubagentDetails | SuspendedSnapshot>;
							}),
						);
						return;
					}
					if (job.kind === "parallel") {
				// N-C2: rebuild a fully-ordered result array.
				// The previous design assumed exactly one
				// suspended task and walked
				// `job.completedResults` as "every other slot".
				// With multiple concurrent suspensions each
				// suspension's `completedResults` is patched to
				// exclude ALL suspended indices, so a resume on
				// one of them consumes only its own +
				// truly-completed siblings.
				const allActive = getAllSuspensions().filter(
					(s) => s.job.kind === "parallel" && s.id !== susp.id,
				);
				const stillSuspendedIndices = new Set<number>();
				for (const s of allActive) {
					if (s.job.kind === "parallel") stillSuspendedIndices.add(s.job.index);
				}

				const merged: SingleResult[] = new Array(job.tasks.length);
				let sibCursor = 0;
				for (let i = 0; i < job.tasks.length; i++) {
					if (i === job.index) {
						merged[i] = result;
					} else if (stillSuspendedIndices.has(i)) {
						merged[i] = {
							agent: job.tasks[i]!.agent,
							agentSource: "unknown",
							task: job.tasks[i]!.task,
							exitCode: -1,
							messages: [],
							stderr: "",
							usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
						};
					} else {
						const lite = job.completedResults[sibCursor];
						if (lite) {
							merged[i] = liteToSingle(lite);
						} else {
							// P2 (defensive fallback): the cursor
							// underflowed `job.completedResults`.
							// This shouldn't happen with P1's kill
							// propagation in place, but it COULD
							// happen if a sibling's
							// `completedResults` was clobbered by
							// some other path (e.g. a test seam
							// that mutates the registry directly,
							// or a future codepath that forgets to
							// update siblings). Synthesize a
							// placeholder failed result so the
							// cursor walk never produces
							// `undefined` for `liteToSingle` —
							// which is the literal crash site
							// (`liteToSingle` on line ~450 reads
							// `lite.agent`).
							merged[i] = {
								agent: job.tasks[i]!.agent,
								agentSource: "unknown",
								task: job.tasks[i]!.task,
								exitCode: -1,
								stopReason: "aborted",
								errorMessage: `Sibling task at index ${i} (${job.tasks[i]!.agent}) produced no result — likely killed during suspension before its result was propagated to this parallel group.`,
								messages: [],
								stderr: "",
								usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
							};
						}
						sibCursor++;
					}
				}

				if (stillSuspendedIndices.size > 0) {
					// N-C2: patch every other still-suspended
					// suspension's `completedResults` to include
					// the just-resumed result, so when ITS
					// resume fires later, the cursor walk finds
					// the right number of entries (excluding all
					// still-suspended indices + itself). Without
					// this, the second resume would either
					// underflow (no entries for completed slots)
					// or overflow (consume a sibling's slot).
					for (const s of allActive) {
						if (s.job.kind !== "parallel") continue;
						if (s.job.index === job.index) continue;
						// Rebuild completedResults from the patched
						// `merged` array we just constructed,
						// skipping still-suspended slots and the
						// current slot (which the resume handler
						// is now resolving).
						const newCompleted: SingleResultLite[] = [];
						for (let k = 0; k < merged.length; k++) {
							if (stillSuspendedIndices.has(k)) continue;
							if (k === s.job.index) continue;
							newCompleted.push(singleToLite(merged[k]!));
						}
						// `s.job` is mutable in place — the
						// resume handler reads from the same
						// reference on the next call.
						(s.job as { completedResults: SingleResultLite[] }).completedResults = newCompleted;
					}
					const remaining = allActive.map((s) => {
						const idleMs = Date.now() - s.lastEventAtMs;
						const inFlight = extractInFlight(s.messages);
						return {
							suspensionId: s.id,
							idleMs,
							runningCommand: inFlight?.command ?? null,
							requestedTimeout: inFlight?.timeout ?? null,
							tail: summarizeTail(s.messages, s.stderr, DEFAULT_TAIL_LINES),
						};
					});
					const successCount = merged.filter(
						(r) => r.exitCode !== -1 && !isFailedResult(r),
					).length;
					const completedCount = merged.filter((r) => r.exitCode !== -1).length;
					const trailerLines = remaining
						.map(
							(s) =>
								`- suspensionId: ${s.suspensionId} (idleMs=${s.idleMs}, command=${s.runningCommand ?? "(none)"})`,
						)
						.join("\n");
					resolve({
						content: [
							{
								type: "text",
								text: appendUsageLines(
									JSON.stringify(
										{
											status: "idle_suspended",
											suspensions: remaining,
											completedCount,
											totalTasks: job.tasks.length,
											successCount,
										},
										null,
										2,
									) + `\n\n${trailerLines}`,
									merged,
								),
							},
						],
						details: makeDetails("parallel", remaining)(merged),
						usage: aggregateUsageToUsage(merged),
					});
					return;
				}

				const successCount = merged.filter((r) => !isFailedResult(r)).length;
				const summaries = merged.map((r) => {
					const output = truncateParallelOutput(getResultOutput(r));
					const status = isFailedResult(r)
						? `failed${r.stopReason && r.stopReason !== "end" ? ` (${r.stopReason})` : ""}`
						: "completed";
					return `### [${r.agent}] ${status}\n\n${output}`;
				});
				settled.done = true;
				resolve({
					content: [
						{
							type: "text",
							text: appendUsageLines(
								`Parallel: ${successCount}/${merged.length} succeeded\n\n${summaries.join("\n\n---\n\n")}`,
								merged,
							),
						},
					],
					details: makeDetails("parallel")(merged),
					usage: aggregateUsageToUsage(merged),
				});
				return;
			}
				},
			);
		};

		proc.once("close", (code, signal) => {
			safeSettle<AgentToolResult<SubagentDetails | SuspendedSnapshot>>(
				settled,
				resolve,
				"resume close handler",
				() => settleError("resume close handler (lit the kill/crash path during finalize)"),
				() => {
					if (settled.done) return;
					if (finalized) return;
					if (resumedSuspended) return;
					if (buffer.trim()) processLine(buffer);
					const result: SingleResult = { ...partial };
					if (code === null) {
						result.exitCode = -1;
						if (!result.stopReason) result.stopReason = "aborted";
						if (!result.errorMessage) {
							result.errorMessage = signal ? `Process terminated by signal ${signal}` : "Process terminated by signal";
						}
					} else {
						result.exitCode = code;
					}
					// Finalize via the safe wrapper so any throw
					// inside `finalizeAndContinue` (the active
					// crash site: liteToSingle(undefined) on a
					// missing sibling slot) becomes an isError
					// result instead of crashing the host.
					safeSettle<AgentToolResult<SubagentDetails | SuspendedSnapshot>>(
						settled,
						resolve,
						"finalizeAndContinue (close)",
						() => settleError("finalizeAndContinue (close)"),
						() => {
							if (settled.done) return;
							finalizeAndContinue(result, susp.job);
						},
					);
				},
			);
		});

		proc.once("error", (err) => {
			safeSettle<AgentToolResult<SubagentDetails | SuspendedSnapshot>>(
				settled,
				resolve,
				"resume error handler",
				() => settleError("resume error handler"),
				() => {
					if (settled.done) return;
					if (finalized) return;
					if (resumedSuspended) return;
					const result: SingleResult = { ...partial, exitCode: 1 };
					if (!result.stopReason) result.stopReason = "error";
					if (!result.errorMessage) {
						result.errorMessage = err ? (err as Error).message : "Child process errored";
					}
					safeSettle<AgentToolResult<SubagentDetails | SuspendedSnapshot>>(
						settled,
						resolve,
						"finalizeAndContinue (error)",
						() => settleError("finalizeAndContinue (error)"),
						() => {
							if (settled.done) return;
							finalizeAndContinue(result, susp.job);
						},
					);
				},
			);
		});

		activeAbortHandler = reAttachAbortListener(signal, proc, {
			isSuspended: () => resumedSuspended,
		});

		armWatchdog();
	});
}

/* -------------------------------------------------------------------------- */
/*                       Mode runners: single / chain / parallel              */
/* -------------------------------------------------------------------------- */

async function runSingle(
	agentName: string,
	task: string,
	cwd: string | undefined,
	ctx: { cwd: string },
	signal: AbortSignal | undefined,
	onUpdate: OnUpdateCallback | undefined,
	agents: AgentConfig[],
	allToolNames: string[],
	agentScope: AgentScope,
	discovery: { projectAgentsDir: string | null },
	makeDetails: (mode: "single" | "parallel" | "chain", suspensions?: SuspendedSnapshot["suspensions"]) => (results: SingleResult[]) => SubagentDetails | SuspendedSnapshot,
	modelOverride: string | undefined,
): Promise<AgentToolResult<SubagentDetails | SuspendedSnapshot>> {
	const outcome = await runSingleAgent(
		ctx.cwd,
		agents,
		agentName,
		task,
		cwd,
		undefined,
		signal,
		onUpdate,
		makeDetails("single"),
		allToolNames,
		modelOverride,
		{ kind: "single" },
		0,
	);
	if (outcome.kind === "suspended") {
		const built = buildSuspendedSnapshot("single", [
			{ suspensionId: outcome.id, snapshot: outcome.snapshot, lastEventAtMs: outcome.lastEventAtMs },
		]);
		return {
			content: [
				{
					type: "text",
					text: appendUsageLines(
						JSON.stringify(
							{
								status: "idle_suspended",
								suspensionId: outcome.id,
								idleMs: Date.now() - outcome.lastEventAtMs,
								runningCommand: built[0]?.runningCommand ?? null,
								requestedTimeout: built[0]?.requestedTimeout ?? null,
								tail: built[0]?.tail ?? [],
							},
							null,
							2,
						),
						[outcome.snapshot],
					),
				},
			],
			details: makeDetails("single", built)([outcome.snapshot]),
			usage: aggregateUsageToUsage([outcome.snapshot]),
		};
	}
	const result = outcome.result;
	const isError = isFailedResult(result);
	const out = getResultOutput(result);
	if (isError) {
		const text = `Agent ${result.stopReason || "failed"}: ${out}`;
		return {
			content: [{ type: "text", text: appendUsageLines(text, [result]) }],
			details: makeDetails("single")([result]),
			isError: true,
			usage: aggregateUsageToUsage([result]),
		};
	}
	return {
		content: [{ type: "text", text: appendUsageLines(out, [result]) }],
		details: makeDetails("single")([result]),
		usage: aggregateUsageToUsage([result]),
	};
}

async function runChain(
	chain: Array<{ agent: string; task: string; cwd?: string; model?: string }>,
	ctx: { cwd: string },
	signal: AbortSignal | undefined,
	onUpdate: OnUpdateCallback | undefined,
	agents: AgentConfig[],
	allToolNames: string[],
	agentScope: AgentScope,
	discovery: { projectAgentsDir: string | null },
	makeDetails: (mode: "single" | "parallel" | "chain", suspensions?: SuspendedSnapshot["suspensions"]) => (results: SingleResult[]) => SubagentDetails | SuspendedSnapshot,
	modelOverride: string | undefined,
): Promise<AgentToolResult<SubagentDetails | SuspendedSnapshot>> {
	const results: SingleResult[] = [];
	let previousOutput = "";
	for (let i = 0; i < chain.length; i++) {
		const r = await runChainStep(
			i,
			chain[i]!,
			chain,
			results,
			previousOutput,
			ctx,
			signal,
			onUpdate,
			agents,
			allToolNames,
			agentScope,
			discovery,
			makeDetails,
			modelOverride,
		);
		if ("early" in r) return r.early;
		results.push(r.result);
		if (r.isError) {
			const errorMsg = getResultOutput(r.result);
			const text = `Chain stopped at step ${i + 1} (${chain[i]!.agent}): ${errorMsg}`;
			return {
				content: [{ type: "text", text: appendUsageLines(text, results) }],
				details: makeDetails("chain")(results),
				isError: true,
				usage: aggregateUsageToUsage(results),
			};
		}
		previousOutput = getFinalOutput(r.result.messages);
	}
	return {
		content: [
			{
				type: "text",
				text: appendUsageLines(
					getFinalOutput(results[results.length - 1]!.messages) || "(no output)",
					results,
				),
			},
		],
		details: makeDetails("chain")(results),
		usage: aggregateUsageToUsage(results),
	};
}

async function runChainRemaining(
	remaining: Array<{ agent: string; task: string; cwd?: string; model?: string }>,
	startIndex: number,
	previousOutput: string,
	allResults: SingleResult[],
	fullChain: Array<{ agent: string; task: string; cwd?: string; model?: string }>,
	ctx: { cwd: string },
	signal: AbortSignal | undefined,
	onUpdate: OnUpdateCallback | undefined,
	agents: AgentConfig[],
	allToolNames: string[],
	agentScope: AgentScope,
	discovery: { projectAgentsDir: string | null },
	makeDetails: (mode: "single" | "parallel" | "chain", suspensions?: SuspendedSnapshot["suspensions"]) => (results: SingleResult[]) => SubagentDetails | SuspendedSnapshot,
	modelOverride: string | undefined,
): Promise<AgentToolResult<SubagentDetails | SuspendedSnapshot>> {
	let prev = previousOutput;
	for (let i = 0; i < remaining.length; i++) {
		const idx = startIndex + i;
		const r = await runChainStep(
			idx,
			remaining[i]!,
			fullChain,
			allResults,
			prev,
			ctx,
			signal,
			onUpdate,
			agents,
			allToolNames,
			agentScope,
			discovery,
			makeDetails,
			modelOverride,
		);
		if ("early" in r) return r.early;
		allResults[idx] = r.result;
		if (r.isError) {
			const errorMsg = getResultOutput(r.result);
			const text = `Chain stopped at step ${idx + 1} (${remaining[i]!.agent}): ${errorMsg}`;
			return {
				content: [{ type: "text", text: appendUsageLines(text, allResults) }],
				details: makeDetails("chain")(allResults),
				isError: true,
				usage: aggregateUsageToUsage(allResults),
			};
		}
		prev = getFinalOutput(r.result.messages);
	}
	return {
		content: [
			{
				type: "text",
				text: appendUsageLines(
					getFinalOutput(allResults[allResults.length - 1]!.messages) || "(no output)",
					allResults,
				),
			},
		],
		details: makeDetails("chain")(allResults),
		usage: aggregateUsageToUsage(allResults),
	};
}

type ChainStepOutcome =
	| { result: SingleResult; isError: boolean }
	| { early: AgentToolResult<SubagentDetails | SuspendedSnapshot> };

async function runChainStep(
	stepIndex: number,
	step: { agent: string; task: string; cwd?: string; model?: string },
	fullChain: Array<{ agent: string; task: string; cwd?: string; model?: string }>,
	results: SingleResult[],
	previousOutput: string,
	ctx: { cwd: string },
	signal: AbortSignal | undefined,
	onUpdate: OnUpdateCallback | undefined,
	agents: AgentConfig[],
	allToolNames: string[],
	agentScope: AgentScope,
	discovery: { projectAgentsDir: string | null },
	makeDetails: (mode: "single" | "parallel" | "chain", suspensions?: SuspendedSnapshot["suspensions"]) => (results: SingleResult[]) => SubagentDetails | SuspendedSnapshot,
	modelOverride: string | undefined,
): Promise<ChainStepOutcome> {
	const taskWithContext = step.task.replace(/\{previous\}/g, previousOutput);
	const chainUpdate: OnUpdateCallback | undefined = onUpdate
		? (partial) => {
				const currentResult = partial.details?.results?.[0] as SingleResult | undefined;
				if (currentResult) {
					const merged = [...results, currentResult];
					onUpdate({
						content: partial.content,
						details: makeDetails("chain")(merged),
					});
				}
			}
		: undefined;

	const outcome = await runSingleAgent(
		ctx.cwd,
		agents,
		step.agent,
		taskWithContext,
		step.cwd,
		stepIndex + 1,
		signal,
		chainUpdate,
		makeDetails("chain"),
		allToolNames,
		step.model ?? modelOverride,
		{
			kind: "chain",
			steps: fullChain,
			index: stepIndex,
			previousOutput,
			results: results.map(singleToLite),
		},
		stepIndex + 1,
	);
	if (outcome.kind === "suspended") {
		const built = buildSuspendedSnapshot("chain", [
			{ suspensionId: outcome.id, snapshot: outcome.snapshot, lastEventAtMs: outcome.lastEventAtMs },
		]);
		return {
			early: {
				content: [
					{
						type: "text",
						text: appendUsageLines(
							JSON.stringify(
								{
									status: "idle_suspended",
									suspensionId: outcome.id,
									idleMs: Date.now() - outcome.lastEventAtMs,
									runningCommand: built[0]?.runningCommand ?? null,
									requestedTimeout: built[0]?.requestedTimeout ?? null,
									tail: built[0]?.tail ?? [],
								},
								null,
								2,
							),
							[outcome.snapshot],
						),
					},
				],
				details: makeDetails("chain", built)([...results, outcome.snapshot]),
				usage: aggregateUsageToUsage([outcome.snapshot]),
			},
		};
	}
	const result = outcome.result;
	return { result, isError: isFailedResult(result) };
}

async function runParallel(
	tasks: Array<{ agent: string; task: string; cwd?: string; model?: string }>,
	ctx: { cwd: string },
	signal: AbortSignal | undefined,
	onUpdate: OnUpdateCallback | undefined,
	agents: AgentConfig[],
	allToolNames: string[],
	agentScope: AgentScope,
	discovery: { projectAgentsDir: string | null },
	makeDetails: (mode: "single" | "parallel" | "chain", suspensions?: SuspendedSnapshot["suspensions"]) => (results: SingleResult[]) => SubagentDetails | SuspendedSnapshot,
	modelOverride: string | undefined,
): Promise<AgentToolResult<SubagentDetails | SuspendedSnapshot>> {
	if (tasks.length > MAX_PARALLEL_TASKS) {
		return {
			content: [
				{
					type: "text",
					text: `Too many parallel tasks (${tasks.length}). Max is ${MAX_PARALLEL_TASKS}.`,
				},
			],
			details: makeDetails("parallel")([]),
		};
	}

	const allResults: SingleResult[] = new Array(tasks.length);
	for (let i = 0; i < tasks.length; i++) {
		allResults[i] = {
			agent: tasks[i]!.agent,
			agentSource: "unknown",
			task: tasks[i]!.task,
			exitCode: -1,
			messages: [],
			stderr: "",
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
		};
	}

	// P1: parallel-group id. Every suspension issued by this call
	// shares this groupId so `handleKill` can find siblings via
	// `getSiblingSuspensions` and merge the kill result into their
	// `completedResults` (otherwise a kill-then-resume sequence
	// would shift slots because the cursor walk would consume the
	// wrong completedResults entries — the live crash bug). Format
	// mirrors `newSuspensionId` but prefixed with `par_` to keep
	// the two namespaces visually distinct.
	const groupId = newParallelGroupId();

	const emitParallelUpdate = (suspensions?: SuspendedSnapshot["suspensions"]) => {
		if (onUpdate) {
			const running = allResults.filter((r) => r.exitCode === -1).length;
			const done = allResults.filter((r) => r.exitCode !== -1).length;
			onUpdate({
				content: [
					{ type: "text", text: `Parallel: ${done}/${allResults.length} done, ${running} running...` },
				],
				details: makeDetails("parallel", suspensions)([...allResults]),
			});
		}
	};

	const tasks_ = await mapWithConcurrencyLimit(tasks, MAX_CONCURRENCY, async (t, index) => {
		const r = await runSingleAgent(
			ctx.cwd,
			agents,
			t.agent,
			t.task,
			t.cwd,
			undefined,
			signal,
			(partial) => {
				const r0 = partial.details?.results?.[0] as SingleResult | undefined;
				if (r0) {
					allResults[index] = r0;
					emitParallelUpdate();
				}
			},
			makeDetails("parallel"),
			allToolNames,
			t.model ?? modelOverride,
			{
				kind: "parallel",
				groupId,
				tasks,
				index,
				taskSpec: t,
				completedResults: allResults
					.filter((_, i) => i !== index && allResults[i]!.exitCode !== -1)
					.map(singleToLite),
			},
			0,
		);
		if (r.kind === "suspended") {
			allResults[index] = r.snapshot;
			return { suspended: true, id: r.id, lastEventAtMs: r.lastEventAtMs, snapshot: r.snapshot } as const;
		}
		allResults[index] = r.result;
		emitParallelUpdate();
		return { suspended: false as const, result: r.result };
	});

	// N-C2: compute the suspended-index set ONCE so every
	// suspension's `completedResults` is patched with the same
	// exclusion. With multiple concurrent suspensions the
	// previous per-suspension patch (excluding only its own
	// index) caused a resume on one to consume the others as
	// if they had completed, shifting slots by one.
	const suspendedIndices = new Set<number>();
	for (let i = 0; i < tasks_.length; i++) {
		const t = tasks_[i]!;
		if ("suspended" in t && t.suspended) suspendedIndices.add(i);
	}

	const suspensions: SuspendedSnapshot["suspensions"] = [];
	let anySuspended = false;
	for (let i = 0; i < tasks_.length; i++) {
		const t = tasks_[i]!;
		if ("suspended" in t && t.suspended) {
			anySuspended = true;
			const liveSusp = getSuspension(t.id);
			if (liveSusp && liveSusp.job.kind === "parallel") {
				liveSusp.job = {
					...liveSusp.job,
					completedResults: allResults
						.filter((_, j) => !suspendedIndices.has(j))
						.map(singleToLite),
				};
			}
			const built = buildSuspendedSnapshot("parallel", [
				{ suspensionId: t.id, snapshot: t.snapshot, lastEventAtMs: t.lastEventAtMs },
			]);
			suspensions.push(built[0]!);
		}
	}

	if (anySuspended) {
		const completedResults = tasks_
			.map((t, i) => ({ t, i }))
			.filter((x) => "result" in x.t)
			.map((x) => getResultOutput((x.t as { result: SingleResult }).result));
		const suspendedText = suspensions
			.map(
				(s) =>
					`- suspensionId: ${s.suspensionId} (idleMs=${s.idleMs}, command=${s.runningCommand ?? "(none)"})`,
			)
			.join("\n");
		const baseText =
			JSON.stringify(
				{
					status: "idle_suspended",
					suspensions: suspensions.map((s) => ({
						suspensionId: s.suspensionId,
						idleMs: s.idleMs,
						runningCommand: s.runningCommand,
						requestedTimeout: s.requestedTimeout,
						tail: s.tail,
					})),
					completedCount: completedResults.length,
					totalTasks: tasks.length,
				},
				null,
				2,
			) + `\n\n${suspendedText}`;
		return {
			content: [
				{
					type: "text",
					text: appendUsageLines(baseText, allResults),
				},
			],
			details: makeDetails("parallel", suspensions)([...allResults]),
			usage: aggregateUsageToUsage(allResults),
		};
	}

	const successCount = allResults.filter((r) => !isFailedResult(r)).length;
	const summaries = allResults.map((r) => {
		const output = truncateParallelOutput(getResultOutput(r));
		const status = isFailedResult(r)
			? `failed${r.stopReason && r.stopReason !== "end" ? ` (${r.stopReason})` : ""}`
			: "completed";
		return `### [${r.agent}] ${status}\n\n${output}`;
	});
	const baseText = `Parallel: ${successCount}/${allResults.length} succeeded\n\n${summaries.join("\n\n---\n\n")}`;
	return {
		content: [
			{
				type: "text",
				text: appendUsageLines(baseText, allResults),
			},
		],
		details: makeDetails("parallel")(allResults),
		usage: aggregateUsageToUsage(allResults),
	};
}

/* -------------------------------------------------------------------------- */
/*                       Parent-process cleanup (Stage G)                     */
/* -------------------------------------------------------------------------- */

let __parentProcessCleanupRegistered = false;
function parentProcessCleanup(): void {
	if (__parentProcessCleanupRegistered) return;
	__parentProcessCleanupRegistered = true;
	const reap = () => {
		const suspended = getAllSuspensions();
		for (const s of suspended) {
			// `killProcessGroup` is the same synchronous descendant
			// walker used by the regular kill path — it SIGCONT's
			// the tree (handles the frozen case) and SIGKILL's
			// every descendant by ppid before the group-level
			// SIGKILL. Keeping this path synchronous (parent
			// `exit` / SIGINT / SIGTERM handlers run on the
			// main thread; we can't await anything here) — the
			// function is sync top-to-bottom (sync walk + sync
			// signal + sync fallback). Using the helper here
			// removes the previous pgid-only gap that would
			// have orphaned setsid grand-children on parent
			// shutdown.
			killProcessGroup(s.proc);
		}
	};

	process.on("exit", reap);

	const onSignal = (sig: NodeJS.Signals) => {
		reap();
		process.removeListener(sig, onSignal);
		process.kill(process.pid, sig);
	};
	process.on("SIGINT", onSignal);
	process.on("SIGTERM", onSignal);
}

export function __resetParentProcessCleanupForTests(): void {
	__parentProcessCleanupRegistered = false;
}

/**
 * Reset the lazy `modelsStore` cache so the remote-store lookup
 * path in `getContextWindowFor` re-reads
 * `~/.pi/agent/models-store.json` on next call.
 *
 * The cache is `null | undefined`-typed (undefined = not loaded
 * yet, null = load failed). Tests that pre-populate a fixture file
 * call this between cases; tests that exercise the "no remote
 * store" path use it to clear an earlier failed-load attempt
 * before re-trying with a present file. Safe to call when the
 * cache is already undefined (no-op).
 */
export function __resetModelsStoreForTests(): void {
	modelsStore = undefined;
}

parentProcessCleanup();
