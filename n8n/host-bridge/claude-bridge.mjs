#!/usr/bin/env node
// Host-side bridge between the n8n containers and the Claude CLI on this machine.
//
// The host `claude` binary is typically a native executable authenticated through
// the OS credential store (e.g. macOS Keychain), so it cannot be mounted into the
// Linux n8n containers. Instead n8n calls this small HTTP server (via
// host.docker.internal) and it runs `claude -p` here, with the developer's own
// auth, plugins, MCP servers, git and gh.
//
// Jobs are asynchronous — long-running Claude sessions can far outlast any HTTP
// request:
//   GET    /health        -> { ok, claudeVersion }
//   POST   /jobs          -> { jobId }  body: see validateJob(); the tool allowlist
//                                       is fixed here (plus CLAUDE_BRIDGE_EXTRA_TOOLS)
//   GET    /jobs/:id      -> job record (status running|succeeded|failed|timeout|cancelled)
//   DELETE /jobs/:id      -> cancels a running job
//
// Security posture:
//   - binds 127.0.0.1 by default (Docker Desktop routes host.docker.internal here)
//   - every request needs `Authorization: Bearer $CLAUDE_BRIDGE_TOKEN`
//   - claude jobs run only inside $CLAUDE_BRIDGE_WORKSPACE_ROOT
//   - script jobs run only the fixed scripts registered in SCRIPTS, never an arbitrary command
//   - claude runs with a tool allowlist; `git push`, PR creation, PR merge, and remote
//     workflow triggers are on the disallow list
//
// Node stdlib only — no npm install.

