import { describe, expect, test } from "bun:test";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { providerEntry } from "@oh-my-pi/pi-catalog/compat/providers";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import type { ModelSpec } from "@oh-my-pi/pi-catalog/types";
import {
	CLOUDFLARE_WORKERS_AI_BASE_URL,
	parseCloudflareWorkersAiCredential,
	serializeCloudflareWorkersAiCredential,
	toCloudflareWorkersAiModelsSearchUrl,
	toCloudflareWorkersAiSpecBaseUrl,
} from "@oh-my-pi/pi-catalog/wire/cloudflare-workers-ai";

function workersAiSpec(): ModelSpec<"openai-completions"> {
	return {
		id: "@cf/zai-org/glm-5.3-flash",
		name: "GLM 5.3 Flash",
		api: "openai-completions",
		provider: "cloudflare-workers-ai",
		baseUrl: CLOUDFLARE_WORKERS_AI_BASE_URL,
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 0.15, output: 0.5, cacheRead: 0.03, cacheWrite: 0 },
		contextWindow: 1_310_720,
		maxTokens: 32_768,
		thinking: { mode: "effort", efforts: [Effort.Low, Effort.High, Effort.Max] },
	};
}

describe("Cloudflare Workers AI credential", () => {
	test("credential round-trips the token and account id", () => {
		// Asserts the exact persisted shape the `ai` transport parses.
		expect(
			parseCloudflareWorkersAiCredential(serializeCloudflareWorkersAiCredential(" wai-test-token ", " acct-test ")),
		).toEqual({
			token: "wai-test-token",
			accountId: "acct-test",
		});
	});

	test("a bare token parses without an account id", () => {
		// Defends the env-only path and rejects junk.
		expect(parseCloudflareWorkersAiCredential("wai-test-token")).toEqual({ token: "wai-test-token" });
		expect(parseCloudflareWorkersAiCredential("{}")).toBeNull();
		expect(parseCloudflareWorkersAiCredential("   ")).toBeNull();
	});
});

describe("Cloudflare Workers AI base URLs", () => {
	test("the spec base URL stays account-agnostic", () => {
		// Defends the contract that a cached row re-targets after an account switch.
		expect(toCloudflareWorkersAiSpecBaseUrl("https://api.cloudflare.com/client/v4/accounts/acct-test/ai/v1")).toBe(
			CLOUDFLARE_WORKERS_AI_BASE_URL,
		);
		expect(toCloudflareWorkersAiSpecBaseUrl("https://proxy.internal/v1")).toBe("https://proxy.internal/v1");
	});

	test("the models-search URL is the account root's sibling", () => {
		expect(
			toCloudflareWorkersAiModelsSearchUrl("https://api.cloudflare.com/client/v4/accounts/acct-test/ai/v1"),
		).toBe("https://api.cloudflare.com/client/v4/accounts/acct-test/ai/models/search");
		expect(
			toCloudflareWorkersAiModelsSearchUrl("https://api.cloudflare.com/client/v4/accounts/acct-test/ai/v1/"),
		).toBe("https://api.cloudflare.com/client/v4/accounts/acct-test/ai/models/search");
	});
});

describe("Cloudflare Workers AI resolved compat", () => {
	test("resolved compat carries the Workers AI deployment contract", () => {
		const model = buildModel(workersAiSpec());
		expect(model.compat.promptCacheSessionHeader).toBe("x-session-affinity");
		expect(model.compat.alwaysSendMaxTokens).toBe(true);
		expect(model.compat.supportsNamedToolChoice).toBe(false);
		expect(model.compat.supportsForcedToolChoice).toBe(true);
		expect(model.compat.supportsDeveloperRole).toBe(false);
		expect(model.compat.supportsStore).toBe(false);
		expect(model.compat.reasoningContentField).toBe("reasoning_content");
		// The default never sends the 400-producing `reasoning_effort: "none"`.
		expect(model.compat.reasoningDisableMode).not.toBe("none-effort");
	});
});

describe("Cloudflare Workers AI catalog entry", () => {
	test("the catalog entry declares the documented env fallback and default model", () => {
		const entry = providerEntry("cloudflare-workers-ai");
		expect(entry?.defaultModel).toBe("@cf/moonshotai/kimi-k2.7-code");
		expect(entry?.envVars).toEqual(["CLOUDFLARE_WORKERS_AI_API_KEY", "CLOUDFLARE_API_TOKEN"]);
		expect(entry?.dynamicModelsAuthoritative).toBe(true);
		// The runtime-only contract the generator depends on.
		expect(entry?.discovery).toBeUndefined();
	});
});
