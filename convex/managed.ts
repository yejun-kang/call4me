import { internalMutation, internalQuery } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import { v } from "convex/values";
import { jevDecision, records } from "./schema";
import { internal } from "./_generated/api";
import type { Decision } from "./jev";

const PRE_PERSON = new Set(["DIALING", "MENU", "HOLD", "RECORDED_MESSAGE", "CALLBACK_OFFERED"]);
const JEV_TO_STATE: Record<string, string> = {
  menu: "MENU", recorded_message: "RECORDED_MESSAGE", hold_music: "HOLD",
  callback_offer: "CALLBACK_OFFERED", human: "IN_CONVERSATION",
};
const JEV_TO_REPORT: Record<string, string> = {
  menu: "menu", recorded_message: "hold", hold_music: "hold", callback_offer: "hold", human: "person",
};

const now = () => new Date().toISOString();
const id = () => crypto.randomUUID().replaceAll("-", "");

async function session(ctx: MutationCtx, key: string) {
  return ctx.db.query("call_session").withIndex("by_external_id", q => q.eq("id", key)).unique();
}
async function publish(ctx: MutationCtx, sessionId: string, type: "caption" | "state" | "summary" | "ask_user" | "event" | "ended", data: Record<string, unknown>) {
  const last = await ctx.db.query("live_message")
    .withIndex("by_session_sequence", q => q.eq("session_id", sessionId)).order("desc").first();
  await ctx.db.insert("live_message", {
    id: id(), session_id: sessionId, at: now(), type, data,
    sequence: (last?.sequence ?? 0) + 1,
  });
  const old = await ctx.db.query("live_message")
    .withIndex("by_session_sequence", q => q.eq("session_id", sessionId)).order("desc").take(420);
  for (const row of old.slice(400)) await ctx.db.delete(row._id);
}
async function event(ctx: MutationCtx, sessionId: string, kind: string, detail: Record<string, unknown>, from: string | null, to: string | null, confidence: number | null = null) {
  await ctx.db.insert("call_event", {
    id: id(), session_id: sessionId, at: now(), kind,
    from_state: from, to_state: to, confidence, detail_json: detail,
  });
}
async function auditEvent(ctx: MutationCtx, actor: string, action: string, subject: string,
  reason: string, allowed = true, evidence: Record<string, unknown> = {}) {
  await ctx.db.insert("audit_log", {
    id: id(), at: now(), actor, action, subject, allowed, reason,
    diff_json: {}, evidence_json: evidence,
  });
}
async function changeState(ctx: MutationCtx, sessionId: string, to: string, reason: string, actor = "agent", confidence: number | null = null) {
  const call = await session(ctx, sessionId);
  if (!call || call.state === to || ["ENDED", "FAILED"].includes(call.state)) return;
  await ctx.db.patch(call._id, { state: to });
  const managed = await ctx.db.query("managed_call").withIndex("by_session", q => q.eq("session_id", sessionId)).unique();
  if (managed) await ctx.db.patch(managed._id, { state_version: (managed.state_version ?? 0) + 1 });
  await event(ctx, sessionId, "transition", { reason, actor }, call.state, to, confidence);
  await auditEvent(ctx, actor, "call.transition", sessionId, reason);
  await publish(ctx, sessionId, "state", { from: call.state, to, reason });
}

export const start = internalMutation({
  args: { call: records.call_session },
  handler: async (ctx, { call }) => {
    if (await session(ctx, call.id)) throw Error("Call already exists");
    await ctx.db.insert("call_session", call);
    await ctx.db.insert("managed_call", {
      session_id: call.id, provider_call_id: null,
      recorded_outcome: null, recorded_reference: null, provider_deleted_at: null,
    });
    await event(ctx, call.id, "transition", { reason: "user started a call" }, null, "DIALING");
    await auditEvent(ctx, "user", "call.start", call.id, "user started a call", true,
      { company: call.company });
    await publish(ctx, call.id, "state", { from: null, to: "DIALING" });
  },
});

