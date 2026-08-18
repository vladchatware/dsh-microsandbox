# @deepseek-ai/dsh-tool-microsandbox

Model-facing `vm_bash` tool: run untrusted code inside the isolated
microsandbox microVM owned by `@deepseek-ai/dsh-microsandbox`, **alongside** the
host execution world. Mount both this tool and the owner in a composition to
give the agent VM execution without replacing the host `bash`/`fs` tools.

```yaml
- id: microsandbox
  name: '@deepseek-ai/dsh-microsandbox'
  config:
    image: debian
    cwd: /workspace
    timeoutMs: 180000
    volume: dsh-web-workspace
    lazy: true

- id: tool-microsandbox
  name: '@deepseek-ai/dsh-tool-microsandbox'
```

`lazy: true` boots the VM only on the first `vm_bash` call, so a session that
never touches the VM costs nothing.

## Configuration

| Key | Default | Meaning |
|---|---|---|
| `maxOutputBytes` | `65536` | Per-stream output cap; overflow keeps the tail and sets `truncated` |
| `timeoutMsCap` | `60000` | Cap on the tool's `timeoutMs` parameter (silently clamped) |

## Tool surface

`vm_bash` — parameters: `command` (required), `description` (required),
`workdir` (default: the owner's `cwd`, i.e. `/workspace`), `timeoutMs`
(clamped). Returns `{ exitCode, stdout, stderr, truncated, timedOut }`.
Commands run as a process group in the VM; a timeout kills the whole group.
The VM's `/workspace` is backed by the owner's persistent named volume.
