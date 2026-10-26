/**
 * Address the open code review feedback on a GitHub pull request.
 *
 * `/address-review <pr-url>` fetches the review feedback itself, so the agent
 * always works from the same deterministic list of open items. The agent then
 * triages through `review_triage`, which walks the user through every draft
 * before any code changes, and finishes through `review_submit`, the only path
 * that posts to GitHub. While a review is active, bash commands that write to
 * GitHub are blocked so the agent cannot bypass that gate.
 *
 * Only question and decline items get a GitHub reply, and only with text the
 * user approved during triage. Fix items are answered by the code change, so
 * the agent never writes text that reaches the PR unseen.
 */

import { StringEnum } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionContext, Theme } from "@mariozechner/pi-coding-agent";
import { getMarkdownTheme, isToolCallEventType } from "@mariozechner/pi-coding-agent";
import { type Component, Markdown, matchesKey, Text, truncateToWidth, wrapTextWithAnsi } from "@mariozechner/pi-tui";
import { Type } from "typebox";

const ENTRY_TYPE = "address-review";
const STATUS_KEY = "address-review";
const TOOL_NAMES = ["review_triage", "review_submit"];

// Hidden marker appended to every conversation reply. Review bodies and
// conversation comments have no "resolved" state, so the marker is how a later
// run knows they were already answered.
const MARKER_PREFIX = "<!-- address-review:";

const GITHUB_WRITE_COMMAND =
	/\bgh\s+(pr\s+(comment|review|edit|close|merge|ready)|issue\s+comment)\b|\bgh\s+api\b[\s\S]*(\bmutation\b|(-X|--method)[\s=]*(POST|PATCH|PUT|DELETE))/i;

const CLASSIFICATIONS = ["fix", "question", "decline", "skip", "unsure"] as const;
type Classification = (typeof CLASSIFICATIONS)[number];

type ItemKind = "thread" | "review" | "comment";

interface ReviewItem {
	id: string;
	kind: ItemKind;
	/** GraphQL node id: the thread for inline threads, the review or comment otherwise. */
	nodeId: string;
	author: string;
	location: string;
	url: string;
	/** The feedback as markdown; for threads, the whole conversation. */
	body: string;
	diffHunk?: string;
}

interface Decision {
	id: string;
	classification: Exclude<Classification, "unsure">;
	summary: string;
	/** User-approved GitHub reply; only question and decline items have one. */
	reply?: string;
	plan?: string;
	/** Extra instruction from the user for the agent. */
	note?: string;
}

interface ReviewSession {
	prUrl: string;
	owner: string;
	repo: string;
	number: number;
	title: string;
	items: ReviewItem[];
	decisions?: Decision[];
}

interface PostResult {
	id: string;
	url?: string;
	error?: string;
}

/** How a tool's interactive flow ended: the user paused it, ended the review, or finished it. */
type Outcome = "paused" | "ended" | "done";

interface TriageDetails {
	outcome: Outcome;
	decisions?: Decision[];
}

interface SubmitDetails {
	outcome: Outcome;
	results: PostResult[];
}

interface CardSection {
	label: string;
	markdown: string;
	maxLines?: number;
}

interface Card {
	title: string;
	subtitle?: string;
	sections: CardSection[];
	hints: string;
}

type CardKey = "enter" | "escape" | "left" | "right" | "e" | "c" | "i" | "s";

const TriageParams = Type.Object({
	items: Type.Array(
		Type.Object({
			id: Type.String({ description: "Item id from the review list, e.g. T1, R1, C1" }),
			classification: StringEnum(CLASSIFICATIONS),
			summary: Type.String({ description: "One line: what the reviewer asks for" }),
			reply: Type.Optional(
				Type.String({ description: "Draft GitHub reply; only for question and decline, ignored otherwise" }),
			),
			plan: Type.Optional(Type.String({ description: "One-line planned code change; required for fix" })),
		}),
		{ description: "Every open review item, exactly once" },
	),
});

const SubmitParams = Type.Object({
	summary: Type.String({
		description:
			"Markdown summary for the user only, never posted: changes per item, files touched, check results, anything left unaddressed",
	}),
});

