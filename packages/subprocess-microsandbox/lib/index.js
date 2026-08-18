import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Readable, Writable } from "node:stream";
import { SubprocessRuntime, scrubbedParentEnv } from "@deepseek-ai/dsh-subprocess";
import { quoteShellArg } from "@deepseek-ai/dsh-microsandbox";
import { Buffer as Buffer$1 } from "node:buffer";
import { createWriteStream, unlinkSync } from "node:fs";
//#region lib/types/output.js
/** Bounded host-side projection of one microsandbox exec output stream. */
/**
* Byte-faithful offset reader over one collect-mode stream. Keeps the bounded
* TAIL in host memory and, when configured, mirrors the complete stream to a
* host spill file up to the spill cap. Offsets are whole-stream byte
* coordinates owned by the caller.
*/
var CollectReader = class {
	maxBytes;
	maxSpillBytes;
	spillPath;
	chunks = [];
	retainedBytes = 0;
	totalBytes = 0;
	spillValid = false;
	spillWriter;
	finished = false;
	constructor(maxBytes, maxSpillBytes, spillPath) {
		this.maxBytes = maxBytes;
		this.maxSpillBytes = maxSpillBytes;
		this.spillPath = spillPath;
		if (spillPath !== void 0 && maxSpillBytes !== void 0) {
			this.spillWriter = createWriteStream(spillPath, { flags: "wx" });
			this.spillValid = true;
		}
	}
	/** Total bytes observed from the exec event stream. */
	get size() {
		return this.totalBytes;
	}
	/** Append one raw output chunk from the SDK event stream. */
	push(bytes) {
		if (bytes.length === 0) return;
		const chunk = Buffer$1.from(bytes);
		this.totalBytes += chunk.length;
		this.chunks.push(chunk);
		this.retainedBytes += chunk.length;
		while (this.retainedBytes > this.maxBytes) {
			const head = this.chunks[0];
			const excess = this.retainedBytes - this.maxBytes;
			if (head.length <= excess) {
				this.chunks.shift();
				this.retainedBytes -= head.length;
			} else {
				this.chunks[0] = head.subarray(excess);
				this.retainedBytes -= excess;
			}
		}
		if (this.spillWriter !== void 0 && this.spillValid) {
			const cap = this.maxSpillBytes;
			if (cap !== void 0 && this.totalBytes <= cap) this.spillWriter.write(chunk);
			else this.invalidateSpill();
		}
	}
	/** Mark the spill invalid (overflow or interrupted transport). */
	invalidateSpill() {
		if (this.spillWriter !== void 0) {
			this.spillWriter.destroy();
			this.spillWriter = void 0;
		}
		if (this.spillPath !== void 0) try {
			unlinkSync(this.spillPath);
		} catch {}
		this.spillValid = false;
	}
	/** Finish the stream: flush the spill writer and seal the reader. */
	finish() {
		if (this.finished) return;
		this.finished = true;
		if (this.spillWriter !== void 0) {
			this.spillWriter.end();
			this.spillWriter = void 0;
		}
	}
	/** @inheritdoc */
	readFrom(fromByte) {
		const retained = Buffer$1.concat(this.chunks, this.retainedBytes);
		const firstRetained = this.totalBytes - this.retainedBytes;
		const lossy = fromByte < firstRetained;
		const start = lossy ? 0 : Math.min(retained.length, Math.max(0, fromByte - firstRetained));
		return {
			text: retained.subarray(start).toString("utf8"),
			nextOffset: this.totalBytes,
			lossy,
			...lossy && this.spillValid && this.maxSpillBytes !== void 0 && this.totalBytes <= this.maxSpillBytes ? { spillPath: this.spillPath } : {}
		};
	}
};
//#endregion
//#region lib/types/index.js
/**
* Microsandbox provider for the subprocess capability seam: managed process
* trees and terminal sessions inside the shared microVM. Each exec is its own
* process-group leader under the microsandbox agentd (verified: started pid ==
* pgid), so tree-scoped termination is one in-guest group kill.
* @module @deepseek-ai/dsh-subprocess-microsandbox
*/
const MAX_TIMER_DELAY_MS = 2147483647;
function assertGraceMs(graceMs) {
	if (!Number.isFinite(graceMs) || graceMs <= 0 || graceMs > MAX_TIMER_DELAY_MS) throw new Error(`subprocess-microsandbox: graceMs must be a positive finite number <= ${MAX_TIMER_DELAY_MS}`);
}
/** Merge the spec env over the shared scrub, honoring undefined tombstones. */
function mergedEnv(env) {
	const base = scrubbedParentEnv();
	if (env === void 0) return base;
	const result = {};
	for (const [key, value] of Object.entries(base)) if (env[key] === void 0) result[key] = value;
	for (const [key, value] of Object.entries(env)) if (value !== void 0) result[key] = value;
	return result;
}
function applyExecOptions(builder, spec, stdin) {
	builder.args(spec.argv.slice(1)).cwd(spec.cwd);
	const env = mergedEnv(spec.env);
	for (const [key, value] of Object.entries(env)) builder.env(key, value);
	if (stdin === "pipe") builder.stdinPipe();
	else if (stdin !== "ignore") builder.stdinBytes(Buffer.from(stdin.data, "utf8"));
	return builder;
}
/**
* The SDK's recv() type is ExecEvent | null, but the native layer can yield
* undefined when a stream ends without an 'exited' event; normalize to null so
* loops only handle the documented end-of-stream value.
*/
async function recvEvent(execHandle) {
	return await execHandle.recv() ?? null;
}
function guestCommand(sandbox, command) {
	return sandbox.exec("bash", ["-c", command]).then((result) => result.stdout());
}
async function guestKillGroup(sandbox, pgid, signal) {
	await sandbox.exec("bash", ["-c", `kill -${signal} -- -${pgid} 2>/dev/null; true`]);
}
/** One managed process tree in the microVM. */
var MicrosandboxProcessHandle = class {
	runtime;
	spec;
	stdin;
	stdout;
	stderr;
	collected;
	done;
	pidValue = -1;
	pgid = -1;
	terminated = false;
	killedWith = null;
	stdoutCollector;
	stderrCollector;
	stdoutPipe;
	stderrPipe;
	stdinBuffer = [];
	stdinSink;
	stdinClosed = false;
	abortListener;
	constructor(runtime, spec) {
		this.runtime = runtime;
		this.spec = spec;
		assertGraceMs(spec.graceMs);
		const stdout = this.makeReader(this.spec.stdio.stdout, true);
		const stderr = this.makeReader(this.spec.stdio.stderr, false);
		this.stdout = stdout.stream;
		this.stderr = stderr.stream;
		this.stdoutCollector = stdout.collector;
		this.stderrCollector = stderr.collector;
		this.stdoutPipe = stdout.stream;
		this.stderrPipe = stderr.stream;
		this.collected = {
			...this.stdoutCollector !== void 0 ? { stdout: this.stdoutCollector } : {},
			...this.stderrCollector !== void 0 ? { stderr: this.stderrCollector } : {}
		};
		this.stdin = spec.stdio.stdin === "pipe" ? new Writable({
			write: (chunk, _encoding, callback) => {
				this.stdinBuffer.push(Buffer.from(chunk));
				this.drainStdin();
				callback();
			},
			final: (callback) => {
				this.stdinClosed = true;
				this.drainStdin();
				callback();
			}
		}) : void 0;
		this.done = this.start();
		if (spec.signal !== void 0) {
			this.abortListener = () => {
				this.terminate();
			};
			if (spec.signal.aborted) this.terminate();
			else spec.signal.addEventListener("abort", this.abortListener, { once: true });
		}
	}
	get pid() {
		return this.pidValue;
	}
	terminate() {
		if (this.terminated || this.pgid < 0) return;
		this.terminated = true;
		this.escalate();
	}
	waitForExit(signal) {
		if (signal !== void 0 && signal.aborted) return Promise.resolve(false);
		return new Promise((resolve) => {
			let settled = false;
			const listener = () => {
				finish(false);
			};
			const finish = (value) => {
				if (settled) return;
				settled = true;
				signal?.removeEventListener("abort", listener);
				resolve(value);
			};
			signal?.addEventListener("abort", listener, { once: true });
			this.done.then(() => {
				finish(true);
			}, () => {
				finish(true);
			});
		});
	}
	makeReader(mode, _isStdout) {
		if (mode === "pipe") return {
			stream: new Readable({ read() {} }),
			collector: void 0
		};
		if (mode === "inherit") return {
			stream: void 0,
			collector: void 0
		};
		const collect = mode;
		const spillPath = collect.spill !== void 0 ? join(tmpdir(), `dsh-msb-${randomUUID()}.spill`) : void 0;
		return {
			stream: void 0,
			collector: new CollectReader(collect.maxBytes, collect.spill?.maxBytes, spillPath)
		};
	}
	async start() {
		try {
			const execHandle = await (await this.runtime.owner.getSandbox()).execStreamWith(this.spec.argv[0], (builder) => applyExecOptions(builder, this.spec, this.spec.stdio.stdin));
			const sink = await execHandle.takeStdin();
			this.stdinSink = sink;
			await this.drainStdin();
			const outcome = await this.runEvents(execHandle);
			this.finishReaders();
			return outcome;
		} catch (error) {
			this.finishReaders();
			throw error;
		}
	}
	async runEvents(execHandle) {
		let code = -1;
		for (;;) {
			const event = await recvEvent(execHandle);
			if (event === null) break;
			if (event.kind === "started") {
				this.pgid = event.pid;
				this.pidValue = event.pid;
			} else if (event.kind === "stdout") this.emitStdout(event.data);
			else if (event.kind === "stderr") this.emitStderr(event.data);
			else {
				code = event.code;
				break;
			}
		}
		return code >= 0 ? {
			exitCode: code,
			signal: null
		} : {
			exitCode: null,
			signal: this.killedWith
		};
	}
	emitStdout(bytes) {
		if (this.stdoutPipe !== void 0) this.stdoutPipe.push(Buffer.from(bytes));
		else if (this.stdoutCollector !== void 0) this.stdoutCollector.push(bytes);
		else process.stdout.write(Buffer.from(bytes));
	}
	emitStderr(bytes) {
		if (this.stderrPipe !== void 0) this.stderrPipe.push(Buffer.from(bytes));
		else if (this.stderrCollector !== void 0) this.stderrCollector.push(bytes);
		else process.stderr.write(Buffer.from(bytes));
	}
	finishReaders() {
		this.stdoutPipe?.push(null);
		this.stderrPipe?.push(null);
		this.stdoutCollector?.finish();
		this.stderrCollector?.finish();
	}
	async drainStdin() {
		const sink = this.stdinSink;
		if (sink === null || sink === void 0) return;
		while (this.stdinBuffer.length > 0) {
			const chunk = this.stdinBuffer.shift();
			await sink.write(chunk);
		}
		if (this.stdinClosed) await sink.close();
	}
	async escalate() {
		const pgid = this.pgid;
		if (pgid <= 0) return;
		try {
			const sandbox = await this.runtime.owner.getSandbox();
			this.killedWith = "SIGTERM";
			await guestKillGroup(sandbox, pgid, "TERM");
			await new Promise((resolve) => setTimeout(resolve, this.spec.graceMs));
			this.killedWith = "SIGKILL";
			await guestKillGroup(sandbox, pgid, "KILL");
		} catch {}
	}
};
/** One terminal session in the microVM. */
var MicrosandboxTerminalHandle = class {
	runtime;
	spec;
	outputSink;
	output;
	done;
	pidValue = -1;
	pgid = -1;
	terminated = false;
	killedWith = null;
	sink;
	constructor(runtime, spec, outputSink) {
		this.runtime = runtime;
		this.spec = spec;
		this.outputSink = outputSink;
		assertGraceMs(spec.graceMs);
		this.output = outputSink;
		this.done = this.start();
	}
	get pid() {
		return this.pidValue;
	}
	async write(data) {
		if (this.sink === null || this.sink === void 0) throw new Error("subprocess-microsandbox: terminal stdin is unavailable");
		await this.sink.write(data);
	}
	inspectForeground() {
		if (this.pgid <= 0) return Promise.resolve(void 0);
		return Promise.resolve({
			processGroupId: this.pgid,
			inputWaiting: false
		});
	}
	async signalForeground(signal) {
		const pgid = this.pgid;
		if (pgid <= 0) throw new Error("subprocess-microsandbox: terminal has not started");
		const sandbox = await this.runtime.owner.getSandbox();
		if (signal === "SIGTERM") this.killedWith = "SIGTERM";
		else if (signal === "SIGKILL") this.killedWith = "SIGKILL";
		await guestKillGroup(sandbox, pgid, signal === "SIGKILL" ? "KILL" : "TERM");
		return pgid;
	}
	async terminate() {
		if (this.terminated) return;
		this.terminated = true;
		const pgid = this.pgid;
		if (pgid <= 0) return;
		const sandbox = await this.runtime.owner.getSandbox();
		try {
			this.killedWith = "SIGTERM";
			await guestKillGroup(sandbox, pgid, "TERM");
			await new Promise((resolve) => setTimeout(resolve, this.spec.graceMs));
			this.killedWith = "SIGKILL";
			await guestKillGroup(sandbox, pgid, "KILL");
		} catch {}
		try {
			await this.done;
		} catch {}
	}
	async start() {
		try {
			const execHandle = await (await this.runtime.owner.getSandbox()).execStreamWith(this.spec.argv[0], (builder) => applyExecOptions(builder, this.spec, "pipe").tty(true));
			await execHandle.resize(this.spec.rows, this.spec.cols);
			this.sink = await execHandle.takeStdin();
			let code = -1;
			for (;;) {
				const event = await recvEvent(execHandle);
				if (event === null) break;
				if (event.kind === "started") {
					this.pgid = event.pid;
					this.pidValue = event.pid;
				} else if (event.kind === "stdout" || event.kind === "stderr") this.outputSink.push(Buffer.from(event.data));
				else {
					code = event.code;
					break;
				}
			}
			this.outputSink.push(null);
			return code >= 0 ? {
				exitCode: code,
				signal: null
			} : {
				exitCode: null,
				signal: this.killedWith
			};
		} catch (error) {
			this.outputSink.destroy(error);
			throw error;
		}
	}
};
/** Microsandbox implementation of the subprocess seam. */
var MicrosandboxSubprocessRuntime = class extends SubprocessRuntime {
	static inject = ["microsandbox"];
	/** @internal Shared owner handle for adapter use. */
	owner;
	handles = /* @__PURE__ */ new Set();
	constructor(ctx) {
		super(ctx);
		this.owner = ctx.microsandbox;
		ctx.effect(() => async () => {
			const live = [...this.handles];
			for (const handle of live) handle.terminate();
			await Promise.allSettled(live.map((handle) => handle.done));
		}, "microsandbox subprocess teardown");
	}
	async resolveExecutable(command, env, _signal) {
		if (command.includes("/")) {
			if (command.startsWith("/")) {
				if (await guestCommand(await this.owner.getSandbox(), `test -x ${quoteShellArg(command)} && printf ok || printf missing`) !== "ok") throw new Error(`subprocess-microsandbox: executable not found: ${command}`);
				return command;
			}
			throw new Error("subprocess-microsandbox: relative command paths with separators are not supported");
		}
		const resolved = (await guestCommand(await this.owner.getSandbox(), `${Object.entries(mergedEnv(env)).map(([key, value]) => `${key}=${quoteShellArg(value)}`).join(" ")} command -v ${quoteShellArg(command)}`)).trim();
		if (resolved.length === 0) throw new Error(`subprocess-microsandbox: executable not found: ${command}`);
		return resolved;
	}
	spawn(spec) {
		const handle = new MicrosandboxProcessHandle(this, spec);
		this.handles.add(handle);
		handle.done.finally(() => this.handles.delete(handle));
		return handle;
	}
	spawnTerminal(spec) {
		const output = new Readable({ read() {} });
		const handle = new MicrosandboxTerminalHandle(this, spec, output);
		this.handles.add(handle);
		handle.done.finally(() => this.handles.delete(handle));
		return Promise.resolve(handle);
	}
};
//#endregion
export { MicrosandboxSubprocessRuntime, MicrosandboxSubprocessRuntime as default };
