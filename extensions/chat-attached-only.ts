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
 *   /chat-blocks           List code blocks detected in the last reply.
 *   /chat-apply [n|--all]  Apply/Create: write one (or all) code block(s)
 *                          from the last reply. Without args, the last one.
 *   /chat-create [n]       Create a NEW file from a block; fails if it exists.
 *   /chat-undo             Undo the last write made by chat-apply/chat-create.
 */

import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname, resolve, sep } from "node:path";

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
  For a brand new file, label it exactly "New file: path/to/file.ext".
  For a patch, label it "Patch: path/to/file.ext" and use a \`\`\`diff fence.
- Only show the parts that change when the user asks for a small edit; show the
  whole file when they ask to create or rewrite it.
- Reply in the user's language.`;

type BlockKind = "create" | "apply" | "patch" | "copy-only";

type CodeBlock = {
	index: number;
	kind: BlockKind;
	lang: string;
	code: string;
	path?: string;
	raw: string;
};

type BackupEntry = {
	abs: string;
	previous: string | null; // null => file did not exist (undo = unlink)
};

/**
 * Extract fenced code blocks with their target hint.
 * Recognized hints (case-insensitive, EN/ES):
 *   File: <path>       -> apply (overwrite if exists)
 *   New file: <path>   -> create (fails visibly if exists)
 *   Patch: <path>      -> patch (with a ```diff fence)
 *   Path/Ruta/Archivo… -> same as File:
 * No hint -> copy-only (never touches disk).
 */
