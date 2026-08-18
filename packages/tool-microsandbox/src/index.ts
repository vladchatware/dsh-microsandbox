/**
 * Model-facing `vm_bash` tool: execute untrusted code inside the isolated
 * microsandbox microVM, alongside the host execution world. The tool drives
 * the shared owner's SDK handle directly; it does not claim the host
 * subprocess/fs/shell seams, so host tools keep working unchanged.
 * @module @deepseek-ai/dsh-tool-microsandbox
 */

import { Buffer } from 'node:buffer'
import { posix } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { ExecHandle, ExecOptionsBuilder, Sandbox } from '@deepseek-ai/dsh-microsandbox'
import type { ExecEvent } from '@deepseek-ai/dsh-microsandbox'

export const name = 'tool-microsandbox'
export const inject = ['tools', 'microsandbox']

/** Configuration for the vm_bash tool. */
export interface Config {
  /** Per-stream output cap in bytes; overflow keeps the tail. */
  maxOutputBytes?: number
  /** Cap on the tool's timeoutMs parameter; larger values clamp. */
  timeoutMsCap?: number
}

/** Runtime configuration schema for the vm_bash tool plugin. */
export const Config: z<Config> = z.object({
  maxOutputBytes: z.number().default(65_536),
  timeoutMsCap: z.number().default(60_000),
})

interface ResolvedConfig {
  maxOutputBytes: number
  timeoutMsCap: number
}

interface VmBashArgs {
  command: string
  description: string
  workdir?: string
  timeoutMs?: number
}

/**
 * The SDK's recv() type is ExecEvent | null, but the native layer can yield
 * undefined when a stream ends without an 'exited' event; normalize to null.
 */
async function recvEvent(execHandle: ExecHandle): Promise<ExecEvent | null> {
  const event: ExecEvent | null | undefined = await execHandle.recv()
  return event ?? null
}

/** Bounded byte tail of one output stream. */
class TailSink {
  private chunks: string[] = []
  private bytes = 0
  private truncated = false

  constructor(private readonly cap: number) {}

  push(data: Uint8Array): void {
    if (data.length === 0) return
    const text = Buffer.from(data).toString('utf8')
    const textBytes = Buffer.byteLength(text)
    if (this.bytes + textBytes > this.cap) this.truncated = true
    this.chunks.push(text)
    this.bytes += textBytes
    while (this.bytes > this.cap && this.chunks.length > 1) {
      const head = this.chunks.shift() as string
      this.bytes -= Buffer.byteLength(head)
    }
    if (this.bytes > this.cap) {
      const joined = this.chunks.join('')
      const kept = joined.slice(-this.cap)
      this.chunks = [kept]
      this.bytes = Buffer.byteLength(kept)
    }
  }

  text(): string {
    return this.chunks.join('')
  }

  isTruncated(): boolean {
    return this.truncated
  }
}

async function guestKillGroup(sandbox: Sandbox, pgid: number): Promise<void> {
  await sandbox.exec('bash', ['-c', `kill -KILL -- -${pgid} 2>/dev/null; true`])
}

function renderResult(value: VmBashOutput): string {
  const lines: string[] = []
  if (value.stdout.length > 0) lines.push(value.stdout.replace(/\n$/u, ''))
  if (value.stderr.length > 0) {
    lines.push('stderr:')
    lines.push(value.stderr.replace(/\n$/u, ''))
  }
  if (value.truncated) lines.push('[output truncated to the tail]')
  if (value.timedOut) {
    lines.push(`[timed out after ${value.timeoutMs}ms; process group killed]`)
  }
  lines.push(`[exit code: ${value.exitCode}]`)
  return lines.join('\n')
}

interface VmBashOutput {
  exitCode: number
  stdout: string
  stderr: string
  truncated: boolean
  timedOut: boolean
  timeoutMs: number
}

