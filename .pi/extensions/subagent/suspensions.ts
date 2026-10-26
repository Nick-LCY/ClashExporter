/**
 * suspensions — registry + process-group helpers for the idle-watchdog
 * arbitration protocol implemented by the subagent extension.
 *
 * Why this exists
 * ---------------
 * When a sub-`pi` process goes silent for too long (default 600s), the
 * parent can't simply SIGKILL it: that throws away the partial transcript
 * and breaks long-running parallel/chain jobs. Instead we SIGSTOP the
 * whole process group (frozen at the kernel level — child `pi`, its
 * bash subprocesses, the deadlock-grandchildren, all of them) and hand
 * control back to the parent LLM with a fact-only snapshot. The parent
 * then decides to `resume` / `kill` / `inspect` via a follow-up call to
 * the same subagent tool.
 *
 * This module owns the data structures and the OS-level process-group
 * plumbing. The orchestration (when to freeze, what to return, how to
 * re-enter `runSingleAgent` on resume) lives in `index.ts`.
 *
 * Module-level state
 * ------------------
 * The registry is a single `Map<SuspensionId, Suspension>` that lives
 * for the lifetime of the parent `pi` process. It is keyed by an
 * auto-incremented id; values hold a live `ChildProcess` plus the
 * resume state (`Job`) needed to continue a chain/parallel job after
 * the SIGCONT.
 *
 * Platform notes
 * --------------
 *   - POSIX: `process.kill(-pgid, signal)` operates on the whole
 *     process group. SIGSTOP freezes everyone; SIGCONT resumes; SIGKILL
 *     is unstoppable. SIGTERM is unreliable on a stopped process
 *     because the kernel doesn't deliver pending signals until the
 *     process is running again, so kill flows thaw first, then SIGKILL.
 *   - **Deep-tree signal handling**: pgid-only signaling misses any
 *     grandchild that the sub-`pi`'s bash spawned with `setsid` /
 *     `nohup` / `disown` (or via `bash &` where bash setsid-forks).
 *     Those grandchildren live in their own pgid — so a SIGSTOP to
 *     the sub-`pi`'s pgid never reaches them. To close that gap we
 *     walk the ppid tree via `collectDescendantPids()` and signal
 *     each descendant individually after the group-level signal.
 *     Freeze walks the tree after the root-group SIGSTOP (so the
 *     tree can't grow under us); thaw walks the tree BEFORE the
 *     root-group SIGCONT (so the root doesn't race ahead of us);
 *     kill walks the tree BEFORE the root-group SIGKILL (same
 *     reason — preserve kill ordering across pgid boundaries).
 *   - Windows: process groups don't exist in the POSIX sense. There is
 *     no SIGSTOP equivalent. We degrade gracefully:
 *       * `freezeProcessGroup` / `thawProcessGroup` are no-ops on win32
 *         (so `isPosixSuspendSupported()` returns `false`).
 *       * `killProcessGroup` shells out to `taskkill /pid <pid> /T /F`,
 *         which terminates the pid and its descendants synchronously.
 *         `/T` = tree, `/F` = force. Any failure is swallowed — best
 *         effort, like everything in this file.
 *
 *     Because we cannot SIGSTOP on win32, the idle watchdog there takes
 *     a different path: it directly `killProcessGroup`s the suspended
 *     sub-process instead of registering a Suspension. The comment in
 *     `index.ts` records this decision.
 */

