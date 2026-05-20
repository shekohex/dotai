# Pi Agent OSC Implementation Checklist

## Protocol Summary

Custom OSC format:

```text
ESC ] 6767 ; pi ; 1 ; <event-name> ; <base64url-json> ST
```

Example:

```text
ESC ] 6767;pi;1;agent.run;eyJzdGF0ZSI6InJ1bm5pbmcifQ ESC \
```

Protocol rules:

- `6767` is the private OSC command number for Pi agent events.
- `pi` is the namespace guard.
- `1` is the protocol version.
- `<event-name>` is a small routing key.
- `<base64url-json>` is a bounded UTF-8 JSON envelope encoded with base64url.
- Emit unconditionally from the controlled agent extension.
- Prefer `ST` terminator and accept `BEL` on Android.
- Keep existing OSC 9, OSC 52, and OSC 777 behavior unchanged.
- Avoid `message_update` and noisy `tool_execution_update` unless throttled.

Base envelope:

```json
{
  "id": "uuid-or-short-id",
  "ts": 1779200000000,
  "source": "agent",
  "sessionId": "...",
  "cwd": "...",
  "seq": 42,
  "data": {}
}
```

V1 event names:

- `hello`
- `agent.session`
- `agent.run`
- `agent.turn`
- `agent.progress`
- `agent.tool`
- `agent.alert`
- `agent.compaction`

## PIOSC-1: Specify Protocol Contract

Status: done

Research:

- Existing agent OSC helpers are in `../agent/src/extensions/terminal-notify.ts` and `../agent/src/extensions/terminal-tmux-ui.ts`; they already define `ESC`, `BEL`, `ST`, OSC field sanitization, stdout writes, tmux passthrough, pane/client TTY selection, and SSH-aware tmux behavior.
- Android currently captures OSC metadata in `CoderTerminal::finishOscMetadata` and preserves OSC 7, OSC 52, OSC 9 notification/progress, and OSC 777 notify by pushing bounded tab-separated strings through `nativeConsumeOscEvents`.
- `docs/android-osc.md` already documents the terminal feed path and current OSC behavior, so the shared protocol contract should live in `../agent/docs` and be linked from Android docs/checklist for both implementers.

Plan:

- Add shared Pi OSC V1 protocol document under `../agent/docs` with exact wire format, fixtures, envelope, event names, bounds, malformed behavior, terminators, tmux passthrough, and compatibility notes.
- Cross-link the protocol from `docs/android-osc.md`.
- Mark PIOSC-1 checklist items complete after validation, commit, and review.

Checklist:

- [x] Add a concise protocol spec shared by Android and agent implementers.
- [x] Define envelope schema, event names, payload size limits, terminators, and unknown-event behavior.
- [x] Document tmux passthrough behavior and reuse existing agent helpers where possible.

User story:

As a terminal app and agent maintainer, I want one written protocol contract so both implementations can evolve without string-shape drift.

Implementation guide:

- Create protocol module/docs in `../agent/src/extensions` or `../agent/docs` and cross-link from `docs/android-osc.md`.
- Use command number `6767`, namespace `pi`, and version `1`.
- Encode payloads as base64url JSON, not raw JSON.
- Include examples for `ST` and `BEL` terminated sequences.
- Define Android behavior for malformed payloads: discard, never render raw data, optionally log sanitized debug reason in debug builds only.

Acceptance criteria:

- Spec contains exact wire format and at least one valid fixture.
- Spec lists all V1 events and required envelope fields.
- Spec states existing OSC 9/52/777 behavior remains unchanged.

Review:

- Review subagent command: `pi --mode-review --no-session --no-extensions --no-skills --tools read,bash -p "Review committed Pi OSC slice for correctness regressions, malformed input handling, protocol compatibility, Android lifecycle/threading issues, and test gaps. Focus only on PIOSC-1 commit fcf466c. Verify existing OSC 9/52/777 behavior is preserved. Return findings by severity with file/line refs, plus residual risks if no findings."`
- Result: no findings. Docs-only change; no Android/runtime code touched, so existing OSC 9/52/777 behavior preserved. Residual risk: no executable tests for docs-only contract; fixture was manually verified with Node base64url encoding.

Commit:

- Implementation: `fcf466c` (`docs(pi-osc): specify protocol contract`)

## PIOSC-2: Add Agent OSC Encoding Library

Status: done

Research:

- Agent is ESM TypeScript with Vitest; terminal OSC tests live at `../agent/test/terminal-notify.test.ts` and `../agent/test/terminal-tmux-ui.test.ts`.
- Existing OSC helpers export constants indirectly through `createOsc777Sequence` and `createTmuxPassthroughSequence`, but Pi OSC needs a separate safe encoder because its payload is base64url JSON and event names must be allowlisted.
- `typebox` and `typebox/value` are already dependencies; existing code uses `Type`, `Static`, and `Value.Check` for boundary schemas.
- `PIOSC-4` owns event-specific payload schemas, so this ticket should validate the shared envelope shape and V1 event allowlist without expanding payload semantics.

