import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import schema from "../../convex/schema";
import { internal } from "../../convex/_generated/api";

const modules = import.meta.glob("../../convex/**/*.ts");
const sessionId = "managed-jev-test";
const providerId = "provider-test-call";
const toolSecret = "synthetic-tool-secret";
const viewerToken = "synthetic-viewer-token";
const providerUrl = "https://api.typesafe.ai/v1/systemone";
const call = {
  id: sessionId, user_id: "test-user", company: "Synthetic Support",
  phone_number: "+15550100100", goal: "Refund the headphone purchase",
  limits_json: {}, disclosure_text: "I am an AI assistant", state: "DIALING",
  started_at: "2026-10-25T00:00:00Z", ended_at: null, outcome: null,
  reference_number: null, minutes_saved: null,
};

type ProviderQuestion = { criteria: Record<string, unknown> };
type ProviderBody = {
  model: string;
  state: Record<string, unknown>;
  questions: Record<string, ProviderQuestion>;
};
const providerRequests: ProviderBody[] = [];
let providerAnswer: (body: ProviderBody) => Response | Promise<Response>;
const providerFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
  expect(String(input)).toBe(providerUrl);
  expect(init?.method).toBe("POST");
  expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer synthetic-typesafe-key");
  const body = JSON.parse(String(init?.body)) as ProviderBody;
  providerRequests.push(body);
  return providerAnswer(body);
});

function decision(body: ProviderBody, choice: string, probability = 0.93) {
  const question = Object.keys(body.questions)[0];
  const options = Object.keys(body.questions[question].criteria);
  const probabilities = Object.fromEntries(options.map(option => [option,
    option === choice ? probability : (1 - probability) / Math.max(1, options.length - 1)]));
  return Response.json({
    model: "jev-latest", usage: {},
    answers: { [question]: { type: "choice", choice, confidence: 0.4, probabilities } },
  });
}

function setup() { return convexTest(schema, modules); }
type TestBackend = ReturnType<typeof setup>;
async function seed(t: TestBackend, state = "DIALING") {
  await t.mutation(internal.managed.start, { call: { ...call, state } });
  await t.mutation(internal.managed.attachProvider, { session_id: sessionId, provider_call_id: providerId });
}
function tool(t: TestBackend, name: string, args: Record<string, unknown>, secret = toolSecret) {
  return t.fetch(`/cartesia/tools/${name}`, {
    method: "POST", headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/json" },
    body: JSON.stringify({ session_id: sessionId, ...args }),
  });
}
function remote(t: TestBackend, text: string, turnId: string) {
  return t.fetch("/cartesia/webhook", {
    method: "POST", headers: { "X-Webhook-Secret": toolSecret, "Content-Type": "application/json" },
    body: JSON.stringify({ type: "call_turn", call_id: providerId, turn: { id: turnId, role: "user", text } }),
  });
}
function events(t: TestBackend) { return t.run(ctx => ctx.db.query("call_event").collect()); }
async function state(t: TestBackend) {
  return (await t.query(internal.managed.detail, { id: sessionId }))?.session.state;
}
function finishWatchers(t: TestBackend) {
  return t.finishAllScheduledFunctions(() => vi.runOnlyPendingTimers());
}