import { spawnSync, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import type { Message } from "@earendil-works/pi-ai";

/** What kind of subagent job the suspended run belongs to. */
export type JobKind = "single" | "chain" | "parallel";

/**
 * Snapshot of the tool call that was in flight when we froze.
 *
 * `command` / `timeout` are populated only for bash calls; other tools
 * (`read`, `grep`, …) still surface the tool name so the LLM knows
 * what was hanging. Used by the `idle_suspended` snapshot returned to
 * the parent so it can decide whether to resume / kill / inspect.
 */
export interface InFlightToolCall {
	toolName: string;
	command?: string;
	timeout?: number;
}

/**
 * Resume state for chain/parallel jobs.
 *
 *   - `kind: "single"` — no extra state, the run is fully self-contained.
 *   - `kind: "chain"` — `steps[i].task` is the original spec; we replay
 *     steps from `index` onward, threading `previousOutput` from the
 *     last completed step. `results` holds the *completed* steps so the
 *     resume can stitch them back in. `previousOutput` is the last
 *     step's final output, ready to substitute into `{previous}`.
 *   - `kind: "parallel"` — `tasks` is the full original task list
 *     (length N), so on resume we can rebuild a fully-ordered result
 *     array of length N. `completedResults` is the *other* indices
 *     that finished while this one was frozen (the suspended index
 *     itself is excluded). Multiple tasks may be suspended at the
 *     same time; each registers its own `Suspension` with its own
 *     `index`. Resuming one should not stomp on the others' slots.
 */
export type Job =
	| { kind: "single" }
	| {
			kind: "chain";
			steps: Array<{
				agent: string;
				task: string;
				cwd?: string;
				model?: string;
			}>;
			index: number;
			previousOutput: string;
			results: SingleResultLite[];
	  }
	| {
			kind: "parallel";
			/**
			 * Operator-set identifier for the parallel call. Suspension
			 * registry entries with the same `groupId` are siblings in
			 * the same parallel call. `handleKill` walks siblings via
			 * this id to merge the kill result into their
			 * `completedResults`, so a later resume can rebuild the
			 * full slot array without shifting indices.
			 *
			 * Why explicit and not derived from the suspension id?
			 * Because suspension ids are minted per suspension, not
			 * per parallel call — two sibling suspensions share a
			 * groupId but have distinct ids. The id→group mapping is
			 * otherwise unstable across freezing and resuming (a
			 * re-frozen proc gets a new suspension id but stays in
			 * the same group).
			 *
			 * Format: `par_<base36-counter>_<6-hex>` mirroring
			 * `newSuspensionId`.
			 */
			groupId: string;
			tasks: Array<{ agent: string; task: string; cwd?: string; model?: string }>;
			index: number;
			taskSpec: { agent: string; task: string; cwd?: string; model?: string };
			completedResults: SingleResultLite[];
	  };

/**
 * Lightweight per-step result carried across a freeze boundary.
 *
 * The parent run builds a richer `SingleResult` for display, but for
 * the purposes of stitching chain/parallel state across a freeze we
 * only need the fields that get fed into the next step's prompt
 * (`getFinalOutput(messages)`) or assembled into the final summary.
 */
export interface SingleResultLite {
	agent: string;
	agentSource: "user" | "project" | "unknown";
	task: string;
	exitCode: number;
	messages: Message[];
	stderr: string;
	usage: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		cost: number;
		contextTokens: number;
		turns: number;
	};
	model?: string;
	/** Provider id from the first assistant message (mirrors
	 *  `SingleResult.provider` in index.ts). Needed by the resume
	 *  / chain-resume paths to resolve the model's context window
	 *  via `getBuiltinModel(provider, model)`. */
	provider?: string;
	stopReason?: string;
	errorMessage?: string;
	step?: number;
}

/**
 * A live suspended sub-process plus everything needed to resume / kill
 * / inspect it from a follow-up tool call.
 *
 * `lastEventAtMs` is the wall-clock time of the most recent stdout
 * NDJSON line OR stderr chunk. The idle watchdog updates it on every
 * line and every stderr data event; the snapshot returns
 * `Date.now() - lastEventAtMs` as `idleMs` so the parent can tell
 * whether the freeze was "just hit 600s" or "has been dead for hours".
 *
 * `activeAbortHandler` is *the* abort handler currently registered on
 * the caller's `originalSignal`. It is set at freeze time and updated
 * on resume / re-freeze so we can `detachAbortListener(..., h)` with
 * the exact function reference that was added (the previous design
 * stored a `null` placeholder and then `detachAbortListener(null)`,
 * which is a no-op and leaks the listener for the lifetime of the
 * signal). `activeAbortHandler` may be `null` if the run was started
 * without a signal or after a clean kill (which never re-attaches).
 */
export interface Suspension {
	id: string;
	proc: ChildProcess;
	inFlight: InFlightToolCall | null;
	messages: Message[];
	stderr: string;
	invocation: string;
	job: Job;
	partialResult: SingleResultLite;
	lastEventAtMs: number;
	originalSignal: AbortSignal | undefined;
	activeAbortHandler: (() => void) | null;
	/**
	 * Set by `handleKill` immediately before SIGKILL is delivered so
	 * `handleResume`'s close/error handlers can tell "natural exit"
	 * apart from "user killed me" and refuse to spawn orphan chain /
	 * parallel remaining steps. Default false.
	 */
	cancelled: boolean;
}

export type SuspensionId = string;

/* -------------------------------------------------------------------------- */
/*                              ID generation                                 */
/* -------------------------------------------------------------------------- */

let __suspensionCounter = 0;

