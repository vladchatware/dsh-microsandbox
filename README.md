# dsh-microsandbox

Microsandbox execution plugins for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness):
run untrusted code in **local, hardware-isolated microVMs** with a persistent
workspace volume — **alongside** the host tools, which stay untouched.

| Package | Role |
|---|---|
| `@deepseek-ai/dsh-microsandbox` | Owns one microVM per harness process (lazy boot); persistent `/workspace` volume |
| `@deepseek-ai/dsh-fs-microsandbox` | `ctx.fs` provider over the VM filesystem (execution-world adapter) |
| `@deepseek-ai/dsh-subprocess-microsandbox` | `ctx.subprocess` provider over the VM (execution-world adapter) |
| `@deepseek-ai/dsh-tool-microsandbox` | `vm_bash` model-facing tool: run commands in the VM |

## Requirements

- DeepSeek Harness `0.1.0-rc.5` (web profile)
- [microsandbox](https://microsandbox.dev) runtime installed locally (`curl -fsSL https://install.microsandbox.dev | sh`)
- macOS Apple Silicon / Linux with KVM / Windows with WHP

## Install

```sh
dsh plugin --profile web add github:vladchatware/dsh-microsandbox
```

Then restart the web instance and open a new session. The agent's tool catalog
gains `vm_bash` next to the normal `bash` tool.

## Usage

Ask the agent (or call the tool) with e.g.:

`vm_bash` — `hostname && uname -s && pwd`

Output shows the **microVM** hostname (`dsh-msb-…`), `Linux`, and `/workspace`
— the persistent per-machine workspace volume (`dsh-web-workspace`), which
survives sandbox restarts.

The normal `bash` tool keeps running on the host — use `vm_bash` for
untrusted code, experiments, or anything that must not touch the host.

## Notes

- This is a DSH **bundle**: one `dsh plugin add` installs everything and
  `cordis.patch.yml` mounts the owner + `vm_bash` alongside the host world.
- The bundle ships self-contained esbuild entries (`dist/`) whose only external
  imports are npm packages (`microsandbox`, `@deepseek-ai/cordis`, `dsh-tools`,…).
- `fs-microsandbox` and `subprocess-microsandbox` are the execution-world
  adapters (swap-in for host `subprocess-local`/`fs-sandbox`); the alongside
  composition mounts only the owner + tool so nothing on the host is disabled.
- Dependencies (`microsandbox` SDK, `@deepseek-ai/cordis`, `dsh-tools`,
  `dsh-fs`, `dsh-subprocess`) resolve from npm at install time.
- Source of the plugins: [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)
  `packages/microsandbox/`.