Plan:

- Add `../agent/src/extensions/pi-osc/encoder.ts` with constants, V1 event allowlist, TypeBox envelope schema, `createPiOscSequence`, and small event-specific wrapper functions.
- Enforce base64url JSON encoding, `ST` default terminator, allowlisted event names, and full-frame byte cap below `8192`.
- Add Vitest coverage for exact fixture bytes, base64url alphabet, semicolon/control isolation, allowlist rejection, envelope validation, BEL option, and oversized rejection.

Checklist:

- [x] Add TypeScript helpers to encode Pi OSC events.
- [x] Add payload sanitization, byte-size checks, and base64url encoding.
- [x] Add unit tests with exact byte fixtures.

User story:

As an agent extension author, I want a small safe encoder so event handlers do not hand-build escape sequences.

Implementation guide:

- Add reusable helpers under `../agent/src/extensions/pi-osc` or similar.
- Export `createPiOscSequence(eventName, envelope)` and typed builders for V1 events.
- Reject event names outside the V1 allowlist.
- Cap encoded OSC length below Android parser cap, currently `8192` bytes.
- Use `ST` by default.
- Add tests in `../agent/test` for format, escaping independence, base64url alphabet, and max-size rejection.

Acceptance criteria:

- Tests prove `ESC ] 6767;pi;1;<event>;<payload> ESC \\` format exactly.
- Semicolons/control characters inside JSON cannot break the OSC frame.
- Oversized payloads are dropped or rejected deterministically.

Review:

- Review subagent command: `pi --mode-review --no-session --no-extensions --no-skills --tools read,bash -p "Review committed Pi OSC slice for correctness regressions, malformed input handling, protocol compatibility, Android lifecycle/threading issues, and test gaps. Focus only on PIOSC-2 commits df7d9e4, b1d23f5, 905bdce, dcc3e34, e41a130, e4ebb05, b247f57, 1ea519c, 1dddda8, 5461ac9, 66d5c70, 9a7cb39, and 089574d. Verify existing OSC 9/52/777 behavior is preserved. Return findings by severity with file/line refs, plus residual risks if no findings."`
- Findings fixed: rejected non-JSON payload values, accepted nested JSON payloads, corrected max-frame boundary, rejected cyclic/toJSON/accessor/symbol-keyed/sparse/extra-property/non-plain malformed payloads, preserved `__proto__` keys, allowed shared acyclic objects, normalized envelope fields before encoding, and normalized arrays manually.
- Final review result: no findings. Residual risk: no connected Android instrumentation run for OSC smoke in this ticket; Android runtime OSC paths were untouched.
- Validation: `cd ../agent && npm test -- --run ./test/pi-osc-encoder.test.ts` passed with 25 tests. `cd ../agent && npm run lint -- src/extensions/pi-osc/encoder.ts test/pi-osc-encoder.test.ts` passed. `cd ../agent && npx oxfmt --check src/extensions/pi-osc/encoder.ts src/extensions/pi-osc/index.ts test/pi-osc-encoder.test.ts` passed. `cd ../agent && npm run typecheck` remains blocked by unrelated missing `@xterm/addon-serialize`, `@xterm/headless`, and `zigpty` type/module errors in `src/subagent-sdk/pty.ts`.

Commit:

- Implementation: `df7d9e4` (`feat(pi-osc): add agent encoder`)
- Review fixes: `b1d23f5` (`fix(pi-osc): reject non-json payload values`), `905bdce` (`fix(pi-osc): accept nested json payloads`), `dcc3e34` (`fix(pi-osc): reject cyclic payloads`), `e41a130` (`fix(pi-osc): allow shared payload objects`), `e4ebb05` (`fix(pi-osc): harden payload normalization`), `b247f57` (`fix(pi-osc): reject non-plain data`), `1ea519c` (`fix(pi-osc): reject accessor payloads`), `1dddda8` (`fix(pi-osc): reject symbol payload keys`), `5461ac9` (`fix(pi-osc): reject extra array properties`), `66d5c70` (`fix(pi-osc): normalize envelope fields`), `9a7cb39` (`fix(pi-osc): validate array descriptors`), `089574d` (`fix(pi-osc): normalize arrays manually`)

## PIOSC-3: Implement Agent OSC Emitter Extension

Status: done

Research:

