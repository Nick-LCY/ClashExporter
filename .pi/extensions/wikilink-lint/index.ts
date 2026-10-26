/**
 * wikilink-lint — hard-enforce docs wikilink validity.
 *
 * Convention (see docs conventions / archivist agent):
 *   - File references inside docs/ use wikilink syntax [[path]]
 *   - Paths are relative to docs/
 *   - Wikilinks may only point to files inside docs/ (not code, not repo-external)
 *
 * This extension blocks `write` / `edit` tool calls whose resulting docs/*.md
 * content contains a wikilink that escapes docs/ or points to a missing file.
 * It is intentionally non-intrusive: prose paths and Markdown links [t](u)
 * are ignored — only actual [[...]] wikilinks are validated.
 *
 * Hard-block rationale: archivist should create the link target first, then
 * add the link. Blocking enforces that ordering instead of leaving dead links.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { describeIssues, lintLinks } from "./lint.ts";

const DOCS_DIR = "docs";

interface EditOp {
	oldText: string;
	newText: string;
}

interface WriteInput {
	path: string;
	content: string;
}

interface EditInput {
	path: string;
	edits: EditOp[];
}

type ToolInput = Partial<WriteInput & EditInput>;

/** Apply edit ops to current content. oldText is unique per edit (tool contract). */
function applyEdits(original: string, edits: EditOp[]): string {
	let result = original;
	for (const op of edits) {
		const idx = result.indexOf(op.oldText);
		if (idx === -1) continue; // unlocatable; the edit tool itself would error
		result = result.slice(0, idx) + op.newText + result.slice(idx + op.oldText.length);
	}
	return result;
}

/** True if `absPath` is a regular file under <cwd>/docs/. */
function isDocsMarkdown(cwd: string, absPath: string): boolean {
	if (!absPath.endsWith(".md")) return false;
	const rel = relative(cwd, absPath);
	return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && (rel === DOCS_DIR || rel.startsWith(`${DOCS_DIR}${sep}`));
}

export default function (pi: ExtensionAPI) {
	pi.on("tool_call", async (event, ctx) => {
		const toolName: string = event.toolName;
		if (toolName !== "write" && toolName !== "edit") return;

		const input = event.input as ToolInput;
		const filePath: string | undefined = input.path;
		if (!filePath) return;

		const absPath = resolve(ctx.cwd, filePath);
		if (!isDocsMarkdown(ctx.cwd, absPath)) return;

		const docsRoot = join(ctx.cwd, DOCS_DIR);

		let finalText: string;
		if (toolName === "write") {
			finalText = input.content ?? "";
		} else {
			// edit: reconstruct the resulting file content, then lint it.
			let current = "";
			try {
				current = readFileSync(absPath, "utf8");
			} catch {
				current = "";
			}
			finalText = applyEdits(current, input.edits ?? []);
		}

		const issues = lintLinks(finalText, docsRoot);
		if (issues.length > 0) {
			return { block: true, reason: describeIssues(issues) };
		}
	});
}
