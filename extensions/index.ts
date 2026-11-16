/**
 * pi-answer-now — end a reasoning model's thinking block while it writes.
 *
 * The engine owns the feature. Basalt closes the thinking section of a running
 * reply when a client posts its request id to `/v1/answer_now`. This extension
 * records that id from the response headers pi already receives, then posts it
 * back on the side. It changes no outbound request of its own.
 *
 * pi only uses the default export. A few pure helpers are exported too, so
 * test/urls.test.mjs can check them without starting pi.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  type ExtensionAPI,
  type ExtensionContext,
  getAgentDir,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { KeyId } from "@earendil-works/pi-tui";

const SETTINGS_KEY = "pi-answer-now";
const DEFAULT_KEYBINDING = "alt+a";
const POST_TIMEOUT_MS = 2000;
const PROBE_TIMEOUT_MS = 2500;
/** Config file written by the pi-llama-swap extension. Read only to reuse its capability cache. */
const LLAMA_SWAP_CONFIG = "pi-llama-swap.json";
/** Longest server message shown in one line of chat. */
const MAX_SERVER_TEXT = 200;

/** What an engine said about answer now. `unknown` covers "never asked" and "asked, got nothing". */
type Capability = "yes" | "no" | "unknown";

interface PostResult {
  status: number;
  body: unknown;
  text: string;
}

/** Result of one attempt: `null` status means the request never got an answer. */
interface Attempt {
  status: number | null;
  result?: PostResult;
  failure?: string;
}

// ── Key syntax ──────────────────────────────────────────────────────────────

const KEY_MODIFIERS = new Set(["ctrl", "shift", "alt", "super"]);
const KEY_NAMES = new Set([
  "escape",
  "esc",
  "enter",
  "return",
  "tab",
  "space",
  "backspace",
  "delete",
  "insert",
  "clear",
  "home",
  "end",
  "pageup",
  "pagedown",
  "up",
  "down",
  "left",
  "right",
]);
const KEY_SYMBOLS = new Set([
  "`",
  "-",
  "=",
  "[",
  "]",
  "\\",
  ";",
  "'",
  ",",
  ".",
  "/",
  "!",
  "@",
  "#",
  "$",
  "%",
  "^",
  "&",
  "*",
  "(",
  ")",
  "_",
  "+",
  "|",
  "~",
  "{",
  "}",
  ":",
  "<",
  ">",
  "?",
]);

/**
 * Reports whether pi can bind a key string. `pi.registerShortcut` accepts any
 * string and never fires an unparseable one, so a typo would be a silent dead
 * key. pi parses keys case-insensitively, and this check matches that.
 */
export function isUsableKeyId(raw: string): boolean {
  // A bare "+" is a key of its own, so read it before splitting on the separator.
  if (KEY_SYMBOLS.has(raw)) {
    return true;
  }
  const parts = raw.split("+");
  const base = parts[parts.length - 1]?.trim().toLowerCase() ?? "";
  const modifiers = parts
    .slice(0, -1)
    .map((part) => part.trim().toLowerCase())
    .filter((part) => part !== "");
  if (modifiers.length !== parts.length - 1) {
    return false;
  }
  if (modifiers.some((modifier) => !KEY_MODIFIERS.has(modifier))) {
    return false;
  }
  if (new Set(modifiers).size !== modifiers.length) {
    return false;
  }
  if (KEY_NAMES.has(base) || KEY_SYMBOLS.has(base)) {
    return true;
  }
  if (/^f(?:[1-9]|1[0-2])$/.test(base)) {
    return true;
  }
  return base.length === 1 && /[a-z0-9]/.test(base);
}

/**
 * Reads the merged settings while the extension loads. pi blocks `pi.getSettings()`
 * until loading ends, and the key must be known before pi builds its shortcut
 * table. `SettingsManager.create` is the same merge pi uses, and reads only.
 */
