# UI Network Serialization Analysis

## Locked Decisions (Q&A Addendum)

This addendum is authoritative and supersedes conflicting exploratory options below.

- No backward compatibility requirements.
- Client capabilities are advertised as feature flags via dedicated endpoint.
- Upstream `ExtensionContext` remains untouched; capabilities exposed through runtime helper (`Reflect`/`Symbol` metadata).
- No resize channel.
- Server sends data/state only; client renders UI locally.
- Remote function-factory UI APIs are hard errors for interactive unsupported paths.
- Interactive requests are broadcast; first response wins; resolved outcome is echoed to all clients.
- No focus model.
- Commands and shortcuts are client-side UI execution; server owns data/mutations.
- Tools execute only on server; client execute path is no-op.
- Client-local UI state is not replicated across connections.
- KV policy: global/per-user namespaces + session entries, LWW conflict, no TTL, no limits in initial release.
- No trusted-client mode.

## Executive Summary

**Pushback:** Attempting to transparently proxy all `ctx.ui.*` methods over the network is a **fundamentally flawed design**. The UI API was designed for in-process function calls with:

- Function references as arguments
- Synchronous return values
- Object references (Theme, TUI, Component)
- Stateful callbacks

These do not serialize. The "ops" approach requires **rethinking the API boundary**, not just wrapping it.

---

## Complete UI Method Analysis

### Tier 1: Safely Serializable (Request/Response or Fire-and-Forget)

| Method                   | Signature                                                    | Network Pattern  | Issues            |
| ------------------------ | ------------------------------------------------------------ | ---------------- | ----------------- |
| `select`                 | `(title, options, opts) => Promise<string \| undefined>`     | Request/Response | ✅ Clean          |
| `confirm`                | `(title, message, opts) => Promise<boolean>`                 | Request/Response | ✅ Clean          |
| `input`                  | `(title, placeholder, opts) => Promise<string \| undefined>` | Request/Response | ✅ Clean          |
| `editor`                 | `(title, prefill?) => Promise<string \| undefined>`          | Request/Response | ✅ Clean          |
| `notify`                 | `(message, type?) => void`                                   | Fire-and-forget  | ✅ Clean          |
| `setStatus`              | `(key, text?) => void`                                       | Fire-and-forget  | ✅ Clean          |
| `setWorkingMessage`      | `(message?) => void`                                         | Fire-and-forget  | ✅ Clean          |
| `setWorkingIndicator`    | `(options?) => void`                                         | Fire-and-forget  | ⚠️ Complex object |
| `setHiddenThinkingLabel` | `(label?) => void`                                           | Fire-and-forget  | ✅ Clean          |
| `setTitle`               | `(title) => void`                                            | Fire-and-forget  | ✅ Clean          |
| `pasteToEditor`          | `(text) => void`                                             | Fire-and-forget  | ✅ Clean          |
| `setEditorText`          | `(text) => void`                                             | Fire-and-forget  | ✅ Clean          |
| `setToolsExpanded`       | `(expanded) => void`                                         | Fire-and-forget  | ✅ Clean          |
| `setTheme`               | `(theme) => {success, error?}`                               | Fire-and-forget  | ⚠️ Theme object   |

### Tier 2: Problematic (Require Design Changes)

| Method             | Signature                      | Problem                                             | Severity  |
| ------------------ | ------------------------------ | --------------------------------------------------- | --------- |
| `getEditorText`    | `() => string`                 | **Synchronous return requires blocking round-trip** | 🔴 High   |
| `getToolsExpanded` | `() => boolean`                | **Synchronous return requires blocking round-trip** | 🔴 High   |
| `getAllThemes`     | `() => {name, path}[]`         | Returns objects; async would break API              | 🟡 Medium |
| `getTheme`         | `(name) => Theme \| undefined` | Returns Theme object; Theme has methods             | 🟡 Medium |
| `theme`            | `readonly Theme`               | Property access; Theme has methods (fg, bg, etc)    | 🔴 High   |

### Tier 3: Unserializable (Function Arguments)