- Extension event types are available in `../agent/node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts`; relevant supported events include `session_start`, `agent_start`, `agent_end`, `turn_start`, `turn_end`, `tool_execution_start`, `tool_execution_end`, `session_before_compact`, `session_compact`, and `after_provider_response`.
- `ToolExecutionStartEvent` and `ToolExecutionEndEvent` include tool call id/name plus args/result, but PIOSC-3 should not emit args/results because PIOSC-4 owns payload schemas and privacy constraints.
- Existing tmux/SSH terminal write behavior is exported from `terminal-notify.ts`: `createTmuxPassthroughSequence`, `getTmuxPaneTty`, `getTmuxClientTty`, `isSshSession`, and `terminalNotifyRuntime`.
- Bundled extensions are registered in `../agent/src/extensions/definitions-group-c.ts`; `terminal-notify` and `terminal-tmux-ui` already live there.

Plan:

- Add `../agent/src/extensions/pi-osc/extension.ts` with runtime hooks for id/time generation, stdout/file writes, and selected lifecycle event handlers.
- Emit compact V1 events for `hello`, `agent.session`, `agent.run`, `agent.turn`, `agent.progress`, `agent.tool`, `agent.alert`, and `agent.compaction`, using existing Pi OSC encoder and tmux passthrough helpers.
- Register extension in grouped bundled definitions and add Vitest coverage for direct stdout, tmux passthrough, every V1 event, compact tool payloads, and provider 429 alert emission.

Checklist:

- [x] Add bundled extension that subscribes to selected Pi lifecycle events.
- [x] Emit `hello`, `agent.session`, `agent.run`, `agent.turn`, `agent.progress`, `agent.tool`, `agent.alert`, and `agent.compaction`.
- [x] Write to stdout or tmux passthrough using existing terminal helpers.

User story:

As an Android terminal user, I want the controlled Pi agent to emit machine-readable state so the terminal can show native progress and agent UI affordances.

Implementation guide:

- Follow existing extension patterns in `../agent/src/extensions/terminal-notify.ts` and `../agent/src/extensions/terminal-tmux-ui.ts`.
- Register the extension in `../agent/src/extensions/definitions-group-c.ts`.
- Emit unconditionally when extension is loaded.
- Use existing `createTmuxPassthroughSequence`, tmux pane/client TTY handling, and SSH logic where applicable.
- Emit `hello` on `session_start` with protocol version and extension version.
- Emit `agent.run` on `agent_start` and `agent_end`.
- Emit `agent.turn` on `turn_start` and `turn_end`.
- Emit `agent.tool` on `tool_execution_start` and `tool_execution_end`; throttle `tool_execution_update` if included.
- Emit `agent.compaction` from upstream `session_before_compact` and `session_compact`.
- Emit `agent.alert` for terminal-worthy alerts only, such as provider `429` or retryable provider failures.

Acceptance criteria:

- Extension is bundled and active through normal `pi` startup.
- Agent tests verify emitted OSC fixtures for each V1 event.
- Existing terminal notification and tmux UI behavior keep working.

Review:

- Review subagent command: `pi --mode-review --no-session --no-extensions --no-skills --tools read,bash -p "Review committed Pi OSC slice for correctness regressions, malformed input handling, protocol compatibility, Android lifecycle/threading issues, and test gaps. Focus only on PIOSC-3 commit 63fccb0. Verify existing OSC 9/52/777 behavior is preserved. Return findings by severity with file/line refs, plus residual risks if no findings."`
- Result: no findings. Existing OSC 9/52/777 paths untouched; Pi OSC uses existing tmux passthrough helpers and encoder. Residual risks: no Android parser/instrumentation smoke for OSC 6767 yet, and no end-to-end OSC 9/52/777 regression run after bundled emitter registration.
- Validation: `cd ../agent && npm test -- --run ./test/pi-osc-extension.test.ts ./test/pi-osc-encoder.test.ts` passed with 29 tests. `cd ../agent && npm run lint -- src/extensions/pi-osc/extension.ts src/extensions/pi-osc/index.ts src/extensions/definitions-group-c.ts test/pi-osc-extension.test.ts test/pi-osc-encoder.test.ts` passed. `cd ../agent && npx oxfmt --check src/extensions/pi-osc/extension.ts src/extensions/pi-osc/index.ts src/extensions/definitions-group-c.ts test/pi-osc-extension.test.ts test/pi-osc-encoder.test.ts` passed. `cd ../agent && npm run typecheck` remains blocked by unrelated missing `@xterm/addon-serialize`, `@xterm/headless`, and `zigpty` type/module errors in `src/subagent-sdk/pty.ts`.

Commit:

- Implementation: `63fccb0` (`feat(pi-osc): emit agent lifecycle frames`)

## PIOSC-4: Define V1 Agent Event Payload Schemas

Status: done

Research:

