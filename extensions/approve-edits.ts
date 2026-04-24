import { constants as fsConstants, promises as fs } from "node:fs";
import path from "node:path";

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { isToolCallEventType } from "@mariozechner/pi-coding-agent";
import { matchesKey } from "@mariozechner/pi-tui";

const APPROVAL_WIDGET_KEY = "approve-edits-prompt";
const APPROVAL_STATUS_KEY = "approve-edits-status";
const SUPPORTS_INLINE_APPROVAL = process.stdin.isTTY === true && process.stdout.isTTY === true;

type ApprovalContext = ExtensionContext;

type ApprovalRequest = {
	filePath: string;
	operationLabel: string;
};

type FileEdit = {
	oldText: string;
	newText: string;
};

export default function (pi: ExtensionAPI) {
	let approvalEnabled = true;

	pi.on("session_start", async (_event, ctx) => {
		if (!ctx.hasUI) return;
		updateApprovalStatus(ctx, approvalEnabled);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		if (!ctx.hasUI) return;
		clearApprovalUi(ctx);
		ctx.ui.setStatus(APPROVAL_STATUS_KEY, undefined);
	});

	pi.registerShortcut("ctrl+q", {
		description: "Toggle edit approval on/off",
		handler: async (ctx) => {
			toggleApproval(ctx, () => {
				approvalEnabled = !approvalEnabled;
				return approvalEnabled;
			});
		},
	});

	pi.registerCommand("approve-edits", {
		description: "Toggle edit approval on/off",
		handler: async (_args, ctx) => {
			toggleApproval(ctx, () => {
				approvalEnabled = !approvalEnabled;
				return approvalEnabled;
			});
		},
	});

	pi.on("tool_call", async (event, ctx) => {
		if (!ctx.hasUI || !approvalEnabled) return undefined;

		if (isToolCallEventType("write", event)) {
			const shouldPrompt = await shouldPromptForWrite(ctx, event.input.path, event.input.content);
			if (!shouldPrompt) return undefined;

			const approved = await requestApproval(ctx, {
				filePath: event.input.path,
				operationLabel: "write",
			});
			if (!approved) {
				return { block: true, reason: "File write denied by user" };
			}
			return undefined;
		}

		if (isToolCallEventType("edit", event)) {
			const shouldPrompt = await shouldPromptForEdit(ctx, event.input.path, event.input.edits);
			if (!shouldPrompt) return undefined;

			const approved = await requestApproval(ctx, {
				filePath: event.input.path,
				operationLabel: "edit",
			});
			if (!approved) {
				return { block: true, reason: "File edit denied by user" };
			}
			return undefined;
		}

		return undefined;
	});
}

async function requestApproval(ctx: ApprovalContext, request: ApprovalRequest): Promise<boolean> {
	if (!SUPPORTS_INLINE_APPROVAL) {
		return ctx.ui.confirm("Approve file change?", `${request.operationLabel}: ${request.filePath}`);
	}

	// Pi already renders the edit diff in the tool card, including intra-line
	// highlights. The extension only adds approval controls so the user sees one
	// canonical diff instead of a duplicated custom rendering.
	clearApprovalUi(ctx);

	return new Promise<boolean>((resolveApproval) => {
		let settled = false;

		const finish = (approved: boolean): void => {
			if (settled) return;
			settled = true;
			unsubscribeInput();
			ctx.signal?.removeEventListener("abort", abortApproval);
			clearApprovalUi(ctx);
			resolveApproval(approved);
		};

		const abortApproval = (): void => {
			finish(false);
		};

		ctx.ui.setWidget(APPROVAL_WIDGET_KEY, ["Press y/↵ to approve or n/Esc to deny."]);

		const unsubscribeInput = ctx.ui.onTerminalInput((data) => {
			const decision = readApprovalInput(data);
			if (decision === undefined) {
				return undefined;
			}
			finish(decision);
			return { consume: true };
		});

		ctx.signal?.addEventListener("abort", abortApproval, { once: true });
	});
}

function toggleApproval(ctx: ApprovalContext, toggle: () => boolean): void {
	const enabled = toggle();
	updateApprovalStatus(ctx, enabled);
	ctx.ui.notify(enabled ? "Edit approval enabled" : "Edit approval disabled (auto-approve)", "info");
}