| Method               | Signature                                                                                         | Why It Fails                      |
| -------------------- | ------------------------------------------------------------------------------------------------- | --------------------------------- |
| `setWidget`          | `(key, content, options?) => void` where `content` can be `string[] \| (tui, theme) => Component` | **Function cannot serialize**     |
| `setFooter`          | `(factory?) => void` where `factory` is `(tui, theme, footerData) => Component`                   | **Function cannot serialize**     |
| `setHeader`          | `(factory?) => void` where `factory` is `(tui, theme) => Component`                               | **Function cannot serialize**     |
| `setEditorComponent` | `(factory?) => void` where `factory` is `(tui, theme, keybindings) => EditorComponent`            | **Function cannot serialize**     |
| `custom`             | `<T>(factory, options?) => Promise<T>` where `factory` creates Component                          | **Function cannot serialize**     |
| `onTerminalInput`    | `(handler) => () => void` where `handler` is callback                                             | **Callback streaming is complex** |

---

## The 180-Column Problem: Root Cause

### Current Broken Implementation

```typescript
// src/remote/session/ui-context.ts:35
const renderWidth = 180; // HARDCODED - WHY?

state.renderHeader = (): void => {
  input.publishUiEvent(input.record, {
    id: randomUUID(),
    method: "setHeader",
    // Component.render() happens on SERVER with WRONG width
    lines: state.headerComponent.render(renderWidth),
  });
};
```

### Why 180 Was Chosen

1. **Arbitrary "safe" value** — wide enough for most content
2. **Server doesn't know client width** — no capability handshake
3. **Component.render() must happen somewhere** — chose server
4. **Result:** CRASH when terminal narrower than 180; wasted space when wider

### Why This Design Is Wrong

**The server should NOT pre-render UI.** The API `setFooter((tui, theme, data) => Component)` forces server-side rendering because:

- The factory function executes on the server
- It returns a Component object
- Component.render(width) produces string[]
- String[] is sent to client

**This inverts the relationship.** The client (terminal) should render. The server should send:

- **Data** (what to display)
- **Layout hints** (how to prioritize)
- **Let client decide** actual width/height

---

## Design Options Analysis

### Option A: Transparent Proxy (What We Tried)

Make `ctx.ui` methods work over network as if local.

```typescript
// Extension code (unchanged)
ctx.ui.setFooter((tui, theme, data) => createFooter(tui, theme, data));

// Behind the scenes: serialize function? IMPOSSIBLE
```

**Verdict: 🔴 BAD** — Cannot serialize functions. 180-column hack is symptom of this failed approach.

---

### Option B: Pre-render with Width Negotiation

Server renders but first negotiates width with client.

```typescript
// Server
const width = await client.getTerminalWidth();
const lines = component.render(width);
client.send({ method: "setFooter", lines });

// On resize
client.onResize = (newWidth) => {
  server.reRender(newWidth); // Round-trip on every resize!
};
```

**Problems:**

- Lag on resize (network round-trip)
- Floods network during rapid resizes
- Server stateful (must keep component alive)

**Verdict: 🟡 COMPLEX** — Works but inefficient and stateful.

---

### Option C: Client-Side Rendering with Declarative Protocol (Recommended)

Server sends **what** to render, not **how**.

```typescript
// Extension API (NEW - declarative)
ctx.ui.setFooter({
  type: "footer",
  sections: [
    { type: "branch", priority: "high" },
    { type: "model", priority: "high" },
    { type: "cost", priority: "medium" },
    { type: "context-usage", priority: "low" },
  ],
  data: {
    branch: footerData.getGitBranch(),
    model: ctx.model?.id,
    cost: state.totalCost,
    usage: ctx.getContextUsage(),
  },
});
```

**Protocol:**

```json
{
  "method": "setFooter",
  "sections": [...],
  "data": { "branch": "main", "model": "claude-sonnet", "cost": 0.42 }
}
```

**Client-side render:**

```typescript
// Client receives declarative footer
function renderFooter(footerSpec, availableWidth) {
  const parts = footerSpec.sections
    .sort(byPriority)
    .map((s) => formatSection(s, footerSpec.data))
    .filter(fitsIn(availableWidth));
  return composeFooterLine(parts, availableWidth);
}
```

