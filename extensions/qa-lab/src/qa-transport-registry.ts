import type { QaRunnerCliRegistration } from "openclaw/plugin-sdk/qa-runner-runtime";
// Qa Lab plugin module implements qa transport registry behavior.
import type { QaBusState } from "./bus-state.js";
import {
  createQaChannelTransport,
  QA_CHANNEL_DEFAULT_SUITE_CONCURRENCY,
} from "./qa-channel-transport.js";
import type { QaTransportAdapter } from "./qa-transport.js";
import { createQaStateBackedTransportAdapter } from "./qa-transport.js";

export type QaTransportId = "qa-channel";
export type QaTransportDriver = QaTransportId | "crabline" | "live";

export type QaTransportFactoryContext = {
  channelId: string;
  driver: QaTransportDriver;
  outputDir: string;
  commandOptions?: Parameters<
    NonNullable<QaRunnerCliRegistration["adapterFactory"]>["create"]
  >[0]["commandOptions"];
  state: QaBusState;
};

export type QaTransportAdapterFactoryResult<
  TAdapter extends QaTransportAdapter = QaTransportAdapter,
> = {
  adapter: TAdapter;
  cleanup: () => Promise<void>;
};

export type QaTransportAdapterFactory = NonNullable<QaRunnerCliRegistration["adapterFactory"]>;

export type QaTransportAdapterFactoryRegistry = {
  create: (context: QaTransportFactoryContext) => Promise<QaTransportAdapterFactoryResult>;
};

const DEFAULT_QA_TRANSPORT_ID: QaTransportId = "qa-channel";

const QA_CHANNEL_TRANSPORT_FACTORY: QaTransportAdapterFactory = {
  id: "qa-channel",
  matches: ({ channelId, driver }) => driver === "qa-channel" && channelId === "qa-channel",
  async create(context) {
    return createQaChannelTransport(context.state as QaBusState);
  },
};

const CRABLINE_TRANSPORT_FACTORY: QaTransportAdapterFactory = {
  id: "crabline",
  matches: ({ driver }) => driver === "crabline",
  async create(context) {
    const { resolveOpenClawCrablineChannelDriverSelection } = await import("@openclaw/crabline");
    const selection = resolveOpenClawCrablineChannelDriverSelection({ channel: context.channelId });
    const { createQaCrablineTransportAdapter } = await import("./crabline-transport.js");
    return await createQaCrablineTransportAdapter({
      outputDir: context.outputDir,
      selection,
      state: context.state as QaBusState,
    });
  },
};

const DEFAULT_QA_TRANSPORT_FACTORIES = [
  QA_CHANNEL_TRANSPORT_FACTORY,
  CRABLINE_TRANSPORT_FACTORY,
] as const;

function requireQaTransportFactory(
  factories: readonly QaTransportAdapterFactory[],
  context: Pick<QaTransportFactoryContext, "channelId" | "driver">,
) {
  const factory = factories.find((candidate) => candidate.matches(context));
  if (!factory) {
    throw new Error(`no QA transport factory for ${context.driver}:${context.channelId}`);
  }
  return factory;
}

export function createQaTransportAdapterFactoryRegistry(
  factories: readonly QaTransportAdapterFactory[] = [...DEFAULT_QA_TRANSPORT_FACTORIES],
): QaTransportAdapterFactoryRegistry {
  return {
    async create(context) {
      const factory = requireQaTransportFactory(factories, context);
      let adapter: QaTransportAdapter;
      try {
        adapter = await factory.create({
          ...context,
          createAdapter: (params) => createQaStateBackedTransportAdapter(context.state, params),
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(
          `${factory.id} failed to create QA transport ${context.driver}:${context.channelId}: ${message}`,
          { cause: error },
        );
      }
      return {
        adapter,
        cleanup: async () => {
          await adapter.cleanup?.();
        },
      };
    },
  };
}

const qaTransportAdapterFactoryRegistry = createQaTransportAdapterFactoryRegistry();

export function normalizeQaTransportId(input?: string | null): QaTransportId {
  const transportId = input?.trim() || DEFAULT_QA_TRANSPORT_ID;
  if (transportId === "qa-channel") {
    return transportId;
  }
  throw new Error(`unsupported QA transport: ${transportId}`);
}

export async function createQaTransportAdapter(
  context: QaTransportFactoryContext,
  factories?: readonly QaTransportAdapterFactory[],
): Promise<QaTransportAdapterFactoryResult> {
  return await (
    factories
      ? createQaTransportAdapterFactoryRegistry(factories)
      : qaTransportAdapterFactoryRegistry
  ).create(context);
}

export function defaultQaSuiteConcurrencyForTransport(id: QaTransportId): number {
  return id === "qa-channel" ? QA_CHANNEL_DEFAULT_SUITE_CONCURRENCY : 1;
}