/**
 * Mint a fresh suspension id.
 *
 * Format: `susp_<base36-counter>_<6-hex>` where the counter is
 * monotonically increasing within the process and the hex tail is a
 * random discriminator. Two suspensions minted in the same millisecond
 * still get distinct ids because of the random suffix.
 *
 * Exported so tests can pin the format without going through a real
 * freeze path.
 */
export function newSuspensionId(): SuspensionId {
	__suspensionCounter += 1;
	const tail = randomBytes(3).toString("hex");
	return `susp_${__suspensionCounter.toString(36)}_${tail}`;
}

let __groupCounter = 0;

/**
 * Mint a fresh parallel-group id.
 *
 * The id is attached to every suspension issued by the same parallel
 * call — siblings share a `groupId`, can be enumerated by
 * `getSiblingSuspensions`, and `handleKill` uses it to merge the kill
 * result into sibling `completedResults` so a later resume can
 * reconstruct the full slot array without index shift.
 *
 * Format: `par_<base36-counter>_<6-hex>` — mirrored on `newSuspensionId`
 * for consistency. The random hex tail keeps two parallel calls minted
 * in the same millisecond (e.g. nested parallel `runSingleAgent` /
 * parallel calls from a parent that itself is in a parallel fan-out)
 * from colliding when the counter wraps.
 *
 * Exported so tests can pin the format and so `runParallel` in
 * `index.ts` can mint one per call.
 */
export function newParallelGroupId(): string {
	__groupCounter += 1;
	const tail = randomBytes(3).toString("hex");
	return `par_${__groupCounter.toString(36)}_${tail}`;
}

/* -------------------------------------------------------------------------- */
/*                              Registry                                      */
/* -------------------------------------------------------------------------- */

const registry = new Map<SuspensionId, Suspension>();

/** Register a suspension. Overwrites any prior entry with the same id
 *  (shouldn't happen in practice — ids are unique). */
export function registerSuspension(s: Suspension): void {
	registry.set(s.id, s);
}

/** Look up a suspension by id; returns `undefined` when missing. */
export function getSuspension(id: SuspensionId): Suspension | undefined {
	return registry.get(id);
}

/** Drop a suspension from the registry. Idempotent — safe to call
 *  twice or after a kill that already cleaned up. */
export function unregisterSuspension(id: SuspensionId): void {
	registry.delete(id);
}

/** Snapshot of the registry, for diagnostics / parent-process sweep. */
export function getAllSuspensions(): Suspension[] {
	return Array.from(registry.values());
}

/**
 * Find all currently-suspended siblings of `excludeId` in the same
 * parallel group.
 *
 * Used by `handleKill` to merge the kill result into the siblings'
 * `completedResults` so a later resume can rebuild the full slot
 * array without index shift. Returns `[]` if the suspension is
 * missing or has no groupId (e.g. it's a single-mode or chain-mode
 * suspension — neither kind has siblings).
 *
 * Only matches `kind: "parallel"` entries; chain and single
 * suspensions are never siblings. The match is exact on `groupId`,
 * so two parallel calls running concurrently (e.g. nested under a
 * parallel parent) don't accidentally cross-pollinate.
 *
 * The registry snapshot is taken synchronously — callers should
 * enumerate once and act on the result, not assume stability across
 * subsequent mutations.
 */
export function getSiblingSuspensions(groupId: string, excludeId: SuspensionId): Suspension[] {
	if (!groupId) return [];
	const out: Suspension[] = [];
	for (const s of registry.values()) {
		if (s.id === excludeId) continue;
		if (s.job.kind !== "parallel") continue;
		if (s.job.groupId !== groupId) continue;
		out.push(s);
	}
	return out;
}

/** Test-only escape hatch: wipe the registry between cases. */
export function __clearSuspensionsForTests(): void {
	registry.clear();
	__suspensionCounter = 0;
	__groupCounter = 0;
}

/* -------------------------------------------------------------------------- */
/*                          Pure functions: snapshot                          */
/* -------------------------------------------------------------------------- */

/**
 * Find the most recent tool call whose `toolResult` has not yet been
 * recorded in `messages`.
 *
 * Walks `messages` in reverse; for each `AssistantMessage`, scans its
 * `content` in reverse for `toolCall` parts. As soon as we find one,
 * we look ahead through the trailing messages for the matching
 * `ToolResultMessage` (same `toolCallId`). If none, that tool call is
 * still in flight → return it. If every recent tool call has a result,
 * returns `null`.
 *
 * For `bash` calls we additionally fill `command` and `timeout` from
 * the call's `arguments` (cast as a partial `BashToolInput`) so the
 * parent sees exactly the command string and the timeout the agent
 * asked for.
 *
 * Pure: takes `messages`, returns a fresh object or `null`. No
 * mutation, no I/O. Safe to call from anywhere.
 */
