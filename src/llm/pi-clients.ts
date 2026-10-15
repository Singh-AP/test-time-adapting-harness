import type { Api, AssistantMessage, Context, Message, Model, Models, ThinkingLevel } from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { loadSharedConfigFiles } from "@smithy/core/config";
import type {
	ProposerClient,
	ProposerRequest,
	ProposerResponse,
	SolverClient,
	SolverMessage,
	SolverRequest,
	SolverResponse,
	Usage,
} from "../core/types.ts";
import { type Semaphore, sleep } from "../util/concurrency.ts";
import { resolveModel } from "./model-spec.ts";

/**
 * A pi-ai model collection with every built-in provider. Credentials come from each provider's usual source:
 * API-key variables such as ANTHROPIC_API_KEY or OPENAI_API_KEY, and the AWS credential chain for Amazon Bedrock.
 */
export function createModelCatalog(): Models {
	return builtinModels();
}

/** Resolves "provider/model-id", or a bare Amazon Bedrock model id (see model-spec.ts). */
export function requireModel(models: Models, spec: string): Model<Api> {
	return resolveModel(models, spec);
}

export interface RetryPolicy {
	maxAttempts: number;
	baseDelayMs: number;
	maxDelayMs: number;
	/** How often to reload credentials while they are expired. */
	expiredPollMs?: number;
	/** How long to wait for refreshed credentials before failing. */
	expiredMaxWaitMs?: number;
}

export const DEFAULT_RETRY: RetryPolicy = {
	maxAttempts: 6,
	baseDelayMs: 1000,
	maxDelayMs: 30_000,
	expiredPollMs: 20_000,
	expiredMaxWaitMs: 45 * 60_000,
};

const RETRYABLE =
	/throttl|too many|rate.?limit|rate exceeded|\b429\b|\b50[0-4]\b|service.?unavailable|internal.?server|internalfailure|timed? ?out|timeout|ECONNRESET|EPIPE|ETIMEDOUT|socket hang up|overloaded|not ready|try again|network/i;

export function isRetryable(message: string | undefined): boolean {
	return RETRYABLE.test(message ?? "");
}

const EXPIRED = /ExpiredToken|token included in the request is expired|token has expired/i;

/** Vended session credentials expired; a long run waits for them to be refreshed instead of failing. */
export function isExpiredCredentials(message: string | undefined): boolean {
	return EXPIRED.test(message ?? "");
}

/**
 * The AWS SDK caches the shared config and credentials files for the life of the process, so refreshed
 * credentials are not seen by later requests. Reloading the files replaces that cache.
 */
export async function reloadAwsSharedFiles(): Promise<void> {
	await loadSharedConfigFiles({ ignoreCache: true });
}

/** Removes <think>...</think> blocks that some open models emit inline. */
export function stripThinking(text: string): string {
	let out = text.replace(/<think>[\s\S]*?<\/think>/g, "");
	const close = out.lastIndexOf("</think>");
	if (close >= 0) out = out.slice(close + "</think>".length);
	return out.trimStart();
}

/** pi-ai reports failures as messages with stopReason "error"; retry the transient ones with backoff and jitter. */
export async function completeWithRetry(
	call: () => Promise<AssistantMessage>,
	policy: RetryPolicy,
	signal?: AbortSignal,
	onRetry?: (attempt: number, message: string) => void,
	refreshCredentials: () => Promise<void> = reloadAwsSharedFiles,
): Promise<AssistantMessage> {
	let waitedMs = 0;
	for (let attempt = 1; ; ) {
		const message = await call();
		if (message.stopReason !== "error" || signal?.aborted) return message;
		if (isExpiredCredentials(message.errorMessage)) {
			const pollMs = policy.expiredPollMs ?? 20_000;
			if (waitedMs >= (policy.expiredMaxWaitMs ?? 45 * 60_000)) return message;
			onRetry?.(attempt, `credentials expired; reloading in ${Math.round(pollMs / 1000)} s`);
			await sleep(pollMs, signal);
			waitedMs += pollMs;
			await refreshCredentials();
			continue;
		}
		if (attempt >= policy.maxAttempts || !isRetryable(message.errorMessage)) return message;
		onRetry?.(attempt, message.errorMessage ?? "");
		const delay = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** (attempt - 1)) * (0.5 + Math.random() * 0.5);
		await sleep(delay, signal);
		attempt++;
	}
}

