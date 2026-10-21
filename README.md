# dsh-tool-governor

A DeepSeek Harness plugin that stops runaway tool calls before they burn through your token budget.

## What it does

- **Repeat-call breaker** — denies the same tool + argument combination after N repeats
- **Failure-loop cutoff** — pauses a tool after consecutive failures
- **Optional per-turn caps** — `maxToolCallsPerTurn` / `maxStepsPerTurn`, both `0` (unlimited) by default
- **Monotonic guard** — denies are final; downstream layers cannot re-allow a blocked call

## Install

```bash
dsh plugin --profile web add dsh-tool-governor
```

Restart DSH after installing. Verify the bundle is registered:

```bash
dsh --profile web --dump-config | findstr dsh-tool-governor
```

Pin a version, or install directly from source:

```bash
dsh plugin --profile web add dsh-tool-governor@1.1.0
dsh plugin --profile web add github:George-Java/dsh-tool-governor
```

## Compatibility

| Item | Value |
| --- | --- |
| DSH | `0.2.x` (tested on `0.2.1-rc.2`) |
| Platform | Windows / macOS / Linux |
| Node.js | `^22.19.0 \|\| >=24.0.0` |

The plugin hooks `tools/pre-execute`, `tools/post-execute`, `ctx.tools.guard`, and `agent/pre-step`
at the profile root, so it needs only the global `tools` service. It reads the acting agent from
`exec.agent` / `event.agent`.

## How it decides

- A new user message resets that agent ledger, so repeat and failure counts start fresh every turn.
- Only the structured `result.isError === true` counts as a tool failure. A successful call whose
  output happens to mention an error is not treated as a failure.
- `maxToolCallsPerTurn` and `maxStepsPerTurn` are `0` by default: normal long tasks are never cut off.
  Set a positive value only if you want an explicit fuse.

## Configuration

All fields are optional — defaults are applied when omitted.

| Field | Default | Description |
| :-- | :-- | :-- |
| `maxToolCallsPerTurn` | `0` | Max tool calls per turn; `0` disables the cap |
| `maxStepsPerTurn` | `0` | Max model steps per turn; `0` disables the cap |
| `repeatThreshold` | `3` | Deny the (N+1)-th identical tool + argument call |
| `consecutiveFailureThreshold` | `3` | Pause a tool after N consecutive structured failures |
| `denyTools` | `[]` | Glob patterns of tools to always deny (e.g. `["browser_*"]`) |
| `denyMessage` | built-in | Message injected when a call is denied |

Override through the profile `cordis.patch.yml`:

```yaml
- id: dsh-tool-governor
  name: dsh-tool-governor
  config:
    repeatThreshold: 5
    # opt-in hard caps:
    # maxToolCallsPerTurn: 100
    # maxStepsPerTurn: 50
```

## Uninstall

```bash
dsh plugin --profile web remove dsh-tool-governor
```

## License

MIT
