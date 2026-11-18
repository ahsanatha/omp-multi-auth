import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const extension = join(root, "extensions", "multi-auth.ts");
const agentDir = mkdtempSync(join(tmpdir(), "omp-multi-auth-opencode-go-"));
const capturePath = join(agentDir, "capture.json");
const captureExtension = join(agentDir, "capture.ts");
const baseArgs = ["--mode", "rpc", "--no-extensions", "--no-skills", "--no-rules", "--no-lsp", "--no-session"];
const env = { ...process.env, PI_CODING_AGENT_DIR: agentDir, MULTI_SUB: "opencode-go:1", MP_CAPTURE: capturePath };

// Records the first outbound request, then exits before any real network call.
writeFileSync(
	captureExtension,
	`import { writeFileSync } from "node:fs";
const originalFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  if (String(input instanceof Request ? input.url : input).endsWith("/v1/usage")) return new Response("{}", { status: 401 });
  const headers = Object.fromEntries(new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined)));
  writeFileSync(process.env.MP_CAPTURE, JSON.stringify({ url: String(input instanceof Request ? input.url : input), headers }));
  setTimeout(() => process.exit(0), 25);
  return originalFetch("data:,", { headers: { "content-type": "text/event-stream" } });
};
export default function capture() {}
`,
);

async function capture(model) {
	rmSync(capturePath, { force: true });
	const child = spawn("omp", [...baseArgs, "--model", `opencode-go-2/${model.id}`, "--extension", extension, "--extension", captureExtension], { cwd: root, env });
	const closed = new Promise((resolve) => child.once("close", resolve));
	const stderr = [];
	child.stderr.on("data", (chunk) => stderr.push(chunk));
	child.stdin.write('{"id":"capture","type":"prompt","message":"say hi"}\n');
	try {
		for (let i = 0; i < 300 && !existsSync(capturePath); i++) await new Promise((r) => setTimeout(r, 100));
		assert.ok(existsSync(capturePath), `no request for ${model.id}: ${Buffer.concat(stderr)}`);
		return JSON.parse(readFileSync(capturePath, "utf8"));
	} finally {
		if (child.exitCode === null) child.kill("SIGTERM");
		await closed;
	}
}

try {
	const bootstrap = spawnSync("omp", baseArgs, {
		cwd: root,
		env,
		input: '{"id":"bootstrap","type":"get_available_models"}\n',
		encoding: "utf8",
		maxBuffer: 64 * 1024 * 1024,
		timeout: 30_000,
	});
	assert.equal(bootstrap.status, 0, bootstrap.stderr);
	const db = new DatabaseSync(join(agentDir, "agent.db"));
	db.prepare("INSERT INTO auth_credentials (provider, credential_type, data, identity_key) VALUES (?, 'api_key', ?, NULL)")
		.run("opencode-go-2", JSON.stringify({ key: "test-key" }));
	db.close();

	const listed = spawnSync("omp", [...baseArgs, "--extension", extension], {
		cwd: root,
		env,
		input: '{"id":"models","type":"get_available_models"}\n',
		encoding: "utf8",
		maxBuffer: 64 * 1024 * 1024,
		timeout: 30_000,
	});
	assert.equal(listed.status, 0, listed.stderr);
	const response = listed.stdout.split("\n").filter(Boolean).map((l) => JSON.parse(l)).find((e) => e.id === "models");
	const models = response.data.models.filter((m) => m.provider === "opencode-go-2");
	assert.ok(models.length > 0, "missing models for opencode-go-2");

	console.log(`opencode-go-2 models: ${models.length}`);
	// Clones carry the custom transport api; the real dialect is picked per model inside the transport.
	assert.ok(models.every((m) => m.api === "opencode-go-mp"), "clones must use the opencode-go-mp transport");

	// One probe per catalog dialect; ids are catalog samples, absent ones are skipped.
	const probes = [
		{ id: "claude-haiku-5-5", path: "/inference/go/v1/messages", auth: "x-api-key" },
		{ id: "beam-free", path: "/inference/go/v1/chat/completions", auth: "authorization" },
		{ id: "deepseek-v4-flash", path: "/inference/go/v1/responses", auth: "authorization" },
		{ id: "gemini-4-argon", path: "/inference/go/v1/models/gemini-4-argon:streamGenerateContent", auth: "x-goog-api-key" },
	];
	let probed = 0;
	for (const probe of probes) {
		const model = models.find((m) => m.id === probe.id);
		if (!model) { console.log(`skip ${probe.id}: not in catalog`); continue; }
		const { url, headers } = await capture(model);
		console.log(`${model.id} -> ${url}`);
		assert.ok(url.includes(probe.path), `${model.id}: unexpected url ${url}`);
		assert.ok(url.startsWith("https://opencode.ai/inference/go"), `${model.id}: unexpected host/base ${url}`);
		assert.ok(headers["x-opencode-session"], `${model.id}: missing x-opencode-session`);
		if (probe.auth === "x-api-key") {
			assert.equal(headers["x-api-key"], "test-key", `${model.id}: anthropic must send x-api-key`);
			assert.equal(headers.authorization, undefined, `${model.id}: anthropic must not send authorization`);
		} else if (probe.auth === "authorization") {
			assert.equal(headers.authorization, "Bearer test-key", `${model.id}: expected bearer auth`);
		} else {
			assert.equal(headers["x-goog-api-key"], "test-key", `${model.id}: expected x-goog-api-key`);
		}
		probed++;
	}
	assert.ok(probed >= 2, "too few dialect probes ran");
	console.log("OpenCode Go provider check passed");
} finally {
	rmSync(agentDir, { recursive: true, force: true });
}
