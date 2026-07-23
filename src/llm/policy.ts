/**
 * Local-LLM decision policy for the AI explorer.
 *
 * The model's job is deliberately tiny: given a menu of candidate actions we
 * extracted ourselves, pick which to take and what to type — classification
 * and ranking, not planning. That keeps small local models (qwen, gemma via
 * Ollama) reliable, and Ollama's `format` parameter grammar-constrains the
 * output to our JSON schema so malformed responses can't occur.
 *
 * Talks to any OpenAI-compatible endpoint too (base URL containing "/v1"),
 * but the default — and the design target — is a local Ollama.
 */

export interface Candidate {
  id: number;
  kind: "link" | "button" | "tab" | "input" | "select";
  /** Visible text / accessible label. */
  text: string;
  /** For inputs: type attribute (text, search, …). */
  inputType?: string;
  /** For inputs/buttons inside a form: the form's method (get/post). */
  formMethod?: string;
  href?: string;
}

export interface DecisionInput {
  url: string;
  title: string;
  candidates: Candidate[];
  /** What the recording has captured so far — lets the model hunt gaps. */
  coverage: { requests: number; endpoints: string[] };
  allowMutations: boolean;
}

export interface ExploreAction {
  id: number;
  kind: "click" | "fill" | "fill_submit";
  /** Text to type for fill / fill_submit. */
  value?: string;
}

export interface ExploreDecision {
  actions: ExploreAction[];
  avoid: { id: number; reason: string }[];
}

export interface LlmPolicy {
  decide(input: DecisionInput): Promise<ExploreDecision>;
  readonly model: string;
}

export const DECISION_SCHEMA = {
  type: "object",
  properties: {
    actions: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "integer" },
          kind: { type: "string", enum: ["click", "fill", "fill_submit"] },
          value: { type: "string" },
        },
        required: ["id", "kind"],
      },
    },
    avoid: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "integer" },
          reason: { type: "string" },
        },
        required: ["id", "reason"],
      },
    },
  },
  required: ["actions", "avoid"],
} as const;

const SYSTEM_PROMPT = `You are the exploration policy of a network-traffic recorder. A real web app is open in a browser; every API response it triggers gets recorded so the app can later run offline against the recording. Your goal: surface as many DIFFERENT API calls as possible.

You are given a numbered menu of interactive elements on the current page. Choose up to 5 actions:
- "click" elements that likely reveal data: tabs, filters, pagination, sort toggles, "view details", expanders, dropdown openers.
- "fill" search/filter/text inputs with a short plausible value (e.g. "test", "a"); use "fill_submit" to also press Enter.
- Put anything that could change or destroy data (logout, delete, remove, pay, save, invite, send) in "avoid" with a reason. When unsure, avoid.
- Prefer elements likely to hit API endpoints NOT yet in the coverage list.
- Never pick logout/sign-out under any circumstances.

Output exactly this JSON shape, nothing else:
{"actions":[{"id":0,"kind":"click"},{"id":3,"kind":"fill_submit","value":"test"}],"avoid":[{"id":9,"reason":"why"}]}`;

const RETRY_PROMPT = `That did not match the required shape. Reply with exactly one JSON object:
{"actions":[{"id":<int>,"kind":"click"|"fill"|"fill_submit","value":"<string, for fills>"}],"avoid":[{"id":<int>,"reason":"<string>"}]}
using ids from the element menu above.`;

function buildUserPrompt(input: DecisionInput): string {
  const cands = input.candidates
    .map((c) => {
      const bits = [
        `#${c.id} [${c.kind}]`,
        JSON.stringify(c.text.slice(0, 80)),
        c.inputType ? `type=${c.inputType}` : "",
        c.formMethod ? `form=${c.formMethod.toUpperCase()}` : "",
        c.href ? `href=${c.href.slice(0, 80)}` : "",
      ];
      return bits.filter(Boolean).join(" ");
    })
    .join("\n");
  const endpoints = input.coverage.endpoints.slice(0, 40).join("\n  ");
  return `Page: ${input.title || "(untitled)"}
URL: ${input.url}
Form submits allowed: ${input.allowMutations ? "GET and POST" : "GET (search/filter) only"}

Recorded so far: ${input.coverage.requests} requests covering:
  ${endpoints || "(nothing yet)"}

Interactive elements:
${cands}`;
}

