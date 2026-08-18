/**
 * Microsandbox provider for the filesystem capability seam. Paths, contents,
 * and atomic staging files remain inside the shared microVM.
 * @module @deepseek-ai/dsh-fs-microsandbox
 */

import { createHash, randomUUID } from 'node:crypto'
import { Buffer } from 'node:buffer'
import { posix } from 'node:path'
import { FileSystem, FsError, FsTargetKey, FsVersion } from '@deepseek-ai/dsh-fs'
import type {
  FsDirEntry,
  FsEditOutcome,
  FsEditRequest,
  FsInfo,
  FsPathInfo,
  FsTarget,
  FsWriteIntent,
  FsWriteOutcome,
} from '@deepseek-ai/dsh-fs'
import { quoteShellArg, MicrosandboxError, Sandbox } from '@deepseek-ai/dsh-microsandbox'
import type { FsEntry, FsMetadata, FsReadStream } from '@deepseek-ai/dsh-microsandbox'

const BINARY_SAMPLE_BYTES = 8192
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/

function assertNotAborted(signal: AbortSignal | undefined, operation: string): void {
  if (signal?.aborted === true) throw new FsError(`${operation} aborted`, 'FS_ABORTED')
}

function normalizeLineEndings(value: string): string {
  return value.replaceAll('\r\n', '\n')
}

function detectsCrlf(value: string): boolean {
  const sample = value.slice(0, 4096)
  const crlf = sample.split('\r\n').length - 1
  const lf = sample.split('\n').length - 1 - crlf
  return crlf > lf
}

function restoreLineEndings(value: string, crlf: boolean): string {
  return crlf ? normalizeLineEndings(value).replaceAll('\n', '\r\n') : value
}