export default function (pi: ExtensionAPI) {
	let session: ReviewSession | undefined;

	const setSession = (ctx: ExtensionContext, next: ReviewSession | undefined) => {
		session = next;
		pi.appendEntry(ENTRY_TYPE, { session: next ?? null });
		syncRuntime(ctx);
	};

	// Tools are declared to the model only while a review is active, so they
	// cost nothing in unrelated sessions.
	const syncRuntime = (ctx: ExtensionContext) => {
		const others = pi.getActiveTools().filter((name) => !TOOL_NAMES.includes(name));
		pi.setActiveTools(session ? [...others, ...TOOL_NAMES] : others);
		if (ctx.hasUI) {
			const phase = session?.decisions ? "fixing" : "triage";
			ctx.ui.setStatus(
				STATUS_KEY,
				session
					? ctx.ui.theme.fg("accent", `review #${session.number} · ${phase}`) +
							ctx.ui.theme.fg("dim", " [/address-review stop]")
					: undefined,
			);
		}
	};

	// Escape never discards silently: the user picks between pausing, which
	// keeps the review open for the agent, and ending it with nothing posted.
	const cancelled = async (ctx: ExtensionContext, where: string): Promise<{ outcome: Outcome; text: string }> => {
		const end = "End the review \u2014 nothing is posted to GitHub";
		const choice = await ctx.ui.select(`Review of #${session?.number} paused`, [
			"Pause \u2014 keep the review open and tell the agent what to change",
			end,
		]);
		if (choice === end) {
			setSession(ctx, undefined);
			return { outcome: "ended", text: "The user ended the review. Nothing was posted. Stop." };
		}
		return {
			outcome: "paused",
			text: `The user paused the review at ${where}. Nothing was posted. Stop and wait for instructions; the review stays open.`,
		};
	};

	pi.on("session_start", async (_event, ctx) => {
		session = restoreSession(ctx);
		syncRuntime(ctx);
	});

	pi.on("session_tree", async (_event, ctx) => {
		session = restoreSession(ctx);
		syncRuntime(ctx);
	});

	pi.on("tool_call", async (event) => {
		if (!session || !isToolCallEventType("bash", event)) return undefined;
		if (!GITHUB_WRITE_COMMAND.test(event.input.command)) return undefined;
		return {
			block: true,
			reason: "Writing to GitHub is blocked during /address-review. Replies are posted only through review_submit.",
		};
	});

	pi.registerCommand("address-review", {
		description: "Triage and address open code review comments on a GitHub PR",
		handler: async (args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("/address-review requires interactive mode", "error");
				return;
			}
			if (!ctx.isIdle()) {
				ctx.ui.notify("Wait for the agent to finish before running /address-review", "warning");
				return;
			}
			if (args.trim() === "stop") {
				if (!session) {
					ctx.ui.notify("No review is active", "info");
					return;
				}
				ctx.ui.notify(`Review of #${session.number} ended. Nothing was posted to GitHub.`, "info");
				setSession(ctx, undefined);
				return;
			}
			const ref = parsePrUrl(args.trim());
			if (!ref) {
				ctx.ui.notify("Usage: /address-review <github-pr-url> | /address-review stop", "error");
				return;
			}

			let next: ReviewSession;
			let headRef: string;
			try {
				ctx.ui.notify(`Fetching review feedback for #${ref.number}…`, "info");
				({ session: next, headRef } = await fetchReview(pi, ctx, ref));
			} catch (error) {
				ctx.ui.notify(`Failed to fetch PR: ${errorMessage(error)}`, "error");
				return;
			}

			// Fixes must land on the PR branch, and switching branches is the
			// user's call, so refuse rather than check it out.
			const git = await readGitStatus(pi, ctx);
			if (git.branch !== headRef) {
				ctx.ui.notify(`Check out the PR branch "${headRef}" first (current: "${git.branch}")`, "error");
				return;
			}

			if (next.items.length === 0) {
				ctx.ui.notify(`No open review feedback on #${next.number}`, "info");
				return;
			}

			setSession(ctx, next);
			pi.sendUserMessage(buildKickoffPrompt(next));
		},
	});

	pi.registerTool({
		name: "review_triage",
		label: "Review triage",
		description:
			"Submit the triage of every open PR review item. The user reviews each classification and draft reply, and the result says how to proceed.",
		parameters: TriageParams,
		executionMode: "sequential",
		defaultActive: false,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const current = requireSession(session);
			if (ctx.mode !== "tui") throw new Error("review_triage requires interactive mode");
			assertCoversItems(current, params.items.map((item) => item.id));

			const drafts = params.items.map((item) => ({ ...item, reply: item.reply?.trim() || undefined }));
			const decisions = await reviewTriage(ctx, current, drafts);
			if (!decisions) {
				const { outcome, text } = await cancelled(ctx, "triage");
				return { content: [{ type: "text", text }], details: { outcome } satisfies TriageDetails, terminate: true };
			}

			setSession(ctx, { ...current, decisions });
			return {
				content: [{ type: "text", text: buildTriageResult(current, decisions) }],
				details: { outcome: "done", decisions } satisfies TriageDetails,
			};
		},

		renderCall(args, theme) {
			const count = Array.isArray(args.items) ? args.items.length : 0;
			return new Text(theme.fg("toolTitle", theme.bold("review_triage ")) + theme.fg("muted", `${count} items`), 0, 0);
		},

		renderResult(result, _options, theme) {
			const details = result.details as TriageDetails | undefined;
			if (!details?.decisions) return renderStopped(details?.outcome, theme);
			const decisions = details.decisions;
			const counts = CLASSIFICATIONS.map((c) => [c, decisions.filter((d) => d.classification === c).length] as const)
				.filter(([, n]) => n > 0)
				.map(([c, n]) => `${n} ${c}`)
				.join(" · ");
			const replies = decisions.filter((d) => d.reply).length;
			const github = replies
				? `${plural(replies, "reply", "replies")} queued for GitHub, posted only after final approval`
				: "nothing will be posted to GitHub";
			return new Text(theme.fg("success", "✓ ") + theme.fg("muted", `${counts} · ${github}`), 0, 0);
		},
	});

	pi.registerTool({
		name: "review_submit",
		label: "Review submit",
		description:
			"Finish the PR review: show the user your summary (never posted) and the replies approved during triage, and post the ones the user confirms. The only way to post to the PR.",
		parameters: SubmitParams,
		executionMode: "sequential",
		defaultActive: false,

		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const current = requireSession(session);
			if (ctx.mode !== "tui") throw new Error("review_submit requires interactive mode");
			if (!current.decisions) throw new Error("Call review_triage before review_submit");

			const replies = collectReplies(current.decisions);
			const approved = await reviewReplies(pi, ctx, current, params.summary, replies);
			if (!approved) {
				const { outcome, text } = await cancelled(ctx, "submit");
				return {
					content: [{ type: "text", text }],
					details: { outcome, results: [] } satisfies SubmitDetails,
					terminate: true,
				};
			}

			const results: PostResult[] = [];
			for (const [id, reply] of approved) {
				const item = current.items.find((candidate) => candidate.id === id)!;
				try {
					results.push({ id, url: await postReply(pi, ctx, current, item, reply, signal) });
				} catch (error) {
					results.push({ id, error: errorMessage(error) });
				}
			}

			setSession(ctx, undefined);
			const lines = results.map((r) => (r.url ? `${r.id}: posted ${r.url}` : `${r.id}: FAILED ${r.error}`));
			return {
				content: [
					{ type: "text", text: lines.length ? lines.join("\n") : "Review finished. Nothing was posted to GitHub." },
				],
				details: { outcome: "done", results } satisfies SubmitDetails,
				terminate: true,
			};
		},

		renderCall(_args, theme) {
			return new Text(theme.fg("toolTitle", theme.bold("review_submit")), 0, 0);
		},

		renderResult(result, _options, theme) {
			const details = result.details as SubmitDetails | undefined;
			if (details?.outcome !== "done") return renderStopped(details?.outcome, theme);
			const results = details.results;
			if (results.length === 0) {
				return new Text(theme.fg("success", "✓ Review finished \u00b7 nothing was posted to GitHub"), 0, 0);
			}
			const lines = results.map((r) =>
				r.url
					? theme.fg("success", "✓ ") + theme.fg("accent", r.id) + " " + theme.fg("muted", r.url)
					: theme.fg("error", "✗ ") + theme.fg("accent", r.id) + " " + theme.fg("error", r.error ?? ""),
			);
			return new Text(lines.join("\n"), 0, 0);
		},
	});
}