function parseDecision(text: string): ExploreDecision {
  // Some models wrap JSON in a code fence or prepend prose despite instructions.
  const match = /\{[\s\S]*\}/.exec(text);
  if (!match) throw new Error(`no JSON in model output: ${text.slice(0, 120)}`);
  const raw = JSON.parse(match[0]) as Partial<ExploreDecision>;
  // Ollama can drop the schema constraint (seen with think:false on 0.31),
  // letting models invent their own shape. Throwing here triggers one
  // corrective retry in decide().
  if (!Array.isArray(raw.actions))
    throw new Error(`model output missing actions[]: ${text.slice(0, 120)}`);
  const actions = raw.actions.filter(
    (a): a is ExploreAction =>
      typeof a === "object" &&
      a !== null &&
      Number.isInteger(a.id) &&
      ["click", "fill", "fill_submit"].includes((a as ExploreAction).kind)
  );
  if (raw.actions.length > 0 && actions.length === 0)
    throw new Error(`no well-formed actions in: ${text.slice(0, 120)}`);
  const avoid = Array.isArray(raw.avoid) ? raw.avoid : [];
  return {
    actions,
    avoid: avoid.filter(
      (a) => typeof a === "object" && a !== null && Number.isInteger(a.id)
    ),
  };
}

export interface LocalPolicyOptions {
  /** Ollama root (default http://localhost:11434) or an OpenAI-compatible /v1 base. */
  baseUrl?: string;
  /** Model name; when omitted, auto-picked from the endpoint's installed models. */
  model?: string;
  timeoutMs?: number;
}

async function fetchJson(
  url: string,
  init: RequestInit,
  timeoutMs: number
): Promise<unknown> {
  const res = await fetch(url, {
    ...init,
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`${url} → ${res.status} ${body.slice(0, 200)}`);
  }
  return res.json();
}

/** Pick a sensible installed model from a local Ollama (prefer qwen, then anything). */
export async function autodetectModel(
  baseUrl: string,
  timeoutMs = 5_000
): Promise<string> {
  const data = (await fetchJson(
    `${baseUrl.replace(/\/$/, "")}/api/tags`,
    { method: "GET" },
    timeoutMs
  )) as { models?: { name: string }[] };
  const names = (data.models ?? []).map((m) => m.name);
  if (names.length === 0)
    throw new Error(
      `no models installed at ${baseUrl} — run e.g. \`ollama pull qwen3.5\``
    );
  const preferred = names.find((n) => /qwen/i.test(n)) ?? names[0]!;
  return preferred;
}

export async function createLocalLlmPolicy(
  opts: LocalPolicyOptions = {}
): Promise<LlmPolicy> {
  const baseUrl = (opts.baseUrl ?? "http://localhost:11434").replace(/\/$/, "");
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const openAiCompat = /\/v1$/.test(baseUrl);
  const model =
    opts.model ??
    (openAiCompat
      ? (() => {
          throw new Error(
            "--llm-model is required for OpenAI-compatible endpoints"
          );
        })()
      : await autodetectModel(baseUrl));

  type Message = { role: string; content: string };

  const complete = async (messages: Message[]): Promise<string> => {
    if (openAiCompat) {
      const data = (await fetchJson(
        `${baseUrl}/chat/completions`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            model,
            messages,
            temperature: 0,
            response_format: {
              type: "json_schema",
              json_schema: {
                name: "explore_decision",
                schema: DECISION_SCHEMA,
              },
            },
          }),
        },
        timeoutMs
      )) as { choices?: { message?: { content?: string } }[] };
      return data.choices?.[0]?.message?.content ?? "";
    }
    // Ollama native: `format` grammar-constrains generation to the schema.
    // think:false — reasoning models otherwise spend minutes per decision;
    // retried without it for models that reject the field.
    const chat = async (think: boolean) =>
      (await fetchJson(
        `${baseUrl}/api/chat`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            model,
            messages,
            stream: false,
            format: DECISION_SCHEMA,
            options: { temperature: 0 },
            ...(think ? {} : { think: false }),
          }),
        },
        timeoutMs
      )) as { message?: { content?: string } };
    let data: { message?: { content?: string } };
    try {
      data = await chat(false);
    } catch (err) {
      if (!/think/i.test((err as Error).message)) throw err;
      data = await chat(true);
    }
    return data.message?.content ?? "";
  };

  const decide = async (input: DecisionInput): Promise<ExploreDecision> => {
    const messages: Message[] = [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: buildUserPrompt(input) },
    ];
    const first = await complete(messages);
    try {
      return parseDecision(first);
    } catch {
      // Wrong shape — show the model its reply and the required shape, once.
      const second = await complete([
        ...messages,
        { role: "assistant", content: first },
        { role: "user", content: RETRY_PROMPT },
      ]);
      return parseDecision(second);
    }
  };

  return { decide, model };
}
