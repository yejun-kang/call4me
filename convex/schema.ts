import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

const nullableString = v.union(v.string(), v.null());
const nullableNumber = v.union(v.number(), v.null());
export const jevDecision = v.object({
  question: v.union(v.literal("state_check"), v.literal("menu_choice")),
  choice: v.string(), probability: v.number(), alternatives: v.record(v.string(), v.number()),
  source: v.union(v.literal("jev"), v.literal("heuristic")), fallback_reason: v.optional(v.string()),
});
export const records = {
  call_session: v.object({
    id: v.string(), user_id: v.string(), company: v.string(), phone_number: v.string(),
    goal: v.string(), limits_json: v.any(), disclosure_text: v.string(), state: v.string(),
    started_at: v.string(), ended_at: nullableString, outcome: nullableString,
    reference_number: nullableString, minutes_saved: nullableNumber,
  }),
  call_event: v.object({
    id: v.string(), session_id: v.string(), at: v.string(), kind: v.string(),
    from_state: nullableString, to_state: nullableString, confidence: nullableNumber,
    detail_json: v.any(),
  }),
  user_request: v.object({
    id: v.string(), session_id: v.string(), question: v.string(),
    sensitivity: v.union(v.literal("low"), v.literal("medium"), v.literal("high")),
    status: v.union(v.literal("pending"), v.literal("answered"), v.literal("timed_out"), v.literal("takeover_suggested"), v.literal("cancelled")),
    created_at: v.string(), answered_at: nullableString,
    // Deliberately no answer field.
  }),
  audit_log: v.object({
    id: v.string(), at: v.string(), actor: v.string(), action: v.string(),
    subject: nullableString, allowed: v.boolean(), reason: v.string(),
    diff_json: v.any(), evidence_json: v.any(),
  }),
  menu_path: v.object({
    id: v.string(), company: v.string(), steps_json: v.array(v.string()),
    success_count: v.number(), last_used_at: nullableString,
  }),
  device: v.object({ user_id: v.string(), apns_token: nullableString, live_activity_token: nullableString }),
};

export const liveMessage = v.object({
  id: v.string(), session_id: v.string(), at: v.string(),
  type: v.union(v.literal("caption"), v.literal("state"), v.literal("summary"),
    v.literal("ask_user"), v.literal("event"), v.literal("ended")),
  data: v.any(),
});

export default defineSchema({
  call_session: defineTable(records.call_session).index("by_external_id", ["id"])
    .index("by_started", ["started_at"]).index("by_user_started", ["user_id", "started_at"]),
  call_event: defineTable(records.call_event).index("by_external_id", ["id"])
    .index("by_session_at", ["session_id", "at"]),
  user_request: defineTable(records.user_request).index("by_external_id", ["id"])
    .index("by_session", ["session_id"]),
  audit_log: defineTable(records.audit_log).index("by_external_id", ["id"])
    .index("by_subject_at", ["subject", "at"]),
  menu_path: defineTable(records.menu_path).index("by_external_id", ["id"])
    .index("by_company_success", ["company", "success_count", "last_used_at"]),
  device: defineTable(records.device).index("by_external_id", ["user_id"]),
  live_message: defineTable({ ...liveMessage.fields, sequence: v.number() })
    .index("by_session_sequence", ["session_id", "sequence"])
    .index("by_external_id", ["id"]),
  site_asset: defineTable({
    path: v.string(), storage_id: v.id("_storage"), content_type: v.string(),
  }).index("by_path", ["path"]),
  managed_call: defineTable({
    session_id: v.string(), provider_call_id: nullableString,
    recorded_outcome: nullableString, recorded_reference: nullableString,
    provider_deleted_at: nullableString,
    remote_window: v.optional(v.array(v.string())), remote_sequence: v.optional(v.number()),
    state_version: v.optional(v.number()), jev_count: v.optional(v.number()),
    jev_last_state: v.optional(jevDecision), seen_turn_ids: v.optional(v.array(v.string())),
  }).index("by_session", ["session_id"])
    .index("by_provider", ["provider_call_id"])
    .index("by_deleted", ["provider_deleted_at"]),
  // Answers are AES-GCM ciphertext and are removed as soon as the waiting tool
  // receives them. A cleanup job removes abandoned ciphertext after two minutes.
  answer_mailbox: defineTable({
    request_id: v.string(), ciphertext: v.string(), nonce: v.string(),
    expires_at: v.number(),
  }).index("by_request", ["request_id"])
    .index("by_expiry", ["expires_at"]),
  typed_message: defineTable({
    session_id: v.string(), ciphertext: v.string(), nonce: v.string(), expires_at: v.number(),
  }).index("by_session", ["session_id"])
    .index("by_expiry", ["expires_at"]),
});
