import type {
  DiscoverPayload,
  WorkflowProgressEvent,
  ZeroGTokenUsage,
} from "./langclaw/types";
import type { OnChainToolFinalPayload } from "./onchain-tools/types";
import type { UsageMeter } from "./usage-pricing";

export type DirectChatUsage = ZeroGTokenUsage & {
  meter: UsageMeter;
  model: string;
  totalCostNeuron?: string;
};

export type DirectChatPayload = {
  answer: string;
  model?: string;
  requestedModel?: string;
  usedModel?: string;
  fallbackFrom?: string;
  modelHonored?: boolean;
  source?: "openai" | "fallback";
  title?: string;
  usage?: DirectChatUsage;
  error?: string;
};

export type StoredChatMessage = {
  id: string;
  role: "assistant" | "user";
  content: string;
  chain?: "sui-testnet" | "sui-mainnet";
  mode?: "chat" | "onchain" | "research";
  model?: string;
  result?: DiscoverPayload;
  directAnswer?: DirectChatPayload;
  onChain?: OnChainToolFinalPayload;
  progressEvents?: WorkflowProgressEvent[];
  error?: string;
  stopped?: boolean;
};

export type ChatSession = {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  pinned?: boolean;
  messages: StoredChatMessage[];
};
