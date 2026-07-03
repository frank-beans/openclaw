// Qa Lab plugin module implements Slack live transport adapter behavior.
import { createSlackWebClient, createSlackWriteClient } from "@openclaw/slack/api.js";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { QaRunnerCliRegistration } from "openclaw/plugin-sdk/qa-runner-runtime";
import {
  acquireQaCredentialLease,
  startQaCredentialLeaseHeartbeat,
} from "../shared/credential-lease.runtime.js";
import { __testing as slackLive } from "./slack-live.runtime.js";

type AdapterFactory = NonNullable<QaRunnerCliRegistration["adapterFactory"]>;
type FactoryContext = Parameters<AdapterFactory["create"]>[0];
type SlackRuntimeEnv = ReturnType<typeof slackLive.resolveSlackQaRuntimeEnv>;

type SlackMessage = {
  bot_id?: string;
  text?: string;
  thread_ts?: string;
  ts?: string;
  user?: string;
};

export async function createSlackQaTransportAdapter(context: FactoryContext) {
  const options = context.commandOptions ?? {};
  const lease = await acquireQaCredentialLease<SlackRuntimeEnv>({
    kind: "slack",
    source: options.credentialSource,
    role: options.credentialRole,
    resolveEnvPayload: () => slackLive.resolveSlackQaRuntimeEnv(),
    parsePayload: slackLive.parseSlackQaCredentialPayload,
  });
  const heartbeat = startQaCredentialLeaseHeartbeat(lease);
  const runtimeEnv = lease.payload;
  let driverIdentity: Awaited<ReturnType<typeof slackLive.getSlackIdentity>>;
  let sutIdentity: Awaited<ReturnType<typeof slackLive.getSlackIdentity>>;
  try {
    [driverIdentity, sutIdentity] = await Promise.all([
      slackLive.getSlackIdentity(runtimeEnv.driverBotToken),
      slackLive.getSlackIdentity(runtimeEnv.sutBotToken),
    ]);
  } catch (error) {
    await heartbeat.stop();
    await lease.release();
    throw error;
  }
  const driverClient = createSlackWriteClient(runtimeEnv.driverBotToken);
  const sutClient = createSlackWebClient(runtimeEnv.sutBotToken);
  const accountId = options.sutAccountId?.trim() || "sut";
  let oldestTs = `${Math.floor(Date.now() / 1_000)}.000000`;
  let stopped = false;
  let pollingError: Error | undefined;
  let logicalConversationId = runtimeEnv.channelId;
  const observed = new Set<string>();
  const nativeMessageIds = new Map<string, string>();
  const busMessageIds = new Map<string, string>();
  const polling = (async () => {
    for (;;) {
      if (stopped) {
        return;
      }
      const messages = (await slackLive.listSlackMessages({
        channelId: runtimeEnv.channelId,
        client: sutClient,
        oldestTs,
      })) as SlackMessage[];
      for (const message of messages.toReversed()) {
        const ts = message.ts?.trim();
        if (!ts || observed.has(ts) || message.user !== sutIdentity.userId) {
          continue;
        }
        observed.add(ts);
        oldestTs = ts;
        await context.state.addOutboundMessage({
          accountId,
          to: `channel:${logicalConversationId}`,
          senderId: message.user,
          text: message.text ?? "",
          timestamp: Number(ts.split(".")[0]) * 1_000,
          threadId: message.thread_ts ? busMessageIds.get(message.thread_ts) : undefined,
        });
      }
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 500);
      });
    }
  })().catch((error: unknown) => {
    if (!stopped) {
      pollingError = error instanceof Error ? error : new Error(String(error));
    }
  });

  return context.createAdapter({
    id: "slack",
    label: "Slack live",
    accountId,
    requiredPluginIds: ["slack"],
    supportedActions: [],
    assertTransportHealthy() {
      if (pollingError) {
        throw pollingError;
      }
      heartbeat.throwIfFailed();
    },
    async sendInbound(input) {
      heartbeat.throwIfFailed();
      logicalConversationId = input.conversation.id;
      const text = input.text.replaceAll("@openclaw", `<@${sutIdentity.userId}>`);
      const nativeThreadTs = input.threadId ? nativeMessageIds.get(input.threadId) : undefined;
      const sent = await slackLive.sendSlackChannelMessage({
        channelId: runtimeEnv.channelId,
        client: driverClient,
        text,
        threadTs: nativeThreadTs,
      });
      const message = await context.state.addInboundMessage({
        ...input,
        accountId,
        senderId: driverIdentity.userId,
      });
      nativeMessageIds.set(message.id, sent.ts);
      busMessageIds.set(sent.ts, message.id);
      return message;
    },
    resetTransport: () => {
      logicalConversationId = runtimeEnv.channelId;
      nativeMessageIds.clear();
      busMessageIds.clear();
    },
    createGatewayConfig: () =>
      slackLive.buildSlackQaConfig({} as OpenClawConfig, {
        channelId: runtimeEnv.channelId,
        driverBotUserId: driverIdentity.userId,
        sutAccountId: accountId,
        sutAppToken: runtimeEnv.sutAppToken,
        sutBotToken: runtimeEnv.sutBotToken,
      }),
    waitReady: async ({ gateway }) =>
      await slackLive.waitForSlackChannelStable(gateway as never, accountId, "connected"),
    buildAgentDelivery: () => ({
      channel: "slack",
      to: `channel:${runtimeEnv.channelId}`,
      replyChannel: "slack",
      replyTo: `channel:${runtimeEnv.channelId}`,
    }),
    async handleAction() {
      throw new Error("Slack live QA adapter does not implement transport actions");
    },
    createReportNotes: () => ["Runs through the Slack live adapter and shared QA suite host."],
    async cleanup() {
      stopped = true;
      await polling.catch(() => undefined);
      await heartbeat.stop();
      await lease.release();
    },
  });
}
