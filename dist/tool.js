// packages/microsandbox/tool-microsandbox/src/index.ts
import { Buffer } from "node:buffer";
import { posix } from "node:path";
import z from "@deepseek-ai/schemastery";
import { defineTool } from "@deepseek-ai/dsh-tools";
var name = "tool-microsandbox";
var inject = ["tools", "microsandbox"];
var Config = z.object({
  maxOutputBytes: z.number().default(65536),
  timeoutMsCap: z.number().default(6e4)
});
async function recvEvent(execHandle) {
  const event = await execHandle.recv();
  return event ?? null;
}
var TailSink = class {
  constructor(cap) {
    this.cap = cap;
  }
  cap;
  chunks = [];
  bytes = 0;
  truncated = false;
  push(data) {
    if (data.length === 0) return;
    const text = Buffer.from(data).toString("utf8");
    const textBytes = Buffer.byteLength(text);
    if (this.bytes + textBytes > this.cap) this.truncated = true;
    this.chunks.push(text);
    this.bytes += textBytes;
    while (this.bytes > this.cap && this.chunks.length > 1) {
      const head = this.chunks.shift();
      this.bytes -= Buffer.byteLength(head);
    }
    if (this.bytes > this.cap) {
      const joined = this.chunks.join("");
      const kept = joined.slice(-this.cap);
      this.chunks = [kept];
      this.bytes = Buffer.byteLength(kept);
    }
  }
  text() {
    return this.chunks.join("");
  }
  isTruncated() {
    return this.truncated;
  }
};
async function guestKillGroup(sandbox, pgid) {
  await sandbox.exec("bash", ["-c", `kill -KILL -- -${pgid} 2>/dev/null; true`]);
}
function renderResult(value) {
  const lines = [];
  if (value.stdout.length > 0) lines.push(value.stdout.replace(/\n$/u, ""));
  if (value.stderr.length > 0) {
    lines.push("stderr:");
    lines.push(value.stderr.replace(/\n$/u, ""));
  }
  if (value.truncated) lines.push("[output truncated to the tail]");
  if (value.timedOut) {
    lines.push(`[timed out after ${value.timeoutMs}ms; process group killed]`);
  }
  lines.push(`[exit code: ${value.exitCode}]`);
  return lines.join("\n");
}
async function runVmBash(ctx, args, config) {
  if (typeof args.command !== "string" || args.command.trim().length === 0) {
    throw new Error("vm_bash: command must be a non-empty string");
  }
  const workdir = typeof args.workdir === "string" && args.workdir.length > 0 ? args.workdir : ctx.microsandbox.cwd;
  if (!posix.isAbsolute(workdir)) {
    throw new Error(`vm_bash: workdir must be an absolute VM path: ${JSON.stringify(workdir)}`);
  }
  const requested = typeof args.timeoutMs === "number" && Number.isFinite(args.timeoutMs) && args.timeoutMs > 0 ? args.timeoutMs : config.timeoutMsCap;
  const timeoutMs = Math.min(requested, config.timeoutMsCap);
  const sandbox = await ctx.microsandbox.getSandbox();
  const execHandle = await sandbox.execStreamWith(
    "bash",
    (builder) => builder.args(["-c", args.command]).cwd(workdir)
  );
  const stdout = new TailSink(config.maxOutputBytes);
  const stderr = new TailSink(config.maxOutputBytes);
  let pgid = -1;
  let exitCode = -1;
  let timedOut = false;
  let timer;
  let settled = false;
  const finish = () => {
    if (settled) return;
    settled = true;
    if (timer !== void 0) clearTimeout(timer);
  };
  return new Promise((resolve, reject) => {
    void (async () => {
      try {
        for (; ; ) {
          const event = await recvEvent(execHandle);
          if (event === null) break;
          if (event.kind === "started") {
            pgid = event.pid;
            timer = setTimeout(() => {
              timedOut = true;
              void guestKillGroup(sandbox, pgid).catch(() => {
              });
            }, timeoutMs);
          } else if (event.kind === "stdout") {
            stdout.push(event.data);
          } else if (event.kind === "stderr") {
            stderr.push(event.data);
          } else {
            exitCode = event.code;
            break;
          }
        }
        finish();
        resolve({
          exitCode,
          stdout: stdout.text(),
          stderr: stderr.text(),
          truncated: stdout.isTruncated() || stderr.isTruncated(),
          timedOut,
          timeoutMs
        });
      } catch (error) {
        finish();
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    })();
  });
}
function apply(ctx, config) {
  const runtimeConfig = {
    maxOutputBytes: config.maxOutputBytes ?? 65536,
    timeoutMsCap: config.timeoutMsCap ?? 6e4
  };
  ctx.tools.register(defineTool({
    name: "vm_bash",
    description: "Execute a bash command INSIDE the isolated microsandbox microVM (a separate machine from the host, with its own filesystem at /workspace backed by a persistent volume). Use this for untrusted code, experiments, or anything you do not want touching the host. The host bash tool remains available for ordinary host work.",
    parameters: {
      command: { type: "string", required: true, description: "The bash command to run in the microVM." },
      description: { type: "string", required: true, description: "Short description of what the command does." },
      workdir: { type: "string", description: "Working directory inside the VM (default: the VM's /workspace)." },
      timeoutMs: { type: "number", description: `Timeout in milliseconds; the process group is killed on expiry. Capped at ${runtimeConfig.timeoutMsCap}.` }
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          exitCode: { type: "integer", required: true, description: "Exit code; -1 when killed by signal or timeout." },
          stdout: { type: "string", required: true },
          stderr: { type: "string", required: true },
          truncated: { type: "boolean", required: true },
          timedOut: { type: "boolean", required: true },
          timeoutMs: { type: "integer", required: true }
        }
      },
      render: (_args, value) => [{ type: "text", text: renderResult(value) }]
    },
    async execute(args, _exec) {
      return await runVmBash(ctx, args, runtimeConfig);
    },
    presentCall(args) {
      const parsed = args;
      const view = {
        card: "terminal",
        title: typeof parsed.command === "string" ? parsed.command : "vm_bash",
        description: typeof parsed.description === "string" ? parsed.description : ""
      };
      if (typeof parsed.workdir === "string") view.cwd = parsed.workdir;
      return view;
    }
  }));
}
var index_default = { name, inject, Config, apply };
export {
  Config,
  apply,
  index_default as default,
  inject,
  name
};