/**
 * Walk the user through every triaged item. Returns undefined when the user
 * cancels, so no code changes start from a triage they did not finish.
 */
async function reviewTriage(
	ctx: ExtensionContext,
	current: ReviewSession,
	drafts: { id: string; classification: Classification; summary: string; reply?: string; plan?: string }[],
): Promise<Decision[] | undefined> {
	const ordered = current.items.map((item) => ({ item, draft: { ...drafts.find((d) => d.id === item.id)! } }));
	const notes = new Map<string, string>();
	let index = 0;

	while (index < ordered.length) {
		const { item, draft } = ordered[index]!;
		const note = notes.get(item.id);
		const replies = getsReply(draft.classification);
		const key = await showCard(ctx, {
			title: `${item.id} · @${item.author} · ${item.location}`,
			subtitle: `Triage ${index + 1}/${ordered.length} · ${draft.classification.toUpperCase()}`,
			sections: [
				{ label: "Reviewer comment", markdown: item.body, maxLines: 14 },
				{ label: "Agent's read \u2014 for you only", markdown: draft.summary },
				...(draft.plan && draft.classification === "fix"
					? [{ label: "Planned fix \u2014 for you only", markdown: draft.plan }]
					: []),
				...(note ? [{ label: "Your instruction to the agent", markdown: note }] : []),
				replies
					? {
							label: "GitHub reply \u2014 posted to the PR only after your final approval",
							markdown: draft.reply ?? "_No reply yet \u2014 press enter or e to write one._",
						}
					: { label: "GitHub reply", markdown: `**None.** Nothing is posted for ${draft.classification} items.` },
			],
			hints: `enter accept${replies ? " · e edit reply" : ""} · c change type · i instruct agent · ←/→ navigate · esc pause`,
		});

		if (key === "escape") return undefined;
		if (key === "left") index = Math.max(0, index - 1);
		else if (key === "right") index = Math.min(ordered.length - 1, index + 1);
		else if (key === "e" && replies) draft.reply = await editText(ctx, `GitHub reply to ${item.id}`, draft.reply);
		else if (key === "i") {
			const text = await editText(ctx, `Instruction for the agent on ${item.id}`, note);
			if (text) notes.set(item.id, text);
			else notes.delete(item.id);
		} else if (key === "c") {
			draft.classification = (await pickClassification(ctx, item.id)) ?? draft.classification;
		} else if (key === "enter") {
			if (draft.classification === "unsure") {
				draft.classification = (await pickClassification(ctx, item.id)) ?? "unsure";
				continue;
			}
			if (replies && !draft.reply) {
				draft.reply = await editText(ctx, `GitHub reply to ${item.id}`, undefined);
				continue;
			}
			index++;
		}
	}

	return ordered.map(({ item, draft }) => ({
		id: item.id,
		classification: draft.classification as Decision["classification"],
		summary: draft.summary,
		reply: getsReply(draft.classification) ? draft.reply : undefined,
		plan: draft.classification === "fix" ? draft.plan : undefined,
		note: notes.get(item.id),
	}));
}