function extractCodeBlocks(text: string): CodeBlock[] {
	const blocks: CodeBlock[] = [];
	const fence = /```([^\n`]*)\n([\s\S]*?)```/g;
	let match: RegExpExecArray | null;
	let i = 0;
	while ((match = fence.exec(text)) !== null) {
		const beforeLines = text
			.slice(0, match.index)
			.replace(/\n+$/, "")
			.split("\n");
		const lineBefore = beforeLines[beforeLines.length - 1] ?? "";

		const createHint = lineBefore.match(
			/^\s*(?:New file|Nuevo archivo|Create)\s*:\s*(.+?)\s*$/i,
		);
		const patchHint = lineBefore.match(/^\s*(?:Patch|Parche)\s*:\s*(.+?)\s*$/i);
		const fileHint = lineBefore.match(
			/^\s*(?:File|Path|Archivo|Ruta)\s*:\s*(.+?)\s*$/i,
		);

		const lang = match[1].trim().toLowerCase();
		let kind: BlockKind = "copy-only";
		let path: string | undefined;

		if (patchHint && lang === "diff") {
			kind = "patch";
			path = patchHint[1];
		} else if (createHint) {
			kind = "create";
			path = createHint[1];
		} else if (fileHint) {
			kind = "apply";
			path = fileHint[1];
		}

		blocks.push({
			index: i++,
			kind,
			lang,
			code: match[2],
			path,
			raw: match[0],
		});
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
				.filter(
					(c): c is { type: string; text: string } =>
						!!c &&
						typeof c === "object" &&
						(c as { type?: string }).type === "text",
				)
				.map((c) => c.text)
				.join("\n");
		}
	}
	return "";
}

/** Text of the most recent user message in the active branch (attachments). */
function lastUserText(ctx: ExtensionCommandContext): string {
	const branch = ctx.sessionManager.getBranch() as Array<{
		type?: string;
		message?: { role?: string; content?: unknown };
	}>;
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i];
		if (entry?.type !== "message" || entry.message?.role !== "user") continue;
		const content = entry.message.content;
		if (typeof content === "string") return content;
		if (Array.isArray(content)) {
			return content
				.filter(
					(c): c is { type: string; text: string } =>
						!!c &&
						typeof c === "object" &&
						(c as { type?: string }).type === "text",
				)
				.map((c) => c.text)
				.join("\n");
		}
	}
	return "";
}

/** Reject paths that escape the workspace root (path traversal). */
function normalize(path: string, cwd: string): string {
	const abs = resolve(cwd, path);
	const root = resolve(cwd);
	if (abs !== root && !abs.startsWith(root + sep)) {
		throw new Error(`Ruta fuera del workspace: ${path}`);
	}
	return abs;
}

/** Count attached-file bytes seen by the model in a user message. */
function attachmentStats(userText: string): { files: number; bytes: number } {
	const re = /===== BEGIN UNTRUSTED ATTACHED FILE: (.+?) =====/g;
	let files = 0;
	let m: RegExpExecArray | null;
	while ((m = re.exec(userText)) !== null) files++;
	return { files, bytes: Buffer.byteLength(userText, "utf8") };
}

export default function chatAttachedOnly(pi: ExtensionAPI): void {
	let enabled = false;
	let savedTools: string[] | null = null;
	const allowedPaths = new Set<string>();
	const backups: BackupEntry[] = [];
	let lastBlocks: CodeBlock[] = [];

	pi.registerFlag("chat-attached-only", {
		description:
			"Start in chat mode: only attached files, no tools, code in chat",
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

	/**
	 * Write a file with a backup entry so /chat-undo can revert it.
	 * Returns "created" if the file did not exist before, else "overwritten".
	 */
	function writeWithBackup(
		abs: string,
		content: string,
	): "created" | "overwritten" {
		const previous = existsSync(abs) ? readFileSync(abs, "utf-8") : null;
		backups.push({ abs, previous });
		mkdirSync(dirname(abs), { recursive: true });
		writeFileSync(abs, content, "utf-8");
		return previous === null ? "created" : "overwritten";
	}

	/** Resolve the blocks to use, falling back to the last reply when empty. */
	function currentBlocks(ctx: ExtensionCommandContext): CodeBlock[] {
		if (lastBlocks.length > 0) return lastBlocks;
		return extractCodeBlocks(lastAssistantText(ctx));
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

	// Cache the blocks of the last assistant reply so /chat-blocks,
	// /chat-apply and /chat-create operate on the same snapshot.
	pi.on("after_agent_reply", async (event) => {
		if (!enabled) return;
		const text =
			typeof (event as { text?: unknown }).text === "string"
				? (event as { text: string }).text
				: "";
		lastBlocks = extractCodeBlocks(text);
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
		description:
			"Allow reading one specific path in chat mode (usage: /chat-allow <path>)",
		handler: async (args, ctx) => {
			const path = args.trim();
			if (!path) {
				ctx.ui.notify("Usage: /chat-allow <path>", "warning");
				return;
			}
			let abs: string;
			try {
				abs = normalize(path, ctx.cwd);
			} catch (err) {
				ctx.ui.notify((err as Error).message, "warning");
				return;
			}
			allowedPaths.add(abs);
			if (enabled) applyToolSet();
			ctx.ui.notify(`Allowed for reading: ${abs}`, "info");
		},
	});

	pi.registerCommand("chat-blocks", {
		description:
			"List the code blocks detected in the last reply (with index)",
		handler: async (_args, ctx) => {
			const blocks = currentBlocks(ctx);
			if (blocks.length === 0) {
				ctx.ui.notify("No code blocks in the last reply.", "warning");
				return;
			}
			const lines = blocks.map(
				(b) =>
					`${b.index + 1}. [${b.kind}] ${b.path ?? "(sin path)"} (${b.lang || "text"})`,
			);
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});

	pi.registerCommand("chat-apply", {
		description:
			"Apply: write a code block from the last reply. Usage: /chat-apply [n|--all]",
		handler: async (args, ctx) => {
			const blocks = currentBlocks(ctx);
			if (blocks.length === 0) {
				ctx.ui.notify(
					"No code block found in the last assistant reply.",
					"warning",
				);
				return;
			}
			const arg = args.trim();
			let targets: CodeBlock[];
			if (arg === "--all") {
				targets = blocks.filter((b) => b.path && b.kind !== "copy-only");
			} else if (arg) {
				const idx = parseInt(arg, 10) - 1;
				const picked = blocks[idx];
				targets = picked ? [picked] : [];
			} else {
				targets = [blocks[blocks.length - 1]];
			}
			if (targets.length === 0) {
				ctx.ui.notify(
					"Índice inválido. Usa /chat-blocks para verlos.",
					"warning",
				);
				return;
			}

			const summary = targets
				.map(
					(b) =>
						`  · [${b.index + 1}] ${b.kind} → ${b.path ?? "(sin path)"}`,
				)
				.join("\n");
			const ok = await ctx.ui.confirm(
				"Apply code blocks?",
				`Se escribirán ${targets.length} bloque(s):\n${summary}`,
			);
			if (!ok) return;

			for (const block of targets) {
				if (!block.path) {
					ctx.ui.notify(
						`Bloque ${block.index + 1}: sin File:/New file:, omitido.`,
						"warning",
					);
					continue;
				}
				let abs: string;
				try {
					abs = normalize(block.path, ctx.cwd);
				} catch (err) {
					ctx.ui.notify((err as Error).message, "warning");
					continue;
				}
				if (block.kind === "patch") {
					ctx.ui.notify(
						`Bloque ${block.index + 1}: patches aún no soportados, omitido.`,
						"warning",
					);
					continue;
				}
				const action = writeWithBackup(abs, block.code);
				ctx.ui.notify(
					`${action === "created" ? "Creado" : "Sobrescrito"}: ${abs}`,
					"info",
				);
			}
		},
	});

	pi.registerCommand("chat-create", {
		description:
			"Create: write a NEW file from a block. Fails if it already exists. Usage: /chat-create [n]",
		handler: async (args, ctx) => {
			const blocks = currentBlocks(ctx);
			if (blocks.length === 0) {
				ctx.ui.notify("No code blocks in the last reply.", "warning");
				return;
			}
			const arg = args.trim();
			let target: CodeBlock | undefined;
			if (arg) {
				target = blocks[parseInt(arg, 10) - 1];
			} else {
				target =
					blocks.find((b) => b.kind === "create") ??
					blocks.find((b) => !!b.path);
			}
			if (!target?.path) {
				ctx.ui.notify(
					"Sin bloque aplicable. Etiqueta el bloque como 'New file: <ruta>'.",
					"warning",
				);
				return;
			}
			let abs: string;
			try {
				abs = normalize(target.path, ctx.cwd);
			} catch (err) {
				ctx.ui.notify((err as Error).message, "warning");
				return;
			}
			if (existsSync(abs)) {
				ctx.ui.notify(
					`Ya existe: ${abs}. Usa /chat-apply ${target.index + 1} para sobrescribirlo.`,
					"warning",
				);
				return;
			}
			const action = writeWithBackup(abs, target.code);
			ctx.ui.notify(
				`${action === "created" ? "Creado" : "Sobrescrito"}: ${abs}`,
				"info",
			);
		},
	});

	pi.registerCommand("chat-undo", {
		description: "Undo the last write made by /chat-apply or /chat-create",
		handler: async (_args, ctx) => {
			const last = backups.pop();
			if (!last) {
				ctx.ui.notify("Nada que revertir.", "warning");
				return;
			}
			if (last.previous === null) {
				if (existsSync(last.abs)) unlinkSync(last.abs);
				ctx.ui.notify(`Eliminado (undo de create): ${last.abs}`, "info");
			} else {
				writeFileSync(last.abs, last.previous, "utf-8");
				ctx.ui.notify(`Restaurado: ${last.abs}`, "info");
			}
		},
	});

	pi.registerCommand("chat-stats", {
		description:
			"Show attached-file stats for the last user message (files, bytes)",
		handler: async (_args, ctx) => {
			const stats = attachmentStats(lastUserText(ctx));
			const tokens = Math.ceil(stats.bytes / 4);
			ctx.ui.notify(
				`Adjuntos: ${stats.files} archivo(s) · ${(stats.bytes / 1024).toFixed(1)} KB · ~${tokens} tok`,
				"info",
			);
		},
	});
}