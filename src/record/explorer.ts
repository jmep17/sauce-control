import {
  type Candidate,
  type ExploreDecision,
  type LlmPolicy,
} from "../llm/policy.js";
import { UNSAFE_PATTERN } from "./crawler.js";

/**
 * Per-page AI exploration: candidates in, LLM decision, guarded execution.
 *
 * The LLM only ever *proposes*; every proposal passes the same hard checks
 * (UNSAFE_PATTERN, form-method gating) before execution, so a wrong model
 * answer can waste a click but never fire a destructive action. Every
 * decision is appended to the session's decisions.jsonl — the future
 * fine-tuning dataset.
 */

/** Minimal surface the explorer needs from a browser page. */
export interface ExplorePage {
  url(): string;
  title(): Promise<string>;
  /** Extract + tag interactive elements; ids match later click/fill calls. */
  candidates(): Promise<Candidate[]>;
  click(id: number): Promise<void>;
  fill(id: number, value: string): Promise<void>;
  /** Press Enter in a filled input (submits its form). */
  pressEnter(id: number): Promise<void>;
  /** Return to `url` if an action navigated away. */
  returnTo(url: string): Promise<void>;
}

export interface ExplorerOptions {
  policy: LlmPolicy;
  allowMutations?: boolean;
  maxActionsPerPage?: number;
  coverage: () => { requests: number; endpoints: string[] };
  /** Appends one JSON-serializable record to decisions.jsonl. */
  logDecision?: (record: object) => void;
  warn?: (msg: string) => void;
}

interface ExecutedAction {
  id: number;
  kind: string;
  value?: string;
  outcome: "ok" | "blocked" | "error";
  detail?: string;
}

const FILLABLE = new Set(["input", "select"]);
const SAFE_INPUT_TYPES = new Set([
  "text",
  "search",
  "email",
  "number",
  "tel",
  "url",
  "",
]);

function isSafeCandidate(c: Candidate): boolean {
  if (UNSAFE_PATTERN.test(c.text)) return false;
  if (c.href && UNSAFE_PATTERN.test(c.href)) return false;
  if (c.kind === "input" && !SAFE_INPUT_TYPES.has(c.inputType ?? ""))
    return false;
  return true;
}

function submitAllowed(c: Candidate, allowMutations: boolean): boolean {
  if (allowMutations) return true;
  // GET forms (search/filter) can't mutate server state by convention.
  return (c.formMethod ?? "get").toLowerCase() === "get";
}

export interface ExploreStepResult {
  /** URLs the actions navigated to (fed back into the crawl queue). */
  discovered: string[];
  executed: ExecutedAction[];
}

/**
 * Run one AI exploration step on the current page. Never throws — a policy
 * or action failure degrades to "no exploration on this page".
 */
export async function exploreStep(
  page: ExplorePage,
  opts: ExplorerOptions
): Promise<ExploreStepResult> {
  const {
    policy,
    allowMutations = false,
    maxActionsPerPage = 5,
    coverage,
    logDecision = () => {},
    warn = () => {},
  } = opts;

  const pageUrl = page.url();
  const result: ExploreStepResult = { discovered: [], executed: [] };

  let candidates: Candidate[];
  let title: string;
  let decision: ExploreDecision;
  try {
    [candidates, title] = [await page.candidates(), await page.title()];
    if (candidates.length === 0) return result;
    decision = await policy.decide({
      url: pageUrl,
      title,
      candidates,
      coverage: coverage(),
      allowMutations,
    });
  } catch (err) {
    warn(`AI explorer skipped ${pageUrl}: ${(err as Error).message}`);
    return result;
  }

  const byId = new Map(candidates.map((c) => [c.id, c]));
  for (const action of decision.actions.slice(0, maxActionsPerPage)) {
    const cand = byId.get(action.id);
    const record: ExecutedAction = {
      id: action.id,
      kind: action.kind,
      ...(action.value !== undefined ? { value: action.value } : {}),
      outcome: "ok",
    };
    result.executed.push(record);

    if (!cand) {
      record.outcome = "blocked";
      record.detail = "unknown candidate id";
      continue;
    }
    // The hard floor: the model's verdict never overrides these.
    if (!isSafeCandidate(cand)) {
      record.outcome = "blocked";
      record.detail = "unsafe candidate";
      continue;
    }
    if (
      (action.kind === "fill" || action.kind === "fill_submit") &&
      !FILLABLE.has(cand.kind)
    ) {
      record.outcome = "blocked";
      record.detail = "not fillable";
      continue;
    }
    if (action.kind === "fill_submit" && !submitAllowed(cand, allowMutations)) {
      record.outcome = "blocked";
      record.detail = "non-GET form submit (use --allow-mutations)";
      continue;
    }

    try {
      if (action.kind === "click") {
        await page.click(cand.id);
      } else {
        await page.fill(cand.id, action.value ?? "test");
        if (action.kind === "fill_submit") await page.pressEnter(cand.id);
      }
      // Give the app a beat, then recover if the action navigated away.
      const nowUrl = page.url();
      if (nowUrl !== pageUrl) {
        result.discovered.push(nowUrl);
        await page.returnTo(pageUrl);
      }
    } catch (err) {
      record.outcome = "error";
      record.detail = (err as Error).message.slice(0, 200);
    }
  }

  logDecision({
    ts: new Date().toISOString(),
    url: pageUrl,
    title,
    model: policy.model,
    candidates,
    decision,
    executed: result.executed,
    discovered: result.discovered,
  });
  return result;
}