/**
 * Show the agent's summary next to exactly what will reach GitHub, let the
 * user edit or drop each reply, then confirm once. Returns the replies to post
 * (possibly none), or undefined when the user backs out.
 */
async function reviewReplies(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	current: ReviewSession,
	summary: string,
	replies: Map<string, string>,
): Promise<Map<string, string> | undefined> {
	const git = await readGitStatus(pi, ctx);
	const warnings = [
		git.dirty && "The working tree has uncommitted changes.",
		!git.hasUpstream && "The branch has no upstream; the fixes are not on GitHub.",
		git.ahead > 0 && `The branch is ${git.ahead} commit(s) ahead of its upstream.`,
	].filter(Boolean);

	const itemFor = (id: string) => current.items.find((candidate) => candidate.id === id)!;
	const posting = replies.size
		? [...replies.keys()].map((id) => `- **${id}** \u2192 ${destination(itemFor(id))}`).join("\n")
		: "**Nothing.** Only question and decline items get a reply; fix and skip items get none.";

	const summaryKey = await showCard(ctx, {
		title: `PR #${current.number} · ${current.title}`,
		subtitle: replies.size
			? `${plural(replies.size, "reply", "replies")} to post to GitHub \u2014 you review each one next`
			: "Nothing will be posted to GitHub",
		sections: [
			{ label: "Agent's summary \u2014 for you only, never posted", markdown: summary, maxLines: 30 },
			{ label: "Posted to the GitHub PR", markdown: posting },
			...(replies.size && warnings.length
				? [{ label: "Before posting", markdown: warnings.map((w) => `- ${w}`).join("\n") }]
				: []),
		],
		hints: replies.size ? "enter review replies · esc pause" : "enter finish review · esc pause",
	});
	if (summaryKey !== "enter") return undefined;
	if (replies.size === 0) return new Map();

	const entries = [...replies.entries()].map(([id, reply]) => ({ id, reply, post: true }));
	let index = 0;
	while (index < entries.length) {
		const entry = entries[index]!;
		const item = itemFor(entry.id);
		const key = await showCard(ctx, {
			title: `GitHub reply ${index + 1}/${entries.length} · ${item.id}`,
			subtitle: `${entry.post ? "WILL POST" : "WILL NOT POST"} \u2192 ${destination(item)}`,
			sections: [
				{ label: `Replying to @${item.author} · ${item.location}`, markdown: item.body, maxLines: 10 },
				{
					label: `Exact text posted to GitHub${item.kind === "thread" ? "" : " (plus a hidden marker)"}`,
					markdown: visibleReplyBody(item, entry.reply),
				},
			],
			hints: "enter post · s don't post · e edit · ←/→ navigate · esc pause",
		});

		if (key === "escape") return undefined;
		if (key === "left") index = Math.max(0, index - 1);
		else if (key === "right") index = Math.min(entries.length - 1, index + 1);
		else if (key === "e") {
			entry.reply = (await editText(ctx, `GitHub reply to ${item.id}`, entry.reply)) ?? entry.reply;
		} else if (key === "s") {
			entry.post = false;
			index++;
		} else if (key === "enter") {
			entry.post = true;
			index++;
		}
	}

	const approved = new Map(entries.filter((e) => e.post).map((e) => [e.id, e.reply]));
	if (approved.size === 0) return approved;
	const warning = warnings.length ? `\n\n${warnings.join(" ")}` : "";
	const confirmed = await ctx.ui.confirm(
		"Post to GitHub?",
		`Post ${plural(approved.size, "reply", "replies")} (${[...approved.keys()].join(", ")}) to PR #${current.number}?${warning}`,
	);
	return confirmed ? approved : undefined;
}