beforeEach(() => {
  vi.stubEnv("CALL4ME_TOOL_SECRET", toolSecret);
  vi.stubEnv("CALL4ME_VIEWER_TOKEN", viewerToken);
  vi.stubEnv("CALL4ME_BACKEND_TOKEN", "synthetic-backend-token");
  vi.stubEnv("CALL4ME_ANSWER_KEY", "12".repeat(32));
  vi.stubEnv("TYPESAFE_API_KEY", "synthetic-typesafe-key");
  providerFetch.mockClear();
  providerRequests.length = 0;
  providerAnswer = body => decision(body, "2");
  vi.stubGlobal("fetch", providerFetch);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe("managed Cartesia calls use Jev through their HTTP tools", () => {
  it("rejects unauthorized menu requests before invoking Jev", async () => {
    const t = setup(); await seed(t);
    const response = await tool(t, "menu_choice", { options: "1: Sales\n2: Refunds" }, "wrong");
    expect(response.status).toBe(401);
    expect(providerFetch).not.toHaveBeenCalled();
    expect((await events(t)).filter(event => event.kind === "jev_decision")).toEqual([]);
  });

  it("asks the TypeSafe provider to choose the menu and returns its actual selected key to Cartesia", async () => {
    const t = setup(); await seed(t);
    const response = await tool(t, "menu_choice", { options: "1: Sales\n2: Refunds" });
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("Press 2 with send_dtmf");
    expect(providerFetch).toHaveBeenCalledTimes(1);
    expect(providerRequests[0]).toMatchObject({
      model: "jev-latest", state: { goal: call.goal, menu_options: { "1": "Sales", "2": "Refunds" } },
      questions: { menu_choice: { type: "choice", criteria: { "1": "Sales", "2": "Refunds" } } },
    });
    const recorded = (await events(t)).filter(event => event.kind === "jev_decision");
    expect(recorded).toHaveLength(1);
    expect(recorded[0].detail_json).toMatchObject({
      question: "menu_choice", choice: "2", probability: 0.93, source: "jev", fallback: false,
    });
    const audit = await t.query(internal.managed.auditLog, { session_id: sessionId });
    expect(audit.some(row => row.action === "jev.decision")).toBe(true);
  });

  it("preserves the old callback rule before asking Jev for the menu choice", async () => {
    const t = setup(); await seed(t);
    const response = await tool(t, "menu_choice", { options: "1: Request a callback\n2: Continue holding for refunds" });
    expect(await response.text()).toContain("Press 2 with send_dtmf");
    expect(providerRequests[0].questions.menu_choice.criteria).toEqual({ "2": "Continue holding for refunds" });
  });

  it("marks provider failures as a heuristic fallback instead of claiming a real Jev decision", async () => {
    const t = setup(); await seed(t);
    providerAnswer = () => new Response("provider unavailable", { status: 503 });
    const response = await tool(t, "menu_choice", { options: "1: Sales\n2: Refunds" });
    expect(response.status).toBe(200);
    expect(providerFetch).toHaveBeenCalledTimes(1);
    const recorded = (await events(t)).find(event => event.kind === "jev_decision");
    expect(recorded?.detail_json).toMatchObject({ source: "heuristic", fallback: true });
    expect(recorded?.detail_json.fallback_reason).toBeTruthy();
  });

  it.each(["a person answers", "a new menu arrives"])("does not return an obsolete key when %s during Jev selection", async change => {
    vi.useFakeTimers();
    const t = setup(); await seed(t, "MENU");
    let release!: (response: Response) => void;
    providerAnswer = () => new Promise<Response>(resolve => { release = resolve; });
    const selecting = tool(t, "menu_choice", { options: "1: Sales\n2: Refunds" });
    await vi.waitFor(() => expect(providerFetch).toHaveBeenCalledTimes(1));
    if (change === "a person answers") {
      await tool(t, "report_state", { state: "person", note: "A representative answered." });
    } else {
      await remote(t, "The menu has changed. For refunds press 3.", "new-menu-turn");
    }
    release(decision(providerRequests[0], "2"));
    providerAnswer = body => decision(body, "menu");
    const result = await (await selecting).text();
    expect(result).not.toContain("Press 2 with send_dtmf");
    expect(result).toContain("Do not send these tones");
    await finishWatchers(t);
  });

  it.each(["report_state", "watcher"])("returns the chosen key when %s advances the same menu from DIALING to MENU", async change => {
    vi.useFakeTimers();
    const t = setup(); await seed(t);
    if (change === "watcher") await remote(t, "For sales press 1. For refunds press 2.", "current-menu-turn");
    const before = await t.query(internal.managed.jevContext, { session_id: sessionId });
    let release!: (response: Response) => void;
    let notifyStarted!: () => void;
    const menuStarted = new Promise<void>(resolve => { notifyStarted = resolve; });
    providerAnswer = body => {
      if (!body.questions.menu_choice) return decision(body, "menu");
      return new Promise<Response>(resolve => { release = resolve; notifyStarted(); });
    };
    const selecting = tool(t, "menu_choice", { options: "1: Sales\n2: Refunds" });
    // Do not advance fake time here: the menu request must already be in flight
    // before the parallel state report changes DIALING to MENU.
    await menuStarted;
    if (change === "report_state") {
      await tool(t, "report_state", { state: "menu", note: "The current menu lists refunds on 2." });
    } else {
      await vi.advanceTimersByTimeAsync(0);
      await t.finishInProgressScheduledFunctions();
    }
    const after = await t.query(internal.managed.jevContext, { session_id: sessionId });
    expect(after?.state).toBe("MENU");
    expect(after?.sequence).toBe(before?.sequence);
    expect(after!.state_version).toBeGreaterThan(before!.state_version);
    release(decision(providerRequests.find(body => body.questions.menu_choice)!, "2"));
    // A valid key returns without another timer, transcript turn, or retry.
    const result = await (await selecting).text();
    expect(result).toContain("Press 2 with send_dtmf");
    expect(result).not.toContain("Do not send these tones");
  });
});

describe("Jev watches company speech in the deployed webhook path", () => {
  it("distinguishes a recording from a person and stops watching after a person answers", async () => {
    vi.useFakeTimers();
    const t = setup(); await seed(t);
    providerAnswer = body => decision(body, "recorded_message");
    await remote(t, "This call may be recorded for quality assurance.", "recording-turn");
    await finishWatchers(t);
    expect(await state(t)).toBe("RECORDED_MESSAGE");
    providerAnswer = body => decision(body, "human", 0.85);
    await remote(t, "Hello, this is Sam. How can I help you today?", "human-turn");
    await finishWatchers(t);
    expect(await state(t)).toBe("IN_CONVERSATION");
    const transitions = (await events(t)).filter(event => event.kind === "transition").map(event => event.to_state);
    expect(transitions.slice(-3)).toEqual(["HUMAN_SUSPECTED", "HUMAN_CONFIRMED", "IN_CONVERSATION"]);
    expect(providerRequests.map(body => Object.keys(body.questions)[0])).toEqual(["state_check", "state_check"]);
    await remote(t, "Could you tell me the order number?", "human-followup");
    await finishWatchers(t);
    expect(providerFetch).toHaveBeenCalledTimes(2);
    expect((await events(t)).filter(event => event.kind === "jev_decision").map(event => event.detail_json))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ choice: "recorded_message", source: "jev", applied: true }),
        expect.objectContaining({ choice: "human", source: "jev", applied: true }),
      ]));
  });

  it("does not mark a person confirmed below the original human threshold", async () => {
    vi.useFakeTimers();
    const t = setup(); await seed(t);
    providerAnswer = body => decision(body, "human", 0.7);
    await remote(t, "Thank you for calling, how can I help?", "uncertain-human");
    await finishWatchers(t);
    expect(await state(t)).toBe("DIALING");
    expect(providerFetch).toHaveBeenCalledTimes(1);
    expect((await events(t)).find(event => event.kind === "jev_decision")?.detail_json)
      .toMatchObject({ choice: "human", probability: 0.7, applied: false });
  });

  it("deduplicates a retried Cartesia turn before captions and Jev work", async () => {
    vi.useFakeTimers();
    const t = setup(); await seed(t);
    providerAnswer = body => decision(body, "menu");
    await remote(t, "For refunds press 2.", "same-turn");
    await finishWatchers(t);
    await remote(t, "For refunds press 2.", "same-turn");
    await finishWatchers(t);
    expect(providerFetch).toHaveBeenCalledTimes(1);
    expect((await events(t)).filter(event => event.kind === "caption")).toHaveLength(1);
    expect((await events(t)).filter(event => event.kind === "jev_decision")).toHaveLength(1);
  });

  it("does not let an in-flight state decision override a newer agent report", async () => {
    vi.useFakeTimers();
    const t = setup(); await seed(t);
    let release!: (response: Response) => void;
    providerAnswer = () => new Promise<Response>(resolve => { release = resolve; });
    await remote(t, "Please hold for the next available agent.", "slow-state-turn");
    await vi.advanceTimersByTimeAsync(0);
    await vi.waitFor(() => expect(providerFetch).toHaveBeenCalledTimes(1));
    const report = await tool(t, "report_state", { state: "person", note: "A representative answered." });
    expect(report.status).toBe(200);
    release(decision(providerRequests[0], "hold_music"));
    await t.finishInProgressScheduledFunctions();
    expect(await state(t)).toBe("IN_CONVERSATION");
    const recorded = (await events(t)).find(event => event.kind === "jev_decision");
    expect(recorded?.detail_json).toMatchObject({ choice: "hold_music", applied: false });
  });

  it("does not reopen a completed call when an earlier Jev request finishes", async () => {
    vi.useFakeTimers();
    const t = setup(); await seed(t);
    let release!: (response: Response) => void;
    providerAnswer = () => new Promise<Response>(resolve => { release = resolve; });
    await remote(t, "Hello, this is Sam. How may I help you?", "last-remote-turn");
    await vi.advanceTimersByTimeAsync(0);
    await vi.waitFor(() => expect(providerFetch).toHaveBeenCalledTimes(1));
    await t.mutation(internal.managed.finish, {
      session_id: sessionId, failed: false, reason: "The company ended the call.", summary: "",
    });
    release(decision(providerRequests[0], "human"));
    await t.finishInProgressScheduledFunctions();
    expect(await state(t)).toBe("ENDED");
    expect((await events(t)).filter(event => event.kind === "transition").at(-1)?.to_state).toBe("ENDED");
    expect((await events(t)).some(event => event.kind === "transition" && event.to_state === "IN_CONVERSATION")).toBe(false);
  });
});