async function shouldPromptForWrite(ctx: ApprovalContext, filePath: string, content: string): Promise<boolean> {
	const resolvedPath = resolveToolPath(ctx, filePath);
	const fileState = await getPathState(resolvedPath);
	if (fileState === "directory" || fileState === "missing-parent") {
		return false;
	}

	if (fileState === "file") {
		if (!(await isWritable(resolvedPath))) {
			return false;
		}

		try {
			const existingContent = await fs.readFile(resolvedPath, "utf8");
			if (existingContent === content) {
				return false;
			}
		} catch {
			return false;
		}
	}

	const writableTarget = fileState === "file" ? resolvedPath : await findNearestExistingParent(path.dirname(resolvedPath));
	return writableTarget !== undefined && (await isWritable(writableTarget));
}

async function shouldPromptForEdit(ctx: ApprovalContext, filePath: string, edits: FileEdit[]): Promise<boolean> {
	const resolvedPath = resolveToolPath(ctx, filePath);
	if ((await getPathState(resolvedPath)) !== "file") {
		return false;
	}

	if (!(await isWritable(resolvedPath))) {
		return false;
	}

	let fileContent: string;
	try {
		fileContent = await fs.readFile(resolvedPath, "utf8");
		// Preflighting predictable filesystem and match failures keeps approval
		// prompts for changes that the built-in edit tool can actually apply.
	} catch {
		return false;
	}

	const matchRanges: Array<{ start: number; end: number }> = [];
	let hasMeaningfulChange = false;

	for (const edit of edits) {
		if (edit.oldText.length === 0) {
			return false;
		}

		const matchStart = findUniqueMatchStart(fileContent, edit.oldText);
		if (matchStart === undefined) {
			return false;
		}

		matchRanges.push({ start: matchStart, end: matchStart + edit.oldText.length });
		if (edit.oldText !== edit.newText) {
			hasMeaningfulChange = true;
		}
	}

	matchRanges.sort((a, b) => a.start - b.start);
	for (let i = 1; i < matchRanges.length; i++) {
		if (matchRanges[i - 1]!.end > matchRanges[i]!.start) {
			return false;
		}
	}

	return hasMeaningfulChange;
}

function clearApprovalUi(ctx: ApprovalContext): void {
	ctx.ui.setWidget(APPROVAL_WIDGET_KEY, undefined);
}

function updateApprovalStatus(ctx: ApprovalContext, approvalEnabled: boolean): void {
	const theme = ctx.ui.theme;
	const status = approvalEnabled
		? theme.fg("warning", "auto-edit: off") + theme.fg("dim", " [ctrl+q]")
		: theme.fg("success", "auto-edit: on") + theme.fg("dim", " [ctrl+q]");
	ctx.ui.setStatus(APPROVAL_STATUS_KEY, status);
}

function readApprovalInput(data: string): boolean | undefined {
	if (matchesKey(data, "y") || matchesKey(data, "return") || matchesKey(data, "enter")) {
		return true;
	}

	if (matchesKey(data, "n") || matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
		return false;
	}

	return undefined;
}

function resolveToolPath(ctx: ApprovalContext, filePath: string): string {
	return path.isAbsolute(filePath) ? filePath : path.resolve(ctx.cwd, filePath);
}

async function getPathState(targetPath: string): Promise<"file" | "directory" | "missing" | "missing-parent"> {
	try {
		const stats = await fs.stat(targetPath);
		return stats.isDirectory() ? "directory" : "file";
	} catch {
		const parentPath = await findNearestExistingParent(path.dirname(targetPath));
		return parentPath === undefined ? "missing-parent" : "missing";
	}
}

async function findNearestExistingParent(startPath: string): Promise<string | undefined> {
	let currentPath = path.resolve(startPath);

	while (true) {
		try {
			const stats = await fs.stat(currentPath);
			return stats.isDirectory() ? currentPath : undefined;
		} catch {
			const parentPath = path.dirname(currentPath);
			if (parentPath === currentPath) {
				return undefined;
			}
			currentPath = parentPath;
		}
	}
}

async function isWritable(targetPath: string): Promise<boolean> {
	try {
		await fs.access(targetPath, fsConstants.W_OK);
		return true;
	} catch {
		return false;
	}
}

function findUniqueMatchStart(content: string, searchText: string): number | undefined {
	const firstMatch = content.indexOf(searchText);
	if (firstMatch === -1) {
		return undefined;
	}

	const secondMatch = content.indexOf(searchText, firstMatch + 1);
	return secondMatch === -1 ? firstMatch : undefined;
}
