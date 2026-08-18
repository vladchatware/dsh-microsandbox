import { randomUUID } from "node:crypto";
import { posix } from "node:path";
import { Service } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";
import { ExecHandle, ExecOptionsBuilder, ExecOutput, MicrosandboxError, Sandbox, Sandbox as Sandbox$1, Volume, isInstalled } from "microsandbox";
//#region lib/types/index.js
/**
* Shared ownership of one local microsandbox microVM. Capability adapters
* await the same SDK handle, so filesystem and process operations inhabit one
* Linux execution world, with an optional persistent named volume at cwd.
* @module @deepseek-ai/dsh-microsandbox
*/
/** Quote one opaque argument for in-guest bash helper commands. */
function quoteShellArg(value) {
	return `'${value.replaceAll("'", "'\"'\"'")}'`;
}
/**
* Creates one lazily consumable microsandbox SDK handle and kills the sandbox
* at timeout or disposal. Sandbox creation begins at plugin construction;
* adapters await {@link getSandbox} before their first operation.
*/
var MicrosandboxRuntime = class extends Service {
	static Config = z.object({
		image: z.string().default("debian"),
		cwd: z.string().default("/workspace"),
		timeoutMs: z.number().default(3e5),
		idleTimeoutSecs: z.number().default(0),
		cpus: z.number().default(0),
		memory: z.number().default(0),
		volume: z.string().default(""),
		namePrefix: z.string().default(""),
		lazy: z.boolean().default(false)
	});
	/** Validated remote working directory shared by provider adapters. */
	cwd;
	/** Remote directory reserved for adapter-owned process and terminal state. */
	runtimeRoot;
	config;
	ready;
	disposed = false;
	constructor(ctx, config) {
		super(ctx, "microsandbox");
		const resolved = config;
		this.config = {
			image: resolved.image,
			cwd: resolved.cwd,
			timeoutMs: resolved.timeoutMs,
			idleTimeoutSecs: resolved.idleTimeoutSecs,
			cpus: resolved.cpus,
			memory: resolved.memory,
			volume: resolved.volume,
			lazy: resolved.lazy,
			name: `dsh-msb-${(resolved.namePrefix || randomUUID()).slice(0, 40)}`
		};
		this.validate();
		this.cwd = this.config.cwd;
		this.runtimeRoot = posix.join(this.cwd, ".dsh-msb");
		this.ready = this.config.lazy ? null : this.open();
		if (this.ready !== null) this.ready.catch(() => {});
		ctx.effect(() => async () => {
			this.disposed = true;
			const ready = this.ready;
			if (ready === null) return;
			let sandbox;
			try {
				sandbox = await ready;
			} catch (_sandboxSetupFailure) {
				return;
			}
			try {
				await sandbox.kill();
			} catch {}
		}, "microsandbox sandbox teardown");
	}
	/**
	* Return the shared live SDK handle.
	* @returns the created sandbox after the configured cwd exists.
	* @throws when microsandbox rejects creation or the service is disposing.
	*/
	async getSandbox() {
		if (this.disposed) throw new Error("microsandbox sandbox service is disposing");
		if (this.ready === null) this.ready = this.open();
		const sandbox = await this.ready;
		if (this.disposed) throw new Error("microsandbox sandbox service is disposing");
		return sandbox;
	}
	validate() {
		if (this.config.image.length === 0) throw new Error("dsh-microsandbox: image must not be empty");
		if (!posix.isAbsolute(this.config.cwd)) throw new Error(`dsh-microsandbox: cwd must be an absolute Linux path: ${this.config.cwd}`);
		if (!Number.isFinite(this.config.timeoutMs) || this.config.timeoutMs <= 0) throw new Error("dsh-microsandbox: timeoutMs must be a positive finite number");
		if (this.config.cpus < 0) throw new Error("dsh-microsandbox: cpus must be a non-negative number");
		if (this.config.memory < 0) throw new Error("dsh-microsandbox: memory must be a non-negative number of MiB");
	}
	async open() {
		let builder = Sandbox$1.builder(this.config.name).image(this.config.image).replace();
		if (this.config.cpus > 0) builder = builder.cpus(this.config.cpus);
		if (this.config.memory > 0) builder = builder.memory(this.config.memory);
		if (this.config.volume.length > 0) builder = builder.volume(this.cwd, (volume) => volume.namedWith(this.config.volume, "ensure-exists"));
		const sandbox = await builder.maxDuration(Math.ceil(this.config.timeoutMs / 1e3)).create();
		try {
			await sandbox.exec("bash", ["-c", `mkdir -p -- ${quoteShellArg(this.cwd)} ${quoteShellArg(this.runtimeRoot)}`]);
			if ((await sandbox.fs().stat(this.runtimeRoot)).kind !== "directory") throw new Error(`dsh-microsandbox: runtime root must be a real directory: ${this.runtimeRoot}`);
			await sandbox.exec("bash", ["-c", `chmod 700 -- ${quoteShellArg(this.runtimeRoot)}`]);
			return sandbox;
		} catch (error) {
			try {
				await sandbox.kill();
			} catch {}
			throw error;
		}
	}
};
//#endregion
export { ExecHandle, ExecOptionsBuilder, ExecOutput, MicrosandboxError, MicrosandboxRuntime, MicrosandboxRuntime as default, Sandbox, Volume, isInstalled, quoteShellArg };
