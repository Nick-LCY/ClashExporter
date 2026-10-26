/**
 * bash-guard — enforce a sane default timeout on every bash tool call,
 * and teach the agent when that default fired.
 *
 * Why this exists
 * ---------------
 * Sub-agents (and the main agent) routinely run long-lived bash commands.
 * Without a default timeout, a deadlock or runaway process can hang the
 * sub-agent forever, which in turn hangs the parent chain. The parent
 * layer (subagent extension) has a 600s idle watchdog + SIGSTOP freeze
 * protocol, but that only kicks in after the child has been silent for
 * 10 minutes. A default timeout catches the common case of "I forgot to
 * pass `--timeout`" much earlier.
 *
 * Behavior
 * --------
 *   - Subscribes to `tool_call` and narrows on the built-in `bash` tool
 *     via `isToolCallEventType("bash", event)`.
 *   - If the caller did NOT pass `timeout` (undefined / null), inject
 *     `DEFAULT_BASH_TIMEOUT_S` (300 seconds) into the mutable
 *     `event.input`. Pi mutates this in place before invoking the bash
 *     executor, so the timeout actually takes effect. We also stamp the
 *     call id into `injectedDefaultTimeouts` so we can recognize, in the
 *     matching `tool_result`, that *this* call was the one whose default
 *     we silently injected.
 *   - If the caller DID pass a `timeout` (including 0, which some shells
 *     treat as "wait forever"), respect it verbatim — we never lower or
 *     raise an explicit choice. A sub-agent that explicitly opts into a
 *     900-second window for a known-slow command keeps that window, and
 *     the matching `tool_result` is NOT taught (nothing to teach).
 *
 *   - On `tool_result`, when the call's id is in `injectedDefaultTimeouts`,
 *     the result is `isError`, and any text content mentions a timeout
 *     ("timeout", "timed out", "timed-out"), we append a single short,
 *     factual note explaining that the default was applied and how to opt
 *     out next time. This only patches `content` (per the partial-patch
 *     contract in pi's `tool_result` event); `isError`, `details`, and
 *     `usage` are left untouched. The id is deleted from the map on every
 *     `tool_result` regardless of branch, so the map never leaks.
 *
 *   Two complementary hints surface the same fact at two layers:
 *     - **tool_result hint (here)**: when a bash call *did* time out and
 *       *did* have the default injected, teach the agent in the moment.
 *     - **subagent runtime note (`subagent` extension)**: pre-declare the
 *       default to the sub-agent at spawn time so it knows up front. Both
 *     share `resolveDefaultTimeoutS()` so the env-override hook is honored
 *     by both sides.
 *
 * Side effects / scope
 * --------------------
 *   - Applies to BOTH the main agent and every spawned sub-agent (the
 *     subagent extension does not filter children out of bash-guard).
 *     This is intentional: any process that can issue an unbounded
 *     `bash` is exactly the kind of process we want a safety net on.
 *   - Has no effect on other tools (read, write, edit, grep, …). They
 *     do not have timeout knobs in pi's tool surface today.
 *
 * Testing hook
 * ------------
 *   - `BASH_GUARD_DEFAULT_TIMEOUT_S` (number) overrides the default for
 *     tests and ops that want a tighter or looser default. Illegal
 *     values (non-numeric, negative, zero) are silently ignored — falling
 *     back to `DEFAULT_BASH_TIMEOUT_S` — so a typo never leaves the
 *     agent with zero protection.
 *   - `__getTrackedDefaultInjectionCountForTests` lets the test suite
 *     observe the map's size without poking at internals.
 *
 * No persistent state is held by this extension beyond the per-call
 * tracking map; the map is bounded by in-flight tool calls and is
 * drained by every `tool_result`.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isBashToolResult, isToolCallEventType } from "@earendil-works/pi-coding-agent";

/** Hard-coded default timeout in seconds. 300 = 5 minutes. */
export const DEFAULT_BASH_TIMEOUT_S = 300;

/** Env var name used to override the default at runtime (testing hook). */
const ENV_OVERRIDE = "BASH_GUARD_DEFAULT_TIMEOUT_S";

/**
 * Resolve the effective default timeout from `process.env`.
 *
 * Returns `DEFAULT_BASH_TIMEOUT_S` when the env var is unset, blank,
 * non-numeric, zero, negative, or `NaN`. Any other positive number
 * (including fractional seconds) is returned as-is.
 *
 * Exported so the unit test suite can exercise every branch without
 * having to spin up a real pi host.
 */
