/**
 * Chat Attached-Only Mode ("Continue-style" chat) for Pi / Pi Desktop.
 *
 * Goal: the model may ONLY use the file contents the user attached to the
 * message. It never reads, searches, lists, edits or runs anything, so it
 * cannot follow imports/includes into other files. Answers are plain fenced
 * code blocks shown in the chat; the user then decides to Apply (existing
 * file), Create (new file) or Copy them.
 *
 * Pi Desktop inlines attached text files into the prompt inside blocks like:
 *   ===== BEGIN UNTRUSTED ATTACHED FILE: foo.php =====
 *   ...content...
 *   ===== END UNTRUSTED ATTACHED FILE: foo.php =====
 * so no read tool is needed for them.
 *
 * Controls:
 *   --chat-attached-only   Start with the mode enabled.
 *   /chat-mode             Toggle the mode.
 *   /chat-allow <path>     Opt-in: allow reading one specific path
 *                          (for @-mentioned files). Adds the read tool.
 *   /chat-apply [path]     Apply/Create: write the last code block from the
 *                          last assistant message to <path> (or the block's
 *                          own "File:" hint).
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";

const STATUS_KEY = "chat-attached-only";

const CHAT_MODE_PROMPT = `## Chat Mode (attached files only)

You are in Chat Mode. You may ONLY use the file contents the user attached to
their message. Attached files appear as blocks delimited by
"===== BEGIN UNTRUSTED ATTACHED FILE: <name> =====".

Rules:
- Do NOT read, search, list, grep or otherwise inspect the filesystem, and do
  NOT run shell commands. The files you need are already in the conversation.
- Even when the attached code imports, requires, includes or references other
  files, DO NOT try to access those files. If you truly need a file that was
  not attached, ask the user to attach it instead of looking for it.
- Do NOT edit or create files on disk. Never claim you changed something.
- Answer with the code directly in the chat, inside fenced code blocks. Put the
  target file on the line right before each fence, e.g.:
      File: app/Models/User.php
      \`\`\`php
      ...
      \`\`\`
  For a brand new file, label it "New file: path/to/file.ext".
- Only show the parts that change when the user asks for a small edit; show the
  whole file when they ask to create or rewrite it.
- Reply in the user's language.`;

type CodeBlock = { lang: string; code: string; hint?: string };

/** Extract fenced code blocks, picking up an optional "File:" hint line. */
function extractCodeBlocks(text: string): CodeBlock[] {
	const blocks: CodeBlock[] = [];
	const fence = /```([^\n`]*)\n([\s\S]*?)```/g;
	let match: RegExpExecArray | null;
	while ((match = fence.exec(text)) !== null) {
		const beforeLines = text
			.slice(0, match.index)
			.replace(/\n+$/, "")
			.split("\n");
		const lineBefore = beforeLines[beforeLines.length - 1] ?? "";
		const hint = lineBefore.match(
			/(?:File|New file|Path|Archivo|Nuevo archivo|Ruta)\s*:\s*(.+?)\s*$/i,
		);
		blocks.push({ lang: match[1].trim(), code: match[2], hint: hint?.[1] });
	}
	return blocks;
}

/** Text of the most recent assistant message in the active branch. */
function lastAssistantText(ctx: ExtensionCommandContext): string {
	const branch = ctx.sessionManager.getBranch() as Array<{
		type?: string;
		message?: { role?: string; content?: unknown };
	}>;
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i];
		if (entry?.type !== "message" || entry.message?.role !== "assistant") continue;
		const content = entry.message.content;
		if (typeof content === "string") return content;
		if (Array.isArray(content)) {
			return content
				.filter((c): c is { type: string; text: string } =>
					!!c && typeof c === "object" && (c as { type?: string }).type === "text",
				)
				.map((c) => c.text)
				.join("\n");
		}
	}
	return "";
}

function normalize(path: string, cwd: string): string {
	return resolve(cwd, path);
}

export default function chatAttachedOnly(pi: ExtensionAPI): void {
	let enabled = false;
	let savedTools: string[] | null = null;
	const allowedPaths = new Set<string>();

	pi.registerFlag("chat-attached-only", {
		description: "Start in chat mode: only attached files, no tools, code in chat",
		type: "boolean",
		default: false,
	});

	function updateStatus(ctx: ExtensionContext): void {
		ctx.ui.setStatus(
			STATUS_KEY,
			enabled ? ctx.ui.theme.fg("accent", "💬 chat-only") : undefined,
		);
	}

	function applyToolSet(): void {
		try {
			if (allowedPaths.size > 0) pi.setActiveTools(["read"]);
			else pi.setActiveTools([]);
		} catch {
			/* empty tool set not allowed: tool_call guard still enforces it */
		}
	}

	function setEnabled(next: boolean, ctx: ExtensionContext): void {
		if (next === enabled) return;
		if (next) {
			savedTools = pi.getActiveTools();
			enabled = true;
			applyToolSet();
		} else {
			enabled = false;
			pi.setActiveTools(savedTools ?? ["read", "bash", "edit", "write"]);
			savedTools = null;
		}
		updateStatus(ctx);
	}

	pi.on("session_start", async (_event, ctx) => {
		if (pi.getFlag("chat-attached-only")) {
			enabled = true;
			applyToolSet();
		}
		updateStatus(ctx);
	});

	pi.on("before_agent_start", async (event) => {
		if (!enabled) return;
		return { systemPrompt: `${event.systemPrompt}\n\n${CHAT_MODE_PROMPT}` };
	});

	// Defense in depth: block anything that could touch the filesystem.
	pi.on("tool_call", async (event, ctx) => {
		if (!enabled) return;
		if (event.toolName === "read") {
			const path = (event.input as { path?: string }).path;
			if (path && allowedPaths.has(normalize(path, ctx.cwd))) return;
			return {
				block: true,
				reason:
					"Chat Mode: reading is disabled. Use only the attached files, or /chat-allow <path> to permit this one.",
			};
		}
		return {
			block: true,
			reason: `Chat Mode: the "${event.toolName}" tool is disabled. Answer with code in the chat instead.`,
		};
	});

	pi.registerCommand("chat-mode", {
		description: "Toggle chat mode (attached files only, no tools, code in chat)",
		handler: async (_args, ctx) => {
			setEnabled(!enabled, ctx);
			ctx.ui.notify(
				enabled
					? "Chat mode ON — only attached files, no tools. Code goes in the chat."
					: "Chat mode OFF — full tool access restored.",
				"info",
			);
		},
	});

	pi.registerCommand("chat-allow", {
		description: "Allow reading one specific path in chat mode (usage: /chat-allow <path>)",
		handler: async (args, ctx) => {
			const path = args.trim();
			if (!path) {
				ctx.ui.notify("Usage: /chat-allow <path>", "warning");
				return;
			}
			const abs = normalize(path, ctx.cwd);
			allowedPaths.add(abs);
			if (enabled) applyToolSet();
			ctx.ui.notify(`Allowed for reading: ${abs}`, "info");
		},
	});

	pi.registerCommand("chat-apply", {
		description:
			"Apply/Create: write the last code block of the last reply to a file (usage: /chat-apply [path])",
		handler: async (args, ctx) => {
			const text = lastAssistantText(ctx);
			const blocks = extractCodeBlocks(text);
			if (blocks.length === 0) {
				ctx.ui.notify("No code block found in the last assistant reply.", "warning");
				return;
			}
			const block = blocks[blocks.length - 1];
			const target = args.trim() || block.hint?.trim() || "";
			if (!target) {
				ctx.ui.notify(
					"No target path. Pass one: /chat-apply path/to/file.ext (or label the block with 'File: ...').",
					"warning",
				);
				return;
			}
			const abs = normalize(target, ctx.cwd);
			const confirmed = await ctx.ui.confirm(
				"Apply code block?",
				`Write the last code block (${block.lang || "text"}) to:\n${abs}`,
			);
			if (!confirmed) return;
			mkdirSync(dirname(abs), { recursive: true });
			writeFileSync(abs, block.code, "utf-8");
			ctx.ui.notify(`Written: ${abs}`, "info");
		},
	});
}