function loadTimeSettings(): unknown {
  try {
    return SettingsManager.create(process.cwd(), getAgentDir()).getSettings();
  } catch {
    return undefined;
  }
}

/** Reads the configured key. Returns undefined when the setting is absent or not a string. */
function configuredKeybinding(settings: unknown): string | undefined {
  const section = (settings as Record<string, unknown> | undefined)?.[SETTINGS_KEY];
  if (!section || typeof section !== "object") {
    return undefined;
  }
  const key = (section as Record<string, unknown>).keybinding;
  return typeof key === "string" && key.trim() !== "" ? key.trim() : undefined;
}

// ── Request-id capture ──────────────────────────────────────────────────────

/** Model id of each request that left pi and has not answered with headers yet. */
const pendingModels: string[] = [];
/** Last response header request id per model id. */
const lastRequestIds = new Map<string, string>();
const MAX_TRACKED = 32;

/** Request ids whose stream is open right now, per model id. */
const openStreams = new Map<string, Set<string>>();

/**
 * Reads the request id out of one provider chunk. The engine writes that id into
 * every chunk of its own reply, and basalt writes the same value into
 * `X-Request-Id`, so the stream names the running request on its own.
 */
export function streamEventInfo(data: unknown): { id?: string; done: boolean } {
  const chunk = data as
    | { id?: unknown; choices?: Array<{ finish_reason?: string | null }> | undefined }
    | undefined;
  const id = typeof chunk?.id === "string" && chunk.id !== "" ? chunk.id : undefined;
  const done =
    chunk?.choices?.some(
      (choice) => typeof choice?.finish_reason === "string" && choice.finish_reason !== "",
    ) ?? false;
  return { id, done };
}

function noteStream(modelId: string, data: unknown): void {
  const { id, done } = streamEventInfo(data);
  if (!id) {
    return;
  }
  const open = openStreams.get(modelId) ?? new Set<string>();
  if (done) {
    open.delete(id);
    if (open.size === 0) {
      openStreams.delete(modelId);
    }
    return;
  }
  open.add(id);
  openStreams.set(modelId, open);
}

/**
 * Chooses which request to interrupt. The engine's own stream ids win. A header
 * id only serves when no stream is open, because a header id can belong to an
 * older request, a retry, or a request pi made for itself.
 */
export function pickTargetRequestId(
  openIds: string[],
  headerId: string | undefined,
): { id?: string; ambiguous: boolean } {
  if (openIds.length > 1) {
    return { ambiguous: true };
  }
  if (openIds.length === 1) {
    return { id: openIds[0], ambiguous: false };
  }
  return { id: headerId, ambiguous: false };
}

function findHeader(
  headers: Record<string, string> | undefined,
  wanted: string,
): string | undefined {
  if (!headers) {
    return undefined;
  }
  const lower = wanted.toLowerCase();
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() === lower) {
      return value;
    }
  }
  return undefined;
}

// ── URLs ────────────────────────────────────────────────────────────────────

/** Drops the endpoint suffix and the `/v1` tier, leaving where the service is mounted. */
function basePathOf(pathname: string): string {
  let path = pathname.replace(/\/+$/, "");
  path = path.replace(/\/(?:chat\/completions|completions|messages|responses)$/i, "");
  path = path.replace(/\/+$/, "");
  path = path.replace(/\/v1$/i, "");
  return path.replace(/\/+$/, "");
}

/** The API root, with `/v1` added when the base does not already carry it. */
function apiPath(pathname: string): string {
  return `${basePathOf(pathname)}/v1`;
}

function parsedHttpUrl(raw: string): URL | undefined {
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return undefined;
    }
    return url;
  } catch {
    return undefined;
  }
}

/** Builds `<base>/answer_now` for an engine reached directly. */
export function answerNowUrl(baseUrl: string): string | undefined {
  const url = parsedHttpUrl(baseUrl);
  if (!url) {
    return undefined;
  }
  url.pathname = `${apiPath(url.pathname)}/answer_now`;
  url.search = "";
  url.hash = "";
  return url.toString();
}

