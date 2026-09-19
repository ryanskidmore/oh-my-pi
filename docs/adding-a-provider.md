# Adding a provider

A provider is declared in **KDL** and compiled by `bun run gen:compat` into the checked-in
`packages/catalog/src/compat/rules.json`. TypeScript supplies only the parts that cannot be
declarative: a discovery mapper that turns one upstream endpoint's JSON into `ModelSpec` rows, a
request-shaping transport (header/body rewrites a KDL wire axis cannot express), or a bespoke login
flow the KDL auth grammar has no node for. Everything else — default model, env-var fallback,
discovery wiring, wire-compat quirks, thinking ladders — is authored once in KDL and read back
through generated, typed accessors.

## The five places a provider can touch

| Half | File | What it declares |
| --- | --- | --- |
| Catalog entry | `packages/catalog/src/compat/rules/providers/<id>.kdl` | `default-model` (required — it is what makes the file a catalog provider and puts the id in the generated `KnownProvider` union), `env`, `discovery`, `dynamic-models-authoritative`, `allow-unauthenticated`, `skip-cross-provider-reference-fills`, optional `seed` rows, and the provider's cascade/compat rules |
| Auth policy | `packages/catalog/src/compat/rules/auth/<id>.kdl` + `auth/_order.kdl` | display name, env fallback, login/refresh flow |
| Discovery factory | `MODEL_MANAGER_FACTORIES` in `packages/catalog/src/provider-models/descriptors.ts` + a factory in `packages/catalog/src/provider-models/openai-compat.ts` | the only provider fact that stays in code |
| Request shaping | `TRANSPORTS` in `packages/ai/src/registry/registry.ts` + `packages/ai/src/registry/<id>.ts` | `prepareModel` / `prepareRequest` / `mapSimpleOptions` / `prepareModelDiscovery` |
| Login flow | a hook table in `packages/ai/src/registry/hooks/` + `packages/ai/src/registry/oauth/<id>.ts` | whole-flow logins the KDL grammar cannot express |

Most providers touch three of these five rows, not two: of the 76 catalog providers compiled into
`packages/catalog/src/compat/rules.json`, 67 have a `MODEL_MANAGER_FACTORIES` entry (row 3). For a
provider on a plain OpenAI-compatible host, that entry is almost always a one-line wrapper around
`createSimpleOpenAICompletionsOptions(providerId, baseUrl, config)`
(`packages/catalog/src/provider-models/openai-compat.ts`) — the shortest real example,
`groqModelManagerOptions`:

```ts
export function groqModelManagerOptions(config?: GroqModelManagerConfig): ModelManagerOptions<"openai-completions"> {
	return createSimpleOpenAICompletionsOptions("groq", "https://api.groq.com/openai/v1", config);
}
```

