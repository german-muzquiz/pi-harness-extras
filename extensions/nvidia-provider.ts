import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

// pi ships a hardcoded NVIDIA model catalog that goes stale: NVIDIA retires
// hosted models (e.g. `z-ai/glm-5.1` reached end-of-life and now returns HTTP
// 410) faster than the built-in list is regenerated. Instead of shipping our
// own frozen list, we discard pi's list and rebuild it from NVIDIA's live
// `/v1/models` endpoint on every startup, so retired models disappear and new
// ones appear automatically.

const NVIDIA_BASE_URL = "https://integrate.api.nvidia.com/v1";

// NVCF-POLL-SECONDS keeps long NVCF function invocations from timing out; the
// compat flags mirror what pi's built-in provider sends for this OpenAI-compat
// endpoint (no store, no developer role, `max_tokens` instead of
// `max_completion_tokens`, no strict mode).
const NVIDIA_HEADERS: Record<string, string> = { "NVCF-POLL-SECONDS": "3600" };
const NVIDIA_COMPAT = {
	supportsStore: false,
	supportsDeveloperRole: false,
	supportsReasoningEffort: false,
	maxTokensField: "max_tokens" as const,
	supportsStrictMode: false,
	supportsLongCacheRetention: false,
};

type Capability = {
	name?: string;
	reasoning: boolean;
	input: ("text" | "image")[];
	contextWindow: number;
	maxTokens: number;
	cost?: { input: number; output: number; cacheRead: number; cacheWrite: number };
};

// The `/v1/models` endpoint only returns ids, so it can't tell us whether a
// model reasons, accepts images, or how large its context is. This curated map
// supplies accurate capabilities for the models we know; anything not listed
// falls back to conservative heuristics in `buildModel`.
const CAPABILITIES: Record<string, Capability> = {
	"minimaxai/minimax-m3": { name: "MiniMax-M3", reasoning: true, input: ["text", "image"], contextWindow: 1000000, maxTokens: 16384 },
	"mistralai/mistral-large-3-675b-instruct-2512": { name: "Mistral Large 3 675B", reasoning: false, input: ["text", "image"], contextWindow: 262144, maxTokens: 262144 },
	"mistralai/mistral-small-4-119b-2603": { name: "Mistral Small 4 119B", reasoning: true, input: ["text", "image"], contextWindow: 128000, maxTokens: 8192 },
	"moonshotai/kimi-k2.6": { name: "Kimi K2.6", reasoning: true, input: ["text", "image"], contextWindow: 262144, maxTokens: 262144 },
	"nvidia/nemotron-3-nano-30b-a3b": { name: "Nemotron 3 Nano 30B", reasoning: true, input: ["text"], contextWindow: 131072, maxTokens: 131072 },
	"nvidia/nemotron-3-nano-omni-30b-a3b-reasoning": { name: "Nemotron 3 Nano Omni", reasoning: true, input: ["text", "image"], contextWindow: 256000, maxTokens: 65536 },
	"nvidia/nemotron-3-super-120b-a12b": { name: "Nemotron 3 Super", reasoning: true, input: ["text"], contextWindow: 262144, maxTokens: 262144, cost: { input: 0.2, output: 0.8, cacheRead: 0, cacheWrite: 0 } },
	"nvidia/nemotron-3-ultra-550b-a55b": { name: "Nemotron 3 Ultra 550B", reasoning: true, input: ["text"], contextWindow: 1000000, maxTokens: 65536, cost: { input: 0.5, output: 2.5, cacheRead: 0.15, cacheWrite: 0 } },
	"nvidia/nvidia-nemotron-nano-9b-v2": { name: "Nemotron Nano 9B v2", reasoning: true, input: ["text"], contextWindow: 131072, maxTokens: 131072 },
	"openai/gpt-oss-120b": { name: "GPT-OSS 120B", reasoning: true, input: ["text"], contextWindow: 128000, maxTokens: 8192 },
	"openai/gpt-oss-20b": { name: "GPT-OSS 20B", reasoning: true, input: ["text"], contextWindow: 131072, maxTokens: 32768 },
	"qwen/qwen3.5-122b-a10b": { name: "Qwen3.5 122B-A10B", reasoning: true, input: ["text", "image"], contextWindow: 262144, maxTokens: 65536 },
	"stepfun-ai/step-3.5-flash": { name: "Step 3.5 Flash", reasoning: true, input: ["text"], contextWindow: 256000, maxTokens: 16384 },
	"stepfun-ai/step-3.7-flash": { name: "Step 3.7 Flash", reasoning: true, input: ["text", "image"], contextWindow: 256000, maxTokens: 16384 },
	"z-ai/glm-5.2": { name: "GLM-5.2", reasoning: true, input: ["text"], contextWindow: 131072, maxTokens: 131072 },
};