async function fetchReview(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	ref: { owner: string; repo: string; number: number },
): Promise<{ session: ReviewSession; headRef: string }> {
	const query = `query($owner:String!,$repo:String!,$number:Int!){
  viewer{login}
  repository(owner:$owner,name:$repo){pullRequest(number:$number){
    title url headRefName author{login}
    reviewThreads(first:100){nodes{id isResolved isOutdated path line originalLine
      comments(first:50){nodes{author{login} body url diffHunk reactions(first:50){nodes{user{login}}}}}}}
    reviews(first:100){nodes{id author{login} body url reactions(first:50){nodes{user{login}}}}}
    comments(first:100){nodes{id author{login} body url reactions(first:50){nodes{user{login}}}}}
  }}}`;
	const result = await pi.exec(
		"gh",
		["api", "graphql", "-F", `owner=${ref.owner}`, "-F", `repo=${ref.repo}`, "-F", `number=${ref.number}`, "-f", `query=${query}`],
		{ cwd: ctx.cwd, timeout: 30_000 },
	);
	if (result.code !== 0) throw new Error(result.stderr.trim() || `gh exited with ${result.code}`);

	const data = JSON.parse(result.stdout).data;
	const pr = data?.repository?.pullRequest;
	if (!pr) throw new Error("Pull request not found");

	// Feedback counts as answered once the PR author, or whoever runs this,
	// spoke last in a thread, left a marker reply, or reacted with an emoji.
	const responders = new Set([pr.author?.login, data.viewer?.login].filter(Boolean));
	const acknowledged = (node: { reactions?: { nodes: { user?: { login: string } | null }[] } }) =>
		(node.reactions?.nodes ?? []).some((reaction) => responders.has(reaction.user?.login));
	const answered = new Set<string>();
	for (const comment of pr.comments.nodes) {
		if (!responders.has(comment.author?.login)) continue;
		for (const match of String(comment.body).matchAll(/<!-- address-review:(\S+) -->/g)) answered.add(match[1]!);
	}

	const items: ReviewItem[] = [];
	let threads = 0;
	let reviews = 0;
	let comments = 0;

	for (const thread of pr.reviewThreads.nodes) {
		const posts = thread.comments.nodes;
		if (thread.isResolved || posts.length === 0) continue;
		const last = posts[posts.length - 1];
		if (responders.has(last.author?.login) || acknowledged(last)) continue;
		const line = thread.line ?? thread.originalLine;
		items.push({
			id: `T${++threads}`,
			kind: "thread",
			nodeId: thread.id,
			author: login(posts[0]),
			location: `${thread.path}${line ? `:${line}` : ""}${thread.isOutdated ? " (outdated)" : ""}`,
			url: posts[0].url,
			body: posts.map((post: { author?: { login: string }; body: string }) => `**@${login(post)}:** ${post.body}`).join("\n\n"),
			diffHunk: posts[0].diffHunk,
		});
	}

	for (const review of pr.reviews.nodes) {
		if (!review.body?.trim() || responders.has(review.author?.login) || answered.has(review.id) || acknowledged(review))
			continue;
		items.push({
			id: `R${++reviews}`,
			kind: "review",
			nodeId: review.id,
			author: login(review),
			location: "review body",
			url: review.url,
			body: review.body,
		});
	}

	for (const comment of pr.comments.nodes) {
		if (!comment.body?.trim() || responders.has(comment.author?.login) || answered.has(comment.id) || acknowledged(comment))
			continue;
		items.push({
			id: `C${++comments}`,
			kind: "comment",
			nodeId: comment.id,
			author: login(comment),
			location: "conversation",
			url: comment.url,
			body: comment.body,
		});
	}

	return {
		session: { prUrl: pr.url, owner: ref.owner, repo: ref.repo, number: ref.number, title: pr.title, items },
		headRef: pr.headRefName,
	};
}

