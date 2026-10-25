import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chooseMenu, decideState, parseMenuOptions } from "../../convex/jev";

const menu = { goal: "Refund my headphones", options: { "1": "New orders", "2": "Returns and refunds", "0": "Representative" }, transcript: "For orders press 1, for returns and refunds press 2, or speak with a representative by pressing 0." };
function answer(question: string, choice: string, probabilities: Record<string, number>, confidence = 0.31) {
  return new Response(JSON.stringify({ model: "jev-latest", usage: {}, answers: {
    [question]: { type: "choice", choice, probabilities, confidence },
  } }), { status: 200, headers: { "Content-Type": "application/json" } });
}
let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;
beforeEach(() => {
  vi.stubEnv("TYPESAFE_API_KEY", "test-key");
  vi.stubEnv("TYPESAFE_BASE_URL", "");
  fetchMock = vi.fn<typeof fetch>();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.useRealTimers(); });

describe("TypeSafe Jev HTTP decisions", () => {
  it("uses the SDK's HTTP request and answers schema, with chosen probability instead of confidence", async () => {
    fetchMock.mockResolvedValue(answer("menu_choice", "2", { "0": 0.1, "1": 0.12, "2": 0.78 }));
    const decision = await chooseMenu(menu);
    expect(decision).toEqual({ question: "menu_choice", choice: "2", probability: 0.78,
      alternatives: { "0": 0.1, "1": 0.12, "2": 0.78 }, source: "jev" });
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.typesafe.ai/v1/systemone");
    expect(init?.method).toBe("POST");
    expect(init?.headers).toMatchObject({ Authorization: "Bearer test-key", "Content-Type": "application/json" });
    expect(JSON.parse(init?.body as string)).toEqual({
      model: "jev-latest", state: { goal: menu.goal, menu_options: menu.options, transcript: menu.transcript },
      questions: { menu_choice: { type: "choice", criteria: menu.options,
        instructions: "A phone menu just listed options. Which option best moves the caller toward their goal? Prefer reaching a live representative when no option clearly fits." } },
    });
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it("sends the legacy state context and all eight state descriptions", async () => {
    fetchMock.mockResolvedValue(answer("state_check", "human", { human: 0.93, menu: 0.07 }));
    const decision = await decideState({ transcript: "Your call is important. Hello, how can I help?", latest: "Hello, how can I help?", currentState: "HOLD" });
    expect(decision).toMatchObject({ question: "state_check", choice: "human", probability: 0.93, source: "jev" });
    const request = JSON.parse(fetchMock.mock.calls[0][1]?.body as string);
    expect(request.state).toEqual({
      latest_utterance: "Hello, how can I help?", transcript: "Your call is important. Hello, how can I help?",
      current_state: "HOLD", audio_label: null, audio_confidence: null, silence_seconds: 0,
    });
    expect(Object.keys(request.questions.state_check.criteria)).toEqual([
      "menu", "recorded_message", "hold_music", "silence", "human", "voicemail", "callback_offer", "call_ended",
    ]);
    expect(request.questions.state_check.instructions).toBe("You are monitoring an automated customer-service phone call from the caller's side. Given the last few seconds of what the company side said and the audio label, what is happening on the line right now? Judge mainly by latest_utterance: the earlier transcript may still hold the end of a recording that came before it.");
  });

  it("keeps the callback override and uses transcript when latest is omitted", async () => {
    fetchMock.mockResolvedValue(answer("state_check", "menu", { menu: 0.88, callback_offer: 0.12 }));
    const decision = await decideState({ transcript: "To get a callback, press 1.", currentState: "MENU" });
    expect(decision).toMatchObject({ choice: "callback_offer", probability: 0.88, source: "jev" });
    expect(JSON.parse(fetchMock.mock.calls[0][1]?.body as string).state.latest_utterance).toBe("To get a callback, press 1.");
  });

  it("falls back to confidence only when the chosen option probability is absent", async () => {
    fetchMock.mockResolvedValue(answer("menu_choice", "2", { "1": 0.1 }, 0.7));
    expect(await chooseMenu(menu)).toMatchObject({ choice: "2", probability: 0.7, source: "jev" });
  });

  it("uses discounted heuristics without a key and never claims Jev ran", async () => {
    vi.stubEnv("TYPESAFE_API_KEY", "");
    const decision = await chooseMenu(menu);
    expect(decision).toMatchObject({ choice: "2", source: "heuristic", fallback_reason: "missing_api_key", alternatives: { fallback: 1 } });
    expect(decision.probability).toBeCloseTo(0.45);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ["unknown_choice", () => answer("menu_choice", "9", { "9": 1 }, 1)],
    ["invalid_response", () => answer("menu_choice", "2", { "2": 1.2 })],
    ["invalid_response", () => new Response(JSON.stringify({ choices: { menu_choice: { choice: "2" } } }))],
    ["http_401", () => new Response("provider error with a sensitive diagnostic", { status: 401 })],
  ])("marks %s as heuristic fallback", async (reason, response) => {
    fetchMock.mockResolvedValue(response());
    const decision = await chooseMenu(menu);
    expect(decision).toMatchObject({ choice: "2", source: "heuristic", fallback_reason: reason, alternatives: { fallback: 1 } });
    expect(JSON.stringify(decision)).not.toContain("sensitive");
  });

  it("does not copy exception messages or credentials into decision metadata", async () => {
    fetchMock.mockRejectedValue(new Error("sensitive test-key provider detail"));
    const decision = await chooseMenu(menu);
    expect(decision.fallback_reason).toBe("request_failed");
    expect(JSON.stringify(decision)).not.toMatch(/sensitive|test-key/);
  });

  it("aborts at the two-second deadline even when fetch does not settle", async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementation(() => new Promise(() => {}));
    let completed = false;
    const pending = chooseMenu(menu).then(value => { completed = true; return value; });
    await vi.advanceTimersByTimeAsync(1_999);
    expect(completed).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toMatchObject({ source: "heuristic", fallback_reason: "timeout" });
    expect(fetchMock.mock.calls[0][1]?.signal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps the timeout active while reading the provider response body", async () => {
    vi.useFakeTimers();
    fetchMock.mockResolvedValue({ ok: true, json: () => new Promise(() => {}) } as Response);
    const pending = chooseMenu(menu);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(await pending).toMatchObject({ source: "heuristic", fallback_reason: "timeout" });
  });

  it("preserves legacy heuristic state precedence and confidence discount", async () => {
    vi.stubEnv("TYPESAFE_API_KEY", "");
    expect(await decideState({ transcript: "To get a callback, press 1", currentState: "MENU" })).toMatchObject({ choice: "callback_offer", probability: 0.54 });
    expect(await decideState({ transcript: "Please hold for the next available representative", currentState: "HOLD" })).toMatchObject({ choice: "recorded_message", probability: 0.54 });
    expect(await decideState({ transcript: "", currentState: "HOLD" })).toMatchObject({ choice: "silence", probability: 0.36 });
    expect(await decideState({ transcript: "Unclassified speech", currentState: "HOLD" })).toMatchObject({ choice: "human", probability: 0.24 });
  });

  it("prefers a representative when goal words do not fit and discounts repeated menu words", async () => {
    vi.stubEnv("TYPESAFE_API_KEY", "");
    expect(await chooseMenu({ ...menu, goal: "Close an account" })).toMatchObject({ choice: "0", probability: 0.36 });
    expect(await chooseMenu({ goal: "Refund status", options: { "1": "Returns and refunds", "2": "Status of a refund" }, transcript: "Returns and refunds. Status of a refund." })).toMatchObject({ choice: "2", source: "heuristic" });
  });
});

describe("legacy managed menu parsing", () => {
  it("separates comma-delimited keypad options from a real Cartesia-style response", () => {
    expect(parseMenuOptions("2: billing and late fee questions, 3: technical support, *: hear options again", "")).toEqual({
      "2": "billing and late fee questions", "3": "technical support", "*": "hear options again",
    });
  });
  it("offers Jev the refund choice even when a wrong choice comes first on the same line", async () => {
    const options = parseMenuOptions("1: sales, new purchases, 2: refunds, returns, press #: repeat options", "");
    expect(options).toEqual({ "1": "sales, new purchases", "2": "refunds, returns", "#": "repeat options" });
    fetchMock.mockResolvedValue(answer("menu_choice", "2", { "1": 0.05, "2": 0.9, "#": 0.05 }));
    expect(await chooseMenu({ goal: "Refund headphones", options, transcript: "" })).toMatchObject({ choice: "2", source: "jev" });
    expect(JSON.parse(fetchMock.mock.calls[0][1]?.body as string).questions.menu_choice.criteria).toEqual(options);
  });
  it("recognizes speech-token keys without splitting ordinary commas inside their labels", () => {
    expect(parseMenuOptions("sales: new orders, product questions, billing: invoices, charges, say representative: speak to someone", "")).toEqual({
      "say:sales": "new orders, product questions", "say:billing": "invoices, charges", "say:representative": "speak to someone",
    });
  });
  it("uses structured agent options first, keeps the first duplicate, and preserves keypad strings", () => {
    expect(parseMenuOptions("press 02#: Returns; 1: Sales\n02#: ignored\nrepresentative: Talk to someone", "For billing press 8")).toEqual({
      "02#": "Returns", "1": "Sales", "say:representative": "Talk to someone",
    });
  });
  it.each([
    ["For orders, press 1. For billing, press two.", { "1": "orders", "2": "billing" }],
    ["Press 1 for orders, press 2 for billing.", { "1": "orders", "2": "billing" }],
    ["To speak with an agent press zero. Or say representative.", { "0": "speak with an agent", "say:representative": "representative" }],
    ["Your call is important to us.", {}],
  ])("falls back to the same transcript regex for %s", (transcript, expected) => {
    expect(parseMenuOptions("not structured", transcript)).toEqual(expected);
  });
  it("filters callback choices but preserves the original when every option is a callback", () => {
    expect(parseMenuOptions("1: Get a callback; 2: Keep holding", "")).toEqual({ "2": "Keep holding" });
    expect(parseMenuOptions("1: Get a callback", "")).toEqual({ "1": "Get a callback" });
  });
});
