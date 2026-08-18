/**
 * Microsandbox provider for the subprocess capability seam: managed process
 * trees and terminal sessions inside the shared microVM. Each exec is its own
 * process-group leader under the microsandbox agentd (verified: started pid ==
 * pgid), so tree-scoped termination is one in-guest group kill.
 * @module @deepseek-ai/dsh-subprocess-microsandbox
 */
import { Context } from '@deepseek-ai/cordis';
import { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess';
import type { SubprocessHandle, SubprocessSpawnSpec, SubprocessTerminalHandle, SubprocessTerminalSpawnSpec } from '@deepseek-ai/dsh-subprocess';
/** Microsandbox implementation of the subprocess seam. */
export declare class MicrosandboxSubprocessRuntime extends SubprocessRuntime {
    static inject: string[];
    /** @internal Shared owner handle for adapter use. */
    readonly owner: import('@deepseek-ai/dsh-microsandbox').MicrosandboxRuntime;
    private readonly handles;
    constructor(ctx: Context);
    resolveExecutable(command: string, env?: Readonly<Record<string, string>>, _signal?: AbortSignal): Promise<string>;
    spawn(spec: SubprocessSpawnSpec): SubprocessHandle;
    spawnTerminal(spec: SubprocessTerminalSpawnSpec): Promise<SubprocessTerminalHandle>;
}
export default MicrosandboxSubprocessRuntime;
//# sourceMappingURL=index.d.ts.map