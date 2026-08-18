/**
 * Model-facing `vm_bash` tool: execute untrusted code inside the isolated
 * microsandbox microVM, alongside the host execution world. The tool drives
 * the shared owner's SDK handle directly; it does not claim the host
 * subprocess/fs/shell seams, so host tools keep working unchanged.
 * @module @deepseek-ai/dsh-tool-microsandbox
 */
import type { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
export declare const name = "tool-microsandbox";
export declare const inject: string[];
/** Configuration for the vm_bash tool. */
export interface Config {
    /** Per-stream output cap in bytes; overflow keeps the tail. */
    maxOutputBytes?: number;
    /** Cap on the tool's timeoutMs parameter; larger values clamp. */
    timeoutMsCap?: number;
}
/** Runtime configuration schema for the vm_bash tool plugin. */
export declare const Config: z<Config>;
/** Register the vm_bash tool on ctx.tools. */
export declare function apply(ctx: Context, config: Config): void;
declare const _default: {
    name: string;
    inject: string[];
    Config: z<Config>;
    apply: typeof apply;
};
export default _default;
//# sourceMappingURL=index.d.ts.map