function zeroUsage(): AssistantMessage["usage"] {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function toContext(model: Model<Api>, system: string | undefined, messages: readonly SolverMessage[]): Context {
	const timestamp = Date.now();
	return {
		systemPrompt: system,
		messages: messages.map(
			(m): Message =>
				m.role === "user"
					? { role: "user", content: m.content, timestamp }
					: {
							role: "assistant",
							content: [{ type: "text", text: m.content }],
							api: model.api,
							provider: model.provider,
							model: model.id,
							usage: zeroUsage(),
							stopReason: "stop",
							timestamp,
						},
		),
	};
}

function textOf(message: AssistantMessage): string {
	let text = "";
	for (const block of message.content) if (block.type === "text") text += block.text;
	return text;
}

/** Input includes prompt tokens served from or written to the provider's cache. */
export function usageOf(message: AssistantMessage): Usage {
	const u = message.usage;
	return { input: u.input + u.cacheRead + u.cacheWrite, output: u.output, cost: u.cost.total };
}

export interface PiClientOptions {
	models: Models;
	model: Model<Api>;
	retry?: RetryPolicy;
	/** Bounds concurrent requests across all callers of this client. */
	limiter?: Semaphore;
	onRetry?: (attempt: number, message: string) => void;
	/** Reloads credentials after an expired-token error (default: reload the AWS shared files). */
	refreshCredentials?: () => Promise<void>;
}

/** Frozen solver: a pi-ai model behind the harness's llm() global. */
export class PiSolverClient implements SolverClient {
	private readonly options: PiClientOptions & { temperature?: number };

	constructor(options: PiClientOptions & { temperature?: number }) {
		this.options = options;
	}

	async complete(request: SolverRequest, signal?: AbortSignal): Promise<SolverResponse> {
		const { models, model } = this.options;
		const context = toContext(model, request.system, request.messages);
		const temperature = request.temperature ?? this.options.temperature;
		const call = () =>
			completeWithRetry(
				() => models.complete(model, context, { maxTokens: request.maxTokens, temperature, signal }),
				this.options.retry ?? DEFAULT_RETRY,
				signal,
				this.options.onRetry,
				this.options.refreshCredentials,
			);
		const message = this.options.limiter ? await this.options.limiter.run(call) : await call();
		if (message.stopReason === "error" || message.stopReason === "aborted") {
			throw new Error(`solver model error: ${message.errorMessage ?? message.stopReason}`);
		}
		return { text: stripThinking(textOf(message)), stopReason: message.stopReason, usage: usageOf(message) };
	}
}

/** Proposer: a pi-ai model with optional reasoning; returns final text only. */
export class PiProposerClient implements ProposerClient {
	private readonly options: PiClientOptions & { reasoning?: ThinkingLevel; maxTokens?: number };

	constructor(options: PiClientOptions & { reasoning?: ThinkingLevel; maxTokens?: number }) {
		this.options = options;
	}

	async complete(request: ProposerRequest, signal?: AbortSignal): Promise<ProposerResponse> {
		const { models, model } = this.options;
		const context = toContext(model, request.system, request.messages);
		const maxTokens = Math.min(this.options.maxTokens ?? 32_000, model.maxTokens);
		const call = () =>
			completeWithRetry(
				() => models.completeSimple(model, context, { maxTokens, reasoning: this.options.reasoning, signal }),
				this.options.retry ?? DEFAULT_RETRY,
				signal,
				this.options.onRetry,
				this.options.refreshCredentials,
			);
		const message = this.options.limiter ? await this.options.limiter.run(call) : await call();
		if (message.stopReason === "error" || message.stopReason === "aborted") {
			return {
				text: "",
				stopReason: "error",
				usage: usageOf(message),
				error: message.errorMessage ?? message.stopReason,
			};
		}
		return { text: textOf(message), stopReason: message.stopReason, usage: usageOf(message) };
	}
}