async function postReply(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	current: ReviewSession,
	item: ReviewItem,
	reply: string,
	signal: AbortSignal | undefined,
): Promise<string> {
	if (item.kind === "thread") {
		const mutation = `mutation($threadId:ID!,$body:String!){
  addPullRequestReviewThreadReply(input:{pullRequestReviewThreadId:$threadId,body:$body}){comment{url}}}`;
		const result = await pi.exec(
			"gh",
			["api", "graphql", "-f", `threadId=${item.nodeId}`, "-f", `body=${reply}`, "-f", `query=${mutation}`],
			{ cwd: ctx.cwd, timeout: 30_000, signal },
		);
		if (result.code !== 0) throw new Error(result.stderr.trim() || `gh exited with ${result.code}`);
		return JSON.parse(result.stdout).data.addPullRequestReviewThreadReply.comment.url;
	}

	const body = `${visibleReplyBody(item, reply)}\n\n${MARKER_PREFIX}${item.nodeId} -->`;
	const result = await pi.exec("gh", ["pr", "comment", current.prUrl, "--body", body], {
		cwd: ctx.cwd,
		timeout: 30_000,
		signal,
	});
	if (result.code !== 0) throw new Error(result.stderr.trim() || `gh exited with ${result.code}`);
	return result.stdout.trim();
}

function buildKickoffPrompt(current: ReviewSession): string {
	const items = current.items
		.map((item) => {
			const hunk = item.diffHunk ? `\n\`\`\`diff\n${item.diffHunk}\n\`\`\`` : "";
			return `### ${item.id} · @${item.author} · ${item.location}\n${item.url}${hunk}\n\n${item.body}`;
		})
		.join("\n\n");

	return `Address the open review feedback on PR #${current.number} "${current.title}" (${current.prUrl}).

The address-review extension fetched these open items. Resolved threads and feedback that was already answered are filtered out.

${items}

## What to do now

1. Run \`gh pr diff ${current.prUrl}\` and read the code relevant to every item. Do not change any code yet.
2. Classify every item:
   - fix — valid, needs a code change
   - question — the reviewer asks something; answer it, no code change
   - decline — wrong, out of scope, or conflicts with a deliberate design choice; explain why
   - skip — the current code already handles it, or there is nothing to respond to (bot noise, praise)
   - unsure — could reasonably go either way; the user decides
   Outdated threads are still open until you have checked the current code. A review body may raise several points; one reply covers them all.
3. Call \`review_triage\` once with every item. Draft a GitHub reply only for question and decline items: short, specific and technical, citing files and functions, no thanks or filler. Fix and skip items get no reply; give fix items a one-line plan.

Never post to GitHub yourself: \`review_submit\` is the only way replies reach the PR.`;
}