export function extractInFlight(messages: Message[]): InFlightToolCall | null {
	const seenIds = new Set<string>();
	// Collect toolCallIds that already have a result. Walk forward once.
	for (const m of messages) {
		if (m.role === "toolResult") seenIds.add(m.toolCallId);
	}

	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i];
		if (m.role !== "assistant") continue;
		// Walk content in reverse so the most recent tool call wins.
		for (let p = m.content.length - 1; p >= 0; p--) {
			const part = m.content[p];
			if (part.type !== "toolCall") continue;
			if (seenIds.has(part.id)) continue;
			const toolName = part.name;
			if (toolName === "bash") {
				const args = (part.arguments ?? {}) as { command?: unknown; timeout?: unknown };
				const command = typeof args.command === "string" ? args.command : undefined;
				const timeout = typeof args.timeout === "number" ? args.timeout : undefined;
				return { toolName, command, timeout };
			}
			return { toolName };
		}
	}
	return null;
}

/** One line of the `tail` snapshot returned to the parent LLM. */
export interface TailEntry {
	kind: "assistant_text" | "assistant_tool_call" | "tool_result" | "stderr";
	summary: string;
}

/**
 * Maximum number of stderr lines folded into the summary.
 *
 * Sub-agents that have been running for a while can accumulate
 * thousands of stderr lines (compilers, linters, etc.). Folding all
 * of them into the tail snapshot blows past `n` and buries the recent
 * events. We keep at most this many lines (the trailing window) so
 * the summary stays scannable and the O(n) tail slice above does not
 * have to process megabytes of text.
 */
const STDERR_LINE_CAP = 200;

/**
 * Summarize the trailing events of a sub-agent run for the
 * `idle_suspended` snapshot.
 *
 * Walks `messages` in order (oldest → newest) keeping the *last* `n`
 * entries, then renders each as a one-line string. Stderr is also
 * folded in, one chunk per data event (we don't have per-event
 * timestamps for stderr so we keep the last `STDERR_LINE_CAP` lines
 * verbatim before slicing to `n`).
 *
 * For `assistant_text` parts we truncate to 120 chars so the snapshot
 * stays scannable. For `assistant_tool_call` parts we render the tool
 * name + a 60-char preview of its JSON arguments. `tool_result`
 * entries get a one-line "[ok]"/"[err]" header. Stderr lines are
 * truncated to 200 chars.
 *
 * Pure; no I/O.
 */
export function summarizeTail(messages: Message[], stderr: string, n: number): TailEntry[] {
	const out: TailEntry[] = [];

	for (const m of messages) {
		if (m.role === "assistant") {
			for (const part of m.content) {
				if (part.type === "text") {
					const text = part.text.replace(/\s+/g, " ").trim();
					out.push({
						kind: "assistant_text",
						summary: text.length > 120 ? `${text.slice(0, 120)}…` : text,
					});
				} else if (part.type === "toolCall") {
					const args = JSON.stringify(part.arguments ?? {});
					const preview = args.length > 60 ? `${args.slice(0, 60)}…` : args;
					out.push({
						kind: "assistant_tool_call",
						summary: `${part.name} ${preview}`,
					});
				}
			}
		} else if (m.role === "toolResult") {
			const head = m.isError ? "[err]" : "[ok]";
			const txt = m.content
				.filter((c) => c.type === "text")
				.map((c) => (c as { text: string }).text)
				.join(" ")
				.replace(/\s+/g, " ")
				.trim();
			const summary = txt.length > 100 ? `${txt.slice(0, 100)}…` : txt;
			out.push({
				kind: "tool_result",
				summary: summary ? `${head} ${summary}` : head,
			});
		}
	}

	if (stderr) {
		// Cap to the trailing window first so a multi-megabyte stderr
		// stream does not pay the full split cost on every snapshot.
		const lines = stderr.split("\n").filter(Boolean);
		const stderrSlice = lines.slice(-STDERR_LINE_CAP);
		for (const line of stderrSlice) {
			const trimmed = line.length > 200 ? `${line.slice(0, 200)}…` : line;
			out.push({ kind: "stderr", summary: trimmed });
		}
	}

	return out.slice(-n);
}

/* -------------------------------------------------------------------------- */
/*                          Process-group plumbing                            */
/* -------------------------------------------------------------------------- */

/** True when SIGSTOP / SIGCONT are supported on this platform. Always
 *  false on win32. */
export function isPosixSuspendSupported(): boolean {
	return process.platform !== "win32";
}

