import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const agentDir = mkdtempSync(join(tmpdir(), "omp-multi-auth-transport-"));
const capturePath = join(agentDir, "capture.jsonl");
const captureExtension = join(agentDir, "capture.ts");
mkdirSync(join(agentDir, "home"));

// Nothing listens here; overrides point at it and it is the proxy of last resort.
const dead = "http://127.0.0.1:9";
// Base providers hold their own keys so a clone sharing them is caught.
const baseKeys = { anthropic: "base-anthropic-key", "opencode-go": "base-opencode-key", "github-copilot": "base-copilot-token" };

// Children see only what the test gives them, never the user's keys.
const env = {
	PATH: process.env.PATH,
	HOME: join(agentDir, "home"),
	PI_CODING_AGENT_DIR: agentDir,
	MULTI_SUB: "anthropic:1,opencode-go:1,github-copilot:1",
	MP_CAPTURE: capturePath,
	ANTHROPIC_API_KEY: baseKeys.anthropic,
	OPENCODE_API_KEY: baseKeys["opencode-go"],
	COPILOT_GITHUB_TOKEN: baseKeys["github-copilot"],
	HTTP_PROXY: dead,
	HTTPS_PROXY: dead,
	ALL_PROXY: dead,
};
const baseArgs = ["--mode", "rpc", "--no-extensions", "--no-skills", "--no-rules", "--no-lsp", "--no-session", "--model", "opencode-go/beam-free"];

// Records every outbound request and answers it locally; no real network call.
writeFileSync(
	captureExtension,
	`import { appendFileSync } from "node:fs";
globalThis.fetch = async (input, init) => {
  const request = input instanceof Request ? input : undefined;
  const url = String(request?.url ?? input);
  if (url.endsWith("/usage")) return new Response("{}", { status: 401 });
  const headers = Object.fromEntries(new Headers(init?.headers ?? request?.headers));
  appendFileSync(process.env.MP_CAPTURE, JSON.stringify({ url, headers }) + "\\n");
  return new Response('{"type":"error","error":{"type":"invalid_request_error","message":"stand-in"}}', { status: 400, headers: { "content-type": "application/json" } });
};
export default function capture() {}
`,
);

// One bounded omp child; an early exit rejects every pending request.
function startOmp() {
	const child = spawn("omp", [...baseArgs, "--extension", join(root, "extensions", "multi-auth.ts"), "--extension", captureExtension], { cwd: root, env, timeout: 120_000 });
	const stderr = [];
	const events = [];
	const waiters = new Set();
	let exit;
	const fail = (reason) => {
		for (const waiter of waiters) waiter.reject(new Error(`${reason}: ${Buffer.concat(stderr)}`));
		waiters.clear();
	};
	child.stderr.on("data", (chunk) => stderr.push(chunk));
	child.stdin.on("error", () => {});
	child.once("error", (error) => fail(error.message));
	const closed = new Promise((resolve) =>
		child.once("close", (code, signal) => {
			exit = `code ${code} signal ${signal}`;
			fail(`omp closed early (${exit})`);
			resolve();
		}),
	);
	createInterface({ input: child.stdout }).on("line", (line) => {
		let event;
		try {
			event = JSON.parse(line);
		} catch {
			return;
		}
		events.push(event);
		for (const waiter of waiters) {
			if (!waiter.matches(event)) continue;
			waiters.delete(waiter);
			waiter.resolve(event);
		}
	});
	return {
		events,
		send: (request, matches = (event) => event.id === request.id) =>
			new Promise((resolve, reject) => {
				if (exit) return reject(new Error(`omp already closed (${exit}): ${Buffer.concat(stderr)}`));
				waiters.add({ matches, resolve, reject });
				child.stdin.write(`${JSON.stringify(request)}\n`);
			}),
		close: async () => {
			child.kill();
			await closed;
		},
	};
}

