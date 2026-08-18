# @deepseek-ai/dsh-microsandbox

Shared lifecycle owner for one local microsandbox microVM
([microsandbox.dev](https://microsandbox.dev)). The filesystem and subprocess
adapters inject `ctx.microsandbox`, await its single SDK handle, and therefore
inhabit the same Linux working tree and process world. The package pins
`microsandbox@0.6.10`.

## Configuration

```yaml
- id: microsandbox
  name: '@deepseek-ai/dsh-microsandbox'
  config:
    image: debian
    cwd: /workspace
    timeoutMs: 300000
    idleTimeoutSecs: 600
    cpus: 2
    memory: 1024
    volume: user-<id>
```

`volume` mounts a named volume at `cwd` — the persistent per-user storage that
survives sandbox replacement. `timeoutMs` is the hard sandbox lifetime;
expiry kills the sandbox. `idleTimeoutSecs` lets the local runtime suspend an
idle sandbox. Omitted resource knobs use the runtime defaults.

## Lifecycle and ownership

Construction builds one sandbox (eagerly, like the E2B owner) under the name
`dsh-msb-<prefix-or-uuid>` with `.replace()`, so a stale local sandbox from a
prior harness session is harmless. Before resolving `getSandbox()`, the
service creates `cwd` and the private `cwd/.dsh-msb` adapter-state directory,
verifies it is a real directory, and sets it to mode `0700`.

Disposal kills the sandbox (force, with the runtime default grace). A
`SandboxNotFoundError` means expiry or another owner already deleted it and is
accepted as quiescence.

## Model Experience

None — this shared runtime owner registers no model-visible context; provider
adapters and their consumers own any rendered effects.

## Known Limitations and Deferred Work

- **One microVM per harness session** — a real memory footprint on the host
  (see the design note for sizing); operators should bound concurrent
  sessions.
- **Sandbox state dies with the sandbox** — persistence comes from the named
  `volume`, not the root disk. Snapshots are a follow-up.
- **No network policy or secret wiring yet** — the sandbox gets the runtime's
  default egress; per-host/port allow rules and `secretEnv` are follow-ups.
- **Root execution by default** — dropping to a non-root `user` is a follow-up
  (the SDK supports `user` per exec and per builder).
