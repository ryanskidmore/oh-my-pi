import { type } from "@oh-my-pi/omptype";
import { describe, expect, test } from "bun:test";
import { OpenAICompatSchema } from "@oh-my-pi/pi-coding-agent/config/models-config-schema";

// Regression for #11697: `stripImageInput` is the documented per-model opt-out
// for endpoints that really accept `image_url`, consumed by the transport
// (`vision-guard.ts`). It must be a declared, type-validated `compat` key so a
// misconfigured value surfaces as a schema error instead of silently leaving
// the catalog's text-only rule in force.
describe("OpenAICompatSchema stripImageInput", () => {
	test("accepts the documented boolean opt-out", () => {
		const parsed = OpenAICompatSchema({ stripImageInput: false });
		expect(parsed instanceof type.errors).toBe(false);
	});

	test("rejects a non-boolean value like every other declared compat key", () => {
		const parsed = OpenAICompatSchema({ stripImageInput: "no" });
		expect(parsed instanceof type.errors).toBe(true);
		expect(String(parsed)).toContain("stripImageInput");
	});
});

// `requiresStringMessageContent` is documented in docs/models.md as a `models.yml`
// compat key (send text content as one plain string for endpoints whose per-model
// schema rejects a multi-part `content` array, e.g. Cloudflare Workers AI). The
// arktype object is open, so an undeclared key would be accepted silently and a
// typo would leave the multi-part array on the wire — declare it like every other
// documented key so a wrong value is a schema error.
describe("OpenAICompatSchema requiresStringMessageContent", () => {
	test("accepts the documented boolean opt-in", () => {
		const parsed = OpenAICompatSchema({ requiresStringMessageContent: true });
		expect(parsed instanceof type.errors).toBe(false);
	});

	test("rejects a non-boolean value like every other declared compat key", () => {
		const parsed = OpenAICompatSchema({ requiresStringMessageContent: "yes" });
		expect(parsed instanceof type.errors).toBe(true);
		expect(String(parsed)).toContain("requiresStringMessageContent");
	});
});