/**
 * Builds the llama-swap passthrough for a model. llama-swap keeps a fixed route
 * table, so `/v1/answer_now` 404s at the proxy. `/upstream/<model>/<path>` strips
 * that prefix and forwards any method to the model's engine. The mount prefix in
 * front of llama-swap stays in place, because a reverse proxy keeps its own path.
 */
export function upstreamAnswerNowUrl(baseUrl: string, modelId: string): string | undefined {
  const url = parsedHttpUrl(baseUrl);
  if (!url) {
    return undefined;
  }
  // llama-swap decodes the path before it looks the model up, so a name that
  // holds a slash or a space must travel as one escaped segment, not two.
  const segment = encodeURIComponent(modelId).replace(/%2F/gi, "/");
  url.pathname = `${basePathOf(url.pathname)}/upstream/${segment}/v1/answer_now`;
  url.search = "";
  url.hash = "";
  return url.toString();
}

function originOf(baseUrl: string): string {
  const url = parsedHttpUrl(baseUrl);
  return url ? url.origin : baseUrl;
}

// ── HTTP ────────────────────────────────────────────────────────────────────

/** Adds the credentials pi already resolved for the current model. */
async function requestHeaders(ctx: ExtensionContext): Promise<Record<string, string>> {
  const headers: Record<string, string> = {};
  const model = ctx.model;
  if (model?.headers) {
    Object.assign(headers, model.headers);
  }
  headers["content-type"] = "application/json";
  if (!model) {
    return headers;
  }
  try {
    const resolved = await ctx.modelRegistry.getApiKeyAndHeaders(model);
    if (!resolved.ok) {
      return headers;
    }
    for (const [name, value] of Object.entries(resolved.headers ?? {})) {
      if (value !== null) {
        headers[name] = value;
      }
    }
    const hasAuth =
      findHeader(headers, "authorization") !== undefined ||
      findHeader(headers, "x-api-key") !== undefined;
    if (resolved.apiKey && !hasAuth) {
      headers.Authorization = `Bearer ${resolved.apiKey}`;
    }
  } catch {
    // Model headers alone. The server answers, and the answer is shown.
  }
  return headers;
}

async function postJson(
  url: string,
  body: unknown,
  headers: Record<string, string>,
): Promise<Attempt> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(POST_TIMEOUT_MS),
    });
  } catch (error) {
    return { status: null, failure: describeFetchFailure(error) };
  }
  const text = await response.text().catch(() => "");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    parsed = undefined;
  }
  return { status: response.status, result: { status: response.status, body: parsed, text } };
}

function getJson(
  url: string,
  headers: Record<string, string>,
): Promise<{ ok: boolean; body?: unknown }> {
  return fetch(url, { method: "GET", headers, signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) })
    .then(async (response) => {
      if (!response.ok) {
        return { ok: false };
      }
      try {
        return { ok: true, body: (await response.json()) as unknown };
      } catch {
        return { ok: false };
      }
    })
    .catch(() => ({ ok: false }));
}

function describeFetchFailure(error: unknown): string {
  if (error instanceof Error && error.name === "TimeoutError") {
    return "the server did not answer within 2 seconds";
  }
  if (error instanceof Error && error.name === "AbortError") {
    return "the request was cancelled";
  }
  return "the server refused the connection";
}

// ── Capabilities ────────────────────────────────────────────────────────────

const capabilityCache = new Map<string, Capability>();

function capabilityKey(origin: string, modelId: string): string {
  return `${origin} ${modelId}`;
}

