/**
 * Checks for the pure helpers in extensions/index.ts.
 *
 * The end-to-end tests in answer-now.test.mjs cover one baseUrl shape through a
 * running pi. These cover the rest, including shapes pi does not produce in the
 * harness, so the URL derivation is not trusted from one example.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  answerNowUrl,
  classifyProps,
  engineError,
  isUsableKeyId,
  pickTargetRequestId,
  streamEventInfo,
  upstreamAnswerNowUrl,
} from "../extensions/index.ts";

test("answerNowUrl builds /v1/answer_now from an engine base", () => {
  assert.equal(answerNowUrl("http://127.0.0.1:8090/v1"), "http://127.0.0.1:8090/v1/answer_now");
  assert.equal(answerNowUrl("http://127.0.0.1:8090/v1/"), "http://127.0.0.1:8090/v1/answer_now");
  assert.equal(answerNowUrl("http://127.0.0.1:8090"), "http://127.0.0.1:8090/v1/answer_now");
  assert.equal(
    answerNowUrl("https://basalt.example.com/v1"),
    "https://basalt.example.com/v1/answer_now",
  );
});

test("answerNowUrl drops an endpoint suffix and keeps a gateway prefix", () => {
  assert.equal(answerNowUrl("http://h/v1/chat/completions"), "http://h/v1/answer_now");
  assert.equal(answerNowUrl("http://h/v1/messages"), "http://h/v1/answer_now");
  assert.equal(answerNowUrl("http://h/v1/responses"), "http://h/v1/answer_now");
  assert.equal(answerNowUrl("http://h/completions"), "http://h/v1/answer_now");
  assert.equal(
    answerNowUrl("https://gw.example.com/team/llm/v1"),
    "https://gw.example.com/team/llm/v1/answer_now",
  );
});

test("answerNowUrl drops query and hash, and refuses non-http bases", () => {
  assert.equal(answerNowUrl("http://h/v1?token=abc#frag"), "http://h/v1/answer_now");
  assert.equal(answerNowUrl("file:///tmp/engine"), undefined);
  assert.equal(answerNowUrl("not a url"), undefined);
  assert.equal(answerNowUrl(""), undefined);
});

test("upstreamAnswerNowUrl names the model as one path segment", () => {
  assert.equal(
    upstreamAnswerNowUrl("http://127.0.0.1:8090/v1", "qwen3.8-flash"),
    "http://127.0.0.1:8090/upstream/qwen3.8-flash/v1/answer_now",
  );
  // llama-swap decodes the path before the model lookup, so a name holding a
  // slash travels as real segments. Not proven against a live llama-swap.
  assert.equal(
    upstreamAnswerNowUrl("http://127.0.0.1:8090", "group/deep model"),
    "http://127.0.0.1:8090/upstream/group/deep%20model/v1/answer_now",
  );
  assert.equal(
    upstreamAnswerNowUrl("https://gw.example.com/llm/v1/chat/completions", "m"),
    "https://gw.example.com/llm/upstream/m/v1/answer_now",
  );
});

test("classifyProps reads only the basalt block", () => {
  assert.equal(classifyProps({ basalt: { capabilities: ["logprobs", "answer_now"] } }), "yes");
  assert.equal(classifyProps({ basalt: { capabilities: ["logprobs"] } }), "no");
  assert.equal(classifyProps({ basalt: {} }), "no");
  assert.equal(classifyProps({ title: "llama.cpp server", abilities: {} }), "no");
  assert.equal(classifyProps(undefined), "unknown");
  assert.equal(classifyProps("not json"), "unknown");
  // A real llama-swap reply for a model it would not load for a probe.
  assert.equal(
    classifyProps({ src: "llama-swap", error: { message: "not loaded", code: "conflict" } }),
    "unknown",
  );
  assert.equal(classifyProps({ error: "not loaded" }), "unknown");
});

test("isUsableKeyId accepts what pi can bind", () => {
  for (const key of [
    "alt+a",
    "ctrl+alt+a",
    "ctrl+shift+g",
    "F12",
    "f1",
    "+",
    "ctrl+alt+delete",
    "ALT+A",
    "super+k",
  ]) {
    assert.equal(isUsableKeyId(key), true, `${key} should bind`);
  }
});

test("isUsableKeyId rejects what pi would never fire", () => {
  for (const key of ["", "alt+", "foo+a", "alt+alt+a", "ctrl+a+b", "cmd+k", "alt+ab"]) {
    assert.equal(isUsableKeyId(key), false, `${key} should be rejected`);
  }
});

test("streamEventInfo reads the engine's own id out of a chunk", () => {
  const open = streamEventInfo({ id: "chatcmpl-1", choices: [{ finish_reason: null }] });
  assert.equal(open.id, "chatcmpl-1");
  assert.equal(open.done, false);
  assert.equal(
    streamEventInfo({ id: "chatcmpl-1", choices: [{ finish_reason: "stop" }] }).done,
    true,
  );
  assert.equal(streamEventInfo({ choices: [] }).id, undefined);
  assert.equal(streamEventInfo(undefined).done, false);
});

test("pickTargetRequestId prefers the open stream and refuses to guess", () => {
  assert.deepEqual(pickTargetRequestId(["a"], "h"), { id: "a", ambiguous: false });
  assert.deepEqual(pickTargetRequestId([], "h"), { id: "h", ambiguous: false });
  assert.deepEqual(pickTargetRequestId(["a", "b"], "h"), { ambiguous: true });
  assert.deepEqual(pickTargetRequestId([], undefined), { id: undefined, ambiguous: false });
});

test("engineError separates an engine refusal from a proxy miss", () => {
  assert.deepEqual(engineError({ error: { code: "unknown_request", state: "none" } }), {
    code: "unknown_request",
    state: "none",
  });
  assert.equal(engineError({ detail: "Not Found" }), undefined);
  assert.equal(engineError(""), undefined);
  assert.equal(engineError(undefined), undefined);
});