- Current Pi OSC encoder validates the shared envelope and JSON-serializable `data`, but `data` is still `Record<string, unknown>` and not event-specific.
- Current emitter payloads are compact: hello protocol metadata, session started reason, run running/idle, turn running/complete with `turnIndex`, progress active/clear, tool call id/name/state/isError, alert provider warning/status, and compaction preparing/complete.
- `PIOSC-4` should not expand event scope; it should codify current emitter payloads with TypeBox and make `createPiOscSequence` reject mismatched event data before encoding.
- Protocol docs exist in `../agent/docs/pi-agent-osc-protocol.md` and need payload semantics aligned with emitted V1 events.

Plan:

- Add `../agent/src/extensions/pi-osc/schemas.ts` with TypeBox schemas and inferred types for every V1 payload.
- Wire `createPiOscSequence` to validate `envelope.data` against the schema for `eventName` after JSON normalization and before base64url encoding.
- Add schema/encoder tests for valid emitted payloads and invalid tool, alert, and progress payloads; update protocol docs with compact payload semantics.

Checklist:

- [x] Add TypeBox schemas for all V1 payloads.
- [x] Keep payloads compact and privacy-safe.
- [x] Add schema tests for valid and invalid payloads.

User story:

As an implementer, I want typed event payloads so Android and agent code share stable semantics instead of ad hoc maps.

Implementation guide:

- Use `typebox` per agent project rules.
- Put schemas beside the agent OSC encoder and export inferred types.
- Payloads should include only metadata needed by Android UI.
- Do not include full assistant/user messages in V1.
- Do not include secrets, raw provider payloads, full command output, clipboard contents, or unbounded tool results.
- Keep tool payload fields compact: `toolCallId`, `toolName`, `state`, `isError?`, `label?`, `summary?`.
- Keep alert payload fields compact: `kind`, `title`, `body`, `severity`, `statusCode?`.

Acceptance criteria:

- Every emitted V1 event validates against its schema before encoding.
- Tests cover invalid tool, alert, and progress payloads.
- Payload schema docs match emitted events.

Review:

- Review subagent command: `pi --mode-review --no-session --no-extensions --no-skills --tools read,bash -p "Review committed Pi OSC slice for correctness regressions, malformed input handling, protocol compatibility, Android lifecycle/threading issues, and test gaps. Focus only on PIOSC-4 commits c7e4bc2 and 2cb5a7c. Verify existing OSC 9/52/777 behavior is preserved. Return findings by severity with file/line refs, plus residual risks if no findings."`
- Findings fixed: updated protocol fixture to match `hello` schema, and bounded emitted `agent.tool` `toolCallId`/`toolName` fields before schema validation.
- Final review result: no findings. Residual risks: no connected instrumentation run for OSC 9/52/777; target commits do not touch Android OSC scanner. Schema tightening is intentional for V1 and rejects old incomplete `hello` payloads.
- Validation: `cd ../agent && npm test -- --run ./test/pi-osc-encoder.test.ts ./test/pi-osc-extension.test.ts` passed with 32 tests. `cd ../agent && npm run lint -- src/extensions/pi-osc/encoder.ts src/extensions/pi-osc/schemas.ts src/extensions/pi-osc/extension.ts src/extensions/pi-osc/index.ts test/pi-osc-encoder.test.ts test/pi-osc-extension.test.ts` passed. `cd ../agent && npx oxfmt --check src/extensions/pi-osc/encoder.ts src/extensions/pi-osc/schemas.ts src/extensions/pi-osc/extension.ts src/extensions/pi-osc/index.ts test/pi-osc-encoder.test.ts test/pi-osc-extension.test.ts docs/pi-agent-osc-protocol.md` passed. `cd ../agent && npm run typecheck` remains blocked by unrelated missing `@xterm/addon-serialize`, `@xterm/headless`, and `zigpty` type/module errors in `src/subagent-sdk/pty.ts`.

Commit:

- Implementation: `c7e4bc2` (`feat(pi-osc): validate v1 payload schemas`)
- Review fix: `2cb5a7c` (`fix(pi-osc): bound emitted tool fields`)

## PIOSC-5: Replace Android Tab-String OSC Bridge With Typed Events

Status: done

Research:

- Native currently emits bounded tab-separated strings from `CoderTerminal::finishOscMetadata`: `clipboard\t<kind>\t<data>`, `notification\t<title>\t<body>`, and `progress\t<state>\t<value>`.
- `CoderTerminalView.notifyOscMetadataChanged` consumes raw strings directly and dispatches to clipboard, notification, and progress handlers.
- `TerminalNotificationRouter` consumes the same raw string shape for headless terminals; `CoderHeadlessTerminalEndpoint` forwards `TerminalEngineUpdate.oscEvents` to the router.
- `TerminalEngine` returns raw `List<String>` from JNI, so this ticket can preserve native/JNI behavior while adding a Kotlin typed conversion boundary immediately after consumption.

Plan:

- Add a sealed `TerminalOscEvent` model with clipboard, notification, progress, Pi placeholder, and ignored cases plus a parser from native raw strings.
- Update `TerminalEngine`, `CoderTerminalView`, `CoderHeadlessTerminalEndpoint`, and `TerminalNotificationRouter` to pass typed events instead of raw tab strings.
- Add unit tests for raw conversion of OSC 52 clipboard, OSC 9/777 notification, OSC 9;4 progress, malformed strings, and future Pi placeholder events.

Checklist:

- [x] Introduce typed Android-side OSC event model.
- [x] Convert existing `clipboard`, `notification`, and `progress` internal events to typed values.
- [x] Preserve current OSC 52, OSC 9, and OSC 777 behavior.

User story:

As an Android maintainer, I want a typed OSC bridge so new Pi events do not deepen tab-separated string parsing debt.

Implementation guide:

- Replace or wrap `nativeConsumeOscEvents(handle): Array<String>` with a typed Kotlin conversion boundary.
- Keep native event queue simple if needed, but parse into sealed Kotlin event types before UI handling.
- Update `CoderTerminalView.handleOscEvent` and `TerminalNotificationRouter.handleOscEvent` to consume typed events.
- Consider JSON from native only if it simplifies JNI safely; otherwise use a small structured delimiter internally and convert immediately.
- Add unit tests for conversion of existing clipboard, notification, and progress events.

Acceptance criteria:

- Existing OSC 52 clipboard works after refactor.
- Existing OSC 9 alert/progress works after refactor.
- Existing OSC 777 notification works after refactor.
- New typed model has a dedicated case for Pi OSC events.

Review:

- Review subagent command: `pi --mode-review --no-session --no-extensions --no-skills --tools read,bash -p "Review committed Pi OSC slice for correctness regressions, malformed input handling, protocol compatibility, Android lifecycle/threading issues, and test gaps. Focus only on PIOSC-5 commit 4dac8ed. Verify existing OSC 9/52/777 behavior is preserved. Return findings by severity with file/line refs, plus residual risks if no findings."`
- Result: no findings. Typed conversion preserves existing tab split semantics for OSC 52 clipboard, OSC 9 alert/progress, and OSC 777 notification. Residual risk: no connected instrumentation/JNI regression run for actual OSC 9/52/777 byte sequences.
- Validation: `./gradlew testDebugUnitTest --tests com.coder.pi.TerminalOscEventTest` passed. `./gradlew compileDebugKotlin` passed. `./gradlew testDebugUnitTest` passed.

Commit:

- Implementation: `4dac8ed` (`refactor(pi-osc): type android osc events`)

## PIOSC-6: Parse Pi OSC 6767 In Native Terminal Layer

Status: done

Research:

- `CoderTerminal::processOscMetadata` buffers OSC bytes up to `8192`, accepts BEL, ST, and C1 ST, then calls `finishOscMetadata`.
- Existing native `finishOscMetadata` handles OSC 7, OSC 52, OSC 9 notification/progress, and OSC 777 notify; adding a `6767;pi;1;` branch can preserve all existing branches unchanged.
- Kotlin `TerminalOscEvent.Pi(eventName, payload)` already exists from PIOSC-5, so native can surface Pi frames as `pi\t<event>\t<payload>` without decoding JSON in C++.
- Debug render fixture lives in `CoderApp.kt` `debugRenderPlaygroundBytes`, which already emits OSC 9/9;4 smoke bytes through real `CoderTerminalView.feedRemoteOutput`.

Plan:

- Add small native helpers for V1 event allowlist, event-name character validation, and base64url payload validation.
- Extend `finishOscMetadata` to accept `6767;pi;1;<event>;<payload>` and push `pi\t<event>\t<payload>` for valid frames only.
- Add debug render Pi OSC frames for `hello`, `agent.run`, and `agent.tool`; add Kotlin unit coverage for Pi raw conversion and run native build/unit validation.

Checklist:

- [x] Extend native side parser to recognize `OSC 6767;pi;1;...`.
- [x] Bound payload size and sanitize event names.
- [x] Surface parsed Pi OSC frames to Kotlin as typed events.

User story:

As the Android terminal app, I want to detect Pi-specific OSC frames while all other terminals safely ignore them.

Implementation guide:

- Extend `CoderTerminal::finishOscMetadata` in `app/src/main/cpp/coder_terminal.cpp`.
- Recognize prefix `6767;pi;1;`.
- Split only protocol fields, not payload content.
- Accept known event names from V1 allowlist.
- Cap raw payload length and event name length.
- Do not decode base64url in C++ unless that is clearly simpler; Kotlin decoding is easier to test.
- Add debug smoke bytes to `pi://debug/render` fixture for at least `hello`, `agent.run`, and `agent.tool`.

Acceptance criteria:

- Valid Pi OSC frames reach Kotlin.
- Malformed namespace/version/event/payload frames are ignored.
- Existing OSC parsing behavior is unchanged.

Review:

- Review subagent command: `pi --mode-review --no-session --no-extensions --no-skills --tools read,bash -p "Review committed Pi OSC slice for correctness regressions, malformed input handling, protocol compatibility, Android lifecycle/threading issues, and test gaps. Focus only on PIOSC-6 commits 5d436e3 and 37f8890. Verify existing OSC 9/52/777 behavior is preserved. Return findings by severity with file/line refs, plus residual risks if no findings."`
- Findings fixed: raised native Pi payload cap to match full Android OSC parser budget instead of dropping valid near-limit frames.
- Final review result: no findings. Residual risks: no native/instrumented regression test directly feeds valid/malformed `6767` bytes through JNI, and no connected Android lifecycle/threading smoke was run.
- Validation: `./gradlew :app:externalNativeBuildDebug` passed. `./gradlew compileDebugKotlin` passed. `./gradlew testDebugUnitTest --tests com.coder.pi.TerminalOscEventTest` passed.

Commit:

- Implementation: `5d436e3` (`feat(pi-osc): parse native osc frames`)
- Review fix: `37f8890` (`fix(pi-osc): accept full native payload budget`)

## PIOSC-7: Decode And Validate Pi OSC Payloads In Kotlin

Status: done

Research:

- Android already depends on `kotlinx.serialization.json`; app code uses `Json { ignoreUnknownKeys = true; explicitNulls = false }` in `CoderApi.kt`.
- PIOSC-6 currently emits native Pi events as `pi\t<eventName>\t<payload>`, which does not let Kotlin validate protocol version, so this ticket needs the internal bridge to include `1` as `pi\t1\t<eventName>\t<payload>`.
- `TerminalOscEvent.Pi` currently carries raw event name and payload only; it should become a validated event with decoded envelope and JSON payload data.
- Local JVM unit tests cannot instantiate `TerminalEngine` because `CoderNative` loads Android JNI library in a way unavailable to plain unit tests; validation can cover Kotlin decoder directly plus native build.

Plan:

- Add Kotlin Pi OSC decoder using `java.util.Base64` URL decoder and `kotlinx.serialization.json`.
- Validate internal version, allowlisted event names, base64url alphabet/size, envelope `id`/`ts`/`source`/`data`, `source == "agent"`, and compact V1 payload shapes.
- Update native internal Pi event string to include version, update typed event parser/tests, and keep malformed frames as `Ignored` so UI feed path never throws.

Checklist:

- [x] Add Kotlin decoder for Pi OSC base64url JSON envelope.
- [x] Validate event name, version, envelope required fields, and event payload shape.
- [x] Drop invalid events safely.

User story:

As an Android UI implementer, I want validated Pi events so UI state cannot be corrupted by malformed terminal output.

Implementation guide:

- Add parser module near `TerminalEngine` or `CoderTerminalView` depending on existing test layout.
- Use Kotlin serialization or existing JSON tooling already available in the app.
- Enforce max decoded payload bytes.
- Require `id`, `ts`, `source`, and `data` in the envelope.
- Require `source == "agent"` for V1.
- Keep unknown V1 event fields ignored unless security-relevant.
- Add unit tests with byte fixtures from agent encoder tests.

Acceptance criteria:

- Android tests decode valid fixtures from agent tests.
- Invalid base64url, invalid JSON, unsupported version, and oversized payloads are dropped.
- Parser never throws into UI feed path.

Review:

- Review subagent command: `pi --mode-review --no-session --no-extensions --no-skills --tools read,bash -p "Review committed Pi OSC slice for correctness regressions, malformed input handling, protocol compatibility, Android lifecycle/threading issues, and test gaps. Focus only on PIOSC-7 commits 1b77465, 25b9572, bc43af9, and 9995dd8. Verify existing OSC 9/52/777 behavior is preserved. Return findings by severity with file/line refs, plus residual risks if no findings."`
- Findings fixed: rejected non-string JSON primitives, decoded UTF-8 strictly, rejected malformed optional envelope metadata and unknown root fields, and accepted blank optional `sessionId`/`cwd` per shared schema.
- Final review result: no findings. Residual risk: no native/JNI or connected Android instrumentation feeding raw OSC bytes through terminal lifecycle.
- Validation: `./gradlew testDebugUnitTest --tests com.coder.pi.TerminalOscEventTest` passed. `./gradlew compileDebugKotlin` passed. `./gradlew :app:externalNativeBuildDebug compileDebugKotlin` passed. `./gradlew testDebugUnitTest` passed.

Commit:

