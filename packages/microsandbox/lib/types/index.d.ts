/**
 * Shared ownership of one local microsandbox microVM. Capability adapters
 * await the same SDK handle, so filesystem and process operations inhabit one
 * Linux execution world, with an optional persistent named volume at cwd.
 * @module @deepseek-ai/dsh-microsandbox
 */
import { Context, Service } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
import { Sandbox } from 'microsandbox';
export { ExecHandle, ExecOptionsBuilder, ExecOutput, isInstalled, MicrosandboxError, Sandbox, Volume, } from 'microsandbox';
export type { ExecEvent, FsEntry, FsMetadata, FsReadStream, FsWriteSink, SandboxFsOps, SandboxHandle, VolumeFs, VolumeHandle, } from 'microsandbox';
/** Configuration for the shared microsandbox owner. */
export interface Config {
    /** OCI image name; default 'debian'. */
    image?: string;
    /** Shared remote working directory, created before adapters receive the sandbox. */
    cwd?: string;
    /** Hard sandbox lifetime in milliseconds; expiry always kills the sandbox. */
    timeoutMs?: number;
    /** Idle timeout in seconds before the local runtime suspends the sandbox. */
    idleTimeoutSecs?: number;
    /** CPU count for the sandbox. */
    cpus?: number;
    /** Memory in MiB for the sandbox. */
    memory?: number;
    /** Named volume mounted at cwd — the persistent per-user storage. */
    volume?: string;
    /** Sandbox name prefix; a short uuid suffix keeps names unique. */
    namePrefix?: string;
    /** Create the sandbox lazily on first getSandbox() instead of at construction. */
    lazy?: boolean;
}
declare module '@deepseek-ai/cordis' {
    interface Context {
        microsandbox: MicrosandboxRuntime;
    }
}
/** Quote one opaque argument for in-guest bash helper commands. */
export declare function quoteShellArg(value: string): string;
/**
 * Creates one lazily consumable microsandbox SDK handle and kills the sandbox
 * at timeout or disposal. Sandbox creation begins at plugin construction;
 * adapters await {@link getSandbox} before their first operation.
 */
export declare class MicrosandboxRuntime extends Service {
    static Config: z<Config>;
    /** Validated remote working directory shared by provider adapters. */
    readonly cwd: string;
    /** Remote directory reserved for adapter-owned process and terminal state. */
    readonly runtimeRoot: string;
    private readonly config;
    private ready;
    private disposed;
    constructor(ctx: Context, config: Config);
    /**
     * Return the shared live SDK handle.
     * @returns the created sandbox after the configured cwd exists.
     * @throws when microsandbox rejects creation or the service is disposing.
     */
    getSandbox(): Promise<Sandbox>;
    private validate;
    private open;
}
export default MicrosandboxRuntime;
//# sourceMappingURL=index.d.ts.map