function decodeText(bytes: Uint8Array, displayPath: string, binarySampleBytes: number): string {
  if (bytes.subarray(0, binarySampleBytes).includes(0)) {
    throw new FsError(`cannot read "${displayPath}": binary file`, 'FS_NOT_TEXT')
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch (error: unknown) {
    throw new FsError(`cannot read "${displayPath}": invalid UTF-8 text`, 'FS_NOT_TEXT', { cause: error })
  }
}

function decodeCanonicalPath(encoded: string): string {
  if (encoded.length === 0 || !BASE64.test(encoded)) {
    throw new Error('fs-microsandbox: canonical path transport returned invalid base64')
  }
  const framed = Buffer.from(encoded, 'base64')
  if (framed.toString('base64') !== encoded
    || framed.length < 2
    || framed.at(-1) !== 0
    || framed.subarray(0, -1).includes(0)) {
    throw new Error('fs-microsandbox: canonical path transport returned invalid NUL framing')
  }
  let path: string
  try {
    path = new TextDecoder('utf-8', { fatal: true }).decode(framed.subarray(0, -1))
  } catch (error: unknown) {
    throw new Error('fs-microsandbox: canonical path is not valid UTF-8', { cause: error })
  }
  if (!posix.isAbsolute(path)) throw new Error('fs-microsandbox: canonical path is not absolute')
  return path
}

function isNotFound(error: unknown): boolean {
  if (!(error instanceof MicrosandboxError)) return false
  return /no such file|not found|enoent|does not exist/i.test(error.message)
}

function isPermission(error: unknown): boolean {
  if (!(error instanceof MicrosandboxError)) return false
  return /permission denied|operation not permitted/i.test(error.message)
}

function mapError(error: unknown, operation: string, displayPath: string, signal?: AbortSignal): FsError {
  if (error instanceof FsError) return error
  if (signal?.aborted === true || (error instanceof DOMException && error.name === 'AbortError')) {
    return new FsError(`${operation} aborted`, 'FS_ABORTED', { cause: error })
  }
  if (isNotFound(error)) {
    return new FsError(`cannot ${operation} "${displayPath}": not found`, 'FS_NOT_FOUND', { cause: error })
  }
  if (isPermission(error)) {
    return new FsError(`cannot ${operation} "${displayPath}": permission denied`, 'FS_PERMISSION_DENIED', { cause: error })
  }
  return new FsError(`cannot ${operation} "${displayPath}": ${String(error)}`, 'FS_IO_ERROR', { cause: error })
}

function entryType(entry: { kind: string }): FsInfo['type'] {
  switch (entry.kind) {
    case 'file':
      return 'file'
    case 'directory':
      return 'directory'
    default:
      return 'other'
  }
}

function entryVersion(path: string, entry: FsMetadata | FsEntry): ReturnType<typeof FsVersion> {
  const facts = JSON.stringify([
    path,
    entry.kind,
    entry.size,
    entry.mode,
    entry.modified?.toISOString(),
  ])
  return FsVersion(`msb:${createHash('sha256').update(facts).digest('hex')}`)
}

function literalEdit(content: string, request: FsEditRequest, displayPath: string): string {
  const oldString = normalizeLineEndings(request.oldString)
  const newString = normalizeLineEndings(request.newString)
  if (oldString.length === 0) {
    throw new FsError(`cannot edit "${displayPath}": old_string must be non-empty`, 'FS_EDIT_NOT_FOUND')
  }
  let matches = 0
  let offset = 0
  while (true) {
    const found = content.indexOf(oldString, offset)
    if (found < 0) break
    matches += 1
    offset = found + oldString.length
  }
  if (matches === 0) throw new FsError(`cannot edit "${displayPath}": old_string was not found`, 'FS_EDIT_NOT_FOUND')
  if (!request.replaceAll && matches !== 1) {
    throw new FsError(`cannot edit "${displayPath}": old_string matched ${matches} times`, 'FS_AMBIGUOUS_EDIT')
  }
  return request.replaceAll ? content.split(oldString).join(newString) : content.replace(oldString, newString)
}

/** Remote filesystem backend sharing the microVM owned by `ctx.microsandbox`. */
export class MicrosandboxFileSystem extends FileSystem {
  static inject = ['microsandbox']

  private readonly locks = new Map<string, Promise<unknown>>()

  override async resolve(path: string, opts?: { cwd?: string; signal?: AbortSignal }): Promise<FsTarget> {
    assertNotAborted(opts?.signal, 'resolve')
    if (path.trim().length === 0) throw new FsError('file_path must be a non-empty string', 'FS_NOT_FOUND')
    const displayPath = posix.resolve(opts?.cwd ?? this.ctx.microsandbox.cwd, path)
    try {
      const sandbox = await this.ctx.microsandbox.getSandbox()
      const targetKey = await this.canonicalPath(sandbox, displayPath, opts?.signal)
      assertNotAborted(opts?.signal, 'resolve')
      return { targetKey: FsTargetKey(targetKey), displayPath }
    } catch (error: unknown) {
      throw mapError(error, 'resolve', displayPath, opts?.signal)
    }
  }

  override processPath(target: FsTarget): string {
    return String(target.targetKey)
  }

  override fileUrl(target: FsTarget): string {
    const path = this.processPath(target)
    if (!posix.isAbsolute(path)) throw new Error(`fs-microsandbox: expected an absolute process path: ${JSON.stringify(path)}`)
    return `file://${path.split('/').map(segment => encodeURIComponent(segment)).join('/')}`
  }

  override contains(parent: FsTarget, child: FsTarget): boolean {
    const relative = posix.relative(this.processPath(parent), this.processPath(child))
    return relative === '' || (relative !== '..' && !relative.startsWith('../') && !posix.isAbsolute(relative))
  }

  override async stat(target: FsTarget, signal?: AbortSignal): Promise<FsInfo | undefined> {
    assertNotAborted(signal, 'stat')
    const entry = await this.probe(String(target.targetKey), target.displayPath, signal)
    if (entry === undefined) return undefined
    return {
      version: entryVersion(String(target.targetKey), entry),
      type: entryType(entry),
      ...(entry.kind === 'file' ? { size: entry.size } : {}),
    }
  }

  override async lstat(path: string, opts?: { cwd?: string }, signal?: AbortSignal): Promise<FsPathInfo | undefined> {
    assertNotAborted(signal, 'lstat')
    if (path.trim().length === 0) throw new FsError('file_path must be a non-empty string', 'FS_NOT_FOUND')
    const displayPath = posix.resolve(opts?.cwd ?? this.ctx.microsandbox.cwd, path)
    try {
      const sandbox = await this.ctx.microsandbox.getSandbox()
      const result = await sandbox.exec('bash', ['-c',
        `LC_ALL=C stat -c '%F|%s|%Y' -- ${quoteShellArg(displayPath)} 2>/dev/null || echo MISSING`,
      ])
      assertNotAborted(signal, 'lstat')
      const line = result.stdout().trim()
      if (line === 'MISSING') return undefined
      const [kind, sizeText, mtimeText] = line.split('|')
      const type = kind === 'symbolic link'
        ? 'symlink' as const
        : kind === 'regular file' || kind === 'regular empty file'
          ? 'file' as const
          : kind === 'directory'
            ? 'directory' as const
            : 'other' as const
      const facts = JSON.stringify([displayPath, kind, sizeText, mtimeText])
      return {
        version: FsVersion(`msb:${createHash('sha256').update(facts).digest('hex')}`),
        type,
        ...(type === 'file' ? { size: Number(sizeText) } : {}),
      }
    } catch (error: unknown) {
      throw mapError(error, 'lstat', displayPath, signal)
    }
  }

  override async readText(target: FsTarget, signal?: AbortSignal): Promise<string> {
    await this.requireRegular(target, signal)
    try {
      const sandbox = await this.ctx.microsandbox.getSandbox()
      const bytes = await sandbox.fs().read(String(target.targetKey))
      assertNotAborted(signal, 'read')
      return decodeText(bytes, target.displayPath, BINARY_SAMPLE_BYTES)
    } catch (error: unknown) {
      throw mapError(error, 'read', target.displayPath, signal)
    }
  }

  override async readBytes(target: FsTarget, signal: AbortSignal | undefined, maxBytes: number): Promise<Uint8Array> {
    const info = await this.requireRegular(target, signal)
    if (info.size !== undefined && info.size > maxBytes) {
      throw new FsError(`cannot read "${target.displayPath}": ${info.size} bytes exceeds the ${maxBytes}-byte limit`, 'FS_TOO_LARGE')
    }
    try {
      const sandbox = await this.ctx.microsandbox.getSandbox()
      const stream = await sandbox.fs().readStream(String(target.targetKey))
      const chunks: Uint8Array[] = []
      let bytes = 0
      let completed = false
      try {
        while (true) {
          assertNotAborted(signal, 'read')
          const next = await stream.recv()
          if (next === null) break
          bytes += next.byteLength
          if (bytes > maxBytes) {
            throw new FsError(`cannot read "${target.displayPath}": content exceeds the ${maxBytes}-byte limit`, 'FS_TOO_LARGE')
          }
          chunks.push(next)
        }
        completed = true
      } finally {
        if (!completed) {
          try {
            await stream[Symbol.asyncDispose]()
          } catch (_streamCancellationFailure) {
            // The read already failed; abandoning the remote stream adds nothing.
          }
        }
      }
      const whole = new Uint8Array(bytes)
      let offset = 0
      for (const chunk of chunks) {
        whole.set(chunk, offset)
        offset += chunk.byteLength
      }
      return whole
    } catch (error: unknown) {
      throw mapError(error, 'read', target.displayPath, signal)
    }
  }

  override async streamText(target: FsTarget, signal?: AbortSignal): Promise<AsyncIterable<string>> {
    await this.requireRegular(target, signal)
    const displayPath = target.displayPath
    const targetKey = String(target.targetKey)
    const owner = this.ctx.microsandbox
    return {
      async *[Symbol.asyncIterator](): AsyncGenerator<string> {
        let stream: FsReadStream
        try {
          const sandbox = await owner.getSandbox()
          stream = await sandbox.fs().readStream(targetKey)
        } catch (error: unknown) {
          throw mapError(error, 'read', displayPath, signal)
        }
        const decoder = new TextDecoder('utf-8', { fatal: true })
        let sampledBytes = 0
        let completed = false
        try {
          while (true) {
            assertNotAborted(signal, 'read')
            const next = await stream.recv()
            if (next === null) break
            if (sampledBytes < BINARY_SAMPLE_BYTES) {
              const sample = next.subarray(0, BINARY_SAMPLE_BYTES - sampledBytes)
              if (sample.includes(0)) throw new FsError(`cannot read "${displayPath}": binary file`, 'FS_NOT_TEXT')
              sampledBytes += sample.length
            }
            let text: string
            try {
              text = decoder.decode(next, { stream: true })
            } catch (error: unknown) {
              throw new FsError(`cannot read "${displayPath}": invalid UTF-8 text`, 'FS_NOT_TEXT', { cause: error })
            }
            if (text.length > 0) yield text
          }
          try {
            decoder.decode()
          } catch (error: unknown) {
            throw new FsError(`cannot read "${displayPath}": invalid UTF-8 text`, 'FS_NOT_TEXT', { cause: error })
          }
          completed = true
        } catch (error: unknown) {
          throw mapError(error, 'read', displayPath, signal)
        } finally {
          if (!completed) {
            try {
              await stream[Symbol.asyncDispose]()
            } catch (_streamCancellationFailure) {
              // The primary read outcome owns the result; cancellation is best-effort.
            }
          }
        }
      },
    }
  }

  override async listDir(target: FsTarget, signal?: AbortSignal): Promise<FsDirEntry[]> {
    const info = await this.stat(target, signal)
    if (info === undefined) throw new FsError(`cannot list "${target.displayPath}": not found`, 'FS_NOT_FOUND')
    if (info.type !== 'directory') throw new FsError(`cannot list "${target.displayPath}": not a directory`, 'FS_NOT_DIRECTORY')
    try {
      const sandbox = await this.ctx.microsandbox.getSandbox()
      const listed = await sandbox.fs().list(String(target.targetKey))
      const entries: FsDirEntry[] = []
      for (const entry of listed) {
        const name = posix.basename(entry.path)
        const displayPath = posix.join(target.displayPath, name)
        const canonical = entry.kind === 'symlink'
          ? await this.canonicalPath(sandbox, entry.path, signal)
          : entry.path
        const resolved = entry.kind === 'symlink'
          ? await this.probe(canonical, displayPath, signal)
          : undefined
        entries.push({
          name,
          type: resolved === undefined ? (entry.kind === 'file' ? 'file' : entry.kind === 'directory' ? 'directory' : 'other') : entryType(resolved),
          target: { targetKey: FsTargetKey(canonical), displayPath },
          ...(resolved !== undefined ? { version: entryVersion(canonical, resolved) } : {}),
          ...(resolved?.kind === 'file' ? { size: resolved.size } : {}),
        })
      }
      return entries.sort((left, right) => left.name.localeCompare(right.name))
    } catch (error: unknown) {
      throw mapError(error, 'list', target.displayPath, signal)
    }
  }

  override async writeText(
    target: FsTarget,
    content: string,
    expected?: FsWriteIntent,
    signal?: AbortSignal,
  ): Promise<FsWriteOutcome> {
    return this.withLock(String(target.targetKey), async () => {
      const existing = await this.probe(String(target.targetKey), target.displayPath, signal)
      if (existing !== undefined && entryType(existing) !== 'file') {
        throw new FsError(`cannot write "${target.displayPath}": not a regular file`, 'FS_NOT_REGULAR_FILE')
      }
      this.checkWriteIntent(existing, expected, target)
      const before = existing === undefined ? null : await this.readForDiff(target, signal)
      const version = await this.writeAtomic(
        target,
        content,
        existing,
        expected?.kind === 'createIfAbsent',
        signal,
      )
      return {
        operation: existing === undefined ? 'create' : 'update',
        version,
        before,
        after: normalizeLineEndings(content),
      }
    })
  }

  override async editText(
    target: FsTarget,
    edit: FsEditRequest,
    expected?: { version: ReturnType<typeof FsVersion> },
    signal?: AbortSignal,
  ): Promise<FsEditOutcome> {
    return this.withLock(String(target.targetKey), async () => {
      const existing = await this.probe(String(target.targetKey), target.displayPath, signal)
      if (existing === undefined) {
        throw new FsError(`cannot edit "${target.displayPath}": file changed since it was read`, 'FS_STALE_VERSION')
      }
      if (entryType(existing) !== 'file') {
        throw new FsError(`cannot edit "${target.displayPath}": not a regular file`, 'FS_NOT_REGULAR_FILE')
      }
      if (expected !== undefined && entryVersion(String(target.targetKey), existing) !== expected.version) {
        throw new FsError(`cannot edit "${target.displayPath}": file changed since it was read`, 'FS_STALE_VERSION')
      }
      const raw = await this.readForEdit(target, signal)
      const before = normalizeLineEndings(raw)
      const after = literalEdit(before, edit, target.displayPath)
      const storage = restoreLineEndings(after, detectsCrlf(raw))
      const version = await this.writeAtomic(target, storage, existing, false, signal)
      return { version, before, after }
    })
  }

  private async withLock<T>(targetKey: string, operation: () => Promise<T>): Promise<T> {
    const prior = this.locks.get(targetKey) ?? Promise.resolve()
    const run = prior.then(operation, operation)
    const tail = run.then(() => undefined, () => undefined)
    this.locks.set(targetKey, tail)
    try {
      return await run
    } finally {
      if (this.locks.get(targetKey) === tail) this.locks.delete(targetKey)
    }
  }

  private async canonicalPath(sandbox: Sandbox, path: string, signal?: AbortSignal): Promise<string> {
    assertNotAborted(signal, 'resolve')
    try {
      const result = await sandbox.exec('bash', ['-c',
        `set -o pipefail; realpath -mz -- ${quoteShellArg(path)} | base64 -w0`,
      ])
      return decodeCanonicalPath(result.stdout())
    } catch (error: unknown) {
      throw mapError(error, 'resolve', path, signal)
    }
  }

  private async probe(path: string, displayPath: string, signal?: AbortSignal): Promise<FsMetadata | undefined> {
    assertNotAborted(signal, 'stat')
    try {
      const sandbox = await this.ctx.microsandbox.getSandbox()
      if (!(await sandbox.fs().exists(path))) return undefined
      assertNotAborted(signal, 'stat')
      const entry = await sandbox.fs().stat(path)
      assertNotAborted(signal, 'stat')
      return entry
    } catch (error: unknown) {
      if (isNotFound(error)) return undefined
      throw mapError(error, 'stat', displayPath, signal)
    }
  }

  private async requireRegular(target: FsTarget, signal?: AbortSignal): Promise<FsInfo> {
    const info = await this.stat(target, signal)
    if (info === undefined) throw new FsError(`cannot read "${target.displayPath}": not found`, 'FS_NOT_FOUND')
    if (info.type !== 'file') throw new FsError(`cannot read "${target.displayPath}": not a regular file`, 'FS_NOT_REGULAR_FILE')
    return info
  }

  private checkWriteIntent(existing: FsMetadata | undefined, expected: FsWriteIntent | undefined, target: FsTarget): void {
    if (expected?.kind === 'createIfAbsent' && existing !== undefined) {
      throw new FsError(`cannot overwrite existing "${target.displayPath}" without reading it first`, 'FS_NOT_OBSERVED')
    }
    if (expected?.kind === 'replaceIfVersion') {
      if (existing === undefined || entryVersion(String(target.targetKey), existing) !== expected.version) {
        throw new FsError(`cannot write "${target.displayPath}": file changed since it was read`, 'FS_STALE_VERSION')
      }
    }
  }

  private async readForDiff(target: FsTarget, signal?: AbortSignal): Promise<string | null> {
    try {
      const sandbox = await this.ctx.microsandbox.getSandbox()
      const bytes = await sandbox.fs().read(String(target.targetKey))
      assertNotAborted(signal, 'read')
      return normalizeLineEndings(decodeText(bytes, target.displayPath, bytes.length))
    } catch (error: unknown) {
      if (error instanceof FsError && error.code === 'FS_NOT_TEXT') return null
      throw mapError(error, 'read', target.displayPath, signal)
    }
  }

  private async readForEdit(target: FsTarget, signal?: AbortSignal): Promise<string> {
    try {
      const sandbox = await this.ctx.microsandbox.getSandbox()
      const bytes = await sandbox.fs().read(String(target.targetKey))
      assertNotAborted(signal, 'edit')
      return decodeText(bytes, target.displayPath, bytes.length)
    } catch (error: unknown) {
      throw mapError(error, 'edit', target.displayPath, signal)
    }
  }

  private async writeAtomic(
    target: FsTarget,
    content: string,
    existing: FsMetadata | undefined,
    createIfAbsent: boolean,
    signal?: AbortSignal,
  ): Promise<ReturnType<typeof FsVersion>> {
    assertNotAborted(signal, 'write')
    const sandbox = await this.ctx.microsandbox.getSandbox()
    const targetPath = String(target.targetKey)
    const stagingDirectory = posix.join(posix.dirname(targetPath), `.dsh-${randomUUID()}.tmp`)
    const temporary = posix.join(stagingDirectory, 'content')
    let stagingDirectoryCreated = false
    try {
      await sandbox.fs().mkdir(stagingDirectory)
      stagingDirectoryCreated = true
      await sandbox.exec('bash', ['-c', `chmod 700 -- ${quoteShellArg(stagingDirectory)}`])
      assertNotAborted(signal, 'write')
      await sandbox.fs().write(temporary, content)
      assertNotAborted(signal, 'write')
      const mode = existing === undefined ? 0o600 : existing.mode & 0o777
      await sandbox.exec('bash', ['-c', `chmod ${mode.toString(8)} -- ${quoteShellArg(temporary)}`])
      assertNotAborted(signal, 'write')
      if (createIfAbsent) {
        const targetArg = quoteShellArg(targetPath)
        const publication = await sandbox.exec('bash', ['-c',
          `if ln -T -- ${quoteShellArg(temporary)} ${targetArg}; then printf created; elif test -e ${targetArg} || test -L ${targetArg}; then printf exists; else exit 1; fi`,
        ])
        if (publication.stdout() === 'exists') {
          throw new FsError(
            `cannot overwrite existing "${target.displayPath}" without reading it first`,
            'FS_NOT_OBSERVED',
          )
        }
        if (publication.stdout() !== 'created') {
          throw new Error('guarded create returned an invalid publication result')
        }
      } else {
        await sandbox.fs().rename(temporary, targetPath)
      }
      try {
        await sandbox.fs().removeDir(stagingDirectory)
      } catch (_committedStagingCleanupFailure) {
        // The target is already committed; an empty private directory cannot turn that write into a failure.
      }
      const committed = await this.probe(targetPath, target.displayPath, signal)
      if (committed === undefined) {
        throw new Error(`write committed but target vanished: ${targetPath}`)
      }
      return entryVersion(targetPath, committed)
    } catch (error: unknown) {
      if (stagingDirectoryCreated) {
        try {
          await sandbox.fs().removeDir(stagingDirectory)
        } catch (_stagingDirectoryAlreadyAbsentOrCleanupFailed) {
          // Only the private staging directory is swallowed; the original failure owns the operation.
        }
      }
      throw mapError(error, 'write', target.displayPath, signal)
    }
  }
}

export default MicrosandboxFileSystem
