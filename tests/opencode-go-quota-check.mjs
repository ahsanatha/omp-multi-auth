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
const agentDir = mkdtempSync(join(tmpdir(), "omp-multi-auth-opencode-go-quota-"));
const capturePath = join(agentDir, "usage-request.json");
const stubExtension = join(agentDir, "stub.ts");
const baseArgs = ["--mode", "rpc", "--no-extensions", "--no-skills", "--no-rules", "--no-lsp", "--no-session"];
const env = { ...process.env, PI_CODING_AGENT_DIR: agentDir, MULTI_SUB: "opencode-go:1", MP_CAPTURE: capturePath };

// Serves MP_USAGE_STATUS / MP_USAGE_BODY for the usage route and records the request.
writeFileSync(
	stubExtension,
	`import { writeFileSync } from "node:fs";
const originalFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = String(input instanceof Request ? input.url : input);
  if (!url.endsWith("/v1/usage")) return originalFetch(input, init);
  writeFileSync(process.env.MP_CAPTURE, JSON.stringify({ url, headers: Object.fromEntries(new Headers(init?.headers)) }));
  return new Response(process.env.MP_USAGE_BODY, { status: Number(process.env.MP_USAGE_STATUS), headers: { "content-type": "application/json" } });
};
export default function stub() {}
`,
);

const resetsAt = new Date(Date.now() + 3 * 3_600_000).toISOString();
const win = (percent, status = "ok") => ({ status, percent, resetsAt });
const usage = (rolling, weekly, monthly) => JSON.stringify({ usage: { rolling, weekly, monthly } });

async function run(status, body) {
	rmSync(capturePath, { force: true });
	const child = spawn(
		"omp",
		[...baseArgs, "--model", "opencode-go-2/beam-free", "--extension", extension, "--extension", stubExtension],
		{ cwd: root, env: { ...env, MP_USAGE_STATUS: String(status), MP_USAGE_BODY: body } },
	);
	const closed = new Promise((resolve) => child.once("close", resolve));
	const statuses = [];
	createInterface({ input: child.stdout }).on("line", (line) => {
		try {
			const event = JSON.parse(line);
			if (event.method === "setStatus" && event.statusKey === "multi-auth-quota") statuses.push(event.statusText);
		} catch {
			// non-JSON protocol noise
		}
	});
	try {
		for (let i = 0; i < 300 && !existsSync(capturePath); i++) await new Promise((r) => setTimeout(r, 100));
		assert.ok(existsSync(capturePath), "usage route was never requested");
		await new Promise((r) => setTimeout(r, 1000)); // let the status line settle
		return { request: JSON.parse(readFileSync(capturePath, "utf8")), shown: statuses.filter(Boolean) };
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

	// Weekly is the tightest of rolling/weekly: 7d 40% left.
	let { request, shown } = await run(200, usage(win(20), win(60), win(10)));
	assert.equal(request.url, "https://opencode.ai/inference/go/v1/usage");
	assert.equal(request.headers.authorization, "Bearer test-key");
	assert.ok(request.headers["x-opencode-session"], "usage poll must send x-opencode-session");
	assert.match(shown.at(-1) ?? "", /^7d 40% /, `unexpected status: ${JSON.stringify(shown)}`);

	// An exhausted monthly window is display-only and must not surface as the worst window.
	({ shown } = await run(200, usage(win(10), win(10), win(100, "rate-limited"))));
	assert.match(shown.at(-1) ?? "", /^5h 90% /, `monthly leaked into status: ${JSON.stringify(shown)}`);

	// A rate-limited rolling window counts as 0% left.
	({ shown } = await run(200, usage(win(10, "rate-limited"), win(10), win(10))));
	assert.match(shown.at(-1) ?? "", /^5h 0% /, `unexpected status: ${JSON.stringify(shown)}`);

	// Partial or failed responses leave the status line blank.
	({ shown } = await run(200, JSON.stringify({ usage: { rolling: win(10), weekly: win(10) } })));
	assert.deepEqual(shown, [], "partial usage payload must not render");
	({ shown } = await run(401, JSON.stringify({ error: { message: "Missing API key" } })));
	assert.deepEqual(shown, [], "401 must not render");

	console.log("OpenCode Go quota check passed");
} finally {
	rmSync(agentDir, { recursive: true, force: true });
}
