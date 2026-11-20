import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const agentDir = mkdtempSync(join(tmpdir(), "omp-multi-auth-transport-"));

const seen = [];
const server = createServer((req, res) => {
	req.resume();
	seen.push({ path: req.url, proxyKey: req.headers["x-proxy-key"] });
	res.writeHead(400, { "content-type": "application/json" });
	res.end('{"type":"error","error":{"type":"invalid_request_error","message":"stand-in"}}');
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const baseUrl = `http://127.0.0.1:${server.address().port}/anthropic`;

function runOmp(requests) {
	return new Promise((resolve, reject) => {
		const child = spawn(
			"omp",
			[
				"--mode", "rpc", "--no-extensions", "--no-skills", "--no-rules",
				"--no-lsp", "--no-session", "--extension", join(root, "extensions", "multi-auth.ts"),
			],
			{
				cwd: root,
				env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, MULTI_SUB: "anthropic:1" },
				timeout: 60_000,
			},
		);
		const stderr = [];
		child.stderr.on("data", (chunk) => stderr.push(chunk));
		const events = [];
		const waiters = [];
		createInterface({ input: child.stdout }).on("line", (line) => {
			let event;
			try {
				event = JSON.parse(line);
			} catch {
				return;
			}
			events.push(event);
			for (let i = waiters.length - 1; i >= 0; i--) {
				if (waiters[i].matches(event)) waiters.splice(i, 1)[0].resolve(event);
			}
		});
		const waitFor = (matches) => new Promise((res) => waiters.push({ matches, resolve: res }));
		child.once("error", reject);
		(async () => {
			const responses = {};
			for (const { request, until } of requests) {
				const done = waitFor(until ?? ((event) => event.id === request.id));
				child.stdin.write(`${JSON.stringify(request)}\n`);
				responses[request.id] = await done;
			}
			child.stdin.end();
			const code = await new Promise((res) => child.once("close", res));
			resolve({ code, responses, events, stderr: Buffer.concat(stderr).toString() });
		})().catch(reject);
	});
}

try {
	const bootstrap = spawnSync(
		"omp",
		["--mode", "rpc", "--no-extensions", "--no-skills", "--no-rules", "--no-lsp", "--no-session"],
		{
			cwd: root,
			env: { ...process.env, PI_CODING_AGENT_DIR: agentDir },
			input: '{"id":"bootstrap","type":"get_available_models"}\n',
			encoding: "utf8",
			maxBuffer: 64 * 1024 * 1024,
		},
	);
	assert.equal(bootstrap.error, undefined, bootstrap.error?.message);
	assert.equal(bootstrap.status, 0, bootstrap.stderr);

	const db = new DatabaseSync(join(agentDir, "agent.db"));
	db.prepare(
		"INSERT INTO auth_credentials (provider, credential_type, data, identity_key) VALUES (?, 'api_key', ?, NULL)",
	).run("anthropic-2", JSON.stringify({ key: "test-anthropic-2-key" }));
	db.close();

	// set_model answers with the one resolved model, which stays under the RPC
	// frame limit that the whole catalog from get_available_models exceeds.
	const selectSub = { request: { id: "model", type: "set_model", provider: "anthropic-2", modelId: "claude-haiku-4-5" } };

	// Without a models.yml override an added account keeps the catalog endpoint.
	const plain = await runOmp([selectSub]);
	assert.equal(plain.code, 0, plain.stderr);
	assert.equal(plain.responses.model.success, true, JSON.stringify(plain.responses.model));
	assert.equal(plain.responses.model.data.baseUrl, "https://api.anthropic.com", "anthropic-2 left the catalog endpoint without an override");

	writeFileSync(
		join(agentDir, "models.yml"),
		`providers:\n  anthropic:\n    baseUrl: ${baseUrl}\n    headers:\n      x-proxy-key: base-provider-key\n`,
	);

	const proxied = await runOmp([
		selectSub,
		{
			request: { id: "prompt", type: "prompt", message: "say hi" },
			until: (event) => event.type === "agent_end",
		},
	]);
	assert.equal(proxied.code, 0, proxied.stderr);
	assert.doesNotMatch(JSON.stringify(proxied.events), /"type":"extension_error"/);
	assert.equal(proxied.responses.model.success, true, JSON.stringify(proxied.responses.model));
	assert.equal(proxied.responses.model.data.baseUrl, baseUrl, "anthropic-2 did not take the base provider's baseUrl");

	const messages = seen.filter((request) => request.path.startsWith("/anthropic/v1/messages"));
	assert.ok(messages.length > 0, `anthropic-2 sent nothing to the base provider's baseUrl: ${JSON.stringify(seen)}`);
	assert.ok(messages.every((request) => request.proxyKey === "base-provider-key"), `anthropic-2 did not send the base provider's headers: ${JSON.stringify(messages)}`);
	console.log(`anthropic-2 requests at the base provider's baseUrl: ${messages.length}`);
	console.log("Base transport check passed");
} finally {
	server.close();
	rmSync(agentDir, { recursive: true, force: true });
}
