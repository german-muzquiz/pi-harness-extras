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

function clearApprovalUi(ctx: ApprovalContext): void {
	ctx.ui.setWidget(APPROVAL_WIDGET_KEY, undefined);
}

function updateApprovalStatus(ctx: ApprovalContext, approvalEnabled: boolean): void {
	const theme = ctx.ui.theme;
	const status = approvalEnabled
		? theme.fg("success", "auto-edit: on") + theme.fg("dim", " [ctrl+q]")
		: theme.fg("warning", "auto-edit: off") + theme.fg("dim", " [ctrl+q]");
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