paired with `groq: config => groqModelManagerOptions(config),` in `MODEL_MANAGER_FACTORIES`. A plain
API-key provider on an existing wire API (`openai-completions`, `anthropic-messages`,
`google-generative-ai`, …) that reuses bundled or generically-discovered rows needs rows 1, 2, and
this one-line row 3 — see [Choosing a catalog shape](#choosing-a-catalog-shape) for which KDL shape
row 1 should take. The exact KDL syntax for row 1 is the
[Provider catalog grammar](../packages/catalog/src/compat/rules/README.md#provider-catalog-grammar)
section of `packages/catalog/src/compat/rules/README.md`; for row 2 it's that same file's
[Auth grammar](../packages/catalog/src/compat/rules/README.md#auth-grammar) section — this document
does not repeat that grammar, only how the pieces fit together.

The 9 providers with **no** `MODEL_MANAGER_FACTORIES` entry (`amazon-bedrock`, `azure`,
`gitlab-duo`, the three MiniMax variants, and the OAuth-driven `google-antigravity` /
`google-gemini-cli` / `openai-codex`) are excluded from `PROVIDER_DESCRIPTORS` entirely and get no
runtime discovery/refresh through this table: the bedrock/azure/gitlab-duo/MiniMax group is served
from bundled `models.json` rows only, with no live refresh, while the three OAuth-driven ids get a
bespoke manager the coding-agent runtime builds directly
(`SPECIAL_MODEL_MANAGER_PROVIDER_IDS` in
`packages/coding-agent/src/config/model-provider-discovery.ts`) instead of going through this table.

Row 3 itself grows beyond that one-line wrapper into a bespoke fetcher and mapper in
`openai-compat.ts` when the provider's model-list response is not OpenAI-shaped — Cloudflare
Workers AI (the worked example below) is exactly this case: its `models-search` endpoint has no
OpenAI-compatible `/v1/models` route at all. Rows 4 and 5 exist for different needs: row 4 (a
transport) for request/header/base-URL rewrites a KDL wire axis cannot express, and row 5 (a login
hook) for a login flow beyond a single API-key prompt.

Adding a **new wire protocol** (a new member of `Api`) is a different, larger task: it also touches
the dispatch `switch` in `packages/ai/src/stream.ts`, `packages/ai/src/api-registry.ts`, and the
`KnownApi` union in `packages/catalog/src/types.ts`. This document assumes you are reusing an
existing `Api`.

## Worked example: Cloudflare Workers AI

`cloudflare-workers-ai` is a provider with zero bundled rows, a custom login flow, and a
request-shaping transport — it touches all five rows. For the opposite end of the spectrum, read
`packages/catalog/src/compat/rules/providers/minimax.kdl` and
`packages/catalog/src/compat/rules/auth/minimax.kdl` alongside it: `minimax` touches only rows 1
and 2 — a `default-model`, an `env` fallback, and one wire-compat axis in the provider KDL, and just
a display `name` with no `login` node at all (env-key only) in the auth KDL. It has no
`MODEL_MANAGER_FACTORIES` entry, no `TRANSPORTS` entry, and no login hook.

### 1. Provider KDL — catalog entry, wire axes, and why there's no `discovery` or `seed`

`packages/catalog/src/compat/rules/providers/cloudflare-workers-ai.kdl`:

```kdl
provider "cloudflare-workers-ai" priority=-1 {
	default-model "@cf/moonshotai/kimi-k2.7-code"
	env "CLOUDFLARE_WORKERS_AI_API_KEY" "CLOUDFLARE_API_TOKEN"
	dynamic-models-authoritative #true
	skip-cross-provider-reference-fills #true

	prompt-cache-session-header "x-session-affinity"
	always-send-max-tokens #true
	supports-developer-role #false
	supports-store #false
	supports-named-tool-choice #false
	reasoning-content-field "reasoning_content"
	thinking-mode "effort"
	thinking-efforts "low" "medium" "high"
	class "qwen" {
		thinking-format "openai"
	}
}
```

`default-model` is what makes this a catalog provider at all. `env` is the runtime API-key
fallback order. `dynamic-models-authoritative #true` means a successful live fetch replaces
whatever bundled rows exist (here, none). `skip-cross-provider-reference-fills #true` stops the
generator from backfilling capability data from same-id rows on other providers — Workers AI's own
`models-search` response is the deployment truth, and a same-id row behind `cloudflare-ai-gateway`
carries a different tariff and effort ladder.

The file deliberately has **no `discovery` node and no `seed`**: `discovery` is what enrolls a
provider in `packages/catalog/scripts/generate-models.ts` (offline catalog generation baked into
`models.json`), and Cloudflare's roster and pricing change on Cloudflare's schedule — baking one
snapshot in would ship a stale hard-coded list. Runtime discovery is the only source of rows, which
is why the id is also listed in `RUNTIME_ONLY_PROVIDERS` in
`packages/catalog/test/compat-conformance.test.ts` (see step 3) and is skipped by
`packages/catalog/test/provider-default-models.test.ts` (there is no bundled slice to check the
`default-model` against).

The rest of the block is wire-compat axes from the closed vocabulary in
`packages/catalog/src/compat/axes.ts` — `prompt-cache-session-header`, `always-send-max-tokens`,
`supports-developer-role`, `supports-store`, `supports-named-tool-choice`,
`reasoning-content-field`, `thinking-mode`, `thinking-efforts`, and a nested `class "qwen"`
refinement. Each one exists because it was measured against the live endpoint, not guessed; see
`docs/provider-quirks.md`'s "Cloudflare Workers AI" section for the measurements.

`priority=-1` and the bare `thinking-efforts "low" "medium" "high"` are a real cascade-ambiguity
resolution. Reasoning rows that publish no `reasoning.supported_efforts` vocabulary at all
(`nemotron-3-120b-a12b`, `glm-4.7-flash`, and others) fell through to the generic five-tier
`minimal/low/medium/high/xhigh` default, and the
endpoint 400s (AiError code 8001) on `minimal` and `xhigh`. The fix — a provider-root
`thinking-efforts "low" "medium" "high"` — ties in rank with `classes/gpt-oss.kdl`'s unconditioned
class-root `thinking-efforts "low" "medium" "high"` (both rank at
`(exactness=0, dimensions=1)`), which is exactly the "two distinct rules tie on all three
[precedence] components" case in `packages/catalog/src/compat/rules/README.md`'s
[Precedence and ambiguity](../packages/catalog/src/compat/rules/README.md#precedence-and-ambiguity)
section: an explicit `priority=` plus a comment naming the rule it yields to, not reordering
declarations. The values happen to agree here, so the tie-break is cosmetic, but `gen:compat` still
requires the explicit priority. See the full comment above `provider "cloudflare-workers-ai"` in
the KDL file, and `providers/ollama.kdl`'s `priority=-1` for the same pattern on a different axis.
A discovered ladder (e.g. `deepseek-v4-flash-0731`'s `[low, high, max]`) is structurally immune to
this fallback — see [Where policy goes](#where-policy-goes).

### 2. Auth KDL + the `_order.kdl` line

`packages/catalog/src/compat/rules/auth/cloudflare-workers-ai.kdl`:

```kdl
auth "cloudflare-workers-ai" {
	name "Cloudflare Workers AI"
	login "custom" hook="cloudflare-workers-ai"
}
```

`login "custom" hook="cloudflare-workers-ai"` means the whole login flow is a named TypeScript hook
rather than a declarative `api-key`/`oauth-code`/`device-code` flow — see step 5.

`packages/catalog/src/compat/rules/auth/_order.kdl` pins the `/login` roster order; every provider
whose auth node declares a `login` (and doesn't set `show-in-login-list #false`) must appear in its
single `login-order "…" …` node. This provider's id was inserted immediately before
`"cloudflare-ai-gateway"`:

```
… "vercel-ai-gateway" "cloudflare-workers-ai" "cloudflare-ai-gateway" "litellm" …
```

Skip this and `bun run gen:compat` fails with `loginable provider "cloudflare-workers-ai" is
missing from login-order` (the check lives in
`packages/catalog/scripts/compat-compiler/compile-auth.ts`).

### 3. Regenerate and commit the compiled output

```sh
bun run gen:compat
```

This compiles every `.kdl` file under `packages/catalog/src/compat/rules/` into three generated
files — **never hand-edit them**:

- `packages/catalog/src/compat/rules.json` — the full compiled rule tree the runtime engine reads
- `packages/catalog/src/compat/provider-ids.ts` — gains `| "cloudflare-workers-ai"` in the
  `KnownProvider` union
- `packages/catalog/src/compat/auth-ids.ts` — gains it in both the auth-id and login-id unions

Commit all three alongside the KDL change; `test/compat-compile.test.ts` fails if `rules.json`
drifts from the KDL sources.

### 4. Discovery factory and its `MODEL_MANAGER_FACTORIES` entry

`packages/catalog/src/provider-models/openai-compat.ts` gained
`cloudflareWorkersAiModelManagerOptions` (a paginated `GET {account}/ai/models/search` fetcher plus
a mapper from Cloudflare's OpenRouter-shaped projection onto `ModelSpec<"openai-completions">`).
`packages/catalog/src/provider-models/descriptors.ts`'s `MODEL_MANAGER_FACTORIES` table — the *only*
provider fact this codebase keeps in TypeScript instead of KDL — pairs it with the id:

```ts
"cloudflare-workers-ai": config => cloudflareWorkersAiModelManagerOptions(config),
```

`PROVIDER_DESCRIPTORS` (also in `descriptors.ts`) is derived by joining every compiled KDL provider
entry (`providerEntries()`) with its `MODEL_MANAGER_FACTORIES` entry, if any; providers without a
factory keep a KDL entry but no runtime discovery. `DEFAULT_MODEL_PER_PROVIDER` is read straight off
the compiled entries' `default-model`.

### 5. Transport and login hook

`packages/ai/src/registry/cloudflare-workers-ai.ts` exports `cloudflareWorkersAiTransport: ProviderTransport`
— it implements `prepareRequest` (unwraps the stored JSON credential, substitutes the account id
into the `<account>` placeholder in `model.baseUrl`) and `prepareModelDiscovery` (the same
substitution before a runtime discovery fetch). It does **not** set the `x-session-affinity` header
in code — that rides the `prompt-cache-session-header` wire axis declared in step 1, applied
generically in `packages/ai/src/providers/openai-shared.ts` (`resolveOpenAIRequestSetup`). Never
hard-code model- or provider-conditional policy in TypeScript when a KDL axis already exists for it.

`packages/ai/src/registry/registry.ts`'s `TRANSPORTS` table wires the transport to the id:

```ts
const TRANSPORTS: Record<string, ProviderTransport> = {
	…
	"cloudflare-workers-ai": cloudflareWorkersAiTransport,
	…
};
```

`PROVIDER_REGISTRY` maps every compiled auth policy (`authProviders()`) through
`buildProviderDefinition(policy, TRANSPORTS[policy.id])`; a provider with no `TRANSPORTS` entry
still gets a full `ProviderDefinition` from its KDL auth policy alone. A compile-time check
(`_CheckRegistryComplete` in `registry.ts`) makes it a **type error** — not a runtime surprise — to
add a KDL catalog entry without a matching KDL auth entry.

The login flow itself lives in `packages/ai/src/registry/oauth/cloudflare-workers-ai.ts`
(`loginCloudflareWorkersAi`, prompting for a Cloudflare API token and account id) and is wired into
`API_KEY_LOGIN_HOOKS` in `packages/ai/src/registry/hooks/api-key.ts`:

```ts
"cloudflare-workers-ai": () => import("../oauth/cloudflare-workers-ai").then(m => m.loginCloudflareWorkersAi),
```

`login "custom" hook="…"` resolves against `HOOKS.login`, the table `packages/ai/src/registry/hooks/index.ts`
merges from **every** hook-table file (`api-key.ts`'s `API_KEY_LOGIN_HOOKS`, `oauth-code.ts`'s
`OAUTH_CODE_LOGIN_HOOKS`, `custom.ts`'s `CUSTOM_LOGIN_HOOKS`) — not only `hooks/custom.ts`. A simple
paste-a-token(-and-something-else) flow like this one belongs beside the other API-key hooks in
`api-key.ts`; reserve `custom.ts` for flows with no simpler category. `bun --cwd=packages/ai test
test/auth-hooks-registry.test.ts` asserts every `hook="…"` name in the compiled auth tree resolves
against one of these tables.

## Choosing a catalog shape

- **Bundled rows from the shared catalog, no runtime discovery** — most API-key providers on an
  existing OpenAI-compatible host. No `discovery` node; the models are already in `models.json` from
  a `models.dev`-sourced descriptor.
- **`discovery label="…"`** — enrolls the provider in `generate-models.ts` so its live catalog is
  fetched and baked into `models.json` at generation time (offline, with generation-time
  credentials). Example: `anthropic` (`packages/catalog/src/compat/rules/providers/anthropic.kdl`).
- **`seed … bundle="always" | "fallback" | "empty"`** — for catalogs that cannot be discovered at
  generation time: authored rows that the generator bundles per policy (`always`: every regen;
  `fallback`: only when live discovery failed; `empty`: only when no other source produced a row).
  Examples: `cloudflare-ai-gateway` (`bundle="empty"`, `providers/cloudflare-ai-gateway.kdl`),
  `sakana` (`bundle="fallback"`, `providers/sakana.kdl`). See "Seed rows" in
  `packages/catalog/src/compat/rules/README.md` for the full grammar.
- **No bundled rows at all** — runtime discovery is the only source: `charm-hyper`,
  `cloudflare-workers-ai`, and the local engines `litellm` / `vllm` / `lm-studio` / `ollama`. The
  local engines are additionally listed in `DISCOVERY_ONLY_PROVIDERS` in
  `packages/catalog/scripts/generate-models.ts` (they are never fetched at generation time *and*
  their previous-snapshot rows are dropped, since their catalog is whatever happens to be running on
  the machine that invoked the generator). `charm-hyper` and `cloudflare-workers-ai` reach "no
  bundled rows" purely by omitting the `discovery` node — the generator's fetch loop
  (`PROVIDER_DESCRIPTORS.filter(isCatalogDescriptor)`) never sees them, so
  `charm-hyper`/`cloudflare-workers-ai` do not need `DISCOVERY_ONLY_PROVIDERS` membership. Two
  consequences either way: the id must be added to `RUNTIME_ONLY_PROVIDERS` in
  `packages/catalog/test/compat-conformance.test.ts`, and
  `packages/catalog/test/provider-default-models.test.ts` skips the provider because there is no
  bundled slice to check `default-model` against.

## Where policy goes

Catalog policy lives in one of three ownership strata under `packages/catalog/src/compat/rules/`
(see `packages/catalog/src/compat/rules/README.md`, which is the authoritative grammar reference —
this section only restates the rule of where things go, per `AGENTS.md`):

- `taxonomy/*.kdl` — model identity: class membership, product families, revision extraction.
- `classes/*.kdl` — vendor-lineage truths: behavior inherent to a model line, independent of host.
- `providers/<id>.kdl` — a provider's catalog identity plus its deployment contract: host-imposed
  behavior and documented per-model residue that taxonomy cannot express exactly.
- `runtime/behavior.kdl` — heuristics used before or outside exact model lookup (routing, quota
  tiers, roster exclusions, …).

Do not move a statistically common behavior into a class file, or a lineage truth into a provider
file. The directive vocabulary itself — every axis a rule may assign — is closed and lives in
`packages/catalog/src/compat/axes.ts`; the compiler rejects unknown directives and out-of-vocabulary
values against that table.

Resolution order, per `resolveOpenAICompletionsPolicy` and `resolveThinkingPolicy` in
`packages/catalog/src/compat/resolve.ts`: a detected baseline (host/family/modality facts) →
KDL cascade axes → an explicit `spec.thinking`/`spec.compat` from a discovery mapper → fixups. For
thinking specifically, an explicit `spec.thinking` with a non-empty `efforts` array short-circuits
straight to `fillExplicitThinking`, which only *backfills* fields the spec side left absent
(`effortMap`, `defaultLevel`, …) — it never reassigns `thinking.efforts`. A discovered ladder is
therefore structurally immune to any KDL `thinking-efforts` rule; the cascade's `thinking-efforts`
is read only as `rule.efforts` when the discovery mapper left `thinking` unset entirely (see the
Cloudflare Workers AI worked example above for a concrete case).

`bun run gen:compat` throws `AmbiguousOverlapError` (`packages/catalog/src/compat/cascade.ts`) when
two rules tie on `(model-selector exactness, constrained-dimension count, priority)` for the same
axis. Resolve it with an explicit `priority=` on the block plus a `//` comment naming the rule it
intentionally yields to (or wins over) — never by reordering declarations, and never by adding a
provider- or model-conditional special case in TypeScript.

## Tests to write and run

Standing list, run from the repo root unless noted:

```sh
bun run gen:compat
bun --cwd=packages/catalog test test/compat-compile.test.ts test/compat-conformance.test.ts \
     test/compat-cascade.test.ts test/compat-taxonomy.test.ts test/compat-parity.test.ts \
     test/descriptors.test.ts test/provider-default-models.test.ts
bun --cwd=packages/ai test test/auth-hooks-registry.test.ts
bun run check:ts
bun run check:tools
```

Plus, for a new provider:

- A catalog test with a mocked `fetch` proving the discovery mapping —
  `packages/catalog/test/<id>-provider.test.ts` (worked example:
  `packages/catalog/test/cloudflare-workers-ai-provider.test.ts`), and often a companion
  `<id>-wire.test.ts` asserting the credential/base-URL helpers and the resolved compat contract via
  `buildModel` (worked example: `packages/catalog/test/cloudflare-workers-ai-wire.test.ts`).
- An `ai` test proving login, request shaping, and any recorded stream quirk —
  `packages/ai/test/<id>.test.ts` (worked example: `packages/ai/test/cloudflare-workers-ai.test.ts`).

House rules that apply to all of these: no `mock.module()`, no source-grepping tests, and no
long-lived mutation of `Bun.env`/`process.env` — use the `withEnv` helper at
`packages/ai/test/helpers/index.ts`. Every test defends a named, externally observable contract.

## Checklist

1. `packages/catalog/src/wire/<id>.ts` — credential parse/serialize helpers, if the provider stores
   a structured (non-bearer) credential.
2. `packages/catalog/src/compat/rules/providers/<id>.kdl` — catalog entry + wire/thinking axes.
3. `packages/catalog/src/compat/rules/auth/<id>.kdl` — auth policy.
4. `packages/catalog/src/compat/rules/auth/_order.kdl` — insert the id into `login-order` if the
   auth policy declares a `login`.
5. `packages/catalog/src/identity/priority.ts` — add the id to `DEFAULT_MODEL_PROVIDER_ORDER` if it
   should participate in automatic role selection.
6. `packages/catalog/test/compat-conformance.test.ts` — add to `RUNTIME_ONLY_PROVIDERS` if the
   provider has no bundled rows.
7. Run `bun run gen:compat`; commit `rules.json`, `provider-ids.ts`, `auth-ids.ts`.
8. `packages/catalog/src/provider-models/openai-compat.ts` (or a sibling provider-models file) — a
   model-manager factory, if the provider has any runtime discovery at all. For a plain
   OpenAI-compatible host this is usually a one-line `createSimpleOpenAICompletionsOptions(providerId,
   baseUrl, config)` wrapper; write a bespoke discovery mapper only when the response shape needs it.
9. `packages/catalog/src/provider-models/descriptors.ts` — `MODEL_MANAGER_FACTORIES` entry, if step 8
   added a factory (skip both for the bespoke no-factory cases in
   [The five places a provider can touch](#the-five-places-a-provider-can-touch) above).
10. `packages/catalog/test/<id>-provider.test.ts` / `<id>-wire.test.ts` — discovery-mapping and
    compat-resolution tests.
11. `packages/ai/src/registry/<id>.ts` — `ProviderTransport`, if request/discovery shaping needs
    code.
12. `packages/ai/src/registry/registry.ts` — `TRANSPORTS` entry.
13. `packages/ai/src/registry/oauth/<id>.ts` + a `packages/ai/src/registry/hooks/*.ts` table entry —
    login flow, if it needs more than the declarative `api-key`/`oauth-code`/`device-code` grammar.
14. `packages/ai/test/<id>.test.ts` — login, request-shaping, and stream-quirk tests.
15. `bun run check:ts` and `bun run check:tools`.
16. Docs and changelogs: `docs/providers.md`, `docs/environment-variables.md`,
    `docs/provider-quirks.md`, `packages/ai/README.md`, and one line under `## [Unreleased]` /
    `### Added` in each affected `packages/*/CHANGELOG.md`.