export const attachProvider = internalMutation({
  args: { session_id: v.string(), provider_call_id: v.string() },
  handler: async (ctx, args) => {
    const row = await ctx.db.query("managed_call")
      .withIndex("by_session", q => q.eq("session_id", args.session_id)).unique();
    if (!row || row.provider_call_id) throw Error("Call cannot be attached");
    await ctx.db.patch(row._id, { provider_call_id: args.provider_call_id });
    await event(ctx, args.session_id, "call.dial", {}, "DIALING", "DIALING");
    await auditEvent(ctx, "agent", "call.dial", args.session_id, "Cartesia call placed");
  },
});

export const byProvider = internalQuery({
  args: { provider_call_id: v.string() },
  handler: async (ctx, args) => {
    const row = await ctx.db.query("managed_call")
      .withIndex("by_provider", q => q.eq("provider_call_id", args.provider_call_id)).unique();
    return row?.session_id ?? null;
  },
});

export const detail = internalQuery({
  args: { id: v.string() },
  handler: async (ctx, args) => {
    const call = await ctx.db.query("call_session")
      .withIndex("by_external_id", q => q.eq("id", args.id)).unique();
    if (!call) return null;
    const timeline = await ctx.db.query("call_event")
      .withIndex("by_session_at", q => q.eq("session_id", args.id)).collect();
    const plain = <T extends { _id: unknown; _creationTime: number }>(row: T) => {
      const { _id, _creationTime, ...fields } = row;
      return fields;
    };
    return { session: plain(call), timeline: timeline.map(plain) };
  },
});

export const list = internalQuery({
  args: { user_id: v.union(v.string(), v.null()), limit: v.number() },
  handler: async (ctx, args) => {
    const q = args.user_id
      ? ctx.db.query("call_session").withIndex("by_user_started", q => q.eq("user_id", args.user_id!))
      : ctx.db.query("call_session").withIndex("by_started");
    return (await q.order("desc").take(Math.max(1, Math.min(100, args.limit)))).map(({ _id, _creationTime, ...row }) => row);
  },
});

export const auditLog = internalQuery({
  args: { session_id: v.string() },
  handler: async (ctx, args) => {
    const rows = await ctx.db.query("audit_log")
      .withIndex("by_subject_at", q => q.eq("subject", args.session_id)).collect();
    return rows.map(({ _id, _creationTime, diff_json, evidence_json, ...row }) => ({
      ...row, diff: diff_json, evidence: evidence_json,
    }));
  },
});

export const managed = internalQuery({
  args: { session_id: v.string() },
  handler: async (ctx, args) => {
    const row = await ctx.db.query("managed_call")
      .withIndex("by_session", q => q.eq("session_id", args.session_id)).unique();
    const call = await ctx.db.query("call_session")
      .withIndex("by_external_id", q => q.eq("id", args.session_id)).unique();
    return row && call ? { provider_call_id: row.provider_call_id,
      recorded_outcome: row.recorded_outcome, recorded_reference: row.recorded_reference,
      call: { id: call.id, user_id: call.user_id, state: call.state, goal: call.goal,
        limits_json: call.limits_json, started_at: call.started_at } } : null;
  },
});

