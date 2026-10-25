import { internalAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import { chooseMenu, decideState } from "./jev";

const PRE_PERSON = new Set(["DIALING", "MENU", "HOLD", "RECORDED_MESSAGE", "CALLBACK_OFFERED"]);

export const classify = internalAction({
  args: { session_id: v.string(), sequence: v.number() },
  handler: async (ctx, args): Promise<void> => {
    const context = await ctx.runQuery(internal.managed.jevContext, { session_id: args.session_id });
    if (!context || context.sequence !== args.sequence || !PRE_PERSON.has(context.state)) return;
    const decision = await decideState({ transcript: context.transcript, latest: context.latest, currentState: context.state });
    // A newer utterance or agent report must not be overwritten by a late request.
    await ctx.runMutation(internal.managed.jevRecord, { ...args, state_version: context.state_version,
      decision, reason: "new company speech" });
  },
});

// Privileged deployment check: synthetic data only, no call creation or DB writes.
export const checkConnection = internalAction({
  args: {},
  handler: async () => {
    const menu = await chooseMenu({ goal: "Refund a headphone purchase",
      options: { "1": "New sales", "2": "Returns and refunds", "3": "Technical support" },
      transcript: "For new sales press one. For returns and refunds press two. For technical support press three." });
    const state = await decideState({ transcript: "Hello, this is Sam. How can I help you today?",
      latest: "Hello, this is Sam. How can I help you today?", currentState: "MENU" });
    return { passed: menu.source === "jev" && menu.choice === "2" && state.source === "jev" && state.choice === "human",
      menu, state };
  },
});