/** Classifies a parsed /props body. Only Basalt reports the capability. */
export function classifyProps(body: unknown): Capability {
  if (!body || typeof body !== "object") {
    return "unknown";
  }
  // An error body proves nothing about the model. llama-swap answers an
  // unloaded model with an error, and that must not cache a "no".
  if ("error" in (body as Record<string, unknown>)) {
    return "unknown";
  }
  const block = (body as Record<string, unknown>).basalt;
  if (!block || typeof block !== "object") {
    return "no";
  }
  const capabilities = (block as Record<string, unknown>).capabilities;
  if (Array.isArray(capabilities)) {
    return capabilities.includes("answer_now") ? "yes" : "no";
  }
  return "no";
}

/**
 * Reads pi-llama-swap's cached capability for this model, so a model already
 * probed by that extension costs nothing here. Absent field means no opinion.
 */
async function cachedCapability(provider: string, modelId: string): Promise<boolean | undefined> {
  let raw: string;
  try {
    raw = await readFile(join(getAgentDir(), LLAMA_SWAP_CONFIG), "utf8");
  } catch {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
  const root = parsed as Record<string, unknown>;
  const instances: unknown[] = Array.isArray(root.instances) ? root.instances : [root];
  for (const entry of instances) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const instance = entry as Record<string, unknown>;
    if (
      !Array.isArray(root.instances) &&
      typeof instance.id === "string" &&
      instance.id !== provider
    ) {
      continue;
    }
    if (Array.isArray(root.instances) && instance.id !== provider) {
      continue;
    }
    const caps = instance.modelCapabilities;
    if (!caps || typeof caps !== "object") {
      continue;
    }
    const discovered = (caps as Record<string, unknown>)[modelId];
    if (discovered && typeof discovered === "object") {
      const value = (discovered as Record<string, unknown>).answerNow;
      if (typeof value === "boolean") {
        return value;
      }
    }
  }
  return undefined;
}

/** Resolves answer-now support once per engine and model, from cache then one props read. */
async function resolveCapability(ctx: ExtensionContext): Promise<Capability> {
  const model = ctx.model;
  if (!model) {
    return "unknown";
  }
  const origin = originOf(model.baseUrl);
  const key = capabilityKey(origin, model.id);
  const cached = capabilityCache.get(key);
  if (cached !== undefined) {
    return cached;
  }
  const fromOtherExtension = await cachedCapability(model.provider, model.id);
  if (fromOtherExtension !== undefined) {
    const verdict: Capability = fromOtherExtension ? "yes" : "no";
    capabilityCache.set(key, verdict);
    return verdict;
  }
  const headers = await requestHeaders(ctx);
  delete headers["content-type"];
  // autoload=false makes llama-swap refuse instead of loading a model for a probe.
  const props = await getJson(
    `${origin}/props?model=${encodeURIComponent(model.id)}&autoload=false`,
    headers,
  );
  const verdict = props.ok ? classifyProps(props.body) : "unknown";
  capabilityCache.set(key, verdict);
  return verdict;
}

// ── Reporting ───────────────────────────────────────────────────────────────

function report(ctx: ExtensionContext, kind: "info" | "warning" | "error", message: string): void {
  if (ctx.hasUI) {
    ctx.ui.notify(message, kind);
    return;
  }
  console.error(`[pi-answer-now] ${message}`);
}

function clip(text: string): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > MAX_SERVER_TEXT ? `${clean.slice(0, MAX_SERVER_TEXT)}…` : clean;
}

/** The `{ error: … }` block an engine returns, or undefined when it sent none. */
export function engineError(body: unknown): Record<string, unknown> | undefined {
  const error = (body as Record<string, unknown> | undefined)?.error;
  return error && typeof error === "object" ? (error as Record<string, unknown>) : undefined;
}

