# @deepseek-ai/dsh-subprocess-microsandbox

Microsandbox implementation of the [subprocess seam](packages/subprocess/subprocess)
(`ctx.subprocess`). Load `@deepseek-ai/dsh-microsandbox` first, then this service
in place of `dsh-subprocess-local`; existing Bash, PTY, and LSP consumers then
execute in the shared microVM.

Substrate facts (probed on msb 0.6.10): each exec is its own process-group
leader (started pid == pgid), so tree-scoped termination is one in-guest group
kill; `tty(true)` execs give programmatic PTY text I/O plus resize.

Known substrate limits:

- **No signal fact** — the SDK reports `code: -1` for a signalled process;
  the provider attributes SIGTERM/SIGKILL when it performed the kill itself.
- **Foreground-group inspection is best-effort** — without `ps` in minimal
  images the terminal reports its session leader as the foreground group.
- **Minimal OCI images must contain `bash` and the `kill` builtin** (debian does).