// The live catalog also exposes embeddings, rerankers, reward, safety/guard and
// document-parsing models that can't be driven as chat models. Excluding them
// keeps the `/model` picker limited to usable conversational endpoints.
const NON_CHAT_PATTERN = /embed|embedqa|rerank|reward|safety|guard|parse|content-safety/i;

export default async function (pi: ExtensionAPI) {
	const apiKey = resolveNvidiaKey();

	let ids: string[];
	try {
		ids = await fetchChatModelIds(apiKey);
	} catch (error) {
		// Falling back to the curated ids keeps a working provider (still free of
		// the retired glm-5.1) even when we can't reach NVIDIA at startup.
		console.error(`[nvidia-provider] live model fetch failed, using curated list: ${errorMessage(error)}`);
		ids = Object.keys(CAPABILITIES);
	}

	pi.registerProvider("nvidia", {
		name: "NVIDIA",
		baseUrl: NVIDIA_BASE_URL,
		// Prefer the resolved literal key so auth works regardless of how the key
		// is stored; fall back to the standard env reference otherwise.
		apiKey: apiKey ?? "$NVIDIA_API_KEY",
		api: "openai-completions",
		models: ids.map(buildModel),
	});
}

function buildModel(id: string) {
	const cap = CAPABILITIES[id] ?? inferCapability(id);
	return {
		id,
		name: cap.name ?? id,
		reasoning: cap.reasoning,
		input: cap.input,
		cost: cap.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: cap.contextWindow,
		maxTokens: cap.maxTokens,
		headers: NVIDIA_HEADERS,
		compat: NVIDIA_COMPAT,
	};
}

async function fetchChatModelIds(apiKey: string | undefined): Promise<string[]> {
	const response = await fetch(`${NVIDIA_BASE_URL}/models`, {
		headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
	});
	if (!response.ok) {
		throw new Error(`HTTP ${response.status}`);
	}
	const payload = (await response.json()) as { data?: Array<{ id: string }> };
	const ids = (payload.data ?? []).map((m) => m.id).filter((id) => !NON_CHAT_PATTERN.test(id));
	if (ids.length === 0) {
		throw new Error("no chat models returned");
	}
	return ids.sort();
}

// Conservative defaults for models missing from CAPABILITIES: assume text-only,
// non-reasoning, mid-size context. Vision support is the one trait reliably
// encoded in NVIDIA ids ("vl"/"vision"/"omni"), so we detect it here.
function inferCapability(id: string): Capability {
	const input: ("text" | "image")[] = /(?:^|[-/])(?:vl|vision|omni)(?:[-/]|$)/i.test(id) ? ["text", "image"] : ["text"];
	return { reasoning: false, input, contextWindow: 128000, maxTokens: 8192 };
}

// Resolve the key the same way pi does at request time so our startup fetch can
// authenticate: NVIDIA_API_KEY env var first, then the `nvidia` entry in
// ~/.pi/agent/auth.json (which may store a literal key or a `!command`).
function resolveNvidiaKey(): string | undefined {
	const fromEnv = process.env.NVIDIA_API_KEY?.trim();
	if (fromEnv) return fromEnv;

	try {
		const authPath = path.join(os.homedir(), ".pi", "agent", "auth.json");
		const auth = JSON.parse(readFileSync(authPath, "utf8")) as Record<string, { type?: string; key?: string }>;
		const stored = auth.nvidia?.key?.trim();
		if (!stored) return undefined;
		if (stored.startsWith("!")) {
			return execSync(stored.slice(1), { encoding: "utf8" }).trim();
		}
		return stored;
	} catch {
		return undefined;
	}
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