export function resolveDefaultTimeoutS(env: NodeJS.ProcessEnv = process.env): number {
	const raw = env[ENV_OVERRIDE];
	if (raw === undefined || raw === null || raw === "") return DEFAULT_BASH_TIMEOUT_S;
	const n = Number(raw);
	if (!Number.isFinite(n) || n <= 0) return DEFAULT_BASH_TIMEOUT_S;
	return n;
}

/**
 * Tracks toolCallIds for which we injected the default timeout.
 *
 * - `tool_call` adds an entry iff we injected (input.timeout was undefined
 *   or null). Explicit timeouts are never tracked, so a tool_result
 *   for an explicit-timeout call will see no entry and stay silent.
 * - `tool_result` deletes the entry unconditionally (even if the id was
 *   absent), so the map is bounded by in-flight tool calls.
 *
 * The id is what `isBashToolResult(event)` leaves accessible on the
 * narrowed event, so we use it as the map key.
 */
const injectedDefaultTimeouts = new Map<string, true>();

/**
 * Debug-only: returns the current size of the injection-tracking map.
 * Used by the test suite to assert that `tool_result` always drains the
 * map regardless of which branch it took. Not exported from any public
 * surface area; unit tests reach it via direct module import.
 */
export function __getTrackedDefaultInjectionCountForTests(): number {
	return injectedDefaultTimeouts.size;
}

/** Regex matched against the textual content of a bash `tool_result`.
 *  Intentionally generous so it catches both pi's stock error wording
 *  ("Command timed out after N seconds") and anything downstream that
 *  rewords it. Only runs against text items, not image content. */
const TIMEOUT_TEXT_PATTERN = /timed?[- ]?out|timeout/i;

/**
 * Build the factual hint line that gets appended to a bash tool result
 * content array when the default timeout actually fired.
 *
 * Kept as a pure function so the test suite can assert the exact wording
 * without re-deriving it from the source.
 */
export function buildBashGuardHint(defaultTimeoutS: number): string {
	return `bash-guard: no explicit timeout was passed, so the default ${defaultTimeoutS}s was applied. Pass a "timeout" parameter (seconds) for commands that legitimately need longer.`;
}

export default function (pi: ExtensionAPI) {
	const defaultTimeoutS = resolveDefaultTimeoutS();
	const hintText = buildBashGuardHint(defaultTimeoutS);

	pi.on("tool_call", (event) => {
		if (!isToolCallEventType("bash", event)) return;
		// Only inject when the caller left it undefined / null. Anything
		// else — including 0, which some users use to opt into "wait
		// forever" — is an explicit choice we must respect.
		if (event.input.timeout === undefined || event.input.timeout === null) {
			event.input.timeout = defaultTimeoutS;
			injectedDefaultTimeouts.set(event.toolCallId, true);
		}
	});

	pi.on("tool_result", (event) => {
		// Always drain the tracking map regardless of which branch we
		// take below. `.delete()` is a no-op when the id was absent
		// (i.e. the caller passed an explicit timeout), which is the
		// cheap, safe way to keep the map bounded by in-flight calls.
		const callId = event.toolCallId;
		const wasInjected = injectedDefaultTimeouts.delete(callId);

		// Only teach when ALL of the following hold:
		//   1. The result is for the built-in bash tool.
		//   2. We injected the default for this specific call id.
		//   3. Pi marked the result as an error (successes never time
		//      out, so teaching then would just be noise).
		//   4. Some text content actually mentions a timeout — guards
		//      against teaching on a non-timeout isError (e.g. exit
		//      code != 0) that we shouldn't mis-attribute to timeout.
		if (!isBashToolResult(event)) return;
		if (!wasInjected) return;
		if (!event.isError) return;
		const mentionsTimeout = event.content.some(
			(part) => part.type === "text" && TIMEOUT_TEXT_PATTERN.test(part.text),
		);
		if (!mentionsTimeout) return;

		// Partial patch on `content` only — isError / details / usage
		// are left untouched per the pi `tool_result` partial-patch
		// contract.
		return {
			content: [...event.content, { type: "text", text: hintText }],
		};
	});
}