export const transition = internalMutation({
  args: { session_id: v.string(), to: v.string(), reason: v.string() },
  handler: async (ctx, args) => {
    const call = await session(ctx, args.session_id);
    if (!call) return;
    const reason = args.reason.slice(0, 200);
    const managed = await ctx.db.query("managed_call").withIndex("by_session", q => q.eq("session_id", args.session_id)).unique();
    const last = managed?.jev_last_state;
    const reported = ({ MENU: "menu", HOLD: "hold", IN_CONVERSATION: "person" } as Record<string, string>)[args.to];
    if (reported && last && last.probability >= 0.6 && JEV_TO_REPORT[last.choice] && JEV_TO_REPORT[last.choice] !== reported) {
      const detail = { agent: reported, jev: last.choice, probability: last.probability, source: last.source };
      await event(ctx, args.session_id, "jev_disagreement", detail, null, null);
      await publish(ctx, args.session_id, "event", { kind: "jev_disagreement", ...detail });
    }
    if (args.to === "IN_CONVERSATION" &&
      ["DIALING", "MENU", "HOLD", "RECORDED_MESSAGE", "CALLBACK_OFFERED"].includes(call.state)) {
      for (const state of ["HUMAN_SUSPECTED", "HUMAN_CONFIRMED", "IN_CONVERSATION"])
        await changeState(ctx, args.session_id, state, reason);
      return;
    }
    if (args.to === "MENU" && ["IN_CONVERSATION", "WAITING_ON_USER"].includes(call.state))
      await changeState(ctx, args.session_id, "HOLD", reason);
    await changeState(ctx, args.session_id, args.to, reason);
  },
});

export const caption = internalMutation({
  args: { session_id: v.string(), speaker: v.string(), text: v.string(), turn_id: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const call = await session(ctx, args.session_id);
    if (!call) return;
    const managed = await ctx.db.query("managed_call").withIndex("by_session", q => q.eq("session_id", args.session_id)).unique();
    if (managed && args.turn_id) {
      if (managed.seen_turn_ids?.includes(args.turn_id)) return;
      await ctx.db.patch(managed._id, { seen_turn_ids: [...(managed.seen_turn_ids ?? []), args.turn_id].slice(-100) });
    }
    const detail = { speaker: args.speaker, text: args.text };
    await event(ctx, args.session_id, "caption", detail, null, null);
    await publish(ctx, args.session_id, "caption", { ...detail, final: true });
    if (managed && args.speaker === "remote") {
      const sequence = (managed.remote_sequence ?? 0) + 1;
      await ctx.db.patch(managed._id, {
        remote_window: [...(managed.remote_window ?? []), args.text].slice(-4), remote_sequence: sequence,
      });
      // Match the old background watcher: acknowledging Cartesia never waits on Jev.
      if (PRE_PERSON.has(call.state)) await ctx.scheduler.runAfter(0, internal.jevWatch.classify, { session_id: args.session_id, sequence });
    }
  },
});

export type JevContext = {
  goal: string; state: string; transcript: string; latest: string; sequence: number; state_version: number;
};
export const jevContext = internalQuery({
  args: { session_id: v.string() },
  handler: async (ctx, args): Promise<JevContext | null> => {
    const managed = await ctx.db.query("managed_call").withIndex("by_session", q => q.eq("session_id", args.session_id)).unique();
    const call = await ctx.db.query("call_session").withIndex("by_external_id", q => q.eq("id", args.session_id)).unique();
    if (!managed || !call || ["ENDED", "FAILED"].includes(call.state)) return null;
    const remote = managed.remote_window ?? [];
    return { goal: call.goal, state: call.state, transcript: remote.join(" "), latest: remote.at(-1) ?? "",
      sequence: managed.remote_sequence ?? 0, state_version: managed.state_version ?? 0 };
  },
});