- Implementation: `1b77465` (`feat(pi-osc): validate kotlin payloads`)
- Review fixes: `25b9572` (`fix(pi-osc): strictly validate kotlin payloads`), `bc43af9` (`fix(pi-osc): reject malformed envelope metadata`), `9995dd8` (`fix(pi-osc): accept blank optional metadata`)

## PIOSC-8: Implement Android Agent State Store

Status: done

Research:

- `TerminalOscEvent.Pi` is now validated and carries decoded `PiOscEnvelope` with event-specific `data`; `CoderTerminalView.handleOscEvent` currently ignores it.
- `CoderTerminalView.dispose()` and `disposeManagerOwnedEngine()` are the active cleanup paths for terminal views and engine/session replacement.
- There is no existing agent state model, and PIOSC-8 does not require persistence or UI rendering, so a small pure Kotlin `TerminalAgentState` can be unit-tested without Android dependencies.
- Headless `TerminalNotificationRouter` still ignores Pi events; PIOSC-9 owns notification/UI surfacing.

Plan:

- Add `TerminalAgentState` and immutable snapshot data classes to track handshake/session/run/turn/progress/tools/alerts/compaction in memory with bounded tool and alert histories.
- Update `CoderTerminalView` to own one `TerminalAgentState`, apply validated Pi events, expose a snapshot for later UI, and clear it on disposal/session replacement.
- Add unit tests for all V1 state transitions, bounded histories, session isolation via separate state instances, and cleanup.

Checklist:

- [x] Add per-terminal in-memory state for latest Pi agent session/run/progress/tool events.
- [x] Keep state scoped to terminal session.
- [x] Clear state on terminal close or session replacement.

User story:

As an Android terminal user, I want native UI to reflect current agent state without polluting terminal text rendering.

Implementation guide:

- Store state in `CoderTerminalView` or a small `TerminalAgentState` class.
- Track protocol handshake, running state, active turn, active tools, progress, alerts, and compaction state.
- Bound active/completed tool history.
- Do not persist raw event payloads unless explicitly needed.
- Do not log prompts, commands, tool output, provider payloads, or secrets.

Acceptance criteria:

- State updates from `hello`, `agent.run`, `agent.turn`, `agent.progress`, `agent.tool`, `agent.alert`, and `agent.compaction`.
- State is isolated between terminal sessions.
- State cleanup occurs on view/session disposal.

Review:

- Targeted unit tests cover all V1 state updates, bounded tool and alert histories, isolated instances, and cleanup.
- State stores parsed fields plus event metadata only; it does not retain raw envelope `data`.
- `./gradlew testDebugUnitTest --tests com.coder.pi.TerminalAgentStateTest --no-daemon` passes.

Commit:

## PIOSC-9: Add Android UI And Notification Handling For V1 Events

Status: done

Research:

- `CoderTerminalView.handleOscEvent` now applies Pi events but does not notify Compose or route alerts/progress.
- `TerminalSurface` already has `statusContent` overlay support and owns Compose state for OSC metadata.
- Existing visible notification paths are `handleOscNotification` and `handleOscProgress`; reusing them preserves permissions, throttling, foreground suppression, haptics, and notification channels.
- Headless terminals route OSC through `TerminalNotificationRouter`, which currently ignores Pi events and can own a small `TerminalAgentState` instance.
- PIOSC-9 should not add preferences; OSC notification toggles and notification permission behavior already exist.

Plan:

- Add pure presentation helpers that map `TerminalAgentStateSnapshot` and Pi alerts/progress to bounded UI/notification strings.
- Update `CoderTerminalView` to publish agent state changes to Compose, show compact overlay via `TerminalSurface`, and route Pi alerts/progress through existing notification methods.
- Update `TerminalNotificationRouter` to maintain headless agent state and route Pi alerts/progress through existing notification methods.
- Add unit tests for presentation mapping and run focused Android validation.

Checklist:

- [x] Surface agent running/progress state in existing terminal UI.
- [x] Route `agent.alert` to existing notification behavior.
- [x] Keep UI compact and non-disruptive.

User story:

As a mobile user, I want Pi agent activity to appear as native status, progress, and alerts so I can follow long-running work without reading terminal escape output.

Implementation guide:

- Reuse existing progress notification behavior where possible.
- Map `agent.progress` to current progress notification channel.
- Map `agent.alert` to current terminal notification channel with workspace context.
- Show active tools and compaction only if there is an existing UI affordance or a small non-invasive panel.
- Avoid adding new settings unless required by product behavior.
- Preserve user notification permission handling and rate limits.

Acceptance criteria:

- Agent running state is visible in the active terminal UI.
- Agent progress updates notification progress.
- Agent alert posts a native notification when terminal is backgrounded or appropriate.
- Foreground behavior does not spam toasts or notifications.

Review:

- Implementation review found one UI lifecycle issue: `TerminalSurface` could retain stale `agentStatus` when composed with a different `CoderTerminalView` before the next Pi event.
- Fixed by refreshing `agentStatus` from `terminalView.agentStateSnapshot()` inside the `DisposableEffect(terminalView)` setup.
- Second review found no correctness regressions in PIOSC-9 scope. Existing OSC 9/52/777 paths remain unchanged; Pi events reuse existing notification/progress methods.
- `./gradlew testDebugUnitTest --tests com.coder.pi.TerminalAgentPresentationTest --tests com.coder.pi.TerminalAgentStateTest --no-daemon` passes.
- `./gradlew compileDebugKotlin --no-daemon` passes.

Commit:

- `d74798a` `feat(pi-osc): surface android agent events`
- `21076a7` `fix(pi-osc): refresh android agent overlay state`

## PIOSC-10: Add End-To-End Debug Smoke Flow

Status: building

Research:

- `pi://debug/render` is already documented in `docs/android-osc.md` and feeds `debugRenderPlaygroundBytes` into a real `CoderTerminalView`.
- Current debug bytes already include OSC title, OSC 7 PWD, OSC 9 notification/progress, `hello`, `agent.run`, and a running `agent.tool` Pi frame.
- PIOSC-10 still needs active `agent.progress`, completed `agent.tool`, `agent.alert`, Pi progress clear, and explicit debug documentation of expected UI state.
- Existing OSC 52 and OSC 777 behavior should stay in the same debug fixture so the smoke screen continues to exercise legacy OSC paths alongside Pi OSC.

Plan:

- Extend `debugRenderPlaygroundBytes` with bounded Pi OSC V1 fixture frames for progress active/clear, tool complete, and alert.
- Add OSC 52 clear/query-safe smoke and OSC 777 notify smoke without changing runtime parser behavior.
- Document manual `pi://debug/render` validation and expected UI states in `docs/android-osc.md` plus checklist review.
- Add a unit test that verifies debug bytes contain required Pi and legacy OSC smoke frames.

Checklist:

- [ ] Add debug fixture bytes for Pi OSC events.
- [ ] Document manual validation path.
- [ ] Capture or describe expected UI states.

User story:

As a developer, I want one debug screen to validate Pi OSC handling through the real terminal parser and UI path.

Implementation guide:

- Use existing `pi://debug/render` path and `debugRenderPlaygroundBytes` in `CoderApp.kt`.
- Include at least `hello`, running `agent.run`, active `agent.progress`, `agent.tool` start/end, `agent.alert`, and clear progress.
- Keep debug-only content out of production behavior.
- Document validation steps in `docs/android-osc.md` or this checklist.

Acceptance criteria:

- Debug render emits Pi OSC frames through `CoderTerminalView.feedRemoteOutput`.
- UI receives decoded typed events.
- Existing OSC 9/52/777 debug smokes still work.

Review:

Commit:

## PIOSC-11: Add Cross-Repo Validation

Status: not-started

Research:

Checklist:

- [ ] Run agent checks for encoder and extension changes.
- [ ] Run Android checks for parser and UI changes.
- [ ] Add shared fixtures or documented fixture copy process.

User story:

As a maintainer, I want proof that agent-emitted bytes are accepted by Android before the feature is considered complete.

Implementation guide:

- Agent validation from `../agent`: `npm run typecheck`, `npm test`, `npm run lint`, `npm run format:check`.
- Android validation from `.`: `./gradlew testDebugUnitTest`, `./gradlew assembleDebug`.
- Prefer shared fixture strings in docs or generated test fixtures so both sides test the same protocol examples.
- If Android device is available, run a debug smoke with `pi://debug/render` and capture screenshot/log evidence.

Acceptance criteria:

- Agent checks pass.
- Android checks pass.
- At least one fixture emitted by the agent encoder is decoded by Android tests.

Review:

Commit:

## PIOSC-12: Final Integration Review And Cleanup

Status: not-started

Research:

Checklist:

- [ ] Review feature for privacy, bounds, malformed input, and UI spam risks.
- [ ] Remove temporary debug-only code not intentionally kept.
- [ ] Update implementation docs with final event semantics and validation evidence.

User story:

As a product owner, I want the Pi OSC feature shipped with clear behavior, bounded risk, and no temporary implementation leftovers.

Implementation guide:

- Audit all OSC-derived strings for bounds and control-character handling.
- Audit notification behavior for rate limits and permission checks.
- Confirm no event emits secrets, prompts, raw tool output, provider payloads, or clipboard contents.
- Confirm existing OSC 9/52/777 compatibility remains intact.
- Fill every ticket `Review` and `Commit` section before final handoff.

Acceptance criteria:

- All checklist tickets have completed checkbox state.
- Every ticket has Review and Commit filled by implementer.
- Final docs match actual implementation.
- No known high-risk malformed-input or privacy gaps remain.

Review:

Commit:
