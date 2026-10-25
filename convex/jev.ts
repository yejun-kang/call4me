/** The legacy Jev checks, using TypeSafe's HTTP wire format in Convex actions. */
export type Decision = {
  question: "state_check" | "menu_choice";
  choice: string;
  probability: number;
  alternatives: Record<string, number>;
  source: "jev" | "heuristic";
  fallback_reason?: string;
};

const INSTRUCTIONS = {
  state_check: "You are monitoring an automated customer-service phone call from the caller's side. " +
    "Given the last few seconds of what the company side said and the audio label, " +
    "what is happening on the line right now? Judge mainly by latest_utterance: the " +
    "earlier transcript may still hold the end of a recording that came before it.",
  menu_choice: "A phone menu just listed options. Which option best moves the caller toward their " +
    "goal? Prefer reaching a live representative when no option clearly fits.",
};
const STATE_DESCRIPTIONS: Record<string, string> = {
  menu: "an automated menu listing options to press or say",
  recorded_message: "a recorded announcement (e.g. 'your call is important to us')",
  hold_music: "hold music is playing",
  silence: "nothing is being said",
  human: "a live person is speaking (e.g. introduces themselves, asks how to help)",
  voicemail: "a voicemail box asking to leave a message",
  callback_offer: "the system offers to call the caller back instead of waiting",
  call_ended: "the call was disconnected or the other side said goodbye and hung up",
};
const CALLBACK = /(call you back|callback|call back|return your call|keep your place in line)/;
const STATE_PATTERNS: [string, RegExp][] = [
  ["call_ended", /\b(goodbye|good bye|disconnect(ed|ing)?|hang(ing)? up)\b/],
  ["voicemail", /(leave (a|your) message|after the (tone|beep)|voicemail)/],
  ["callback_offer", CALLBACK],
  ["human", /(my name is|this is \w+ (speaking|with)|how (can|may) i (help|assist)|who am i speaking|thank you for (holding|waiting)[,.]? (this is|my name)|hello\?|are you there|can you hear me)/],
  ["menu", /(\bpress\b|\bsay\b \w+|\bfor\b [\w ]+,? (press|say|dial)|main menu)/],
  ["recorded_message", /(your call is important|please (continue to )?hold|please stay on the line|all of our (agents|representatives|associates)|wait time|calls? (may be|are) (recorded|monitored)|monitored for quality|thank you for calling|menu options have changed|transfer(ring)? you|next available)/],
];
const STOP = new Set(["the", "a", "an", "to", "for", "my", "of", "and", "or", "on", "in", "is", "i"]);
const REP_WORDS = new Set(["agent", "representative", "operator", "person", "someone", "associate"]);
const stem = (word: string) => word.endsWith("s") && word.length > 3 ? word.slice(0, -1) : word;
const tokens = (text: string) => text.toLowerCase().match(/[a-z]+/g) ?? [];
const words = (text: string) => new Set(tokens(text).filter(word => !STOP.has(word)).map(stem));

function heuristicState(transcript: string): [string, number] {
  const text = transcript.toLowerCase().trim();
  for (const [choice, pattern] of STATE_PATTERNS) {
    if (text && pattern.test(text)) return [choice, 0.9];
  }
  // Managed calls do not provide the audio labels used by the Python phone pipeline.
  return text ? ["human", 0.4] : ["silence", 0.6];
}

function heuristicMenu(goal: string, labels: Record<string, string>, transcript: string): [string, number] {
  const options = Object.keys(labels);
  const goalWords = words(goal);
  const heard = new Map<string, number>();
  for (const word of tokens(transcript).map(stem)) heard.set(word, (heard.get(word) ?? 0) + 1);
  let best: string | undefined;
  let bestScore = 0;
  for (const key of options) {
    const score = [...words(labels[key])].reduce((sum, word) =>
      sum + (goalWords.has(word) ? 1 / Math.max(1, heard.get(word) ?? 0) : 0), 0);
    if (score > bestScore) { best = key; bestScore = score; }
  }
  if (best !== undefined) return [best, Math.min(0.95, 0.6 + 0.15 * Math.max(1, bestScore))];
  for (const key of options) {
    if ([...words(labels[key])].some(word => REP_WORDS.has(word))) return [key, 0.6];
  }
  return [options[0], 0.3];
}