import { spawn, execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const JOBS_DIR = path.join(HERE, ".jobs");

const TOKEN = process.env.CLAUDE_BRIDGE_TOKEN || "";
const HOST = process.env.CLAUDE_BRIDGE_HOST || "127.0.0.1";
const PORT = Number(process.env.CLAUDE_BRIDGE_PORT || 8787);
const WORKSPACE_ROOT = path.resolve(
	(process.env.CLAUDE_BRIDGE_WORKSPACE_ROOT || path.join(os.homedir(), "claude-workspaces")).replace(/^~(?=$|\/)/, os.homedir()),
);
const CLAUDE_BIN = process.env.CLAUDE_BIN || "claude";
const PERMISSION_MODE = process.env.CLAUDE_BRIDGE_PERMISSION_MODE || "acceptEdits";
const MAX_TIMEOUT_MIN = 180;

// Base allowlist. Extend via CLAUDE_BRIDGE_EXTRA_TOOLS (space or comma separated).
const DEFAULT_ALLOWED_TOOLS = [
	"Read",
	"Edit",
	"Write",
	"Glob",
	"Grep",
	"Skill",
	"Task",
	"TodoWrite",
	"Bash(git status:*)",
	"Bash(git diff:*)",
	"Bash(git log:*)",
	"Bash(git show:*)",
	"Bash(git add:*)",
	"Bash(git commit:*)",
	"Bash(git checkout:*)",
	"Bash(git switch:*)",
	"Bash(git branch:*)",
	"Bash(git rev-parse:*)",
	"Bash(git ls-files:*)",
	"Bash(ls:*)",
	"Bash(mkdir:*)",
	"Bash(find:*)",
	"Bash(wc:*)",
	"Bash(cat:*)",
	// common build / test entry points
	"Bash(npm:*)",
	"Bash(npx:*)",
	"Bash(yarn:*)",
	"Bash(pnpm:*)",
	"Bash(node:*)",
	"Bash(python3:*)",
	"Bash(pytest:*)",
	"Bash(uv:*)",
	"Bash(go:*)",
	"Bash(make:*)",
	...(process.env.CLAUDE_BRIDGE_EXTRA_TOOLS || "").split(/[\s,]+/).filter(Boolean),
];

// Denied regardless of the allowlist — mutation of remote state belongs to the
// developer, not to a workflow-driven claude session.
const DISALLOWED_TOOLS = [
	"Bash(git push:*)",
	"Bash(gh pr create:*)",
	"Bash(gh pr merge:*)",
	"Bash(gh pr ready:*)",
	"Bash(gh workflow run:*)",
	"Bash(gh workflow enable:*)",
	"Bash(gh workflow disable:*)",
	"Bash(gh run rerun:*)",
	"Bash(gh run cancel:*)",
	"Bash(gh repo delete:*)",
];

// name -> [script, ...fixed leading args]; callers only ever supply the trailing args.
// Add your own scripts to n8n/host-bridge/scripts/ and register them here.
const SCRIPTS = {
	example: [path.join(HERE, "scripts", "example.sh")],
};

const jobs = new Map();

function log(msg) {
	process.stderr.write(`[claude-bridge ${new Date().toISOString()}] ${msg}\n`);
}

function jobDir(id) {
	return path.join(JOBS_DIR, id);
}

function persist(job) {
	const { child, timer, ...record } = job;
	fs.writeFileSync(path.join(jobDir(job.id), "job.json"), JSON.stringify(record, null, 2));
}

function tail(file, bytes = 4000) {
	try {
		const buf = fs.readFileSync(file);
		return buf.subarray(Math.max(0, buf.length - bytes)).toString("utf8");
	} catch {
		return "";
	}
}

function publicView(job) {
	const { child, timer, ...record } = job;
	return {
		...record,
		logTail: tail(path.join(jobDir(job.id), "stderr.log")),
	};
}

// Jobs left "running" by a previous bridge process are orphaned — mark them so pollers stop.
function loadJobs() {
	fs.mkdirSync(JOBS_DIR, { recursive: true });
	for (const id of fs.readdirSync(JOBS_DIR)) {
		const file = path.join(JOBS_DIR, id, "job.json");
		if (!fs.existsSync(file)) continue;
		try {
			const job = JSON.parse(fs.readFileSync(file, "utf8"));
			if (job.status === "running") {
				job.status = "failed";
				job.error = "bridge restarted while the job was running";
				job.finishedAt = new Date().toISOString();
				fs.writeFileSync(file, JSON.stringify(job, null, 2));
			}
			jobs.set(id, job);
		} catch {
			// unreadable record — ignore it
		}
	}
}

function resolveCwd(rel) {
	if (typeof rel !== "string" || rel.trim() === "") throw new Error("cwd is required");
	const abs = path.resolve(WORKSPACE_ROOT, rel);
	if (abs !== WORKSPACE_ROOT && !abs.startsWith(WORKSPACE_ROOT + path.sep)) {
		throw new Error(`cwd must stay inside the workspace root (${WORKSPACE_ROOT})`);
	}
	return abs;
}

function validateJob(body) {
	if (!body || typeof body !== "object") throw new Error("JSON body required");
	const timeoutMin = Number(body.timeoutMin ?? 30);
	if (!Number.isFinite(timeoutMin) || timeoutMin <= 0 || timeoutMin > MAX_TIMEOUT_MIN) {
		throw new Error(`timeoutMin must be between 0 and ${MAX_TIMEOUT_MIN}`);
	}
	if (body.kind === "claude") {
		if (typeof body.prompt !== "string" || body.prompt.trim() === "") throw new Error("prompt is required");
		const cwd = resolveCwd(body.cwd || ".");
		if (body.model !== undefined && (typeof body.model !== "string" || !/^[\w.[\]-]+$/.test(body.model))) {
			throw new Error("model must be a model id string");
		}
		return { kind: "claude", prompt: body.prompt, cwd, timeoutMin, model: body.model };
	}
	if (body.kind === "script") {
		const script = SCRIPTS[body.name];
		if (!script) throw new Error(`unknown script: ${body.name} (allowed: ${Object.keys(SCRIPTS).join(", ")})`);
		const args = body.args ?? [];
		if (!Array.isArray(args) || !args.every((a) => typeof a === "string" && !a.includes("\0"))) {
			throw new Error("args must be an array of strings");
		}
		return { kind: "script", name: body.name, script, args, cwd: WORKSPACE_ROOT, timeoutMin };
	}
	throw new Error('kind must be "claude" or "script"');
}

function startJob(spec) {
	for (const j of jobs.values()) {
		if (j.status === "running" && j.kind === "claude" && spec.kind === "claude" && j.cwd === spec.cwd) {
			const err = new Error(`job ${j.id} is already running in ${spec.cwd}`);
			err.statusCode = 409;
			throw err;
		}
	}

	const id = `${Date.now().toString(36)}-${crypto.randomBytes(4).toString("hex")}`;
	fs.mkdirSync(jobDir(id), { recursive: true });
	fs.mkdirSync(spec.cwd, { recursive: true });

	let cmd;
	let args;
	if (spec.kind === "claude") {
		cmd = CLAUDE_BIN;
		args = [
			"-p",
			spec.prompt,
			"--output-format",
			"json",
			"--permission-mode",
			PERMISSION_MODE,
			"--allowedTools",
			...DEFAULT_ALLOWED_TOOLS,
			"--disallowedTools",
			...DISALLOWED_TOOLS,
		];
		if (spec.model) args.push("--model", spec.model);
		fs.writeFileSync(path.join(jobDir(id), "prompt.md"), spec.prompt);
	} else {
		cmd = "/bin/bash";
		args = [...spec.script, ...spec.args];
	}

	const stdout = fs.openSync(path.join(jobDir(id), "stdout.log"), "w");
	const stderr = fs.openSync(path.join(jobDir(id), "stderr.log"), "w");

	const env = { ...process.env, CLAUDE_BRIDGE_WORKSPACE_ROOT: WORKSPACE_ROOT };
	delete env.CLAUDE_BRIDGE_TOKEN;

	// detached -> own process group, so a timeout kills claude and everything it spawned
	const child = spawn(cmd, args, { cwd: spec.cwd, env, stdio: ["ignore", stdout, stderr], detached: true });
	fs.closeSync(stdout);
	fs.closeSync(stderr);

	const job = {
		id,
		kind: spec.kind,
		name: spec.name,
		cwd: spec.cwd,
		status: "running",
		createdAt: new Date().toISOString(),
		finishedAt: null,
		timeoutMin: spec.timeoutMin,
		exitCode: null,
		result: null,
		sessionId: null,
		costUsd: null,
		usage: null,
		modelUsage: null,
		error: null,
		child,
	};
	jobs.set(id, job);

	job.timer = setTimeout(() => {
		job.status = "timeout";
		killGroup(job);
	}, spec.timeoutMin * 60_000);

	child.on("error", (err) => {
		job.error = `failed to start ${cmd}: ${err.message}`;
	});

	child.on("close", (code) => {
		clearTimeout(job.timer);
		job.exitCode = code;
		job.finishedAt = new Date().toISOString();
		const out = fs.readFileSync(path.join(jobDir(id), "stdout.log"), "utf8");
		if (job.kind === "claude") {
			try {
				const parsed = JSON.parse(out);
				job.result = parsed.result ?? null;
				job.sessionId = parsed.session_id ?? null;
				job.costUsd = parsed.total_cost_usd ?? null;
				job.usage = parsed.usage ?? null;
				job.modelUsage = parsed.modelUsage ?? null;
				if (parsed.is_error) job.error = job.error || `claude reported an error (${parsed.subtype || "unknown"})`;
			} catch {
				job.result = out.trim() || null;
				job.error = job.error || "claude output was not valid JSON";
			}
		} else {
			// scripts print their machine-readable result as the last stdout line
			const last = out.trim().split("\n").pop() || "";
			try {
				job.result = JSON.parse(last);
			} catch {
				job.result = out.trim() || null;
			}
		}
		if (job.status === "running") job.status = code === 0 && !job.error ? "succeeded" : "failed";
		delete job.child;
		persist(job);
		log(`job ${id} (${job.kind}${job.name ? ":" + job.name : ""}) -> ${job.status} exit=${code}`);
	});

	persist(job);
	log(`job ${id} started (${spec.kind}${spec.name ? ":" + spec.name : ""}) in ${spec.cwd}`);
	return job;
}

function killGroup(job) {
	if (!job.child) return;
	const pid = job.child.pid;
	try {
		process.kill(-pid, "SIGTERM");
	} catch {
		// already gone
	}
	setTimeout(() => {
		try {
			process.kill(-pid, "SIGKILL");
		} catch {
			// already gone
		}
	}, 10_000).unref();
}

function authorized(req) {
	const header = req.headers.authorization || "";
	const given = Buffer.from(header.replace(/^Bearer\s+/i, ""));
	const want = Buffer.from(TOKEN);
	return given.length === want.length && crypto.timingSafeEqual(given, want);
}

function send(res, status, body) {
	res.writeHead(status, { "content-type": "application/json" });
	res.end(JSON.stringify(body));
}

function readBody(req) {
	return new Promise((resolve, reject) => {
		let size = 0;
		const chunks = [];
		req.on("data", (c) => {
			size += c.length;
			if (size > 1_000_000) {
				reject(Object.assign(new Error("body too large"), { statusCode: 413 }));
				req.destroy();
				return;
			}
			chunks.push(c);
		});
		req.on("end", () => {
			try {
				resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {});
			} catch {
				reject(Object.assign(new Error("invalid JSON body"), { statusCode: 400 }));
			}
		});
		req.on("error", reject);
	});
}

async function handle(req, res) {
	if (!authorized(req)) return send(res, 401, { error: "unauthorized" });

	const url = new URL(req.url, "http://bridge");
	const jobMatch = url.pathname.match(/^\/jobs\/([\w-]+)$/);

	if (req.method === "GET" && url.pathname === "/health") {
		let claudeVersion = null;
		try {
			claudeVersion = execFileSync(CLAUDE_BIN, ["--version"], { encoding: "utf8", timeout: 15_000 }).trim();
		} catch (err) {
			return send(res, 503, { ok: false, error: `claude CLI unavailable: ${err.message}` });
		}
		return send(res, 200, { ok: true, claudeVersion, workspaceRoot: WORKSPACE_ROOT, permissionMode: PERMISSION_MODE });
	}

	if (req.method === "POST" && url.pathname === "/jobs") {
		const spec = validateJob(await readBody(req));
		const job = startJob(spec);
		return send(res, 202, { jobId: job.id, status: job.status });
	}

	if (jobMatch && req.method === "GET") {
		const job = jobs.get(jobMatch[1]);
		if (!job) return send(res, 404, { error: "no such job" });
		return send(res, 200, publicView(job));
	}

	if (jobMatch && req.method === "DELETE") {
		const job = jobs.get(jobMatch[1]);
		if (!job) return send(res, 404, { error: "no such job" });
		if (job.status === "running") {
			job.status = "cancelled";
			killGroup(job);
		}
		return send(res, 200, publicView(job));
	}

	return send(res, 404, { error: "not found" });
}

if (!TOKEN || TOKEN.length < 32) {
	log("FATAL: CLAUDE_BRIDGE_TOKEN must be set (>= 32 chars) — see n8n/scripts/bridge-up.sh");
	process.exit(1);
}

fs.mkdirSync(WORKSPACE_ROOT, { recursive: true });
loadJobs();

http
	.createServer((req, res) => {
		handle(req, res).catch((err) => send(res, err.statusCode || 400, { error: err.message }));
	})
	.listen(PORT, HOST, () => {
		log(`listening on http://${HOST}:${PORT} (workspace root ${WORKSPACE_ROOT}, permission mode ${PERMISSION_MODE})`);
	});