/** Basalt answers a refusal with `{ error: { code, message, state } }`. */
function engineRefusal(result: PostResult): string | undefined {
  const error = engineError(result.body);
  if (!error) {
    return undefined;
  }
  const { code, state } = error;
  if (code === "not_thinking" && state === "finished") {
    return "That reply has already finished.";
  }
  if (code === "not_thinking" && state === "answering") {
    return "The model is already writing its answer.";
  }
  if (code === "not_thinking") {
    return "This model is running with thinking off, so there is nothing to end.";
  }
  if (code === "unknown_request") {
    return "The engine no longer knows that request. It has moved on to another one.";
  }
  if (code === "unknown_session") {
    return "The engine has no running request for this session.";
  }
  if (code === "no_target") {
    return "The engine did not accept the target of this request.";
  }
  return undefined;
}

function failureMessage(
  attempts: Attempt[],
  capability: Capability,
  engine: string,
): { kind: "info" | "warning" | "error"; message: string } {
  const last = attempts[attempts.length - 1];
  if (last?.status === null) {
    return { kind: "error", message: `Could not reach ${engine}: ${last.failure}.` };
  }
  const result = last?.result;
  if (!result) {
    return { kind: "error", message: `Could not reach ${engine}.` };
  }
  const refusal = engineRefusal(result);
  if (refusal) {
    return { kind: "warning", message: refusal };
  }
  if (result.status === 404) {
    if (capability === "no") {
      return { kind: "warning", message: `${engine} does not offer answer now.` };
    }
    if (attempts.length > 1) {
      return {
        kind: "warning",
        message:
          `${engine} answered 404 on /v1/answer_now and on /upstream/<model>/v1/answer_now. ` +
          "The server in front of the engine does not pass those paths.",
      };
    }
    return {
      kind: "warning",
      message: `${engine} has no /v1/answer_now route. It is not a basalt engine, or it is too old.`,
    };
  }
  if (result.status === 401 || result.status === 403) {
    return {
      kind: "error",
      message: `${engine} refused this call as unauthenticated (${result.status}).`,
    };
  }
  const detail = result.text ? ` ${clip(result.text)}` : "";
  return { kind: "error", message: `${engine} answered ${result.status}.${detail}` };
}

// ── Action ──────────────────────────────────────────────────────────────────

let inFlight = false;

async function answerNow(ctx: ExtensionContext): Promise<void> {
  const model = ctx.model;
  if (!model) {
    report(ctx, "warning", "No model is selected, so there is no reply to answer.");
    return;
  }
  const engine = `${model.id} at ${originOf(model.baseUrl)}`;
  const direct = answerNowUrl(model.baseUrl);
  if (!direct) {
    report(ctx, "error", `Cannot build an answer-now URL from ${model.baseUrl}.`);
    return;
  }
  if (inFlight) {
    report(ctx, "info", "Already asking the engine.");
    return;
  }
  // The stream names the request the engine is working on right now. A header
  // id can belong to an older request, a retry, or a request pi made for
  // itself, so it only serves as a fallback.
  const open = openStreams.get(model.id);
  const target = pickTargetRequestId(open ? [...open] : [], lastRequestIds.get(model.id));
  if (target.ambiguous) {
    report(
      ctx,
      "warning",
      `More than one request for ${model.id} streams at once. Answer now cannot tell which one to stop.`,
    );
    return;
  }
  const requestId = target.id;
  if (!requestId) {
    const capability = await resolveCapability(ctx);
    if (capability === "no") {
      report(ctx, "warning", `${engine} does not offer answer now.`);
    } else {
      report(
        ctx,
        "warning",
        "No request id yet for this model. The engine has not answered pi yet, so there is nothing to interrupt. Try again once it starts.",
      );
    }
    return;
  }

  inFlight = true;
  let attempts: Attempt[];
  let capability: Capability;
  try {
    const headers = await requestHeaders(ctx);
    const body = { request_id: requestId };
    attempts = [await postJson(direct, body, headers)];
    // llama-swap answers a path outside its route table with a body of its own.
    // An engine 404 names a code, such as unknown_request, and nothing better
    // waits behind the proxy, so only the first kind is worth a second route.
    const engineAnswered = engineError(attempts[0].result?.body) !== undefined;
    if (attempts[0].status === 404 && !engineAnswered) {
      const upstream = upstreamAnswerNowUrl(model.baseUrl, model.id);
      if (upstream && upstream !== direct) {
        attempts.push(await postJson(upstream, body, headers));
      }
    }
    capability = capabilityCache.get(capabilityKey(originOf(model.baseUrl), model.id)) ?? "unknown";
  } finally {
    inFlight = false;
  }

  const succeeded = attempts.find((attempt) => attempt.status === 200);
  if (succeeded?.result) {
    const reply = succeeded.result.body as Record<string, unknown> | undefined;
    const state = typeof reply?.state === "string" ? reply.state : "unknown state";
    const id = typeof reply?.request_id === "string" ? reply.request_id : requestId;
    report(ctx, "info", `Answer now: closed the thinking of ${id} (was ${state}).`);
    return;
  }
  const failure = failureMessage(attempts, capability, engine);
  report(ctx, failure.kind, failure.message);
}

