/**
 * Live smoke check against a real basalt engine. Manual, not part of `npm test`.
 *
 * It needs a configured provider and network access, so it is not a test. Run
 * it against a model you do not mind interrupting:
 *
 *   LIVE_CHECK_EXTENSIONS="/path/to/provider-extension" \
 *     node test/live-check.mjs provider/model:high
 *
 * Pi loads only the extensions you list, so name the one that provides the
 * model too. Without it the model does not exist in the process.
 *
 * It starts a turn, presses /answer while the model thinks, then reports what
 * pi showed and whether the reply went on to its answer.
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { join } from "node:path";

const PACKAGE_DIR = join(import.meta.dirname, "..");
const MODEL = process.argv[2];
if (!MODEL) {
  console.error("usage: node test/live-check.mjs <provider/model[:thinking]>");
  process.exit(2);
}
const extraExtensions = (process.env.LIVE_CHECK_EXTENSIONS ?? "")
  .split(/\s+/)
  .filter((path) => path !== "");
const TURN_TIMEOUT_MS = 240_000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const args = ["-ne"];
for (const path of extraExtensions) {
  args.push("-e", path);
}
args.push("-e", PACKAGE_DIR, "--no-session", "--mode", "rpc", "--model", MODEL);

const child = spawn("pi", args, {
  cwd: PACKAGE_DIR,
  stdio: ["pipe", "pipe", "pipe"],
});

const records = [];
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
      records.push(JSON.parse(line));
    } catch {
      // Startup text before the protocol starts.
    }
  }
});
child.stderr.on("data", (chunk) => process.stderr.write(chunk));

const has = (needle) => records.some((record) => JSON.stringify(record).includes(needle));

async function until(predicate, timeoutMs, label) {
  const started = Date.now();
  for (;;) {
    if (predicate()) {
      return;
    }
    if (child.exitCode !== null) {
      throw new Error(`pi exited with ${child.exitCode} waiting for ${label}`);
    }
    if (Date.now() - started > timeoutMs) {
      throw new Error(`timed out waiting for ${label}; notifies: ${JSON.stringify(notifies())}`);
    }
    await sleep(50);
  }
}

function notifies() {
  return records
    .filter((record) => record.type === "extension_ui_request" && record.method === "notify")
    .map((record) => `${record.notifyType}: ${record.message}`);
}

console.log(`model: ${MODEL}`);
child.stdin.write(`${JSON.stringify({ id: "ready", type: "get_state" })}\n`);
await until(() => has('"command":"get_state"'), TURN_TIMEOUT_MS, "pi to start");
const state = records.find((record) => record.command === "get_state")?.data;
console.log(`selected: ${state?.provider}/${state?.id} thinking=${state?.thinkingLevel}`);

child.stdin.write(
  `${JSON.stringify({
    type: "prompt",
    message:
      "Work out, step by step and at length, every way a farmer could cross a river with a wolf, a goat and a cabbage. Think for a long time before you answer.",
  })}\n`,
);

// Press once the engine is thinking, which is when the feature has work to do.
await until(() => has("thinking_delta"), TURN_TIMEOUT_MS, "the model to start thinking");
console.log("thinking reached pi; pressing /answer");
child.stdin.write(`${JSON.stringify({ type: "prompt", message: "/answer" })}\n`);

await until(
  () =>
    notifies().some((line) =>
      /Answer now|closed the thinking|does not offer|no longer knows|No request id|refused|Could not reach|answered /.test(
        line,
      ),
    ),
  TURN_TIMEOUT_MS,
  "the extension to answer",
);
console.log(`extension said: ${notifies().join(" | ")}`);

const said = notifies().join(" ");
assert.match(said, /closed the thinking/, "the engine did not close the thinking");

// The same reply must carry on and write its answer.
await until(() => has('"agent_end"'), TURN_TIMEOUT_MS, "the reply to finish");
const texts = records
  .filter((record) => record.type === "message_update")
  .map((record) => record.assistantMessageEvent?.delta ?? "")
  .filter((text) => typeof text === "string" && text.length > 0);
console.log(`answer text after the press: ${texts.slice(-3).join("").slice(0, 120)}`);

child.kill();
await sleep(200);
console.log("\nLIVE CHECK PASSED");