**Benefits:**

- ✅ No function serialization
- ✅ Client renders with actual width
- ✅ No lag on resize (client-local)
- ✅ Network efficient (send data once, re-render locally)

**Trade-offs:**

- Requires new declarative API (breaking change)
- Less flexible than arbitrary functions

**Verdict: 🟢 GOOD** — Clean separation of concerns.

---

### Option D: Server Streams Render Commands (Immediate Mode)

Server sends drawing commands, client executes.

```typescript
// Extension (imperative)
ctx.ui.drawText(0, 0, "Hello", { color: "blue" });
ctx.ui.drawBox(0, 1, 10, 3, { border: "single" });
```

**Protocol:**

```json
[
  { "cmd": "text", "x": 0, "y": 0, "text": "Hello", "style": { "fg": "blue" } },
  { "cmd": "box", "x": 0, "y": 1, "w": 10, "h": 3, "border": "single" }
]
```

**Problems:**

- High network overhead (many small commands)
- Still need width for layout
- State synchronization issues

**Verdict: 🟡 COMPLEX** — Overkill for this use case.

---

## Recommended Architecture

### Two-Layer Design

```
┌─────────────────────────────────────────────────────────────┐
│  LAYER 1: Declarative UI (Network-Safe)                    │
│  • setStatus, notify, setWorkingMessage                     │
│  • setDeclarativeFooter, setDeclarativeHeader               │
│  • setWidget (string[] only, no functions)                  │
├─────────────────────────────────────────────────────────────┤
│  LAYER 2: Interactive Primitives (Request/Response)        │
│  • select, confirm, input, editor                           │
│  • custom (limited - see below)                             │
├─────────────────────────────────────────────────────────────┤
│  LAYER 3: Local-Only (Client Extensions)                   │
│  • setFooter with function                                  │
│  • setHeader with function                                  │
│  • setEditorComponent                                       │
│  • custom with complex components                           │
│  • onTerminalInput                                          │
└─────────────────────────────────────────────────────────────┘
```

### Handling the Tier 3 Methods

**Option 1: Move to Client Extensions**

```typescript
// Client-side extension (runs locally, not over network)
export default function clientUIExtension(pi: ExtensionAPI): void {
  pi.on("session_start", (_event, ctx) => {
    // This runs on client, has full UI access
    ctx.ui.setFooter((tui, theme, data) => createComplexFooter(tui, theme, data));
  });
}
```

**Option 2: Simplified Server-Safe Versions**

```typescript
// Server can call this - sends declarative spec
ctx.ui.setFooterLayout({
  type: "standard",
  show: ["branch", "model", "cost"],
  format: "compact",
});
```

**Option 3: Error on Unsupported**

```typescript
// Server-side UI context
setFooter: () => {
  throw new Error(
    "setFooter with function not supported in remote mode. " +
    "Use setFooterLayout() or move logic to client extension."
  );
},
```

### Handling Synchronous Getters

**Current (broken for remote):**

```typescript
const text = ctx.ui.getEditorText(); // Synchronous!
```

**Option 1: Async Version (breaking change)**

```typescript
const text = await ctx.ui.getEditorTextAsync();
```

**Option 2: Cached Value (eventual consistency)**

```typescript
// Server caches last known value
ctx.ui.getEditorText(); // Returns cached (may be stale)

// Client pushes updates
client.onDraftChange = (text) => server.updateCachedDraft(text);
```

**Option 3: Pass Value to Handler**

```typescript
// Instead of querying, receive in event
pi.on("before_agent_start", (event, ctx) => {
  const text = event.prompt; // Passed to handler
});
```

---

## Migration Path for Current Extensions

### Extension Audit