// ── Extension ───────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  const configured = configuredKeybinding(loadTimeSettings());
  const invalidKey =
    configured !== undefined && !isUsableKeyId(configured) ? configured : undefined;
  const keybinding = invalidKey ? DEFAULT_KEYBINDING : (configured ?? DEFAULT_KEYBINDING);

  const run = async (ctx: ExtensionContext): Promise<void> => {
    try {
      await answerNow(ctx);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      report(ctx, "error", `Answer now failed: ${detail}`);
    }
  };

  pi.registerCommand("answer", {
    description: "Ask the model to stop thinking and answer now",
    handler: (_args: string, ctx: ExtensionContext) => run(ctx), // command handlers take (args, ctx)
  });

  pi.registerShortcut(keybinding as KeyId, {
    description: "Answer now",
    handler: run,
  });

  // One props read per engine and model, ahead of the press, so the first use is fast.
  const warm = async (ctx: ExtensionContext): Promise<void> => {
    try {
      await resolveCapability(ctx);
    } catch {
      // Unknown until the press needs it.
    }
  };

  pi.on("session_start", async (_event, ctx) => {
    if (invalidKey) {
      report(
        ctx,
        "warning",
        `"${invalidKey}" is not a key pi can bind. ${SETTINGS_KEY}.keybinding in settings.json uses forms like "alt+a" or "ctrl+shift+g". Using "${DEFAULT_KEYBINDING}".`,
      );
    }
    void warm(ctx);
  });

  pi.on("model_select", async (_event, ctx) => {
    void warm(ctx);
  });

  // The engine names each request on its response headers. Pair the header
  // with the model that pi sent, so a title or compaction request cannot be
  // mistaken for the turn the user is watching.
  pi.on("before_provider_request", (event) => {
    const payload = event.payload as Record<string, unknown> | undefined;
    const model = typeof payload?.model === "string" ? payload.model : undefined;
    if (model) {
      pendingModels.push(model);
      if (pendingModels.length > MAX_TRACKED) {
        pendingModels.shift();
      }
    }
  });

  // Each chunk names the request the engine works on. This is the only source
  // that proves which request streams right now.
  pi.on("provider_stream_event", (event) => {
    noteStream(event.model, event.data);
  });

  // A stream that never reached a final chunk must not linger as a candidate.
  pi.on("turn_end", () => {
    openStreams.clear();
  });
  pi.on("agent_end", () => {
    openStreams.clear();
  });

  pi.on("after_provider_response", (event) => {
    const model = pendingModels.shift();
    const requestId = findHeader(event.headers, "x-request-id");
    if (model && requestId) {
      lastRequestIds.set(model, requestId);
      if (lastRequestIds.size > MAX_TRACKED) {
        const oldest = lastRequestIds.keys().next().value;
        if (oldest !== undefined) {
          lastRequestIds.delete(oldest);
        }
      }
    }
  });
}
