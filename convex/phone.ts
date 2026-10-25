import { httpAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { chooseMenu, parseMenuOptions } from "./jev";

const CARTESIA = "https://api.cartesia.ai";
const VERSION = "2026-08-14";
const PRE_PERSON = new Set(["DIALING", "MENU", "HOLD", "RECORDED_MESSAGE", "CALLBACK_OFFERED"]);
const END_REASONS: Record<string, string> = {
  agent_hangup: "The assistant ended the call.", client_hangup: "The company ended the call.",
  api_cancelled: "You cancelled the call.", voicemail_detected: "The call reached voicemail.",
  call_inactivity: "The call ended after a long silence.", client_inactivity: "The call ended after a long silence.",
  max_duration: "The call reached its time limit.", dial_no_answer: "No one answered.",
  dial_busy: "The line was busy.", dial_failed: "The call could not be placed.", dial_timeout: "No one answered.",
};

function json(data: unknown, status = 200) { return Response.json(data, { status }); }
function error(detail: string, status = 400) { return json({ detail }, status); }
function bearer(request: Request) { return request.headers.get("Authorization")?.replace(/^Bearer\s+/i, "").trim() || ""; }
function viewer(request: Request) {
  const expected = process.env.CALL4ME_VIEWER_TOKEN;
  return !!expected && bearer(request) === expected;
}
function toolAuth(request: Request, webhook = false) {
  const expected = process.env.CALL4ME_TOOL_SECRET;
  const given = webhook ? request.headers.get("X-Webhook-Secret") : bearer(request);
  return !!expected && !!given && given === expected;
}
function text(value: unknown, max = 1000) { return String(value ?? "").trim().slice(0, max); }
function redact(value: unknown) {
  return text(value, 5000)
    .replace(/\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g, "[REDACTED]")
    .replace(/(?<!\d)\d(?:[ -]?\d){3,}(?!\d)/g, "[REDACTED]");
}
function highSensitivity(value: string, question = "") {
  if (/\b(?:password|passcode|cvv|cvc)\b/i.test(question)) return true;
  if (/\b(?:ssn|social security|(?:credit|debit) card number)\b/i.test(question) && !/last\s+(?:4|four)/i.test(question)) return true;
  if (/\b\d{3}-\d{2}-\d{4}\b/.test(value)) return true;
  const digits = value.replace(/\D/g, "");
  if (digits.length >= 13 && digits.length <= 19) {
    let sum = 0; for (let i = 0; i < digits.length; i++) {
      let n = Number(digits[digits.length - 1 - i]);
      if (i % 2) n = n > 4 ? n * 2 - 9 : n * 2;
      sum += n;
    }
    if (sum % 10 === 0) return true;
  }
  return false;
}
function keyBytes() {
  const hex = process.env.CALL4ME_ANSWER_KEY || "";
  if (!/^[a-f0-9]{64}$/i.test(hex)) throw Error("Answer encryption key is not configured");
  return Uint8Array.from(hex.match(/../g)!, b => parseInt(b, 16));
}
function toBase64(bytes: Uint8Array) { return btoa(String.fromCharCode(...bytes)); }
function fromBase64(value: string) { return Uint8Array.from(atob(value), c => c.charCodeAt(0)); }
async function encrypt(answer: string) {
  const key = await crypto.subtle.importKey("raw", keyBytes(), "AES-GCM", false, ["encrypt"]);
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, key, new TextEncoder().encode(answer));
  return { ciphertext: toBase64(new Uint8Array(ciphertext)), nonce: toBase64(nonce) };
}
async function decrypt(ciphertext: string, nonce: string) {
  const key = await crypto.subtle.importKey("raw", keyBytes(), "AES-GCM", false, ["decrypt"]);
  const bytes = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromBase64(nonce) }, key, fromBase64(ciphertext));
  return new TextDecoder().decode(bytes);
}
async function cartesia(path: string, method = "GET", body?: unknown) {
  const apiKey = process.env.CARTESIA_API_KEY;
  if (!apiKey) throw Error("Cartesia is not configured");
  const response = await fetch(CARTESIA + path, {
    method, headers: { Authorization: `Bearer ${apiKey}`, "Cartesia-Version": VERSION,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) throw Error(`Cartesia ${method} ${path} returned ${response.status}`);
  return response.status === 204 ? {} : response.json();
}
function normalizePhone(value: string) {
  const digits = value.replace(/\D/g, "");
  if (value.startsWith("+") && digits.length >= 8 && digits.length <= 15) return `+${digits}`;
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return null;
}
function sessionOut(row: Record<string, unknown>) {
  const { limits_json, ...rest } = row;
  return { ...rest, limits: limits_json };
}

export const calls = httpAction(async (ctx, request) => {
  if (!viewer(request)) return error("missing or wrong access token", 401);
  if (request.method === "GET") {
    const url = new URL(request.url);
    const limit = Number(url.searchParams.get("limit") || 20);
    const user_id = url.searchParams.get("user_id");
    const rows = await ctx.runQuery(internal.managed.list, { user_id, limit });
    return json(rows.map(row => sessionOut(row)));
  }
  let body: Record<string, any>;
  try { body = await request.json(); } catch { return error("Invalid JSON"); }
  const company = text(body.company, 120), goal = text(body.goal, 1500);
  const disclosure = text(body.disclosure_text, 500);
  const phone = normalizePhone(text(body.phone_number));
  if (!company || !goal || !disclosure || !phone) return error("Company, phone number, goal and disclosure are required", 422);
  const known = Array.isArray(body.known_info) ? body.known_info.slice(0, 10) : [];
  for (const item of known) {
    if (!text(item.label, 40) || !text(item.value, 120) || highSensitivity(text(item.value), text(item.label)))
      return error("Known information contains unsupported sensitive information", 422);
  }
  const limits = {
    max_hold_minutes: Number(body.limits?.max_hold_minutes || 0), max_spend_usd: Number(body.limits?.max_spend_usd || 0),
    allow_plan_changes: !!body.limits?.allow_plan_changes, allow_cancellation: !!body.limits?.allow_cancellation,
    notes: text(body.limits?.notes, 1000),
  };
  const id = crypto.randomUUID().replaceAll("-", "");
  const call = { id, user_id: text(body.user_id, 64) || "demo-user", company, phone_number: phone,
    goal, limits_json: limits, disclosure_text: disclosure, state: "DIALING", started_at: new Date().toISOString(),
    ended_at: null, outcome: null, reference_number: null, minutes_saved: null };
  await ctx.runMutation(internal.managed.start, { call });
  const restrictions = [limits.allow_plan_changes ? "Plan or subscription changes allowed." : "No plan or subscription changes.",
    limits.allow_cancellation ? "Cancellation allowed." : "No cancellations.",
    limits.max_spend_usd ? `Spend at most $${limits.max_spend_usd}.` : "No new charges.", limits.notes].filter(Boolean).join(" ");
  try {
    const result = await cartesia("/agents/calls", "POST", {
      agent_id: process.env.CARTESIA_AGENT_ID, from_number_id: process.env.CARTESIA_NUMBER_ID,
      ringing_timeout_seconds: 60,
      outbound_calls: [{ to_number: phone, dynamic_variables: {
        session_id: id, company, goal, limits: restrictions,
        known_info: known.map((item: any) => `${text(item.label, 40)}: ${text(item.value, 120)}`).join("; ") || "none",
        disclosure,
      } }],
    });
    const providerId = result?.calls?.[0]?.agent_call_id;
    if (!providerId) throw Error("Cartesia did not return a call ID");
    await ctx.runMutation(internal.managed.attachProvider, { session_id: id, provider_call_id: String(providerId) });
  } catch (e) {
    await ctx.runMutation(internal.managed.finish, { session_id: id, failed: true,
      reason: "The call could not be placed. Try again in a moment.", summary: "" });
  }
  return json(sessionOut(call), 201);
});

export const callPath = httpAction(async (ctx, request) => {
  if (!viewer(request)) return error("missing or wrong access token", 401);
  const parts = new URL(request.url).pathname.split("/").filter(Boolean);
  const id = parts[1], action = parts[2];
  if (!id) return error("call not found", 404);
  const detail = await ctx.runQuery(internal.managed.detail, { id });
  if (!detail) return error("call not found", 404);
  if (request.method === "GET") {
    if (action === "audit") return json(await ctx.runQuery(internal.managed.auditLog, { session_id: id }));
    if (action) return error("not found", 404);
    return json({ session: sessionOut(detail.session), timeline: detail.timeline.map(e => {
      const { detail_json, ...rest } = e; return { ...rest, detail: detail_json };
    }) });
  }
  if (action === "takeover" || action === "handback") return json({ ok: false, detail: "This call does not support takeover" }, 202);
  if (action === "type") {
    const body = await request.json();
    const value = text(body.text, 1000);
    if (!value) return error("Message is required", 422);
    const encrypted = await encrypt(value);
    const queued = await ctx.runMutation(internal.managed.queueTyped, { session_id: id, ...encrypted });
    return queued ? json({ ok: true, detail: "queued" }, 202) : error("call ended", 409);
  }
  if (action !== "cancel" && action !== "hold") return error("not found", 404);
  if (action === "hold") {
    const body = await request.json();
    if (body.keep_waiting) return json({ ok: true, detail: "keep waiting" }, 202);
  }
  const managed = await ctx.runQuery(internal.managed.managed, { session_id: id });
  if (managed?.provider_call_id && !["ENDED", "FAILED"].includes(managed.call.state)) {
    try { await cartesia(`/agents/calls/${managed.provider_call_id}/cancel`, "POST"); }
    catch { return error("Could not cancel the call; try again", 502); }
  }
  return json({ ok: true, detail: "cancel requested" }, 202);
});

export const answer = httpAction(async (ctx, request) => {
  if (!viewer(request)) return error("missing or wrong access token", 401);
  const request_id = new URL(request.url).pathname.split("/")[2];
  if (!request_id) return error("request not found", 404);
  const info = await ctx.runQuery(internal.managed.requestInfo, { request_id });
  if (!info) return error("request not found", 404);
  if (info.status !== "pending") return error(`request is ${info.status}`, 409);
  const body = await request.json();
  const value = text(body.answer, 500);
  if (!value) return error("Answer is required", 422);
  const encrypted = await encrypt(value);
  const accepted = await ctx.runMutation(internal.managed.putAnswer, { request_id, ...encrypted });
  if (!accepted) return error("request already answered", 409);
  return json({ ok: true, detail: "delivered" }, 202);
});

export const companies = httpAction(async (_ctx, request) => {
  if (!viewer(request)) return error("missing or wrong access token", 401);
  const q = (new URL(request.url).searchParams.get("q") || "").toLowerCase();
  const rows = [{ name: "Amazon", phone_number: "", note: "Enter the support number to call" }];
  return json(rows.filter(row => row.name.toLowerCase().includes(q)));
});

export const metrics = httpAction(async (_ctx, request) => {
  if (!viewer(request)) return error("missing or wrong access token", 401);
  return error("no eval results yet", 404);
});

export const webhook = httpAction(async (ctx, request) => {
  if (!toolAuth(request, true)) return error("bad secret", 401);
  const event = await request.json();
  const session_id = await ctx.runQuery(internal.managed.byProvider, { provider_call_id: text(event.call_id) });
  if (!session_id) return json({ ok: false });
  const kind = text(event.type);
  if (kind === "call_turn") {
    const turn = event.turn || {};
    for (const call of turn.tool_calls || []) {
      if (call.name === "send_dtmf") await ctx.runMutation(internal.managed.menuAction, { session_id });
    }
    const caption = redact(turn.text);
    if (caption) await ctx.runMutation(internal.managed.caption, {
      session_id, speaker: turn.role === "assistant" ? "agent" : "remote", text: caption,
      ...(typeof turn.id === "string" ? { turn_id: turn.id } : typeof event.id === "string" ? { turn_id: event.id } : {}),
    });
  } else if (kind === "call_completed" || kind === "call_failed") {
    const call = event.call || {};
    const reason = text(call.end_reason, 100);
    const explanation = END_REASONS[reason] || reason.replaceAll("_", " ") || "The call ended.";
    await ctx.runMutation(internal.managed.finish, { session_id,
      failed: call.status === "failed", reason: explanation, summary: redact(call.summary),
    });
    try {
      await cartesia(`/agents/calls/${text(event.call_id)}`, "DELETE");
      await ctx.runMutation(internal.managed.markProviderDeleted, { session_id });
    } catch { /* retry via maintenance */ }
  }
  return json({ ok: true });
});

export const tool = httpAction(async (ctx, request) => {
  if (!toolAuth(request)) return error("bad secret", 401);
  const name = new URL(request.url).pathname.split("/").at(-1);
  const args = await request.json();
  const session_id = text(args.session_id);
  const managed = await ctx.runQuery(internal.managed.managed, { session_id });
  if (!managed || ["ENDED", "FAILED"].includes(managed.call.state))
    return new Response("This call is no longer active. Wrap up politely.");
  let result = "noted";
  if (name === "menu_choice") {
    const context = await ctx.runQuery(internal.managed.jevContext, { session_id });
    if (!context) return new Response("This call is no longer active. Wrap up politely.");
    const options = parseMenuOptions(redact(args.options), context.transcript);
    if (!Object.keys(options).length) result = "Could not read the options. Pick the one that best fits the goal yourself.";
    else {
      const decision = await chooseMenu({ goal: context.goal, options, transcript: context.transcript });
      const label = options[decision.choice] || "";
      const spoken = decision.choice.startsWith("say:");
      const word = decision.choice.slice(4);
      const action = spoken ? `Say "${word}" to the menu` : `Press ${decision.choice} with send_dtmf`;
      const shown = spoken ? `Say "${word}"` : `Press ${decision.choice}`;
      const recorded = await ctx.runMutation(internal.managed.jevRecord, { session_id, decision,
        sequence: context.sequence, state_version: context.state_version,
        reason: "menu: which option?", summary: `${decision.source === "jev" ? "Jev" : "Fallback"}: ${shown} (${label}), ${Math.round(decision.probability * 100)}% sure` });
      if (!recorded) return new Response("The call changed while selecting this menu option. Do not send these tones. Continue from what the company is saying now; request a new menu choice if needed.");
      result = `${action} (${label}).` + (decision.probability < 0.5
        ? " Jev is not sure: if another option clearly fits the goal better, choose that one instead." : "");
    }
  } else if (name === "report_state") {
    const target = ({ menu: "MENU", hold: "HOLD", person: "IN_CONVERSATION" } as Record<string, string>)[text(args.state)];
    if (target) await ctx.runMutation(internal.managed.transition, { session_id, to: target, reason: redact(args.note) || `agent: ${args.state}` });
  } else if (name === "finish") {
    await ctx.runMutation(internal.managed.recordOutcome, {
      session_id, summary: redact(args.summary), reference: redact(args.reference_number),
    });
    result = "Recorded. Say goodbye; end the call once the rep has said goodbye.";
  } else if (name === "check_offer") {
    const limits = managed.call.limits_json as Record<string, any>;
    const kind = text(args.kind) || "other", amount = Number(args.amount_usd || 0);
    let reason = "";
    if (kind === "plan_change" && !limits.allow_plan_changes) reason = "the customer did not allow plan or subscription changes";
    else if (kind === "cancellation" && !limits.allow_cancellation) reason = "the customer did not allow cancellations";
    else if (amount > Number(limits.max_spend_usd || 0)) reason = `$${amount} is over the customer's spending limit`;
    result = reason ? `Not allowed: ${reason}. Politely decline and steer back to the goal.`
      : kind === "other" ? "Allowed only if it is part of the goal. Otherwise politely decline."
      : "Allowed. Confirm the details with the rep.";
    await ctx.runMutation(internal.managed.guardDecision, { session_id, kind, allowed: !reason,
      reason: reason || "allowed within customer limits" });
  } else if (name === "ask_user") {
    const question = text(args.question, 500) || "The rep needs information.";
    const keypad = args.delivery === "dtmf";
    if (args.sensitivity === "high" || highSensitivity("", question)) {
      await ctx.runMutation(internal.managed.guardDecision, { session_id, kind: "ask_user", allowed: false,
        reason: "high-sensitivity info is never relayed by the agent" });
      result = keypad ? "Not allowed: never relay a full card number, SSN, or password. Stay silent."
        : "Not allowed: never relay a full card number, SSN, or password. Tell the rep the customer will provide it another way, and continue.";
    } else {
      const sensitivity = args.sensitivity === "low" ? "low" : "medium";
      const resume = keypad ? managed.call.state : "IN_CONVERSATION";
      const waiting = !keypad || !PRE_PERSON.has(managed.call.state);
      const { request_id } = await ctx.runMutation(internal.managed.askStart, { session_id,
        question: redact(question), sensitivity, waiting });
      let value: string | null = null;
      for (let i = 0; i < 95; i++) {
        const mailbox = await ctx.runQuery(internal.managed.peekAnswer, { request_id });
        if (mailbox) { value = await decrypt(mailbox.ciphertext, mailbox.nonce); break; }
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
      await ctx.runMutation(internal.managed.closeRequest, { request_id, session_id,
        status: value === null ? "timed_out" : "answered", resume_state: resume });
      if (value === null) result = keypad
        ? "No answer yet. Stay silent; do not send tones or guess. Call call4me_ask_user again with delivery dtmf if the keypad answer is still needed."
        : "No answer yet. Ask the rep to hold a little longer, then call call4me_ask_user again.";
      else if (highSensitivity(value, question)) {
        await ctx.runMutation(internal.managed.guardDecision, { session_id, kind: "relay", allowed: false,
          reason: "answer looks like a full card number or SSN" });
        result = keypad ? "The answer is too sensitive to relay. Stay silent; do not send any tones."
          : "The customer's answer is too sensitive to say. Tell the rep they will provide it another way.";
      }
      else if (keypad) {
        const digits = value.replace(/[\s-]/g, "");
        result = !digits || /[^0-9*#]/.test(digits)
          ? "Invalid keypad answer. Stay silent and do not send tones. Call call4me_ask_user again with delivery dtmf to request only keypad digits."
          : `The customer provided keypad digits: ${digits}\nCall send_dtmf now with these exact digits. Preserve leading zeroes. Append # or * only if explicitly requested and not already included. Do not speak the digits or any commentary.`;
      } else result = `The customer answered: ${value.trim()}\nTell the rep now. Read numbers digit by digit.`;
    }
  } else return new Response(`unknown tool ${name}`);
  const messages = await ctx.runMutation(internal.managed.takeTyped, { session_id });
  if (messages.length) {
    const lines = await Promise.all(messages.map(m => decrypt(m.ciphertext, m.nonce)));
    result += `\nMessage from the customer for the rep. Say it now, word for word: ${lines.map(m => JSON.stringify(m)).join(" ")}`;
  }
  return new Response(result, { headers: { "Content-Type": "text/plain; charset=utf-8" } });
});