| Extension      | UI Methods Used                                      | Tier | Action Required                                |
| -------------- | ---------------------------------------------------- | ---- | ---------------------------------------------- |
| `prompt-stash` | `custom`, `getEditorText`, `setEditorText`, `notify` | 2, 3 | Convert `custom` to declarative or client-side |
| `files`        | `custom` (for external editor), `select`, `notify`   | 1, 3 | External editor needs client-side              |
| `review`       | `select`, `notify`, `custom`                         | 1, 3 | `custom` for loader needs alternative          |
| `coreui`       | `setFooter`, `setHeader`                             | 3    | Convert to declarative layout                  |
| `modes`        | `select`, `setStatus`                                | 1, 2 | ✅ Already compatible                          |
| `openusage`    | `notify`, `setStatus`                                | 1    | ✅ Already compatible                          |
| `executor`     | `select`, `confirm` (optional)                       | 1    | ✅ Already compatible                          |

### Specific Recommendations

**1. prompt-stash `custom` usage:**

```typescript
// Current - uses custom component
const result = await ctx.ui.custom<PromptStashBrowserAction>(
  (tui, theme, keybindings, done) => new PromptStashBrowser(tui, theme, keybindings, entries, done),
  { overlay: true },
);

// Option A: Client-side only
if (!ctx.hasClientUI) {
  ctx.ui.notify("Prompt stash browser requires local client", "error");
  return;
}
// Proceed with custom...

// Option B: Use standard select
const choice = await ctx.ui.select(
  "Select stash entry:",
  entries.map((e) => e.preview),
);
```

**2. files `custom` for external editor:**

```typescript
// Current - suspends TUI, opens external editor
const updated = await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
  const result = openExternalEditor(tui, editorCmd, content);
  done(result);
});

// Should be: Client-side tool
// External editor cannot work over network anyway
```

**3. coreui footer:**

```typescript
// Current - function that renders
ctx.ui.setFooter((tui, theme, footerData) => ({
  render(width) {
    /* complex logic */
  },
}));

// Proposed - declarative
ctx.ui.setFooterData({
  branch: footerData.getGitBranch(),
  model: ctx.model?.id,
  cost: state.totalCost,
  contextUsage: ctx.getContextUsage(),
  extensionStatuses: footerData.getExtensionStatuses(),
});
// Client has standard footer renderer that consumes this data
```

---

## Protocol Design (Declarative Approach)

### Fire-and-Forget Operations

```typescript
// Server → Client
interface NotifyOp {
  op: "notify";
  message: string;
  type?: "info" | "warning" | "error";
}

interface SetStatusOp {
  op: "setStatus";
  key: string;
  text?: string;
}

interface SetFooterDataOp {
  op: "setFooterData";
  data: FooterData; // Declarative, not rendered
}

interface SetWorkingMessageOp {
  op: "setWorkingMessage";
  message?: string;
}
```

### Request/Response Operations

```typescript
// Server → Client
interface SelectRequest {
  id: string;
  op: "select";
  title: string;
  options: string[];
  timeout?: number;
}

// Client → Server
interface SelectResponse {
  id: string; // Matches request
  value?: string;
  cancelled?: boolean;
}
```

### Width Handling

```typescript
// Client capabilities at connect
interface ClientCapabilities {
  terminal: { columns: number; rows: number };
}

// Client → Server on resize
interface TerminalResize {
  op: "terminal.resize";
  columns: number;
  rows: number;
}

// Server updates footer data (client re-renders locally)
// No round-trip for resize!
```

---

## Conclusion

### Why 180 Columns Was Wrong

It was a **symptom** of trying to serialize non-serializable functions. The server rendered because the API forced it to. The fix is not dynamic width negotiation — it's **not rendering on the server at all**.

### What to Do Instead

1. **Admit the API boundary** — Functions cannot cross the network
2. **Split the API** — Declarative (network-safe) vs Local-only (client-side)
3. **Client renders** — Server sends data, client decides layout
4. **Graceful degradation** — Extensions check capabilities, adapt behavior

### Immediate Actions

1. **Remove 180 hardcode** — Send footer data, not rendered lines
2. **Create declarative footer API** — Server sends JSON, client renders
3. **Audit all `custom` usages** — Move to client or replace with `select`
4. **Document tier 3 methods** — Explicitly unsupported in remote mode