// Selects each clone model, prompts once, and checks the request that reached fetch.
async function wire(label, cases, tag) {
	writeFileSync(capturePath, "");
	const omp = startOmp();
	let logged = 0;
	try {
		for (const c of cases) {
			const name = `${label} ${c.clone}/${c.id}`;
			await omp.send({ id: "new", type: "new_session" });
			const set = await omp.send({ id: "model", type: "set_model", provider: c.clone, modelId: c.id });
			assert.equal(set.success, true, `${name}: ${JSON.stringify(set)}`);
			const base = tag ? `${dead}/${tag}-${c.provider}` : undefined;
			if (c.modelBase) assert.equal(set.data.baseUrl, base ?? c.modelBase, `${name}: wrong model baseUrl`);

			await omp.send({ id: "prompt", type: "prompt", message: "say hi" }, (event) => event.type === "agent_end");
			const log = readFileSync(capturePath, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)).slice(logged);
			logged += log.length;
			const sent = log.filter((request) => /\/(messages|chat\/completions|responses)$/.test(new URL(request.url).pathname));
			assert.ok(sent.length > 0, `${name}: no inference request, saw ${JSON.stringify(log.map((request) => request.url))}`);
			for (const { url, headers } of sent) {
				assert.equal(url.split("?")[0], base ? `${base}${c.path}` : c.url, `${name}: wrong outbound url`);
				assert.equal(headers["x-proxy-key"], tag ? `${tag}-${c.provider}` : undefined, `${name}: wrong x-proxy-key`);
				const secret = `${headers.authorization} ${headers["x-api-key"]}`;
				assert.ok(secret.includes(c.key), `${name}: clone credential not sent`);
				assert.ok(!secret.includes(baseKeys[c.provider]), `${name}: clone sent the base provider's credential`);
			}
			console.log(`${name} -> ${sent[0].url}`);
		}
		assert.doesNotMatch(JSON.stringify(omp.events), /"type":"extension_error"/);
	} finally {
		await omp.close();
	}
}

const clone = (provider, id, key, url, path, modelBase) => ({ provider, clone: `${provider}-2`, id, key, url, path, modelBase });
const anthropic = clone("anthropic", "claude-haiku-4-5", "test-anthropic-2-key", "https://api.anthropic.com/v1/messages", "/v1/messages", "https://api.anthropic.com");
const go = clone("opencode-go", "beam-free", "test-opencode-go-2-key", "https://opencode.ai/inference/go/v1/chat/completions", "/chat/completions");
const copilot = clone("github-copilot", "claude-haiku-4.5", "fake-token", "https://api.individual.githubcopilot.com/v1/messages", "/v1/messages");
// The anthropic-dialect sample guards the per-dialect catalog URL: the registered clone URL belongs to another dialect.
const goAnthropic = { ...go, id: "claude-haiku-5-5", url: "https://opencode.ai/inference/go/v1/messages" };
const overrides = (tag) =>
	`providers:\n${Object.keys(baseKeys).map((provider) => `  ${provider}:\n    baseUrl: ${dead}/${tag}-${provider}\n    headers:\n      x-proxy-key: ${tag}-${provider}\n`).join("")}`;

try {
	// Without any key omp refuses to start ("No default model selected"); the dummy base keys let it create agent.db.
	const bootstrap = spawnSync("omp", baseArgs, { cwd: root, env, input: '{"id":"bootstrap","type":"get_state"}\n', encoding: "utf8", timeout: 60_000 });
	assert.equal(bootstrap.error, undefined, bootstrap.error?.message);
	assert.equal(bootstrap.status, 0, bootstrap.stderr);

	const db = new DatabaseSync(join(agentDir, "agent.db"));
	const insert = db.prepare("INSERT INTO auth_credentials (provider, credential_type, data, identity_key) VALUES (?, ?, ?, NULL)");
	insert.run("anthropic-2", "api_key", JSON.stringify({ key: anthropic.key }));
	insert.run("opencode-go-2", "api_key", JSON.stringify({ key: go.key }));
	insert.run("github-copilot-2", "oauth", JSON.stringify({ access: "fake-token;proxy-ep=proxy.individual.githubcopilot.com", refresh: "fake-refresh", expires: Date.now() + 3600000 }));
	db.close();

	// No models file: accounts keep catalog endpoints, token-derived for Copilot.
	await wire("default", [anthropic, go, goAnthropic, copilot]);

	// models.yml wins; the models.yaml beside it is ignored.
	writeFileSync(join(agentDir, "models.yml"), overrides("yml"));
	writeFileSync(join(agentDir, "models.yaml"), overrides("yaml"));
	await wire("models.yml", [anthropic, go, copilot], "yml");

	// models.yaml is read only when models.yml is absent.
	rmSync(join(agentDir, "models.yml"));
	await wire("models.yaml", [anthropic, go, copilot], "yaml");
	console.log("Base transport check passed");
} finally {
	rmSync(agentDir, { recursive: true, force: true });
}
