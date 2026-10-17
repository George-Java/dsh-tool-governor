# dsh-tool-governor

A DeepSeek Harness plugin that stops runaway tool calls before they burn through your token budget.

## What it does

- **Repeat-call breaker** — denies the same tool + argument combination after N repeats
- **Per-turn budget fuse** — hard-caps tool calls and model steps per turn
- **Failure-loop cutoff** — pauses a tool after consecutive failures
- **Monotonic guard** — denies are final; downstream layers cannot re-allow a blocked call

## Install

```bash
dsh plugin --profile web add github:George-Java/dsh-tool-governor
```

Restart DSH after installing. Verify the bundle is registered:

```bash
dsh --profile web --dump-config | findstr dsh-tool-governor
```

Pin a ref explicitly if needed:

```bash
dsh plugin --profile web add "github:George-Java/dsh-tool-governor#main"
```

## Compatibility

| Item | Value |
| --- | --- |
| DSH | `0.1.x` (tested on `0.1.0-rc.5` and later) |
| Platform | Windows / macOS / Linux |
| Node.js | `^22.19.0 || >=24.0.0` |

> **0.2.x note:** DSH 0.2 replaced the per-agent `agent` service with the `agents` registry plus scoped agent events. This plugin's `inject: ['agent']` therefore waits for a service that no longer exists and stays inactive on `0.2.x`. Porting to `exec.agent` / `event.agent` is in progress.

## Configuration

All fields are optional — defaults are applied when omitted.

| Field | Default | Description |
| :-- | :-- | :-- |
| `maxToolCallsPerTurn` | `24` | Max tool calls allowed in one turn |
| `maxStepsPerTurn` | `16` | Max model steps allowed in one turn |
| `repeatThreshold` | `2` | Deny after the same call repeats this many times |
| `consecutiveFailureThreshold` | `2` | Pause a tool after N consecutive failures |
| `denyTools` | `[]` | Glob patterns of tools to always deny (e.g. `["browser_*"]`) |
| `denyMessage` | built-in | Message injected when a call is denied |

Override through your profile's `cordis.patch.yml`:

```yaml
- id: dsh-tool-governor
  name: dsh-tool-governor
  config:
    maxToolCallsPerTurn: 12
    repeatThreshold: 1
```

## Uninstall

```bash
dsh plugin --profile web remove dsh-tool-governor
```

## How it works

The plugin registers four hooks on `ctx`:

1. `tools/pre-execute` — denies blacklisted tools, exhausted per-turn budgets, repeated signatures, and failure loops.
2. `tools/post-execute` — counts completed calls and tracks consecutive failures.
3. `ctx.tools.guard` — a monotonic, synchronous guard that makes earlier denials final.
4. `agent/pre-step` — blocks the turn once its model-step budget is spent.

Per-agent, per-turn ledgers are keyed by agent id and turn number; a new turn starts a fresh budget.

## License

MIT
