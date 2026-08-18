/**
 * Shared ownership of one local microsandbox microVM. Capability adapters
 * await the same SDK handle, so filesystem and process operations inhabit one
 * Linux execution world, with an optional persistent named volume at cwd.
 * @module @deepseek-ai/dsh-microsandbox
 */

import { randomUUID } from 'node:crypto'
import { posix } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { MountBuilder, Sandbox } from 'microsandbox'

export {
  ExecHandle,
  ExecOptionsBuilder,
  ExecOutput,
  isInstalled,
  MicrosandboxError,
  Sandbox,
  Volume,
} from 'microsandbox'
export type {
  ExecEvent,
  FsEntry,
  FsMetadata,
  FsReadStream,
  FsWriteSink,
  SandboxFsOps,
  SandboxHandle,
  VolumeFs,
  VolumeHandle,
} from 'microsandbox'

/** Configuration for the shared microsandbox owner. */
export interface Config {
  /** OCI image name; default 'debian'. */
  image?: string
  /** Shared remote working directory, created before adapters receive the sandbox. */
  cwd?: string
  /** Hard sandbox lifetime in milliseconds; expiry always kills the sandbox. */
  timeoutMs?: number
  /** Idle timeout in seconds before the local runtime suspends the sandbox. */
  idleTimeoutSecs?: number
  /** CPU count for the sandbox. */
  cpus?: number
  /** Memory in MiB for the sandbox. */
  memory?: number
  /** Named volume mounted at cwd — the persistent per-user storage. */
  volume?: string
  /** Sandbox name prefix; a short uuid suffix keeps names unique. */
  namePrefix?: string
  /** Create the sandbox lazily on first getSandbox() instead of at construction. */
  lazy?: boolean
}

interface ResolvedConfig {
  image: string
  cwd: string
  timeoutMs: number
  idleTimeoutSecs: number
  cpus: number
  memory: number
  volume: string
  name: string
  lazy: boolean
}

interface SchemaResolvedConfig extends Config {
  image: string
  cwd: string
  timeoutMs: number
  idleTimeoutSecs: number
  cpus: number
  memory: number
  volume: string
  namePrefix: string
  lazy: boolean
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    microsandbox: MicrosandboxRuntime
  }
}

/** Quote one opaque argument for in-guest bash helper commands. */
export function quoteShellArg(value: string): string {
  return `'${value.replaceAll('\'', "'\"'\"'")}'`
}

/**
 * Creates one lazily consumable microsandbox SDK handle and kills the sandbox
 * at timeout or disposal. Sandbox creation begins at plugin construction;
 * adapters await {@link getSandbox} before their first operation.
 */
export class MicrosandboxRuntime extends Service {
  static Config: z<Config> = z.object({
    image: z.string().default('debian'),
    cwd: z.string().default('/workspace'),
    timeoutMs: z.number().default(300_000),
    // 0 / empty sentinels mean 'unset' (runtime default); schemastery has no optional() here.
    idleTimeoutSecs: z.number().default(0),
    cpus: z.number().default(0),
    memory: z.number().default(0),
    volume: z.string().default(''),
    namePrefix: z.string().default(''),
    lazy: z.boolean().default(false),
  })

  /** Validated remote working directory shared by provider adapters. */
  readonly cwd: string
  /** Remote directory reserved for adapter-owned process and terminal state. */
  readonly runtimeRoot: string

  private readonly config: ResolvedConfig
  private ready: Promise<Sandbox> | null
  private disposed = false

