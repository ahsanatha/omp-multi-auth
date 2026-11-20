import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const extension = join(root, "extensions", "multi-auth.ts");
const agentDir = mkdtempSync(join(tmpdir(), "omp-multi-auth-sub-usage-"));
const savedUsage = join(agentDir, "cache", "multi-auth-usage.json");
const env = { ...process.env, PI_CODING_AGENT_DIR: agentDir, MULTI_SUB: "anthropic:2" };

// Stands in for Anthropic's OAuth API so the probe never leaves the machine.
const upstream = { status: 200, usageCalls: 0 };
const server = createServer((req, res) => {
	res.setHeader("content-type", "application/json");
	if (!req.url.endsWith("/api/oauth/usage")) return res.end("{}");
	upstream.usageCalls += 1;
	if (upstream.status !== 200) {
		res.statusCode = upstream.status;
		return res.end("{}");
	}
	const resets_at = new Date(Date.now() + 3_600_000).toISOString();
	res.end(JSON.stringify({ five_hour: { utilization: 12, resets_at }, seven_day: { utilization: 34, resets_at } }));
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
writeFileSync(join(agentDir, "models.yml"), `providers:\n  anthropic-2:\n    baseUrl: http://127.0.0.1:${server.address().port}\n`);

// Each call is a fresh omp process, and omp drops its own cached reports for anthropic-2 on startup.
async function usage() {
	const child = spawn("omp", ["usage", "--json", "--provider", "anthropic-2", "--no-extensions", "-e", extension], { cwd: root, env });
	const out = [];
	const err = [];
	child.stdout.on("data", (chunk) => out.push(chunk));
	child.stderr.on("data", (chunk) => err.push(chunk));
	const code = await new Promise((resolve) => child.once("close", resolve));
	assert.equal(code, 0, Buffer.concat(err).toString());
	return JSON.parse(Buffer.concat(out).toString());
}

const fiveHourUsed = (report) => report.limits.find((l) => (l.window?.id ?? l.scope.windowId) === "5h")?.amount.usedFraction;

try {
	await usage(); // creates agent.db
	const db = new DatabaseSync(join(agentDir, "agent.db"));
	db.prepare("INSERT INTO auth_credentials (provider, credential_type, data, identity_key) VALUES (?, 'oauth', ?, ?)").run(
		"anthropic-2",
		JSON.stringify({ access: "sk-ant-oat01-test", refresh: "refresh", expires: Date.now() + 86_400_000, email: "sub@example.com", accountId: "acct-2" }),
		"email:sub@example.com",
	);
	db.close();

	const first = await usage();
	const report = first.reports.find((r) => r.provider === "anthropic-2");
	assert.ok(report, `no anthropic-2 report: ${JSON.stringify(first)}`);
	assert.ok(report.limits.every((l) => l.scope.provider === "anthropic-2"), "limits must be relabeled to the sub");
	assert.equal(fiveHourUsed(report), 0.12);
	assert.equal(upstream.usageCalls, 1);

	const second = await usage();
	assert.equal(upstream.usageCalls, 1, "a new process within 5 minutes must reuse the saved report");
	assert.equal(second.reports.find((r) => r.provider === "anthropic-2")?.fetchedAt, report.fetchedAt);

	const saved = JSON.parse(readFileSync(savedUsage, "utf8"));
	for (const entry of Object.values(saved)) entry.fetchedAt -= 10 * 60_000;
	writeFileSync(savedUsage, JSON.stringify(saved));
	upstream.status = 429;
	const throttled = await usage();
	assert.equal(upstream.usageCalls, 2, "a stale saved report must be refreshed");
	const lastGood = throttled.reports.find((r) => r.provider === "anthropic-2");
	assert.ok(lastGood, `a 429 must keep the last good report: ${JSON.stringify(throttled)}`);
	assert.equal(fiveHourUsed(lastGood), 0.12);

	console.log("sub usage check passed");
} finally {
	server.close();
	rmSync(agentDir, { recursive: true, force: true });
}
