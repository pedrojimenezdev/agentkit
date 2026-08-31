# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-08-31

First release under the `railguard` name.

### Added

- **Streaming.** Optional `stream()` on the `LLM` interface, implemented for both
  providers over `fetch` + `ReadableStream` with no external dependencies. SSE
  parsing is exposed as `sseData`, `openAIDeltas`, and `anthropicDeltas` — plain
  async generators over any async iterable, so streaming is testable without a
  network. Payloads are buffered across chunk boundaries, since a network chunk
  can split a frame mid-JSON.
- **`streamToString(stream)`** for collecting a stream into the single string it
  would have produced.
- **Zod-compatible `structured()`.** `StructuredOptions.schema` accepts anything
  with Zod's `safeParse` signature, typed structurally so no validation library
  becomes a dependency. `schema` takes precedence over `validate` when both are
  passed, and the schema's own error message is quoted back to the model on the
  self-correction turn.
- **`parseToolArgumentsResult`** — the reporting counterpart to
  `parseToolArguments`, returning why a malformed argument string failed.
- **CI.** GitHub Actions workflow running install, typecheck, test, and build
  across Node 20 and 22 on pushes to `main` and every pull request.
- **`npm run test:compiled`** — the full suite compiled to JavaScript before it
  runs, via a new `tsconfig.test.json`. `npm test` relies on Node's
  `--experimental-strip-types`, which does not exist before Node 22.6, so the
  suite could not run at all on the Node 20 the package claims to support. CI
  runs the compiled suite on every matrix version and the native one only where
  it is available.
- **Tests** covering Anthropic message serialization, streaming, chunk overlap,
  tool-argument error surfacing, and the schema path through `structured()` —
  11 tests before this release, 34 after.

### Fixed

- **Agent loop:** `onStep` fired twice per step, double-counting any metric the
  callback recorded and running its side effects a second time.
- **Anthropic tool calling:** `createAnthropic` dropped `tool_use` blocks from
  responses and filtered tool messages out of requests, so tool calling never
  worked against the Messages API. Assistant tool calls now serialize as
  `tool_use` blocks and results as `tool_result` blocks grouped onto a single
  user turn, as the API requires.
- **Chunk overlap:** `chunk()` applied overlap only to the final chunk, leaving
  every other boundary unoverlapped, and truncated a sentence longer than `size`
  instead of splitting it — silently losing content.
- **Tool argument errors:** a malformed argument string silently became `{}`, so
  the tool ran against empty input and the model never learned its call was
  wrong. `executeTool` now returns a readable failure the model can correct from.

### Changed

- **Renamed from `agentkit` to `railguard`**, with `repository`, `homepage`, and
  `bugs` fields added to `package.json`.
- **`LLMCallOptions`** extracted as a named exported type, shared by `complete()`
  and `stream()`.
- **`structured()`** now takes an exported `StructuredOptions<T>` type; `validate`
  is optional, and calling with neither `schema` nor `validate` throws a clear
  error instead of failing on an undefined call.
- **README** rewritten around the problem railguard solves, with a copy-pasteable
  quickstart and honest positioning against LangChain and the raw provider SDKs.

[0.1.0]: https://github.com/pedrojimenezdev/railguard/releases/tag/v0.1.0