  constructor(ctx: Context, config: Config) {
    super(ctx, 'microsandbox')
    // Schemastery fills these fields before construction; the type does not encode that step.
    const resolved = config as SchemaResolvedConfig
    this.config = {
      image: resolved.image,
      cwd: resolved.cwd,
      timeoutMs: resolved.timeoutMs,
      idleTimeoutSecs: resolved.idleTimeoutSecs,
      cpus: resolved.cpus,
      memory: resolved.memory,
      volume: resolved.volume,
      lazy: resolved.lazy,
      name: `dsh-msb-${(resolved.namePrefix || randomUUID()).slice(0, 40)}`,
    }
    this.validate()
    this.cwd = this.config.cwd
    this.runtimeRoot = posix.join(this.cwd, '.dsh-msb')
    this.ready = this.config.lazy ? null : this.open()
    if (this.ready !== null) {
      // A deployment may load the owner before any adapter uses it. Keep a
      // failed eager boot observed; getSandbox() still returns the error.
      void this.ready.catch(() => {})
    }

    ctx.effect(() => async () => {
      this.disposed = true
      const ready = this.ready
      if (ready === null) return
      let sandbox: Sandbox
      try {
        sandbox = await ready
      } catch (_sandboxSetupFailure) {
        // open() either acquired no sandbox or already made the one rollback attempt.
        return
      }
      try {
        await sandbox.kill()
      } catch {
        // Expiry or an external removal is quiescence; anything else is logged by the SDK.
      }
    }, 'microsandbox sandbox teardown')
  }

  /**
   * Return the shared live SDK handle.
   * @returns the created sandbox after the configured cwd exists.
   * @throws when microsandbox rejects creation or the service is disposing.
   */
  async getSandbox(): Promise<Sandbox> {
    if (this.disposed) throw new Error('microsandbox sandbox service is disposing')
    if (this.ready === null) this.ready = this.open()
    const sandbox = await this.ready
    // oxlint-disable-next-line typescript/no-unnecessary-condition -- Awaiting readiness yields to disposal.
    if (this.disposed) throw new Error('microsandbox sandbox service is disposing')
    return sandbox
  }

  private validate(): void {
    if (this.config.image.length === 0) {
      throw new Error('dsh-microsandbox: image must not be empty')
    }
    if (!posix.isAbsolute(this.config.cwd)) {
      throw new Error(`dsh-microsandbox: cwd must be an absolute Linux path: ${this.config.cwd}`)
    }
    if (!Number.isFinite(this.config.timeoutMs) || this.config.timeoutMs <= 0) {
      throw new Error('dsh-microsandbox: timeoutMs must be a positive finite number')
    }
    if (this.config.cpus < 0) {
      throw new Error('dsh-microsandbox: cpus must be a non-negative number')
    }
    if (this.config.memory < 0) {
      throw new Error('dsh-microsandbox: memory must be a non-negative number of MiB')
    }
  }

  private async open(): Promise<Sandbox> {
    let builder = Sandbox.builder(this.config.name)
      .image(this.config.image)
      .replace()
    if (this.config.cpus > 0) builder = builder.cpus(this.config.cpus)
    if (this.config.memory > 0) builder = builder.memory(this.config.memory)
    if (this.config.volume.length > 0) {
      builder = builder.volume(this.cwd, (volume: InstanceType<typeof MountBuilder>) => volume.namedWith(this.config.volume, 'ensure-exists'))
    }
    const sandbox = await builder
      .maxDuration(Math.ceil(this.config.timeoutMs / 1000))
      .create()
    try {
      // mkdir -p through bash so nested cwd parents are created; the fs()
      // mkdir is single-level only.
      await sandbox.exec('bash', ['-c', `mkdir -p -- ${quoteShellArg(this.cwd)} ${quoteShellArg(this.runtimeRoot)}`])
      const runtimeRoot = await sandbox.fs().stat(this.runtimeRoot)
      if (runtimeRoot.kind !== 'directory') {
        throw new Error(`dsh-microsandbox: runtime root must be a real directory: ${this.runtimeRoot}`)
      }
      await sandbox.exec('bash', ['-c', `chmod 700 -- ${quoteShellArg(this.runtimeRoot)}`])
      return sandbox
    } catch (error: unknown) {
      try {
        await sandbox.kill()
      } catch {
        // Single rollback attempt; the sandbox maxDuration bounds any leak.
      }
      throw error
    }
  }
}

export default MicrosandboxRuntime
