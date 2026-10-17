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
| DSH | `0.2.x` (tested on `0.2.1-rc.2`) |
| Platform | Windows / macOS / Linux |
| Node.js | `^22.19.0 \|\| >=24.0.0` |

The plugin hooks `tools/pre-execute`, `tools/post-execute`, `ctx.tools.guard`, and `agent/pre-step`
at the profile root, so it needs only the global `tools` service. It reads the acting agent from
`exec.agent` / `event.agent`, and takes the current turn from the `agent/pre-step` payload
(`event.turn`), falling back to `agent.currentTurn` on 0.1.x. A new turn starts a fresh budget.

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

Override through the profile `cordis.patch.yml`:

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

1. `tools/pre-execute` — denies blacklisted tools, exhausted per-turn budgets, repeated signatures, and failure loops.
2. `tools/post-execute` — counts completed calls and tracks consecutive failures.
3. `ctx.tools.guard` — a monotonic, synchronous guard that makes earlier denials final.
4. `agent/pre-step` — records the current turn for every agent and rejects the turn once its model-step budget is spent.

Per-agent, per-turn ledgers are keyed by agent id and turn number.

## License

MIT