describe("the restored Jev path preserves PIN keypad delivery", () => {
  it("returns the exact encrypted user answer as DTMF without converting the menu into a human conversation", async () => {
    const t = setup(); await seed(t, "MENU");
    const asking = tool(t, "ask_user", { question: "Enter your PIN followed by pound.", sensitivity: "medium", delivery: "dtmf" });
    let requestId = "";
    await vi.waitFor(async () => {
      const requests = await t.run(ctx => ctx.db.query("user_request").collect());
      expect(requests).toHaveLength(1);
      requestId = requests[0].id;
    });
    const answer = await t.fetch(`/requests/${requestId}/answer`, {
      method: "POST", headers: { Authorization: `Bearer ${viewerToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ answer: "0012#" }),
    });
    expect(answer.status).toBe(202);
    const mailbox = await t.run(ctx => ctx.db.query("answer_mailbox").collect());
    expect(mailbox).toHaveLength(1);
    expect(mailbox[0].ciphertext).not.toContain("0012#");
    const response = await asking;
    const instruction = await response.text();
    expect(instruction).toContain("keypad digits: 0012#");
    expect(instruction).toContain("Call send_dtmf now with these exact digits");
    expect(instruction).toContain("Do not speak the digits or any commentary");
    expect(await state(t)).toBe("MENU");
    expect(providerFetch).not.toHaveBeenCalled();
    expect(await t.run(ctx => ctx.db.query("answer_mailbox").collect())).toEqual([]);
    expect(JSON.stringify(await events(t))).not.toContain("0012#");
  });
});