function buildTriageResult(current: ReviewSession, decisions: Decision[]): string {
	const lines = decisions.map((d) => {
		const parts = [`${d.id} — ${d.classification}: ${d.summary}`];
		if (d.plan) parts.push(`  plan: ${d.plan}`);
		if (d.reply) parts.push(`  approved reply: ${d.reply}`);
		if (d.note) parts.push(`  user instruction: ${d.note}`);
		return parts.join("\n");
	});
	const fixes = decisions.filter((d) => d.classification === "fix");

	const next = fixes.length
		? `Next:
1. Implement the fix items (${fixes.map((d) => d.id).join(", ")}), following any user instruction. Keep each change minimal and scoped to its comment, and follow the repository's conventions (AGENTS.md / CLAUDE.md).
2. Run the tests, type checks and linters relevant to the changed code, and fix what breaks.
3. Do not commit or push.
4. Call \`review_submit\` with a summary for the user. It is never posted; the GitHub replies approved above are already stored.`
		: "Next: there is no code to change. Call `review_submit` with a short summary for the user. It is never posted.";

	return `The user reviewed the triage of PR #${current.number}:\n\n${lines.join("\n\n")}\n\n${next}`;
}

function collectReplies(decisions: Decision[]): Map<string, string> {
	return new Map(decisions.flatMap((d) => (d.reply?.trim() ? [[d.id, d.reply.trim()] as const] : [])));
}

function getsReply(classification: Classification): boolean {
	return classification === "question" || classification === "decline";
}

function destination(item: ReviewItem): string {
	if (item.kind === "thread") return `reply in the review thread on ${item.location}`;
	return `new PR comment quoting @${item.author}'s ${item.kind === "review" ? "review" : "comment"}`;
}

/** The reply as it appears on GitHub; conversation replies quote what they answer. */
function visibleReplyBody(item: ReviewItem, reply: string): string {
	return item.kind === "thread" ? reply : `${quote(item)}\n\n${reply}`;
}

function renderStopped(outcome: Outcome | undefined, theme: Theme): Text {
	if (outcome === "ended") return new Text(theme.fg("muted", "Review ended \u00b7 nothing was posted to GitHub"), 0, 0);
	return new Text(
		theme.fg("warning", "Paused \u00b7 nothing was posted to GitHub \u00b7 ") +
			theme.fg("dim", "review still open, /address-review stop ends it"),
		0,
		0,
	);
}

function assertCoversItems(current: ReviewSession, ids: string[]): void {
	const known = new Set(current.items.map((item) => item.id));
	const unknown = ids.filter((id) => !known.has(id));
	const missing = [...known].filter((id) => !ids.includes(id));
	const duplicated = ids.filter((id, i) => ids.indexOf(id) !== i);
	const problems = [
		unknown.length && `unknown ids: ${unknown.join(", ")}`,
		missing.length && `missing ids: ${missing.join(", ")}`,
		duplicated.length && `duplicated ids: ${duplicated.join(", ")}`,
	].filter(Boolean);
	if (problems.length) throw new Error(`Triage must list every open item exactly once (${problems.join("; ")})`);
}

function requireSession(current: ReviewSession | undefined): ReviewSession {
	if (!current) throw new Error("No active review. The user starts one with /address-review <pr-url>.");
	return current;
}

function restoreSession(ctx: ExtensionContext): ReviewSession | undefined {
	let restored: ReviewSession | undefined;
	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type === "custom" && entry.customType === ENTRY_TYPE) {
			restored = (entry.data as { session: ReviewSession | null } | undefined)?.session ?? undefined;
		}
	}
	return restored;
}