/* -------------------------------------------------------------------------- */
/*                  Descendant-tree collector (deep-signal fix)              */
/* -------------------------------------------------------------------------- */

/**
 * Collect every descendant pid of `rootPid` by walking the parent
 * pointer chain (NOT the process-group chain).
 *
 * Why ppid, not pgid?
 * --------------------
 * The sub-`pi` is spawned with `detached: true`, so it creates its own
 * process group. But grand-children that the sub-`pi`'s bash spawns
 * with `setsid` (or via `nohup`, or via any path that explicitly
 * creates a new session) sit in their OWN pgid — so a group-level
 * SIGSTOP that targets the sub-`pi`'s pgid never reaches them. The
 * kernel's `kill(-pgid, sig)` is a pgid union, not a tree walk.
 *
 * Walking ppid is correct because every spawn in Unix preserves the
 * parent-child relationship for the lifetime of the child (unless
 * the child is reparented to init via the death of its parent, which
 * still leaves the child in ppid's parent map). The grandparent
 * reaper's only effect is `ppid = 1`, which we never follow.
 *
 * Linux fast path (read every `/proc/<pid>/stat`)
 * --------------------------------
 * Each `/proc/<pid>/stat` line is `pid (comm) state ppid pgrp ...`.
 * The `comm` field can contain spaces, newlines, and parentheses
 * (kernel-truncated to 15 chars but still arbitrary), so we MUST
 * split at the LAST `)` and parse fields after it. Field 0 there is
 * `state`, field 1 is `ppid`. Number indexing is 0-based within the
 * post-`)` substring.
 *
 * POSIX fallback (`ps -eo pid=,ppid=`)
 * ------------------------------------
 * Available on macOS, BSD, and any other POSIX where `/proc` doesn't
 * exist. Less efficient (forks ps) but covers the documented support
 * matrix.
 *
 * Errors / missing processes are swallowed
 * ----------------------------------------
 * A process can vanish between `readdir(/proc)` and `readFile(stat)`
 * (classic TOCTOU). We ignore ENOENT, EACCES, and any parse error
 * — this function is best-effort by design. The caller signals
 * either way (SIGSTOP, SIGCONT, SIGKILL), so a missed descendant is
 * reaped on the next call as long as the kernel still has a record
 * of it.
 */
export function collectDescendantPids(rootPid: number): number[] {
	if (!Number.isInteger(rootPid) || rootPid <= 0) return [];
	const out: number[] = [];
	const visited = new Set<number>([rootPid]);
	// BFS frontier. We mutate `frontier` in place; descendants get
	// pushed onto `out` then onto `frontier` for the next round.
	let frontier: number[] = [rootPid];
	try {
		// Bound the BFS so a malformed /proc can't livelock the
		// parent. Each pid contributes at most one entry to the
		// visited set, and pid values are bounded by `pid_max`
		// (typically 2^22 on Linux); this cap is well above any
		// realistic tree but a million iterations is a fine
		// safety belt.
		const HARD_CAP = 1_000_000;
		while (frontier.length > 0 && visited.size < HARD_CAP) {
			// Use a snapshot of the current frontier's parent map
			// snapshot to avoid walking the whole table on every
			// BFS round. For a subagent with a benign fan-out
			// (≤ a few hundred descendants) this is much cheaper
			// than re-reading /proc once per pid.
			const parentMap = buildParentMap();
			const next: number[] = [];
			for (const parent of frontier) {
				const kids = parentMap.get(parent);
				if (!kids) continue;
				for (const k of kids) {
					if (visited.has(k)) continue;
					visited.add(k);
					out.push(k);
					next.push(k);
				}
			}
			frontier = next;
		}
	} catch {
		// Any unexpected failure (filesystem gone, ps crashed) —
		// return what we have. The callers are best-effort signal
		// dispatchers; partial coverage is strictly better than
		// throwing into the parent agent loop.
	}
	return out;
}

/** Build a parent-to-children map for the local process table.
 *
 *  Linux: read every `/proc/<pid>/stat` directly. Each line is
 *  parsed for `(pid, ppid)`; the comm field's parentheses are
 *  skipped by splitting at the LAST `)`.
 *
 *  macOS / other POSIX: shell out to `ps -eo pid=,ppid=` and parse
 *  the two-column output. We use `=` to suppress the header.
 *
 *  Parsing failures (vanished pids, bad files, permission errors)
 *  are all swallowed — this is a snapshot, not a transaction.
 */
