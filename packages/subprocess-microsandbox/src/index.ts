/**
 * Microsandbox provider for the subprocess capability seam: managed process
 * trees and terminal sessions inside the shared microVM. Each exec is its own
 * process-group leader under the microsandbox agentd (verified: started pid ==
 * pgid), so tree-scoped termination is one in-guest group kill.
 * @module @deepseek-ai/dsh-subprocess-microsandbox
 */

import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Readable, Writable } from 'node:stream'
import { Context } from '@deepseek-ai/cordis'
import { SubprocessRuntime, scrubbedParentEnv } from '@deepseek-ai/dsh-subprocess'
import type {
  SubprocessCollectedOutputs,
  SubprocessHandle,
  SubprocessOutcome,
  SubprocessOutputMode,
  SubprocessSpawnSpec,
  SubprocessTerminalForeground,
  SubprocessTerminalHandle,
  SubprocessTerminalSignal,
  SubprocessTerminalSpawnSpec,
} from '@deepseek-ai/dsh-subprocess'
import {
  ExecHandle,
  ExecOptionsBuilder,
  quoteShellArg,
  Sandbox,
} from '@deepseek-ai/dsh-microsandbox'
import type { ExecEvent } from '@deepseek-ai/dsh-microsandbox'
import { CollectReader } from './output.ts'

const MAX_TIMER_DELAY_MS = 2_147_483_647

function assertGraceMs(graceMs: number): void {
  if (!Number.isFinite(graceMs) || graceMs <= 0 || graceMs > MAX_TIMER_DELAY_MS) {
    throw new Error(`subprocess-microsandbox: graceMs must be a positive finite number <= ${MAX_TIMER_DELAY_MS}`)
  }
}

/** Merge the spec env over the shared scrub, honoring undefined tombstones. */
function mergedEnv(env: Readonly<Record<string, string | undefined>> | undefined): Record<string, string> {
  const base = scrubbedParentEnv()
  if (env === undefined) return base
  const result: Record<string, string> = {}
  for (const [key, value] of Object.entries(base)) {
    if (env[key] === undefined) result[key] = value
  }
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) result[key] = value
  }
  return result
}

function applyExecOptions(
  builder: InstanceType<typeof ExecOptionsBuilder>,
  spec: { argv: readonly string[]; cwd: string; env?: Readonly<Record<string, string | undefined>> | undefined },
  stdin: 'ignore' | 'pipe' | { data: string },
): InstanceType<typeof ExecOptionsBuilder> {
  builder.args(spec.argv.slice(1)).cwd(spec.cwd)
  const env = mergedEnv(spec.env)
  for (const [key, value] of Object.entries(env)) builder.env(key, value)
  if (stdin === 'pipe') builder.stdinPipe()
  else if (stdin !== 'ignore') builder.stdinBytes(Buffer.from(stdin.data, 'utf8'))
  return builder
}

/**
 * The SDK's recv() type is ExecEvent | null, but the native layer can yield
 * undefined when a stream ends without an 'exited' event; normalize to null so
 * loops only handle the documented end-of-stream value.
 */
async function recvEvent(execHandle: ExecHandle): Promise<ExecEvent | null> {
  const event: ExecEvent | null | undefined = await execHandle.recv()
  return event ?? null
}

function guestCommand(sandbox: Sandbox, command: string): Promise<string> {
  return sandbox.exec('bash', ['-c', command]).then(result => result.stdout())
}

async function guestKillGroup(sandbox: Sandbox, pgid: number, signal: 'TERM' | 'KILL'): Promise<void> {
  await sandbox.exec('bash', ['-c', `kill -${signal} -- -${pgid} 2>/dev/null; true`])
}

/** One managed process tree in the microVM. */
class MicrosandboxProcessHandle implements SubprocessHandle {
  readonly stdin: Writable | undefined
  readonly stdout: Readable | undefined
  readonly stderr: Readable | undefined
  readonly collected: SubprocessCollectedOutputs
  readonly done: Promise<SubprocessOutcome>

