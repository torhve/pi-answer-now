# pi-answer-now — Agent Context

## What This Package Does

pi-answer-now lets a person stop a reasoning model mid-thought. The engine owns
the feature; the extension reaches it.

Basalt serves `POST /v1/answer_now`. That call names one running request and
basalt closes the thinking section of that reply, in the same response
([changelog 0.3.3](https://github.com/jesdga95/basalt/blob/main/docs/changelog/0.3.3.md)).
The extension adds `/answer` and a keyboard shortcut that make that call.

The extension changes no outbound request. It reads the request id the engine
writes into its response headers and into every chunk of the reply, then posts
that id back on the side.

### Structure

```
extensions/index.ts   # the whole extension
```

No skills, prompts, themes, or build step. pi loads `.ts` directly through jiti.

### Key Constraints

- **No build step.** Never add one.
- **Peer dependencies** come from pi at runtime. Keep them at range `"*"` and
  never bundle them. `@earendil-works/pi-tui` (for the `KeyId` type) and
  `@types/node` are types-only here, so they belong in `devDependencies`.
- **Two-space indentation**, enforced by biome.

## How The Extension Works

Read `extensions/index.ts` before changing behaviour. These parts carry the design:

| Part | Behaviour |
| --- | --- |
| Key syntax check | `pi.registerShortcut` accepts any string and never fires an unparseable one. The extension validates the configured key and reports a bad one on startup, so a typo is not a silent dead key. |
| Key source | `pi-answer-now.keybinding` in settings. pi's `keybindings.json` lists named actions only, and an extension action is not one of them, so no other route exists. |
| Request targeting | `provider_stream_event` gives the raw engine chunk, which names the request the engine works on. The extension keeps the ids whose stream is open, per model, and clears them on `turn_end` and `agent_end`. `/answer` uses the one open stream for the current model, and refuses when more than one is open. `before_provider_request` plus `after_provider_response` still record the newest header id per model, used only when no stream is open. basalt 0.3.3 wrote the same id in the header and in every chunk; a llama.cpp engine is not proven. The mock can split the two ids to prove the stream id wins. |
| URL | Derived from `ctx.model.baseUrl`. Trailing endpoint suffixes are dropped and `/answer_now` is appended. |
| llama-swap path | llama-swap keeps a fixed route table, so `/v1/answer_now` 404s at the proxy. The extension then calls `<mount>/upstream/<model>/v1/answer_now`, which llama-swap forwards to the engine with the prefix stripped. Any path prefix in front of llama-swap is kept. Credentials come from `ctx.modelRegistry.getApiKeyAndHeaders`. The retry runs only when that 404 carries no engine error body, so a real engine refusal such as `unknown_request` is not retried. |
| Capability probe | `GET <origin>/props?model=<id>&autoload=false`. Only basalt answers with a `basalt` key holding `capabilities`. `autoload=false` stops llama-swap from loading a model to answer a probe. The result only improves error text; it never skips the call. |
| pi-llama-swap cache | `answerNow` in `~/.pi/agent/pi-llama-swap.json` is read before any probe. That field is written by the pi-llama-swap extension, not by hand. |

### The Engine Contract

Basalt 0.3.3 or newer:

- Success: `200 {"object":"answer_now","request_id":…,"state":"queued"|"prompt"|"thinking"}`.
- Refusals: `404 unknown_request`, `409 not_thinking` with `state` of
  `finished` or `answering`, `409` when thinking is off, `400 no_target`.
- Error body: `{"error":{"type","code","message","state"}}`.
- basalt 0.3.3 answers `X-Request-Id` on every chat response.

Source: `serve/tests/test_answer_now.py` and `serve/live.py` in the basalt repo.

A live basalt 0.3.3 behind llama-swap confirmed these shapes:

- `GET /props?model=…&autoload=false` returns a `basalt` block:
  `{"version":"0.3.3","capabilities":["answer_now","logprobs","documents"]}`.
- `POST /v1/answer_now` at the llama-swap front door answers `404` with the plain
  text `404 page not found`. No JSON body, so the retry to `/upstream/…` is right.
- `POST /upstream/<model>/v1/answer_now` reaches basalt, which answers an unknown
  id with `404 {"error":{"type":"not_found_error","code":"unknown_request",…}}`.
  That JSON body is why the retry must not fire a second time.
- A chat response carried `X-Request-Id: chatcmpl-…`.
- llama-swap answers a path under `/upstream/` that names no model with
  `404 {"src":"llama-swap","error":{"message":"model not found","code":"not_found"}}`.
  A public gateway in front of another llama-swap answered an HTML 404 page for
  both answer-now routes, so `/upstream` is not exposed there.
- llama-swap finds the model by matching model names inside the `/upstream/…`
  path (`swaputil.FindModelInPath` in `internal/server/api.go`), and its comments
  name slash names ("author/model") as a supported case. That is why
  `upstreamAnswerNowUrl` lets a slash travel as real path segments.

## Commands

```bash
npm run typecheck      # tsc --noEmit
npm run lint           # biome check
npm run lint:fix       # biome check --write
npm run format         # biome format --write
```

`npm run test` starts pi in RPC mode against a mock engine
(`test/mock-engine.mjs`), runs a real turn, sends `/answer` while that turn
streams, and asserts what the extension showed and what the engine received.
The mock follows basalt's contract, including `X-Request-Id` on every chat
response and the llama-swap route table.

`test/live-check.mjs` is a manual smoke check against a real engine. It is not
part of `npm test`, because it needs a configured provider and network access.
Pi loads only the extensions you name, so pass the extension that provides the
model as well:

```bash
LIVE_CHECK_EXTENSIONS="/path/to/provider-extension" \
  node test/live-check.mjs provider/model:high
```

### Testing against pi

Load only this package, so global extensions cannot interfere:

```bash
pi -ne -e . --no-session
```

Then press the key, or type `/answer`. The expected outcome is one line in the
chat, in every case, including when nothing can be interrupted.

Print mode (`pi -p`) cannot press a key. Use it only to confirm the package
loads without errors.

## Git and PR Conventions

- **Conventional commits** — `feat:`, `fix:`, `docs:`, `chore:`, `ci:`, `refactor:`.
- **Rebase merges only**:

```bash
gh pr merge <number> --rebase
```

- release-please opens a Release PR when conventional commits land on `main`.
  Review the changelog, then merge it with `--rebase` to publish to npm.

## Release Flow

1. Push conventional commits to `main`.
2. release-please opens a Release PR with `CHANGELOG.md` and a version bump.
3. Merge that PR with `--rebase`. GitHub Release and `npm publish` follow.

Users update with `pi update`.

## Pitfalls

- **Do not send a `session_id` to the engine.** That route needs the engine to
  have seen a session header from us. The extension sends none, so only a
  request id can address a reply.
- **Do not gate the action on the capability probe.** A person who presses the
  key wants the engine's own answer, not a guess from a cached probe.
- **Do not trust a props `false` from a failed request.** A read that returned
  nothing is `unknown`. Writing `false` there would cache a basalt model as
  unable to answer now.

- **Do not call `pi.getSettings()` in the factory.** Pi blocks action methods while
  an extension loads, so the load fails. Read the merged settings with
  `SettingsManager.create(process.cwd(), getAgentDir())`. Pi builds its shortcut
  table once, at setup and on reload, so the key must be known at load time.
