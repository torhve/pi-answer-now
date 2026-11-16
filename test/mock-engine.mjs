/**
 * Mock of a basalt engine, and of llama-swap in front of one.
 *
 * The shapes follow basalt's serve/tests/test_answer_now.py and
 * docs/changelog/0.3.3.md: every chat response carries X-Request-Id, one reply
 * streams thinking then answer, and POST /v1/answer_now closes the thinking of
 * one running reply.
 */

import http from "node:http";

const THINKING_TOKENS = 30;
const ANSWER_TOKENS = 8;
const TOKEN_INTERVAL_MS = 40;

function sseChunk(body) {
  return `data: ${JSON.stringify(body)}\n\n`;
}

function chunkModel(requestId, model) {
  return { id: requestId, object: "chat.completion.chunk", created: 0, model };
}

function replyChoice(delta, finishReason) {
  return { index: 0, delta, finish_reason: finishReason };
}

function sendJson(response, status, body) {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload),
  });
  response.end(payload);
}

function readBody(request) {
  return new Promise((resolve) => {
    let raw = "";
    request.on("data", (part) => {
      raw += part;
    });
    request.on("end", () => {
      if (raw === "") {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch {
        resolve({ raw });
      }
    });
  });
}

/**
 * @param swap        llama-swap sits in front: a fixed route table, so only /upstream/<model>/… reaches the engine.
 * @param props       What /props answers: "basalt", "llamacpp", or "none" for a failing probe.
 * @param answerRoute "ok" serves /v1/answer_now, "missing" 404s it like an engine without the
 *                    feature, "blocked" answers 404 on /v1/answer_now and on /upstream/… too,
 *                    like a proxy that strips both paths.
 * @param idDrift     The header carries an id the engine does not know. basalt writes the same id
 *                    in the header and in every chunk; this splits them to check which one the
 *                    extension answers to.
 * @param failFirstChat  The first chat request gets a 500, so an error path can be tested.
 * @param breakFirstChat The first chat stream ends with no finish chunk and no [DONE].
 */
export async function startMockEngine({
  swap = false,
  props = "basalt",
  answerRoute = "ok",
  idDrift = false,
  failFirstChat = false,
  breakFirstChat = false,
} = {}) {
  const calls = [];
  const history = [];
  const running = new Map();
  const arrivals = [];
  let counter = 0;

  const engine = {
    calls,
    history,
    lastFinished() {
      return history[history.length - 1];
    },
    lastAnswerNow() {
      return [...calls].reverse().find((call) => call.answerNow);
    },
    /** Resolves with the request id of the next chat request that starts streaming. */
    /** Resolves with the request id of the next chat request that starts streaming. */
    nextChat() {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error("no chat request reached the mock within 30s")),
          30_000,
        );
        arrivals.push((requestId) => {
          clearTimeout(timer);
          resolve(requestId);
        });
      });
    },
    cancelAll() {
      for (const reply of running.values()) {
        reply.cancelled = true;
      }
    },
  };

  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const path = url.pathname;
    const upstream = path.match(/^\/upstream\/([^/]+)\/v1\/answer_now$/);
    calls.push({ method: request.method, path, headers: request.headers });

    if (request.method === "GET" && path === "/props") {
      if (props === "none") {
        sendJson(response, 409, { error: "model is not running" });
        return;
      }
      const body = {
        title: "llama.cpp server",
        model: url.searchParams.get("model") ?? "",
        n_ctx: 4096,
        n_ctx_train: 40960,
        abilities: { rank: true, embedding: true },
      };
      if (props === "basalt") {
        body.basalt = { version: "0.3.3", capabilities: ["logprobs", "answer_now", "documents"] };
      }
      sendJson(response, 200, body);
      return;
    }

    if (request.method === "POST" && path === "/v1/chat/completions") {
      const body = await readBody(request);
      const model = typeof body.model === "string" ? body.model : "mock";
      const requestId = `mock-${String(++counter).padStart(3, "0")}`;
      if (failFirstChat && counter === 1) {
        sendJson(response, 500, {
          error: {
            type: "server_error",
            code: "mock_failure",
            message: "mock failed the first request",
          },
        });
        return;
      }
      const reply = {
        requestId,
        state: "thinking",
        answerNow: false,
        cancelled: false,
        interrupted: false,
        thinkingTokens: 0,
        broken: breakFirstChat && counter === 1,
        answerTokens: 0,
      };
      running.set(requestId, reply);

      response.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-store",
        "x-request-id": idDrift ? `proxy-${requestId}` : requestId,
      });
      const write = (text) => {
        if (!reply.cancelled) {
          response.write(text);
        }
      };
      write(
        sseChunk({
          ...chunkModel(requestId, model),
          choices: [replyChoice({ role: "assistant", content: "" }, null)],
        }),
      );

      let step = 0;
      const timer = setInterval(() => {
        if (reply.cancelled) {
          clearInterval(timer);
          return;
        }
        if (reply.state === "thinking" && !reply.answerNow) {
          reply.thinkingTokens++;
          if (reply.broken && reply.thinkingTokens >= 2) {
            // No finish chunk and no [DONE]. pi must still close the turn, so a
            // stream id that never saw an end must not live into the next turn.
            clearInterval(timer);
            reply.state = "finished";
            running.delete(requestId);
            history.push({
              requestId,
              thinkingTokens: reply.thinkingTokens,
              answerTokens: 0,
              interrupted: false,
            });
            response.end();
            return;
          }
          write(
            sseChunk({
              ...chunkModel(requestId, model),
              choices: [replyChoice({ reasoning_content: `t${++step} ` }, null)],
            }),
          );
          if (step >= THINKING_TOKENS) {
            reply.state = "answering";
          }
          return;
        }
        reply.state = "answering";
        reply.answerTokens++;
        write(
          sseChunk({
            ...chunkModel(requestId, model),
            choices: [replyChoice({ content: `answer${step} ` }, null)],
          }),
        );
        step++;
        if (reply.answerTokens >= ANSWER_TOKENS) {
          clearInterval(timer);
          write(sseChunk({ ...chunkModel(requestId, model), choices: [replyChoice({}, "stop")] }));
          write("data: [DONE]\n\n");
          reply.state = "finished";
          response.end();
          running.delete(requestId);
          history.push({
            requestId,
            thinkingTokens: reply.thinkingTokens,
            answerTokens: reply.answerTokens,
            interrupted: reply.interrupted,
          });
        }
      }, TOKEN_INTERVAL_MS);

      arrivals.shift()?.(requestId);
      return;
    }

    // Which answer-now paths the front door answers.
    const directOk = answerRoute === "ok" && !swap;
    const upstreamOk = swap && upstream !== null && answerRoute !== "blocked";
    if (request.method === "POST" && (path === "/v1/answer_now" || upstream)) {
      const call = calls[calls.length - 1];
      call.answerNow = true;
      if (!directOk && !upstreamOk) {
        // llama-swap outside its route table, or an engine without the feature.
        sendJson(response, 404, { detail: "Not Found" });
        return;
      }
      const body = await readBody(request);
      call.body = body;
      const requestId = typeof body.request_id === "string" ? body.request_id : undefined;
      const reply = requestId === undefined ? undefined : running.get(requestId);
      if (reply === undefined) {
        sendJson(response, 404, {
          error: {
            type: "invalid_request_error",
            code: "unknown_request",
            message: `no running request ${requestId}`,
            state: "none",
          },
        });
        return;
      }
      if (reply.state !== "thinking") {
        sendJson(response, 409, {
          error: {
            type: "invalid_request_error",
            code: "not_thinking",
            message: `request is ${reply.state}`,
            state: reply.state,
          },
        });
        return;
      }
      reply.answerNow = true;
      reply.interrupted = true;
      sendJson(response, 200, { object: "answer_now", request_id: requestId, state: "thinking" });
      return;
    }

    sendJson(response, 404, { detail: "Not Found" });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;

  return {
    origin,
    engine,
    async stop() {
      engine.cancelAll();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
