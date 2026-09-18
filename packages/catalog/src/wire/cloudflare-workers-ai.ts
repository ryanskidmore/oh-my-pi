import { isRecord } from "../utils";

/** Account-scoped Workers AI REST root; `<account>` is substituted per request and per discovery. */
export const CLOUDFLARE_WORKERS_AI_ACCOUNT_BASE_URL = "https://api.cloudflare.com/client/v4/accounts/<account>/ai";
/** OpenAI-compatible chat-completions root carried on every Workers AI model spec. */
export const CLOUDFLARE_WORKERS_AI_BASE_URL = `${CLOUDFLARE_WORKERS_AI_ACCOUNT_BASE_URL}/v1`;
/**
 * Prompt-cache session header. Workers AI has no `prompt_cache_key`: requests only reuse a warm
 * prompt cache when an identical `x-session-affinity` value routes them to the same instance
 * (developers.cloudflare.com/workers-ai/features/prompt-caching).
 */
export const CLOUDFLARE_WORKERS_AI_SESSION_HEADER = "x-session-affinity";

/** Account-substituted canonical chat root, e.g. `…/accounts/abc123/ai/v1`. */
const CANONICAL_BASE_URL_RE = /^https:\/\/api\.cloudflare\.com\/client\/v4\/accounts\/[^/]+\/ai\/v1\/?$/;

/** Opaque API-key credential payload persisted by Cloudflare Workers AI login. */
export interface CloudflareWorkersAiCredential {
	token: string;
	accountId?: string;
}

/** Parse both structured login credentials and bare API tokens. */
export function parseCloudflareWorkersAiCredential(value: string): CloudflareWorkersAiCredential | null {
	const trimmed = value.trim();
	if (!trimmed) return null;
	if (!trimmed.startsWith("{")) return { token: trimmed };
	try {
		const parsed: unknown = JSON.parse(trimmed);
		if (!isRecord(parsed)) return null;
		if (typeof parsed.token !== "string" || !parsed.token.trim()) return null;
		if (parsed.accountId !== undefined && typeof parsed.accountId !== "string") return null;
		const credential: CloudflareWorkersAiCredential = { token: parsed.token.trim() };
		const accountId = parsed.accountId?.trim();
		if (accountId) credential.accountId = accountId;
		return credential;
	} catch {
		return null;
	}
}

/** Serialize the API token with the account id collected during login. */
export function serializeCloudflareWorkersAiCredential(token: string, accountId: string): string {
	return JSON.stringify({ token: token.trim(), accountId: accountId.trim() });
}

/** Substitute `<account>` into a Workers AI base URL; URLs without the placeholder pass through. */
export function resolveCloudflareWorkersAiBaseUrl(baseUrl: string, accountId: string): string {
	return baseUrl.replace("<account>", accountId);
}

/**
 * Collapse an account-substituted canonical chat root back to its `<account>` template so
 * discovered and cached rows stay account-agnostic and a later account switch re-targets them
 * (the same contract `cloudflare-ai-gateway` gets from its placeholder base URL). A self-hosted
 * or proxied override passes through unchanged.
 */
export function toCloudflareWorkersAiSpecBaseUrl(baseUrl: string): string {
	return CANONICAL_BASE_URL_RE.test(baseUrl.trim()) ? CLOUDFLARE_WORKERS_AI_BASE_URL : baseUrl;
}

/** Models-search endpoint sibling of a chat root: `…/ai/v1` → `…/ai/models/search`. */
export function toCloudflareWorkersAiModelsSearchUrl(baseUrl: string): string {
	const trimmed = baseUrl.trim().replace(/\/+$/, "");
	const accountRoot = trimmed.endsWith("/v1") ? trimmed.slice(0, -"/v1".length) : trimmed;
	return `${accountRoot}/models/search`;
}
