/**
 * End-to-end checks for pi-answer-now.
 *
 * Each test starts pi in RPC mode against a mock engine, runs a real turn,
 * sends /answer while that turn streams, and reads what the extension showed
 * and what the engine received. Nothing is stubbed inside the extension.
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { startMockEngine } from "./mock-engine.mjs";

const PACKAGE_DIR = join(import.meta.dirname, "..");
const READY_TIMEOUT_MS = 60_000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class RpcClient {
  constructor(child) {
    this.child = child;
    this.records = [];
    let buffer = "";
    child.stdout.on("data", (chunk) => {
      buffer += chunk.toString();
      for (;;) {
        const cut = buffer.indexOf("\n");
        if (cut < 0) {
          break;
        }
        const line = buffer.slice(0, cut).trim();
        buffer = buffer.slice(cut + 1);
        if (line === "") {
          continue;
        }
        try {
          this.records.push(JSON.parse(line));
        } catch {
          // Startup text before the protocol starts.
        }
      }
    });
    child.stderr.on("data", () => {
      // Diagnostics. A failure shows in the assertions instead.
    });
  }

  send(command) {
    this.child.stdin.write(`${JSON.stringify(command)}\n`);
  }

  notifyTexts() {
    return this.records
      .filter((record) => record.type === "extension_ui_request" && record.method === "notify")
      .map((record) => record.message);
  }

  async until(match, timeoutMs = READY_TIMEOUT_MS) {
    const started = Date.now();
    for (;;) {
      const hit = this.records.find(match);
      if (hit !== undefined) {
        return hit;
      }
      if (this.child.exitCode !== null) {
        throw new Error(
          `pi exited with ${this.child.exitCode}; last records: ${JSON.stringify(this.records.slice(-4))}`,
        );
      }
      if (Date.now() - started > timeoutMs) {
        throw new Error(`timed out; last records: ${JSON.stringify(this.records.slice(-6))}`);
      }
      await sleep(25);
    }
  }
}

/** Starts pi with only this package loaded, pointed at `origin`. */
async function openSession({ provider, model, origin, settings, agentFiles }) {
  const dir = mkdtempSync(join(tmpdir(), "pi-answer-now-"));
  writeFileSync(
    join(dir, "models.json"),
    JSON.stringify(
      {
        providers: {
          [provider]: {
            baseUrl: `${origin}/v1`,
            api: "openai-completions",
            apiKey: "test-key",
            models: [{ id: model }],
          },
        },
      },
      null,
      2,
    ),
  );
  if (settings !== undefined) {
    writeFileSync(join(dir, "settings.json"), JSON.stringify(settings, null, 2));
  }
  for (const [name, value] of Object.entries(agentFiles ?? {})) {
    writeFileSync(join(dir, name), JSON.stringify(value, null, 2));
  }

  const child = spawn(
    "pi",
    [
      "-ne",
      "-e",
      PACKAGE_DIR,
      "--no-session",
      "--mode",
      "rpc",
      "--provider",
      provider,
      "--model",
      model,
    ],
    {
      cwd: dir,
      env: {
        ...process.env,
        PI_CODING_AGENT_DIR: dir,
        PI_OFFLINE: "1",
        PI_SKIP_VERSION_CHECK: "1",
        PI_TELEMETRY: "0",
      },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  const client = new RpcClient(child);
  client.send({ id: "ready", type: "get_state" });
  await client.until((record) => record.type === "response" && record.id === "ready");
  return {
    client,
    dir,
    async close() {
      child.kill();
      await sleep(100);
    },
  };
}

function findNotify(client, pattern) {
  return client.notifyTexts().find((message) => pattern.test(message));
}

test("basalt engine: interrupts the running reply", async () => {
  const mock = await startMockEngine();
  const session = await openSession({
    provider: "mock",
    model: "mock-basalt",
    origin: mock.origin,
  });
  try {
    // Before any request, there is no id to name.
    session.client.send({ type: "prompt", message: "/answer" });
    await session.client.until(() => findNotify(session.client, /No request id yet/) !== undefined);
    assert.equal(
      mock.engine.calls.some((call) => call.answerNow),
      false,
      "the extension posted before it had a request id",
    );

    const arriving = mock.engine.nextChat();
    session.client.send({ type: "prompt", message: "Think hard about recursion" });
    const requestId = await arriving;
    // Let the response headers reach the extension.
    await sleep(250);

    session.client.send({ type: "prompt", message: "/answer" });
    const shown = await session.client.until(
      () => findNotify(session.client, /closed the thinking/) !== undefined,
    );
    const message = findNotify(session.client, /closed the thinking/);
    assert.ok(message.includes(requestId), `expected the request id ${requestId} in: ${message}`);
    assert.ok(shown !== undefined);

    const call = mock.engine.lastAnswerNow();
    assert.equal(call.path, "/v1/answer_now");
    assert.deepEqual(call.body, { request_id: requestId });

    await session.client.until(() => mock.engine.history.length > 0);
    const finished = mock.engine.lastFinished();
    assert.equal(finished.interrupted, true);
    assert.ok(
      finished.thinkingTokens < 30,
      `thinking ran to ${finished.thinkingTokens} tokens, so nothing was cut short`,
    );
    assert.ok(finished.answerTokens > 0, "the reply never reached its answer");
  } finally {
    await session.close();
    await mock.stop();
  }
});

test("llama-swap: reaches the engine through /upstream with credentials", async () => {
  const mock = await startMockEngine({ swap: true });
  const session = await openSession({ provider: "swap", model: "mock-swap", origin: mock.origin });
  try {
    const arriving = mock.engine.nextChat();
    session.client.send({ type: "prompt", message: "Think hard about recursion" });
    const requestId = await arriving;
    await sleep(250);

    session.client.send({ type: "prompt", message: "/answer" });
    await session.client.until(
      () => findNotify(session.client, /closed the thinking/) !== undefined,
    );

    const answerCalls = mock.engine.calls.filter((call) => call.answerNow);
    assert.equal(
      answerCalls.length,
      2,
      `expected one 404 and one upstream call, saw ${JSON.stringify(answerCalls.map((call) => call.path))}`,
    );
    assert.equal(answerCalls[0].path, "/v1/answer_now");
    assert.equal(answerCalls[1].path, "/upstream/mock-swap/v1/answer_now");
    assert.deepEqual(answerCalls[1].body, { request_id: requestId });
    assert.match(
      answerCalls[1].headers.authorization ?? "",
      /^Bearer test-key$/,
      "llama-swap auth was missing",
    );
  } finally {
    await session.close();
    await mock.stop();
  }
});

test("engine without the route: one readable refusal", async () => {
  const mock = await startMockEngine({ props: "llamacpp", answerRoute: "missing" });
  const session = await openSession({
    provider: "plain",
    model: "mock-plain",
    origin: mock.origin,
  });
  try {
    const arriving = mock.engine.nextChat();
    session.client.send({ type: "prompt", message: "Think hard about recursion" });
    await arriving;
    await sleep(250);

    session.client.send({ type: "prompt", message: "/answer" });
    const shown = await session.client.until(
      () =>
        findNotify(session.client, /does not offer answer now|has no \/v1\/answer_now route/) !==
        undefined,
    );
    const warnings = session.client.records.filter(
      (record) =>
        record.type === "extension_ui_request" &&
        record.method === "notify" &&
        record.notifyType === "warning",
    );
    assert.equal(
      warnings.length,
      1,
      `expected one warning line, saw ${JSON.stringify(warnings.map((record) => record.message))}`,
    );
    assert.ok(shown !== undefined);
    await session.client.until(() => mock.engine.history.length > 0);
    assert.equal(
      mock.engine.history.at(-1).interrupted,
      false,
      "an engine without the feature must not be interrupted",
    );
  } finally {
    await session.close();
    await mock.stop();
  }
});

test("front door blocks both answer-now paths: one readable refusal", async () => {
  const mock = await startMockEngine({ swap: true, props: "basalt", answerRoute: "blocked" });
  const session = await openSession({ provider: "swap", model: "mock-swap", origin: mock.origin });
  try {
    const arriving = mock.engine.nextChat();
    session.client.send({ type: "prompt", message: "Think hard about recursion" });
    await arriving;
    await sleep(250);

    session.client.send({ type: "prompt", message: "/answer" });
    const shown = await session.client.until(
      () => findNotify(session.client, /does not pass those paths/) !== undefined,
    );
    assert.ok(shown !== undefined);

    const answerCalls = mock.engine.calls.filter((call) => call.answerNow);
    assert.deepEqual(
      answerCalls.map((call) => call.path),
      ["/v1/answer_now", "/upstream/mock-swap/v1/answer_now"],
      "expected one try on each answer-now route",
    );
    await session.client.until(() => mock.engine.history.length > 0);
    assert.equal(
      mock.engine.history.at(-1).interrupted,
      false,
      "a blocked front door must not interrupt anything",
    );
  } finally {
    await session.close();
    await mock.stop();
  }
});

test("a header id the engine does not know still interrupts the streaming reply", async () => {
  const mock = await startMockEngine({ idDrift: true });
  const session = await openSession({
    provider: "plain",
    model: "mock-plain",
    origin: mock.origin,
  });
  try {
    const arriving = mock.engine.nextChat();
    session.client.send({ type: "prompt", message: "Think hard about recursion" });
    const requestId = await arriving;
    await sleep(250);

    session.client.send({ type: "prompt", message: "/answer" });
    await session.client.until(
      () => findNotify(session.client, /closed the thinking/) !== undefined,
    );

    const call = mock.engine.calls.find((entry) => entry.answerNow);
    assert.equal(
      call.body.request_id,
      requestId,
      "answer now must name the id the engine streams under, not the header id",
    );
    await session.client.until(() => mock.engine.history.length > 0);
    assert.equal(
      mock.engine.history.at(-1).interrupted,
      true,
      "the running reply must be the one that was interrupted",
    );
  } finally {
    await session.close();
    await mock.stop();
  }
});

test("a stream that never ends cleanly still targets the next reply", async () => {
  const mock = await startMockEngine({ breakFirstChat: true });
  const session = await openSession({
    provider: "plain",
    model: "mock-plain",
    origin: mock.origin,
    settings: { retry: { enabled: false } },
  });
  try {
    const first = mock.engine.nextChat();
    session.client.send({ type: "prompt", message: "Think hard about recursion" });
    await first;
    await session.client.until(() => mock.engine.history.length > 0);

    const second = mock.engine.nextChat();
    session.client.send({ type: "prompt", message: "Think hard about recursion again" });
    const secondId = await second;
    await sleep(250);

    session.client.send({ type: "prompt", message: "/answer" });
    await session.client.until(
      () => findNotify(session.client, /closed the thinking/) !== undefined,
    );
    const call = mock.engine.calls.find((entry) => entry.answerNow);
    assert.equal(
      call.body.request_id,
      secondId,
      "a stream id from a turn that never ended must not become a target",
    );
  } finally {
    await session.close();
    await mock.stop();
  }
});

test("a failed first turn still targets the next reply", async () => {
  const mock = await startMockEngine({ failFirstChat: true });
  const session = await openSession({
    provider: "plain",
    model: "mock-plain",
    origin: mock.origin,
    settings: { retry: { enabled: false } },
  });
  try {
    session.client.send({ type: "prompt", message: "Think hard about recursion" });
    await session.client.until((record) => record.type === "agent_end");

    const arriving = mock.engine.nextChat();
    session.client.send({ type: "prompt", message: "Think hard about recursion again" });
    const requestId = await arriving;
    await sleep(250);

    session.client.send({ type: "prompt", message: "/answer" });
    await session.client.until(
      () => findNotify(session.client, /closed the thinking/) !== undefined,
    );
    const call = mock.engine.calls.find((entry) => entry.answerNow);
    assert.equal(call.body.request_id, requestId);
  } finally {
    await session.close();
    await mock.stop();
  }
});

test("custom keybinding from settings", async () => {
  const mock = await startMockEngine();
  const session = await openSession({
    provider: "mock",
    model: "mock-basalt",
    origin: mock.origin,
    settings: { "pi-answer-now": { keybinding: "ctrl+alt+a" } },
  });
  try {
    // The shortcut is registered from settings; a bad key would have shown a warning.
    session.client.send({ type: "prompt", message: "/answer" });
    await session.client.until(() => findNotify(session.client, /No request id yet/) !== undefined);
    assert.equal(
      findNotify(session.client, /is not a key pi can bind/),
      undefined,
      "a valid key was rejected",
    );
  } finally {
    await session.close();
    await mock.stop();
  }
});

test("reuses the pi-llama-swap capability cache", async () => {
  const mock = await startMockEngine();
  // pi-llama-swap already probed this model, so no /props read follows.
  const session = await openSession({
    provider: "mock",
    model: "mock-basalt",
    origin: mock.origin,
    agentFiles: {
      "pi-llama-swap.json": {
        instances: [
          {
            id: "mock",
            modelCapabilities: { "mock-basalt": { reasoning: true, answerNow: true } },
          },
        ],
      },
    },
  });
  try {
    const arriving = mock.engine.nextChat();
    session.client.send({ type: "prompt", message: "Think hard about recursion" });
    const requestId = await arriving;
    await sleep(250);

    session.client.send({ type: "prompt", message: "/answer" });
    await session.client.until(
      () => findNotify(session.client, /closed the thinking/) !== undefined,
    );

    assert.deepEqual(mock.engine.lastAnswerNow().body, { request_id: requestId });
    const propsReads = mock.engine.calls.filter(
      (call) => call.method === "GET" && call.path === "/props",
    );
    assert.equal(
      propsReads.length,
      0,
      `the extension probed ${propsReads.length} times despite a cached answer`,
    );
  } finally {
    await session.close();
    await mock.stop();
  }
});

test("a late press gets one engine refusal, not a second route", async () => {
  const mock = await startMockEngine();
  const session = await openSession({
    provider: "mock",
    model: "mock-basalt",
    origin: mock.origin,
  });
  try {
    const arriving = mock.engine.nextChat();
    session.client.send({ type: "prompt", message: "Think hard about recursion" });
    await arriving;
    // Let the reply finish, so the engine no longer knows the request.
    await session.client.until(() => mock.engine.history.length > 0);

    session.client.send({ type: "prompt", message: "/answer" });
    await session.client.until(
      () => findNotify(session.client, /no longer knows that request/) !== undefined,
    );

    const answerCalls = mock.engine.calls.filter((call) => call.answerNow);
    assert.equal(
      answerCalls.length,
      1,
      `expected one call, saw ${JSON.stringify(answerCalls.map((call) => call.path))}`,
    );
    assert.equal(answerCalls[0].path, "/v1/answer_now");
  } finally {
    await session.close();
    await mock.stop();
  }
});