async function runVmBash(
  ctx: Context,
  args: VmBashArgs,
  config: ResolvedConfig,
): Promise<VmBashOutput> {
  if (typeof args.command !== 'string' || args.command.trim().length === 0) {
    throw new Error('vm_bash: command must be a non-empty string')
  }
  const workdir = typeof args.workdir === 'string' && args.workdir.length > 0
    ? args.workdir
    : ctx.microsandbox.cwd
  if (!posix.isAbsolute(workdir)) {
    throw new Error(`vm_bash: workdir must be an absolute VM path: ${JSON.stringify(workdir)}`)
  }
  const requested = typeof args.timeoutMs === 'number' && Number.isFinite(args.timeoutMs) && args.timeoutMs > 0
    ? args.timeoutMs
    : config.timeoutMsCap
  const timeoutMs = Math.min(requested, config.timeoutMsCap)

  const sandbox = await ctx.microsandbox.getSandbox()
  const execHandle = await sandbox.execStreamWith(
    'bash',
    (builder: InstanceType<typeof ExecOptionsBuilder>) => builder.args(['-c', args.command]).cwd(workdir),
  )

  const stdout = new TailSink(config.maxOutputBytes)
  const stderr = new TailSink(config.maxOutputBytes)
  let pgid = -1
  let exitCode = -1
  let timedOut = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let settled = false

  const finish = (): void => {
    if (settled) return
    settled = true
    if (timer !== undefined) clearTimeout(timer)
  }

  return new Promise<VmBashOutput>((resolve, reject) => {
    void (async () => {
      try {
        for (;;) {
          const event = await recvEvent(execHandle)
          if (event === null) break
          if (event.kind === 'started') {
            pgid = event.pid
            timer = setTimeout(() => {
              timedOut = true
              void guestKillGroup(sandbox, pgid).catch(() => {})
            }, timeoutMs)
          } else if (event.kind === 'stdout') {
            stdout.push(event.data)
          } else if (event.kind === 'stderr') {
            stderr.push(event.data)
          } else {
            exitCode = event.code
            break
          }
        }
        finish()
        resolve({
          exitCode,
          stdout: stdout.text(),
          stderr: stderr.text(),
          truncated: stdout.isTruncated() || stderr.isTruncated(),
          timedOut,
          timeoutMs,
        })
      } catch (error: unknown) {
        finish()
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })()
  })
}

/** Register the vm_bash tool on ctx.tools. */
export function apply(ctx: Context, config: Config): void {
  // The loader fills defaults through the Config schema, but apply() must stay
  // self-contained for direct mounting (tests, other assemblers): default here.
  const runtimeConfig: ResolvedConfig = {
    maxOutputBytes: config.maxOutputBytes ?? 65_536,
    timeoutMsCap: config.timeoutMsCap ?? 60_000,
  }
  ctx.tools.register(defineTool({
    name: 'vm_bash',
    description: 'Execute a bash command INSIDE the isolated microsandbox microVM (a separate machine from the host, with its own filesystem at /workspace backed by a persistent volume). Use this for untrusted code, experiments, or anything you do not want touching the host. The host bash tool remains available for ordinary host work.',
    parameters: {
      command: { type: 'string', required: true, description: 'The bash command to run in the microVM.' },
      description: { type: 'string', required: true, description: 'Short description of what the command does.' },
      workdir: { type: 'string', description: 'Working directory inside the VM (default: the VM\'s /workspace).' },
      timeoutMs: { type: 'number', description: `Timeout in milliseconds; the process group is killed on expiry. Capped at ${runtimeConfig.timeoutMsCap}.` },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          exitCode: { type: 'integer', required: true, description: 'Exit code; -1 when killed by signal or timeout.' },
          stdout: { type: 'string', required: true },
          stderr: { type: 'string', required: true },
          truncated: { type: 'boolean', required: true },
          timedOut: { type: 'boolean', required: true },
          timeoutMs: { type: 'integer', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: renderResult(value) }],
    },
    async execute(args, _exec) {
      return await runVmBash(ctx, args, runtimeConfig)
    },
    presentCall(args) {
      const parsed = args as Partial<VmBashArgs>
      const view: { card: 'terminal'; title: string; description: string; cwd?: string } = {
        card: 'terminal',
        title: typeof parsed.command === 'string' ? parsed.command : 'vm_bash',
        description: typeof parsed.description === 'string' ? parsed.description : '',
      }
      if (typeof parsed.workdir === 'string') view.cwd = parsed.workdir
      return view
    },
  }))
}

export default { name, inject, Config, apply }
