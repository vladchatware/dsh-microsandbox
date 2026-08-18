# @deepseek-ai/dsh-fs-microsandbox

Microsandbox implementation of the [filesystem seam](packages/fs/fs) (`ctx.fs`).
Paths, contents, and atomic staging files stay inside the shared microVM owned
by `@deepseek-ai/dsh-microsandbox`. Load the owner first, then this service in
place of `dsh-fs-local`; `dsh-tool-fs` and the policy layer then operate on the
remote execution world unchanged.

Implementation notes and known limits:

- **Version tokens** are derived from guest stat facts (path, kind, size, mode,
  mtime). The SDK exposes no per-file revision, so two writes within the mtime
  tick with identical facts collide; the stale guard degrades to a no-op
  instead of failing safe.
- **`lstat`** runs an in-guest `stat` helper (`LC_ALL=C` so `%F` is
  locale-independent) because the SDK exposes no no-follow primitive.
- **Atomic writes** stage into a private `0700` sibling directory and commit
  with an in-guest `rename` (or a `ln -T` no-clobber publication for
  `createIfAbsent`), mirroring the E2B adapter.
- Minimal OCI images must contain `realpath`, `base64`, `stat`, `ln`, and
  `chmod` (debian does).
