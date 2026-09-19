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

function workersAiSpec(overrides: Partial<ModelSpec<"openai-completions">> = {}): ModelSpec<"openai-completions"> {
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
		...overrides,
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

	test("every row demands plain-string message content", () => {
		// Five rows validate against a per-model JSON Schema that types `messages[].content`
		// as a string or ONE content part, and 400 (code 5006) on an array of two or more.
		// The axis is declared at the provider root, so it holds for text-only and
		// multimodal rows alike; image parts stay arrays because the transport exempts
		// non-text content, not because the flag is off for vision rows.
		expect(buildModel(workersAiSpec()).compat.requiresStringMessageContent).toBe(true);
		expect(
			buildModel(workersAiSpec({ id: "@cf/openai/gpt-oss-120b", name: "GPT-OSS 120B", input: ["text"] })).compat
				.requiresStringMessageContent,
		).toBe(true);
	});

	test("the gateway mirror of the same SKU is unaffected", () => {
		// `cloudflare-ai-gateway` projects these SKUs under a `workers-ai/` prefix on a
		// different route; the axis is provider-scoped and must not reach it (nor any other
		// openai-completions provider, which all keep the unassigned default).
		const mirrored = buildModel(
			workersAiSpec({
				id: "workers-ai/@cf/zai-org/glm-5.3-flash",
				provider: "cloudflare-ai-gateway",
				baseUrl: "https://gateway.ai.cloudflare.com/v1/acct-test/my-gateway/workers-ai",
			}),
		);
		expect(mirrored.compat.requiresStringMessageContent).toBeUndefined();
		expect(
			buildModel(workersAiSpec({ provider: "openai", baseUrl: "https://api.openai.com/v1" })).compat
				.requiresStringMessageContent,
		).toBeUndefined();
	});
});

describe("Cloudflare Workers AI effort ladder", () => {
	// Regression coverage for the live-sweep bug: rows that reason (`supported_features`
	// includes `reasoning`) but publish no `reasoning.supported_efforts` vocabulary were built
	// with the generic five-tier ladder (minimal/low/medium/high/xhigh). The endpoint 400s
	// (AiError code 8001) on `minimal` and `xhigh`, and because this provider's disable mode is
	// `lowest-effort`, turning thinking off sent the rejected `minimal` tier. `buildModel` is
	// the same path production uses (`compat/resolve.ts`'s `resolveThinkingPolicy`), so these
	// tests exercise the cascade fix in `providers/cloudflare-workers-ai.kdl`, not the discovery
	// mapper.
	test.each(["@cf/zai-org/glm-4.7-flash", "@cf/nvidia/nemotron-3-120b-a12b"])(
		"%s reasons without a discovered vocabulary and gets exactly low/medium/high",
		id => {
			const model = buildModel(workersAiSpec({ id, name: id, thinking: undefined }));
			expect(model.thinking?.efforts).toEqual([Effort.Low, Effort.Medium, Effort.High]);
		},
	);

	test("a row with a discovered ladder keeps exactly what discovery supplied", () => {
		// glm-5.3-flash-shaped row: discovery mapped `[low, high, max]` (mirrors deepseek's
		// shape). The KDL fallback must never widen or narrow an explicit ladder.
		const model = buildModel(workersAiSpec());
		expect(model.thinking?.efforts).toEqual([Effort.Low, Effort.High, Effort.Max]);
	});

	test("gpt-oss keeps its class-cascade ladder, not a duplicated provider rule", () => {
		// classes/gpt-oss.kdl's unconditioned class-root `thinking-efforts` ties with the
		// provider-root fallback at the same (exactness, dimension) rank; the provider rule's
		// priority=-1 yields the tie instead of `gen:compat` throwing `AmbiguousOverlapError`.
		// Confirms the resolved value is unaffected by adding the provider-root fallback.
		const model = buildModel(
			workersAiSpec({ id: "@cf/openai/gpt-oss-120b", name: "GPT-OSS 120B", thinking: undefined }),
		);
		expect(model.thinking?.efforts).toEqual([Effort.Low, Effort.Medium, Effort.High]);
	});

	test("a non-reasoning row gets no thinking policy at all", () => {
		const model = buildModel(workersAiSpec({ reasoning: false, thinking: undefined }));
		expect(model.thinking).toBeUndefined();
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