class DecisionFailure extends Error {}
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isProbability = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;

function parseDecision(raw: unknown, question: Decision["question"], options: string[]): Decision {
  const answer = isRecord(raw) && isRecord(raw.answers) ? raw.answers[question] : undefined;
  if (!isRecord(answer) || answer.type !== "choice" || typeof answer.choice !== "string" ||
    !isRecord(answer.probabilities) || !isProbability(answer.confidence)) {
    throw new DecisionFailure("invalid_response");
  }
  if (!options.includes(answer.choice)) throw new DecisionFailure("unknown_choice");
  const alternatives: Record<string, number> = {};
  for (const [key, value] of Object.entries(answer.probabilities)) {
    if (!isProbability(value)) throw new DecisionFailure("invalid_response");
    alternatives[key] = value;
  }
  return {
    question, choice: answer.choice,
    // Keep Python's chosen-option probability; confidence is a different certainty score.
    probability: alternatives[answer.choice] ?? answer.confidence,
    alternatives, source: "jev",
  };
}

async function choose(
  question: Decision["question"],
  descriptions: Record<string, string>,
  state: Record<string, unknown>,
  fallback: () => [string, number],
): Promise<Decision> {
  const options = Object.keys(descriptions);
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const apiKey = process.env.TYPESAFE_API_KEY?.trim();
    if (!apiKey) throw new DecisionFailure("missing_api_key");
    if (!/^[\x21-\x7e]+$/.test(apiKey)) throw new DecisionFailure("invalid_api_key");
    // Verified against typesafe-sdk's prepare_system_one/SystemOneResponse and the
    // TypeSafe Choice API docs: the response is answers[question], not choices[question].
    const request = async () => {
      const response = await fetch(`${(process.env.TYPESAFE_BASE_URL?.trim() || "https://api.typesafe.ai").replace(/\/+$/, "")}/v1/systemone`, {
        method: "POST", headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ model: "jev-latest", state, questions: {
          [question]: { type: "choice", instructions: INSTRUCTIONS[question], criteria: descriptions },
        } }),
        signal: controller.signal,
      });
      if (!response.ok) throw new DecisionFailure(`http_${response.status}`);
      return parseDecision(await response.json(), question, options);
    };
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => { reject(new DecisionFailure("timeout")); controller.abort(); }, 2_000);
    });
    return await Promise.race([request(), timeout]);
  } catch (error) {
    const [choice, heuristicProbability] = fallback();
    const probability = heuristicProbability * 0.6;
    const rest = (1 - probability) / Math.max(1, options.length - 1);
    return {
      question, choice, probability,
      alternatives: { fallback: 1, ...Object.fromEntries(options.map(option => [option, option === choice ? probability : rest])) },
      source: "heuristic",
      // Do not retain provider bodies, exception messages, transcripts, or keys in audit metadata.
      fallback_reason: error instanceof DecisionFailure ? error.message : "request_failed",
    };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export async function decideState(input: { transcript: string; latest?: string; currentState: string }): Promise<Decision> {
  const latest = input.latest || input.transcript;
  const decision = await choose("state_check", STATE_DESCRIPTIONS, {
    latest_utterance: latest, transcript: input.transcript,
    audio_label: null, audio_confidence: null, current_state: input.currentState, silence_seconds: 0,
  }, () => heuristicState(input.transcript));
  // Preserve the pre-migration callback override: a callback offer is also phrased as a menu.
  return decision.choice === "menu" && CALLBACK.test(latest.toLowerCase())
    ? { ...decision, choice: "callback_offer" } : decision;
}

export async function chooseMenu(input: { goal: string; options: Record<string, string>; transcript: string }): Promise<Decision> {
  if (!Object.keys(input.options).length) throw new Error("Menu options are required");
  return choose("menu_choice", input.options, {
    goal: input.goal, menu_options: input.options, transcript: input.transcript,
  }, () => heuristicMenu(input.goal, input.options, input.transcript));
}

const NUMBER_WORDS: Record<string, string> = {
  zero: "0", one: "1", two: "2", three: "3", four: "4", five: "5", six: "6", seven: "7", eight: "8", nine: "9", star: "*", pound: "#",
};
const KEY = String.raw`(\d|zero|one|two|three|four|five|six|seven|eight|nine|star|pound)`;
const LABEL = String.raw`([^,.;?!]+?)`;
const END = String.raw`(?=\s*(?:[,.;?!]|$|\bor\b|\bpress\b|\bfor\b))`;
const LABEL_THEN_KEY = new RegExp(String.raw`\b(?:for|to|if you(?:'d like to| would like to| want to)?)\s+${LABEL},?\s+(?:please\s+)?(?:press|dial|push|enter)\s+${KEY}\b`, "g");
const KEY_THEN_LABEL = new RegExp(String.raw`\b(?:press|dial|push)\s+${KEY}\s+(?:for|to|if)\s+${LABEL}${END}`, "g");
const SAY = /\bsay\s+["'“]?([a-z]+(?: [a-z]+)?)["'”]?(?=\s*(?:[,.;?!]|$|\bor\b|\bfor\b|\bto\b))/g;

/** Preserve the managed Python call's structured parser, regex backup and callback filter. */
export function parseMenuOptions(agentOptions: string, transcript: string): Record<string, string> {
  let options: Record<string, string> = {};
  // Cartesia may put structured options on one line. Keep label commas unless
  // the next item explicitly starts another keypad key or speech token and colon.
  const separator = /[\n;]|,\s*(?=(?:press\s+)?(?:[0-9*#]+|(?:say\s+)?[a-z][a-z'-]*)\s*:)/i;
  for (const line of agentOptions.split(separator)) {
    const match = line.match(/^\s*(?:press\s+)?([^:]+?)\s*:\s*(.+?)\s*$/i);
    if (!match) continue;
    let key = match[1].trim().toLowerCase();
    if (!/^[0-9*#]+$/.test(key)) key = `say:${key.replace(/^say/, "").trim()}`;
    if (!Object.hasOwn(options, key)) options[key] = match[2].trim();
  }
  if (!Object.keys(options).length) {
    const text = transcript.toLowerCase();
    const labelFirst = [...text.matchAll(LABEL_THEN_KEY)].map(match => ({
      key: NUMBER_WORDS[match[2]] ?? match[2], label: match[1].trim(), at: match.index,
    }));
    const keyFirst = [...text.matchAll(KEY_THEN_LABEL)].map(match => ({
      key: NUMBER_WORDS[match[1]] ?? match[1], label: match[2].trim(), at: match.index,
    }));
    const styles = [labelFirst, keyFirst].sort((a, b) => (a[0]?.at ?? text.length + 1) - (b[0]?.at ?? text.length + 1));
    for (const matches of styles) {
      for (const match of matches) {
        if (!Object.hasOwn(options, match.key)) options[match.key] = match.label;
      }
    }
    for (const match of text.matchAll(SAY)) {
      const word = match[1].trim();
      if (!["it", "that", "yes", "no"].includes(word) && !Object.hasOwn(options, `say:${word}`)) options[`say:${word}`] = word;
    }
  }
  const withoutCallbacks = Object.fromEntries(Object.entries(options).filter(([, label]) => !CALLBACK.test(label.toLowerCase())));
  options = Object.keys(withoutCallbacks).length ? withoutCallbacks : options;
  return options;
}