  private pidValue = -1
  private pgid = -1
  private terminated = false
  private killedWith: 'SIGTERM' | 'SIGKILL' | null = null
  private readonly stdoutCollector: CollectReader | undefined
  private readonly stderrCollector: CollectReader | undefined
  private readonly stdoutPipe: Readable | undefined
  private readonly stderrPipe: Readable | undefined
  private readonly stdinBuffer: Buffer[] = []
  private stdinSink: Awaited<ReturnType<ExecHandle['takeStdin']>> | undefined
  private stdinClosed = false
  private readonly abortListener: (() => void) | undefined

  constructor(
    private readonly runtime: MicrosandboxSubprocessRuntime,
    private readonly spec: SubprocessSpawnSpec,
  ) {
    assertGraceMs(spec.graceMs)
    const stdout = this.makeReader(this.spec.stdio.stdout, true)
    const stderr = this.makeReader(this.spec.stdio.stderr, false)
    this.stdout = stdout.stream
    this.stderr = stderr.stream
    this.stdoutCollector = stdout.collector
    this.stderrCollector = stderr.collector
    this.stdoutPipe = stdout.stream
    this.stderrPipe = stderr.stream
    this.collected = {
      ...(this.stdoutCollector !== undefined ? { stdout: this.stdoutCollector } : {}),
      ...(this.stderrCollector !== undefined ? { stderr: this.stderrCollector } : {}),
    }
    this.stdin = spec.stdio.stdin === 'pipe'
      ? new Writable({
        write: (chunk, _encoding, callback) => {
          this.stdinBuffer.push(Buffer.from(chunk as string | Uint8Array))
          void this.drainStdin()
          callback()
        },
        final: (callback) => {
          this.stdinClosed = true
          void this.drainStdin()
          callback()
        },
      })
      : undefined
    this.done = this.start()
    if (spec.signal !== undefined) {
      this.abortListener = () => { this.terminate() }
      if (spec.signal.aborted) this.terminate()
      else spec.signal.addEventListener('abort', this.abortListener, { once: true })
    }
  }

  get pid(): number {
    return this.pidValue
  }

  terminate(): void {
    if (this.terminated || this.pgid < 0) return
    this.terminated = true
    void this.escalate()
  }

  waitForExit(signal?: AbortSignal): Promise<boolean> {
    if (signal !== undefined && signal.aborted) return Promise.resolve(false)
    return new Promise((resolve) => {
      let settled = false
      const listener = () => { finish(false) }
      const finish = (value: boolean) => {
        if (settled) return
        settled = true
        signal?.removeEventListener('abort', listener)
        resolve(value)
      }
      signal?.addEventListener('abort', listener, { once: true })
      void this.done.then(() => { finish(true) }, () => { finish(true) })
    })
  }

  private makeReader(mode: SubprocessOutputMode, _isStdout: boolean): {
    stream: Readable | undefined
    collector: CollectReader | undefined
  } {
    if (mode === 'pipe') {
      const stream = new Readable({ read() {} })
      return { stream, collector: undefined }
    }
    if (mode === 'inherit') {
      return { stream: undefined, collector: undefined }
    }
    const collect = mode
    const spillPath = collect.spill !== undefined
      ? join(tmpdir(), `dsh-msb-${randomUUID()}.spill`)
      : undefined
    return {
      stream: undefined,
      collector: new CollectReader(collect.maxBytes, collect.spill?.maxBytes, spillPath),
    }
  }

  private async start(): Promise<SubprocessOutcome> {
    try {
      const sandbox = await this.runtime.owner.getSandbox()
      const execHandle = await sandbox.execStreamWith(
        this.spec.argv[0] as string,
        builder => applyExecOptions(builder, this.spec, this.spec.stdio.stdin),
      )
      const sink = await execHandle.takeStdin()
      this.stdinSink = sink
      await this.drainStdin()
      const outcome = await this.runEvents(execHandle)
      this.finishReaders()
      return outcome
    } catch (error: unknown) {
      this.finishReaders()
      throw error
    }
  }