function buildParentMap(): Map<number, number[]> {
	const map = new Map<number, number[]>();
	if (process.platform === "linux") {
		try {
			const procDir = "/proc";
			const entries = readdirSync(procDir);
			for (const entry of entries) {
				// /proc entries are either numeric (a pid) or things
				// like "self", "cpuinfo", "loadavg". Skip non-numeric
				// without an extra regex call.
				if (!/^\d+$/.test(entry)) continue;
				const pid = Number(entry);
				let stat: string;
				try {
					stat = readFileSync(`${procDir}/${entry}/stat`, "utf8");
				} catch {
					// Process vanished or unreadable; skip.
					continue;
				}
				const ppid = parseLinuxPpidFromStat(stat);
				if (ppid === null) continue;
				let bucket = map.get(ppid);
				if (!bucket) {
					bucket = [];
					map.set(ppid, bucket);
				}
				bucket.push(pid);
			}
		} catch {
			/* swallow — return what we have */
		}
		return map;
	}
	// macOS / BSD fallback: ps -eo pid=,ppid=
	try {
		const out = spawnSync("ps", ["-eo", "pid=,ppid="], { encoding: "utf8" });
		if (out.status !== 0 || !out.stdout) return map;
		for (const line of out.stdout.split("\n")) {
			const trimmed = line.trim();
			if (!trimmed) continue;
			// Two columns separated by whitespace. Columns may be
			// padded; trim aggressively.
			const cols = trimmed.split(/\s+/);
			if (cols.length < 2) continue;
			const pid = Number(cols[0]);
			const ppid = Number(cols[1]);
			if (!Number.isInteger(pid) || !Number.isInteger(ppid)) continue;
			if (pid <= 0 || ppid < 0) continue;
			let bucket = map.get(ppid);
			if (!bucket) {
				bucket = [];
				map.set(ppid, bucket);
			}
			bucket.push(pid);
		}
	} catch {
		/* swallow */
	}
	return map;
}

/** Parse the ppid out of a single `/proc/<pid>/stat` line.
 *
 *  Returns null on any parse failure so the caller can skip the
 *  entry. The `comm` field can contain spaces, newlines, and
 *  parentheses (kernel-truncated to 15 chars but still arbitrary),
 *  so we MUST split at the LAST `)` and parse fields after it.
 *  Field 0 there is `state`, field 1 is `ppid`. */
function parseLinuxPpidFromStat(stat: string): number | null {
	if (!stat) return null;
	const lastParen = stat.lastIndexOf(")");
	if (lastParen < 0) return null;
	const after = stat.slice(lastParen + 1).trimStart();
	if (!after) return null;
	// Split on whitespace. The first token is state (e.g. "S"),
	// the second is ppid (e.g. "1").
	const tokens = after.split(/\s+/);
	if (tokens.length < 2) return null;
	const ppid = Number(tokens[1]);
	if (!Number.isInteger(ppid) || ppid < 0) return null;
	return ppid;
}

/** Send `signal` to each pid in `pids`, swallowing ESRCH (no such
 *  process) and any other failure. Errors should NEVER propagate:
 *  this is the inner loop of freeze/thaw/kill and the parent agent
 *  must not crash on a permission denied or vanished pid. */
export function signalPids(pids: number[], signal: NodeJS.Signals): void {
	for (const pid of pids) {
		try {
			process.kill(pid, signal);
		} catch {
			/* swallow — ESRCH, EPERM, etc. */
		}
	}
}

/**
 * Send `signal` to every descendant of `proc.pid` by ppid tree
 * walk. Used by callers that already signal the root themselves
 * but want the deep-tree coverage too (e.g. the polite SIGTERM
 * path in `attachSignalListener` and the inline abort handler in
 * `index.ts`). Errors are swallowed.
 *
 * Returns the list of descendants that were signalled (or
 * `[]` when the platform is win32 / the proc has no pid).
 * Exported for the inline abort handler in `index.ts`.
 */
export function signalDescendants(proc: ChildProcess, signal: NodeJS.Signals): number[] {
	const pid = proc.pid;
	if (!pid) return [];
	if (process.platform === "win32") return [];
	const descendants = collectDescendantPids(pid);
	signalPids(descendants, signal);
	return descendants;
}

/* -------------------------------------------------------------------------- */
/*                        Group-level signal helpers                          */
/* -------------------------------------------------------------------------- */