async function showCard(ctx: ExtensionContext, card: Card): Promise<CardKey> {
	return ctx.ui.custom<CardKey>((tui, theme, _keybindings, done) => {
		const component = new CardComponent(card, theme);
		return {
			render: (width) => component.render(width),
			invalidate: () => component.invalidate(),
			handleInput(data: string) {
				const key = readCardKey(data);
				if (key) done(key);
				else tui.requestRender();
			},
		};
	});
}

class CardComponent implements Component {
	private cachedWidth?: number;
	private cachedLines?: string[];

	constructor(
		private readonly card: Card,
		private readonly theme: Theme,
	) {}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;
		const th = this.theme;
		const lines: string[] = [th.fg("accent", "─".repeat(width))];

		lines.push(...wrapTextWithAnsi(th.fg("accent", th.bold(` ${this.card.title}`)), width));
		if (this.card.subtitle) lines.push(truncateToWidth(th.fg("muted", ` ${this.card.subtitle}`), width));

		for (const section of this.card.sections) {
			lines.push("", truncateToWidth(th.fg("dim", ` ${section.label}`), width));
			let body = new Markdown(section.markdown, 1, 0, getMarkdownTheme()).render(width);
			if (section.maxLines && body.length > section.maxLines) {
				const hidden = body.length - section.maxLines;
				body = [...body.slice(0, section.maxLines), th.fg("dim", `  … ${hidden} more lines`)];
			}
			lines.push(...body);
		}

		lines.push("", ...wrapTextWithAnsi(th.fg("dim", ` ${this.card.hints}`), width), th.fg("accent", "─".repeat(width)));
		this.cachedWidth = width;
		this.cachedLines = lines;
		return lines;
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}
}

function readCardKey(data: string): CardKey | undefined {
	if (matchesKey(data, "return") || matchesKey(data, "enter")) return "enter";
	if (matchesKey(data, "escape")) return "escape";
	if (matchesKey(data, "left")) return "left";
	if (matchesKey(data, "right")) return "right";
	for (const letter of ["e", "c", "i", "s"] as const) {
		if (matchesKey(data, letter)) return letter;
	}
	return undefined;
}

async function editText(ctx: ExtensionContext, title: string, prefill: string | undefined): Promise<string | undefined> {
	const text = await ctx.ui.editor(title, prefill ?? "");
	if (text === undefined) return prefill;
	return text.trim() || undefined;
}

async function pickClassification(
	ctx: ExtensionContext,
	id: string,
): Promise<Decision["classification"] | undefined> {
	const choice = await ctx.ui.select(`Classify ${id}`, ["fix", "question", "decline", "skip"]);
	return choice as Decision["classification"] | undefined;
}

async function readGitStatus(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
): Promise<{ branch: string; hasUpstream: boolean; ahead: number; dirty: boolean }> {
	const result = await pi.exec("git", ["status", "--porcelain=v2", "--branch"], { cwd: ctx.cwd, timeout: 10_000 });
	const lines = result.stdout.split("\n").filter(Boolean);
	const header = (name: string) => lines.find((line) => line.startsWith(`# branch.${name} `))?.slice(`# branch.${name} `.length);
	return {
		branch: header("head") ?? "",
		hasUpstream: header("upstream") !== undefined,
		ahead: Number(header("ab")?.match(/^\+(\d+)/)?.[1] ?? 0),
		dirty: lines.some((line) => !line.startsWith("#")),
	};
}

function parsePrUrl(input: string): { owner: string; repo: string; number: number } | undefined {
	const match = input.match(/github\.com\/([^/\s]+)\/([^/\s]+)\/pull\/(\d+)/);
	if (!match) return undefined;
	return { owner: match[1]!, repo: match[2]!, number: Number(match[3]) };
}

function plural(count: number, singular: string, pluralForm: string): string {
	return `${count} ${count === 1 ? singular : pluralForm}`;
}

function quote(item: ReviewItem): string {
	const excerpt = item.body.split("\n").slice(0, 3).join("\n");
	return `@${item.author} re ${item.url}\n${excerpt.replace(/^/gm, "> ")}`;
}

function login(node: { author?: { login: string } | null }): string {
	return node.author?.login ?? "ghost";
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