  private async runEvents(execHandle: ExecHandle): Promise<SubprocessOutcome> {
    let code = -1
    // recv() is the SDK's documented end-of-stream contract: null ends the
    // stream (the async iterator leaks nulls when a stream ends without an
    // 'exited' event, so it is not used here).
    for (;;) {
      const event = await recvEvent(execHandle)
      if (event === null) break
      if (event.kind === 'started') {
        this.pgid = event.pid
        this.pidValue = event.pid
      } else if (event.kind === 'stdout') {
        this.emitStdout(event.data)
      } else if (event.kind === 'stderr') {
        this.emitStderr(event.data)
      } else {
        code = event.code
        break
      }
    }
    return code >= 0 ? { exitCode: code, signal: null } : { exitCode: null, signal: this.killedWith }
  }

  private emitStdout(bytes: Uint8Array): void {
    if (this.stdoutPipe !== undefined) this.stdoutPipe.push(Buffer.from(bytes))
    else if (this.stdoutCollector !== undefined) this.stdoutCollector.push(bytes)
    else process.stdout.write(Buffer.from(bytes))
  }

  private emitStderr(bytes: Uint8Array): void {
    if (this.stderrPipe !== undefined) this.stderrPipe.push(Buffer.from(bytes))
    else if (this.stderrCollector !== undefined) this.stderrCollector.push(bytes)
    else process.stderr.write(Buffer.from(bytes))
  }

  private finishReaders(): void {
    this.stdoutPipe?.push(null)
    this.stderrPipe?.push(null)
    this.stdoutCollector?.finish()
    this.stderrCollector?.finish()
  }

  private async drainStdin(): Promise<void> {
    const sink = this.stdinSink
    if (sink === null || sink === undefined) return
    while (this.stdinBuffer.length > 0) {
      const chunk = this.stdinBuffer.shift() as Buffer
      await sink.write(chunk)
    }
    if (this.stdinClosed) await sink.close()
  }

  private async escalate(): Promise<void> {
    const pgid = this.pgid
    if (pgid <= 0) return
    try {
      const sandbox = await this.runtime.owner.getSandbox()
      this.killedWith = 'SIGTERM'
      await guestKillGroup(sandbox, pgid, 'TERM')
      await new Promise(resolve => setTimeout(resolve, this.spec.graceMs))
      this.killedWith = 'SIGKILL'
      await guestKillGroup(sandbox, pgid, 'KILL')
    } catch {
      // The sandbox may be gone; quiescence is proven by done settling.
    }
  }
}

/** One terminal session in the microVM. */
class MicrosandboxTerminalHandle implements SubprocessTerminalHandle {
  readonly output: Readable
  readonly done: Promise<SubprocessOutcome>

  private pidValue = -1
  private pgid = -1
  private terminated = false
  private killedWith: 'SIGTERM' | 'SIGKILL' | null = null
  private sink: Awaited<ReturnType<ExecHandle['takeStdin']>> | undefined

  constructor(
    private readonly runtime: MicrosandboxSubprocessRuntime,
    private readonly spec: SubprocessTerminalSpawnSpec,
    private readonly outputSink: Readable,
  ) {
    assertGraceMs(spec.graceMs)
    this.output = outputSink
    this.done = this.start()
  }

  get pid(): number {
    return this.pidValue
  }

  async write(data: string): Promise<void> {
    if (this.sink === null || this.sink === undefined) throw new Error('subprocess-microsandbox: terminal stdin is unavailable')
    await this.sink.write(data)
  }

  inspectForeground(): Promise<SubprocessTerminalForeground | undefined> {
    if (this.pgid <= 0) return Promise.resolve(undefined)
    // The SDK exposes no foreground-group inspection; report the terminal
    // session leader. Best-effort, documented substrate limit.
    return Promise.resolve({ processGroupId: this.pgid, inputWaiting: false })
  }

  async signalForeground(signal: SubprocessTerminalSignal): Promise<number> {
    const pgid = this.pgid
    if (pgid <= 0) throw new Error('subprocess-microsandbox: terminal has not started')
    const sandbox = await this.runtime.owner.getSandbox()
    if (signal === 'SIGTERM') this.killedWith = 'SIGTERM'
    else if (signal === 'SIGKILL') this.killedWith = 'SIGKILL'
    await guestKillGroup(sandbox, pgid, signal === 'SIGKILL' ? 'KILL' : 'TERM')
    return pgid
  }