/**
 * Freeze a process group AND every descendant via SIGSTOP.
 *
 * POSIX: `process.kill(-pgid, "SIGSTOP")` first (root pgid, blocking
 * new descendant creation), then walk the ppid tree and SIGSTOP each
 * descendant individually. SIGSTOP'ing the root group first prevents
 * the tree from growing under us while we walk it.
 *
 * Why per-pid after the group?
 * -----------------------------
 * The root pgid is the sub-`pi`'s own group. The sub-`pi`'s bash
 * is in the same group (fork-without-setsid preserves pgid). But
 * any grandchild that the bash spawned with `setsid` / `nohup` /
 * `disown` / `bash &` (when bash setsid-forks) lives in its own
 * pgid — so a SIGSTOP to the root pgid does NOT reach it. We
 * collect descendants by ppid and SIGSTOP each one to reach across
 * pgid boundaries.
 *
 * Returns `true` on the root pgid success path even if a descendant
 * SIGSTOP'd failed for some unusual reason (the existing best-effort
 * contract: partial freezing is better than not freezing at all).
 *
 * Windows: no-op. Returns false so callers know the freeze didn't
 * happen and should fall back to a direct kill instead of registering
 * a suspension (which would dangle forever).
 *
 * Any failure is caught and surfaced as `false`; best-effort by
 * design. We never want a SIGSTOP failure to crash the parent agent
 * loop.
 */
export function freezeProcessGroup(proc: ChildProcess): boolean {
	if (!isPosixSuspendSupported()) return false;
	const pgid = proc.pid;
	if (!pgid) return false;
	let rootOk = false;
	try {
		process.kill(-pgid, "SIGSTOP");
		rootOk = true;
	} catch {
		// Root group SIGSTOP failed. Still try to walk the tree
		// best-effort — if the group is already partially reaped
		// the descendants might still be SIGSTOP'able.
	}
	// Walk deep tree. Reverse order so deepest descendants freeze
	// first (topological-ish: leaves before internal nodes).
	const descendants = collectDescendantPids(pgid);
	signalPids(descendants.slice().reverse(), "SIGSTOP");
	return rootOk;
}

/**
 * Resume a frozen process group AND every descendant via SIGCONT.
 *
 * Walk first, then SIGCONT the root group. Reason: if we SIGCONT
 * the root pgid first, the root can race ahead and signal its
 * children before we reach them — leaving a window where the
 * children are still SIGSTOP'd while the parent thinks they are
 * running. Doing descendants first guarantees the entire tree is
 * coherent when the root wakes up.
 *
 * Symmetric to `freezeProcessGroup`. No-op on win32. Failures
 * (already running, no such process, EPERM) are swallowed.
 */
export function thawProcessGroup(proc: ChildProcess): boolean {
	if (!isPosixSuspendSupported()) return false;
	const pgid = proc.pid;
	if (!pgid) return false;
	// Walk fresh — the tree may have changed since freeze time
	// (e.g. a long-running child forked its own subprocess while
	// frozen; SIGSTOP doesn't prevent fork, only execution).
	const descendants = collectDescendantPids(pgid);
	// Thaw descendants first so the root waking up doesn't race
	// with us on its own children.
	signalPids(descendants, "SIGCONT");
	try {
		process.kill(-pgid, "SIGCONT");
		return true;
	} catch {
		return false;
	}
}

/**
 * Forcibly terminate a process group AND every descendant.
 *
 * POSIX: walk the ppid tree and SIGKILL each descendant, then send
 * SIGKILL to the entire group as a final sweep. SIGKILL is delivered
 * immediately by the kernel even when the target is SIGSTOP'd
 * (unlike SIGTERM, which is queued pending SIGCONT), so descendants
 * that were frozen by `freezeProcessGroup` are killed without
 * needing a thaw step.
 *
 * Windows: no SIGKILL analog. We spawn `taskkill /pid <pid> /T /F`
 * which walks the process tree and force-terminates each node. `/T`
 * (tree) catches children the sub-`pi` spawned; `/F` (force) skips
 * the polite "are you sure?" prompt. The taskkill path is already
 * tree-aware so we don't need to manually walk the ppid tree.
 *
 * Any error from either branch is swallowed: we are a best-effort
 * cleaner, and the alternative is a leaked child process.
 */
export function killProcessGroup(proc: ChildProcess): void {
	const pid = proc.pid;
	if (!pid) return;
	if (process.platform === "win32") {
		try {
			spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], {
				stdio: "ignore",
				windowsHide: true,
			});
		} catch {
			/* swallow */
		}
		return;
	}
	// Walk fresh — children may have been forked while the proc
	// was frozen (SIGSTOP doesn't block fork). Reverse order so
	// deepest descendants die first.
	const descendants = collectDescendantPids(pid);
	signalPids(descendants.slice().reverse(), "SIGKILL");
	try {
		process.kill(-pid, "SIGKILL");
	} catch {
		try {
			// Fallback: SIGKILL just the pid, not the group. Some
			// kernels refuse negative pid if the group has already
			// been partially reaped.
			process.kill(pid, "SIGKILL");
		} catch {
			/* swallow */
		}
	}
}

