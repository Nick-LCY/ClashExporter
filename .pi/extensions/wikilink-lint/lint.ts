/**
 * Wikilink linting — pure logic, no pi dependency.
 *
 * Convention enforced by the wikilink-lint extension:
 *   - File references in docs use wikilink syntax: [[path]]
 *   - Paths are relative to the docs/ directory (the "docs root")
 *   - Wikilinks may ONLY point to files inside docs/ (no code, no repo-external)
 *
 * This module is import-safe and unit-testable without the pi runtime.
 */

import { existsSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

export type WikilinkIssueKind = "out-of-docs" | "absolute" | "not-found";

export interface WikilinkIssue {
	/** The full wikilink as written, e.g. [[../src/index.ts]]. */
	raw: string;
	/** Extracted docs-relative file path, or "" when there is none. */
	target: string;
	kind: WikilinkIssueKind;
}

/** Matches [[ ... ]]. Inner content may not contain brackets. */
const WIKILINK_RE = /\[\[([^\[\]]+?)\]\]/g;

/**
 * Extract wikilink targets from markdown text.
 *
 * Handles aliases and anchors:
 *   [[a/b.md]]              -> a/b.md
 *   [[a/b.md|Alias]]        -> a/b.md   (alias after first |)
 *   [[a/b.md#Heading]]      -> a/b.md   (anchor after first #)
 *   [[a/b.md#H|Alias]]      -> a/b.md
 *   [[a/b.md\|Alias]]      -> a/b.md   (escaped \| inside a Markdown table cell)
 *   [[#Heading]]            -> ""        (same-file anchor, no file)
 */
export function extractWikilinkTargets(text: string): { raw: string; target: string }[] {
	const out: { raw: string; target: string }[] = [];
	for (const match of text.matchAll(WIKILINK_RE)) {
		const raw = match[0];
		const inner = match[1];
		// Drop alias: the separator is "|", but inside Markdown table cells it is
		// escaped as "\|". Split on either, take the part before it; then drop any
		// anchor ("#heading").
		const filePart = inner.split(/\\\||\|/)[0].split("#")[0].trim();
		out.push({ raw, target: filePart });
	}
	return out;
}

/**
 * Validate every wikilink in `text`.
 *
 * @param text     The (final) markdown content of a docs file.
 * @param docsRoot Absolute path to the docs/ directory. Wikilink paths are
 *                 resolved against this root.
 * @returns Issues for links that escape docs/, use absolute paths, or point
 *          to non-existent (or non-file) targets.
 */
export function lintLinks(text: string, docsRoot: string): WikilinkIssue[] {
	const issues: WikilinkIssue[] = [];

	for (const { raw, target } of extractWikilinkTargets(text)) {
		// [[#anchor]] and [[ |alias]] with no file -> nothing to validate.
		if (target === "") continue;

		if (isAbsolute(target)) {
			issues.push({ raw, target, kind: "absolute" });
			continue;
		}

		const abs = resolve(docsRoot, target);
		const rel = relative(docsRoot, abs);

		// Escaped docs/ (or targets the docs root dir itself).
		if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`)) {
			issues.push({ raw, target, kind: "out-of-docs" });
			continue;
		}

		// Must exist and be a regular file.
		if (!existsSync(abs) || !statSync(abs).isFile()) {
			issues.push({ raw, target, kind: "not-found" });
		}
	}

	return issues;
}

/** Human-readable, LLM-facing message for a set of issues. */
export function describeIssues(issues: WikilinkIssue[]): string {
	const lines = issues.map((issue) => {
		const why =
			issue.kind === "out-of-docs"
				? "指向 docs/ 之外——wikilink 仅可引用文档库内的内容"
				: issue.kind === "absolute"
					? "使用了绝对路径——wikilink 必须相对 docs/"
					: "目标文件不存在";
		return `  • ${issue.raw} — ${why}`;
	});

	return [
		"wikilink-lint：以下 wikilink 不合规，已阻断写入：",
		...lines,
		"请先创建缺失文件、改为指向 docs/ 内已存在的文档，或对库外内容（如代码）改用普通文字 / 行内代码描述，然后重试。",
	].join("\n");
}