export const jevRecord = internalMutation({
  args: { session_id: v.string(), decision: jevDecision, reason: v.string(),
    sequence: v.optional(v.number()), state_version: v.optional(v.number()), summary: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const call = await session(ctx, args.session_id);
    const managed = await ctx.db.query("managed_call").withIndex("by_session", q => q.eq("session_id", args.session_id)).unique();
    if (!call || !managed || ["ENDED", "FAILED"].includes(call.state)) return false;
    const d: Decision = args.decision;
    const current = args.sequence === (managed.remote_sequence ?? 0) && args.state_version === (managed.state_version ?? 0);
    // A parallel report_state("menu") or Jev watcher may advance DIALING→MENU
    // while this same menu is being decided. That must not delay a valid key.
    const sameMenu = args.sequence === (managed.remote_sequence ?? 0) &&
      (args.state_version === (managed.state_version ?? 0) || PRE_PERSON.has(call.state));
    if (d.question === "menu_choice" && !sameMenu) return false;
    const target = d.question === "state_check" ? JEV_TO_STATE[d.choice] : undefined;
    const apply = !!target && current && PRE_PERSON.has(call.state) &&
      d.probability >= (target === "IN_CONVERSATION" ? 0.75 : 0.6) && target !== call.state;
    const count = (managed.jev_count ?? 0) + 1;
    await ctx.db.patch(managed._id, { jev_count: count,
      ...(d.question === "state_check" && current ? { jev_last_state: d } : {}) });
    const detail = { question: d.question, choice: d.choice, probability: d.probability,
      count, state: call.state, reason: args.reason, fallback: d.source !== "jev", source: d.source,
      ...(d.fallback_reason ? { fallback_reason: d.fallback_reason } : {}), applied: apply };
    await event(ctx, args.session_id, "jev_decision", detail, null, null, d.probability);
    await auditEvent(ctx, d.source, "jev.decision", args.session_id, args.reason, true, detail);
    await publish(ctx, args.session_id, "event", { kind: "jev_decision", ...detail });
    if (apply) {
      const states = target === "IN_CONVERSATION" ? ["HUMAN_SUSPECTED", "HUMAN_CONFIRMED", target] : [target];
      for (const state of states) await changeState(ctx, args.session_id, state, `${d.source}: ${d.choice}`, d.source, d.probability);
    }
    if (args.summary) await publish(ctx, args.session_id, "summary", { text: args.summary });
    return true;
  },
});

export const menuAction = internalMutation({
  args: { session_id: v.string() },
  handler: async (ctx, args) => {
    await event(ctx, args.session_id, "menu_action", { action: "dtmf", value: "[REDACTED]" }, null, null);
    await auditEvent(ctx, "agent", "menu_action", args.session_id, "keypad tones sent");
  },
});

export const recordOutcome = internalMutation({
  args: { session_id: v.string(), summary: v.string(), reference: v.string() },
  handler: async (ctx, args) => {
    const row = await ctx.db.query("managed_call")
      .withIndex("by_session", q => q.eq("session_id", args.session_id)).unique();
    if (!row) return;
    await ctx.db.patch(row._id, {
      recorded_outcome: args.summary.slice(0, 1000) || null,
      recorded_reference: args.reference.slice(0, 100) || null,
    });
    await event(ctx, args.session_id, "call.outcome", {}, null, null);
    await auditEvent(ctx, "agent", "call.outcome", args.session_id, "agent recorded the outcome");
  },
});

export const askStart = internalMutation({
  args: { session_id: v.string(), question: v.string(), sensitivity: v.union(v.literal("low"), v.literal("medium")), waiting: v.boolean() },
  handler: async (ctx, args) => {
    const call = await session(ctx, args.session_id);
    if (!call || ["ENDED", "FAILED"].includes(call.state)) throw Error("Call ended");
    const request_id = id();
    await ctx.db.insert("user_request", {
      id: request_id, session_id: args.session_id, question: args.question,
      sensitivity: args.sensitivity, status: "pending", created_at: now(), answered_at: null,
    });
    await auditEvent(ctx, "agent", "user_request.created", args.session_id, "asked the user");
    if (args.waiting) await changeState(ctx, args.session_id, "WAITING_ON_USER", "ask_user: waiting for the user");
    await publish(ctx, args.session_id, "ask_user", {
      request_id, question: args.question, sensitivity: args.sensitivity, timeout_s: 95,
    });
    return { request_id, previous_state: call.state };
  },
});

export const putAnswer = internalMutation({
  args: { request_id: v.string(), ciphertext: v.string(), nonce: v.string() },
  handler: async (ctx, args) => {
    const request = await ctx.db.query("user_request")
      .withIndex("by_external_id", q => q.eq("id", args.request_id)).unique();
    if (!request || request.status !== "pending") return false;
    const prior = await ctx.db.query("answer_mailbox")
      .withIndex("by_request", q => q.eq("request_id", args.request_id)).unique();
    if (prior) return false;
    await ctx.db.insert("answer_mailbox", { ...args, expires_at: Date.now() + 60_000 });
    await auditEvent(ctx, "user", "user_request.answered", request.session_id, "user answered");
    return true;
  },
});