/* -------------------------------------------------------------------------- */
/*                            AbortSignal helpers                             */
/* -------------------------------------------------------------------------- */

/**
 * Options for {@link attachSignalListener}.
 *
 * `isSuspended` is an optional getter that, if it returns `true`,
 * short-circuits the abort handler so a user Ctrl+C delivered while
 * the sub-process is SIGSTOP'd does NOT issue a polite SIGTERM — the
 * kernel would only queue it (SIGTERM is delivered on SIGCONT) and
 * the process would die right after resume, even if the LLM wanted
 * to keep going. Pass a closure over a `let suspended = false` flag
 * in your run scope and the freeze path flips it before detaching.
 *
 * The `proc.exitCode !== null` check is always present as a
 * belt-and-braces defence: a dead process should not receive any
 * signal.
 */
export interface AttachAbortListenerOptions {
	/** Return `true` while this run's process group is frozen
	 *  (SIGSTOP). Handler will be a no-op in that state. */
	isSuspended?: () => boolean;
}

/**
 * Register an abort handler on `signal` and remember it so we can
 * detach later.
 *
 * Returns the handler that was registered, or `null` if `signal` is
 * undefined. The handler issues a polite SIGTERM (with a 5s SIGKILL
 * fallback) to the entire process group, so a user hitting Ctrl+C
 * during a sub-agent run kills the bash subprocess as well, not just
 * the parent `pi`.
 */
export function attachSignalListener(
	signal: AbortSignal | undefined,
	proc: ChildProcess,
	options: AttachAbortListenerOptions = {},
): (() => void) | null {
	if (!signal) return null;
	const handler = () => {
		// Defensive gate. Order matters:
		//   1. already-dead process (`exitCode !== null`) — ESRCH if
		//      we tried to signal it.
		//   2. currently frozen — SIGTERM would be queued until
		//      SIGCONT, which then runs into the parent's resume /
		//      kill decision. Both wrong; just no-op.
		if (proc.exitCode !== null) return;
		if (options.isSuspended?.()) return;
		// Best-effort polite terminate. We walk the ppid tree
		// before the group-level SIGTERM so a `setsid` grandchild
		// in its own pgid receives the polite shutdown too —
		// otherwise it would silently orphan to PPID=1 when the
		// shim exits and continue holding whatever port / file
		// lock it had grabbed. The 5s SIGKILL fallback uses
		// `killProcessGroup` which already walks the tree.
		if (proc.pid) {
			signalDescendants(proc, "SIGTERM");
			try {
				process.kill(-proc.pid, "SIGTERM");
			} catch {
				/* swallow */
			}
		}
		setTimeout(() => {
			// Use exitCode/signalCode rather than `proc.killed` —
			// `proc.killed` only flips to true when `kill()` is
			// called on the *ChildProcess* handle itself, not when
			// we signal the process group via `process.kill(-pid)`
			// (which we do for both SIGTERM and the SIGKILL
			// fallback). The process might already be dead (code
			// set) but `proc.killed` would still be false, leaving
			// the fallback to fire on a corpse.
			if (proc.exitCode === null && proc.signalCode === null) killProcessGroup(proc);
		}, 5000);
	};
	if (signal.aborted) handler();
	else signal.addEventListener("abort", handler, { once: true });
	return handler;
}

/**
 * Detach a previously-registered abort handler.
 *
 * Safe to call with `null` (no-op). Idempotent: the second call with
 * the same handler is also a no-op because the listener is already
 * removed.
 */
export function detachAbortListener(signal: AbortSignal | undefined, handler: (() => void) | null): void {
	if (!signal || !handler) return;
	try {
		signal.removeEventListener("abort", handler);
	} catch {
		/* swallow */
	}
}

/**
 * Re-attach an abort handler after a resume.
 *
 * On the second leg of a chain/parallel job we need the user's
 * AbortSignal to work again — without re-registering, Ctrl+C would be
 * silently ignored because the first abort handler was detached
 * before the freeze.
 *
 * Pass the same `isSuspended` getter used at freeze time so the
 * resumed handler short-circuits identically on a second freeze.
 */
export function reAttachAbortListener(
	signal: AbortSignal | undefined,
	proc: ChildProcess,
	options: AttachAbortListenerOptions = {},
): (() => void) | null {
	return attachSignalListener(signal, proc, options);
}