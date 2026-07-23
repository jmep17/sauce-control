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
  /** Pick a dropdown option by its visible label. */
  selectOption(id: number, label: string): Promise<void>;
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
  /** Live one-liner per attempted action — the AI's visible reasoning trail. */
  narrate?: (msg: string) => void;
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

function unsafeReason(c: Candidate): string | null {
  // Unlabeled elements (icon-only buttons with no accessible name) are
  // unknowable — one of them may well be the logout button.
  if (!c.text.trim()) return "unlabeled element";
  if (UNSAFE_PATTERN.test(c.text)) return "destructive-looking label";
  if (c.href && UNSAFE_PATTERN.test(c.href)) return "destructive-looking href";
  if (c.kind === "input" && !SAFE_INPUT_TYPES.has(c.inputType ?? ""))
    return `unsafe input type (${c.inputType})`;
  return null;
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
    narrate = () => {},
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
  // The model's own avoid-list binds it: some models list an element in both
  // actions and avoid — avoid wins.
  const avoided = new Set(decision.avoid.map((a) => a.id));
  const finish = (record: ExecutedAction, cand: Candidate | undefined) => {
    const label = cand
      ? JSON.stringify(cand.text.slice(0, 40))
      : `#${record.id}`;
    narrate(
      `ai: ${record.kind} ${label}${record.value !== undefined ? `=${JSON.stringify(record.value)}` : ""} → ${record.outcome}${record.detail ? ` (${record.detail})` : ""}`
    );
  };
  for (const action of decision.actions.slice(0, maxActionsPerPage)) {
    let cand = byId.get(action.id);
    // Small models sometimes put the *option index* in id. If the chosen
    // value matches exactly one dropdown's options, retarget deterministically.
    if (
      action.kind === "select" &&
      action.value &&
      (!cand || cand.kind !== "select")
    ) {
      const matches = candidates.filter(
        (c) => c.kind === "select" && c.options?.includes(action.value!)
      );
      if (matches.length === 1) cand = matches[0];
    }
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
      finish(record, cand);
      continue;
    }
    // The hard floor: the model's verdict never overrides these.
    const unsafe = unsafeReason(cand);
    if (unsafe) {
      record.outcome = "blocked";
      record.detail = unsafe;
      finish(record, cand);
      continue;
    }
    if (avoided.has(action.id)) {
      record.outcome = "blocked";
      record.detail = "model also marked it avoid";
      finish(record, cand);
      continue;
    }
    if (
      (action.kind === "fill" || action.kind === "fill_submit") &&
      !FILLABLE.has(cand.kind)
    ) {
      record.outcome = "blocked";
      record.detail = "not fillable";
      finish(record, cand);
      continue;
    }
    if (action.kind === "select") {
      if (cand.kind !== "select") {
        record.outcome = "blocked";
        record.detail = "not a dropdown";
        finish(record, cand);
        continue;
      }
      if (!action.value) {
        record.outcome = "blocked";
        record.detail = "select needs a value";
        finish(record, cand);
        continue;
      }
    }
    if (action.kind === "fill_submit" && !submitAllowed(cand, allowMutations)) {
      record.outcome = "blocked";
      record.detail = "non-GET form submit (use --allow-mutations)";
      finish(record, cand);
      continue;
    }

    try {
      if (action.kind === "click") {
        await page.click(cand.id);
      } else if (action.kind === "select") {
        await page.selectOption(cand.id, action.value!);
      } else {
        await page.fill(cand.id, action.value ?? "test");
        if (action.kind === "fill_submit") await page.pressEnter(cand.id);
      }
      // Give the app a beat, then recover if the action navigated away.
      const nowUrl = page.url();
      if (nowUrl !== pageUrl) {
        if (!nowUrl.startsWith(new URL(pageUrl).origin)) {
          // Landed off the app entirely (auth redirect?) — don't feed it back.
          record.detail = "navigated off-origin (recovered)";
        } else {
          result.discovered.push(nowUrl);
        }
        await page.returnTo(pageUrl);
      }
    } catch (err) {
      record.outcome = "error";
      record.detail = (err as Error).message.slice(0, 200);
    }
    finish(record, cand);
  }

  // Gate-breaker: state-gated apps ("pick a shop to continue") must not
  // depend on the model phrasing the select action correctly. If nothing
  // executed successfully and the page has a safe dropdown, deterministically
  // pick its first real option.
  if (!result.executed.some((e) => e.outcome === "ok")) {
    const dropdown = candidates.find(
      (c) =>
        c.kind === "select" && !unsafeReason(c) && (c.options?.length ?? 0) > 0
    );
    if (dropdown) {
      const value = dropdown.options![1] ?? dropdown.options![0]!;
      const record: ExecutedAction = {
        id: dropdown.id,
        kind: "select",
        value,
        outcome: "ok",
        detail: "gate-breaker fallback",
      };
      result.executed.push(record);
      try {
        await page.selectOption(dropdown.id, value);
        const nowUrl = page.url();
        if (nowUrl !== pageUrl) {
          if (nowUrl.startsWith(new URL(pageUrl).origin)) {
            result.discovered.push(nowUrl);
          }
          await page.returnTo(pageUrl);
        }
      } catch (err) {
        record.outcome = "error";
        record.detail = (err as Error).message.slice(0, 200);
      }
      finish(record, dropdown);
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