export const peekAnswer = internalQuery({
  args: { request_id: v.string() },
  handler: (ctx, args) => ctx.db.query("answer_mailbox")
    .withIndex("by_request", q => q.eq("request_id", args.request_id)).unique(),
});

export const requestInfo = internalQuery({
  args: { request_id: v.string() },
  handler: async (ctx, args) => {
    const row = await ctx.db.query("user_request")
      .withIndex("by_external_id", q => q.eq("id", args.request_id)).unique();
    return row && { session_id: row.session_id, status: row.status };
  },
});

export const closeRequest = internalMutation({
  args: {
    request_id: v.string(), session_id: v.string(), status: v.union(v.literal("answered"), v.literal("timed_out")),
    resume_state: v.string(),
  },
  handler: async (ctx, args) => {
    const answer = await ctx.db.query("answer_mailbox")
      .withIndex("by_request", q => q.eq("request_id", args.request_id)).unique();
    if (answer) await ctx.db.delete(answer._id);
    const request = await ctx.db.query("user_request")
      .withIndex("by_external_id", q => q.eq("id", args.request_id)).unique();
    if (request?.status === "pending") await ctx.db.patch(request._id, {
      status: args.status, answered_at: args.status === "answered" ? now() : null,
    });
    const call = await session(ctx, args.session_id);
    if (call?.state === "WAITING_ON_USER") await changeState(ctx, args.session_id, args.resume_state, "ask_user completed");
    await publish(ctx, args.session_id, "event", { kind: "ask_user_answered", request_id: args.request_id });
  },
});

export const finish = internalMutation({
  args: { session_id: v.string(), failed: v.boolean(), reason: v.string(), summary: v.string() },
  handler: async (ctx, args) => {
    const call = await session(ctx, args.session_id);
    if (!call || ["ENDED", "FAILED"].includes(call.state)) return;
    const managed = await ctx.db.query("managed_call")
      .withIndex("by_session", q => q.eq("session_id", args.session_id)).unique();
    const requests = await ctx.db.query("user_request")
      .withIndex("by_session", q => q.eq("session_id", args.session_id)).collect();
    for (const request of requests) {
      const answer = await ctx.db.query("answer_mailbox")
        .withIndex("by_request", q => q.eq("request_id", request.id)).unique();
      if (answer) await ctx.db.delete(answer._id);
      if (request.status === "pending") await ctx.db.patch(request._id, { status: "cancelled" });
    }
    const typed = await ctx.db.query("typed_message")
      .withIndex("by_session", q => q.eq("session_id", args.session_id)).collect();
    for (const item of typed) await ctx.db.delete(item._id);
    const state = args.failed ? "FAILED" : "ENDED";
    const minutes_saved = Math.round(Math.max(0, Date.now() - Date.parse(call.started_at)) / 6000) / 10;
    const outcome = managed?.recorded_outcome || args.reason || "The call ended.";
    const summary = args.summary || outcome;
    await ctx.db.patch(call._id, {
      state, ended_at: now(), outcome, reference_number: managed?.recorded_reference ?? null,
      minutes_saved,
    });
    await auditEvent(ctx, "system", "call.end", args.session_id, `call finished in ${state}`);
    await event(ctx, args.session_id, "transition", { reason: args.reason }, call.state, state);
    await event(ctx, args.session_id, "call.ended", { outcome, minutes_saved, summary }, state, state);
    await publish(ctx, args.session_id, "state", { from: call.state, to: state, reason: args.reason });
    const data = { summary, outcome, reference_number: managed?.recorded_reference ?? null, minutes_saved, state };
    await publish(ctx, args.session_id, "summary", { text: summary, ...data });
    await publish(ctx, args.session_id, "ended", data);
  },
});