  async terminate(): Promise<void> {
    if (this.terminated) return
    this.terminated = true
    const pgid = this.pgid
    if (pgid <= 0) return
    const sandbox = await this.runtime.owner.getSandbox()
    try {
      this.killedWith = 'SIGTERM'
      await guestKillGroup(sandbox, pgid, 'TERM')
      await new Promise(resolve => setTimeout(resolve, this.spec.graceMs))
      this.killedWith = 'SIGKILL'
      await guestKillGroup(sandbox, pgid, 'KILL')
    } catch {
      // Quiescence is proven by done settling.
    }
    try {
      await this.done
    } catch {
      // A transport failure still settles in-flight handle calls.
    }
  }

  private async start(): Promise<SubprocessOutcome> {
    try {
      const sandbox = await this.runtime.owner.getSandbox()
      const execHandle = await sandbox.execStreamWith(
        this.spec.argv[0] as string,
        builder => applyExecOptions(builder, this.spec, 'pipe').tty(true),
      )
      await execHandle.resize(this.spec.rows, this.spec.cols)
      this.sink = await execHandle.takeStdin()
      let code = -1
      for (;;) {
        const event = await recvEvent(execHandle)
        if (event === null) break
        if (event.kind === 'started') {
          this.pgid = event.pid
          this.pidValue = event.pid
        } else if (event.kind === 'stdout' || event.kind === 'stderr') {
          this.outputSink.push(Buffer.from(event.data))
        } else {
          code = event.code
          break
        }
      }
      this.outputSink.push(null)
      return code >= 0 ? { exitCode: code, signal: null } : { exitCode: null, signal: this.killedWith }
    } catch (error: unknown) {
      this.outputSink.destroy(error as Error)
      throw error
    }
  }
}

/** Microsandbox implementation of the subprocess seam. */
export class MicrosandboxSubprocessRuntime extends SubprocessRuntime {
  static inject = ['microsandbox']

  /** @internal Shared owner handle for adapter use. */
  readonly owner: import('@deepseek-ai/dsh-microsandbox').MicrosandboxRuntime

  private readonly handles = new Set<{ terminate(): void | Promise<void>; done: Promise<unknown> }>()

  constructor(ctx: Context) {
    super(ctx)
    this.owner = ctx.microsandbox
    ctx.effect(() => async () => {
      const live = [...this.handles]
      for (const handle of live) void handle.terminate()
      await Promise.allSettled(live.map(handle => handle.done))
    }, 'microsandbox subprocess teardown')
  }

  override async resolveExecutable(
    command: string,
    env?: Readonly<Record<string, string>>,
    _signal?: AbortSignal,
  ): Promise<string> {
    if (command.includes('/')) {
      if (command.startsWith('/')) {
        const sandbox = await this.owner.getSandbox()
        const result = await guestCommand(sandbox, `test -x ${quoteShellArg(command)} && printf ok || printf missing`)
        if (result !== 'ok') throw new Error(`subprocess-microsandbox: executable not found: ${command}`)
        return command
      }
      throw new Error('subprocess-microsandbox: relative command paths with separators are not supported')
    }
    const sandbox = await this.owner.getSandbox()
    const envEntries = Object.entries(mergedEnv(env))
      .map(([key, value]) => `${key}=${quoteShellArg(value)}`)
      .join(' ')
    const path = await guestCommand(sandbox, `${envEntries} command -v ${quoteShellArg(command)}`)
    const resolved = path.trim()
    if (resolved.length === 0) throw new Error(`subprocess-microsandbox: executable not found: ${command}`)
    return resolved
  }

  override spawn(spec: SubprocessSpawnSpec): SubprocessHandle {
    const handle = new MicrosandboxProcessHandle(this, spec)
    this.handles.add(handle)
    void handle.done.finally(() => this.handles.delete(handle))
    return handle
    return handle
  }

  override spawnTerminal(spec: SubprocessTerminalSpawnSpec): Promise<SubprocessTerminalHandle> {
    const output = new Readable({ read() {} })
    const handle = new MicrosandboxTerminalHandle(this, spec, output)
    this.handles.add(handle)
    void handle.done.finally(() => this.handles.delete(handle))
    return Promise.resolve(handle)
  }
}

export default MicrosandboxSubprocessRuntime