export const pendingDelete = internalQuery({
  args: {},
  handler: async ctx => {
    const rows = await ctx.db.query("managed_call")
      .withIndex("by_deleted", q => q.eq("provider_deleted_at", null)).take(100);
    const pending = [];
    for (const row of rows) {
      if (!row.provider_call_id) continue;
      const call = await ctx.db.query("call_session")
        .withIndex("by_external_id", q => q.eq("id", row.session_id)).unique();
      if (call && ["ENDED", "FAILED"].includes(call.state)) pending.push({
        session_id: row.session_id, provider_call_id: row.provider_call_id,
      });
    }
    return pending;
  },
});

export const activeProviderCalls = internalQuery({
  args: {},
  handler: async ctx => {
    const rows = await ctx.db.query("managed_call")
      .withIndex("by_deleted", q => q.eq("provider_deleted_at", null)).take(100);
    const active = [];
    for (const row of rows) {
      if (!row.provider_call_id) continue;
      const call = await ctx.db.query("call_session")
        .withIndex("by_external_id", q => q.eq("id", row.session_id)).unique();
      if (call && !["ENDED", "FAILED"].includes(call.state)) active.push({
        session_id: row.session_id, provider_call_id: row.provider_call_id,
      });
    }
    return active;
  },
});

export const markProviderDeleted = internalMutation({
  args: { session_id: v.string() },
  handler: async (ctx, args) => {
    const row = await ctx.db.query("managed_call")
      .withIndex("by_session", q => q.eq("session_id", args.session_id)).unique();
    if (row) await ctx.db.patch(row._id, { provider_deleted_at: now() });
  },
});

export const expireAnswers = internalMutation({
  args: {},
  handler: async ctx => {
    const rows = await ctx.db.query("answer_mailbox")
      .withIndex("by_expiry", q => q.lt("expires_at", Date.now())).take(100);
    for (const row of rows) await ctx.db.delete(row._id);
    const typed = await ctx.db.query("typed_message")
      .withIndex("by_expiry", q => q.lt("expires_at", Date.now())).take(100);
    for (const row of typed) await ctx.db.delete(row._id);
    return rows.length + typed.length;
  },
});

export const queueTyped = internalMutation({
  args: { session_id: v.string(), ciphertext: v.string(), nonce: v.string() },
  handler: async (ctx, args) => {
    const call = await session(ctx, args.session_id);
    if (!call || ["ENDED", "FAILED"].includes(call.state)) return false;
    await ctx.db.insert("typed_message", { ...args, expires_at: Date.now() + 90_000 });
    await event(ctx, args.session_id, "user_message", { action: "typed" }, null, null);
    await auditEvent(ctx, "user", "type_to_talk", args.session_id, "user typed a message");
    return true;
  },
});

export const guardDecision = internalMutation({
  args: { session_id: v.string(), kind: v.string(), allowed: v.boolean(), reason: v.string() },
  handler: async (ctx, args) => {
    await auditEvent(ctx, args.allowed ? "agent" : "guard", `guard.${args.kind}`,
      args.session_id, args.reason.slice(0, 200), args.allowed);
    if (!args.allowed) {
      await event(ctx, args.session_id, "guard_denied", { action: args.kind, reason: args.reason }, null, null);
      await publish(ctx, args.session_id, "event", { kind: "guard_denied", reason: args.reason });
    }
  },
});

export const takeTyped = internalMutation({
  args: { session_id: v.string() },
  handler: async (ctx, args) => {
    const rows = await ctx.db.query("typed_message")
      .withIndex("by_session", q => q.eq("session_id", args.session_id)).take(10);
    for (const row of rows) await ctx.db.delete(row._id);
    return rows.filter(row => row.expires_at > Date.now()).map(row => ({
      ciphertext: row.ciphertext, nonce: row.nonce,
    }));
  },
});
