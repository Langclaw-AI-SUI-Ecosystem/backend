import { resolveProductChain } from "./chain-config";

export type PremiumProviderId = "surf" | "nansen" | "elfa";

type PremiumProviderConfig = {
  apiKey: string;
  enabled: boolean;
  id: PremiumProviderId;
  label: string;
  timeoutMs: number;
};

const premiumProviderLabels: Record<PremiumProviderId, string> = {
  elfa: "Elfa",
  nansen: "Nansen",
  surf: "Surf",
};

export function readPremiumProviderConfig(
  id: PremiumProviderId
): PremiumProviderConfig {
  const prefix = id.toUpperCase();
  const enabled = process.env[`${prefix}_ENABLED`]?.trim() === "true";
  const apiKey = process.env[`${prefix}_API_KEY`]?.trim() ?? "";
  const timeoutValue = Number(process.env[`${prefix}_TIMEOUT_MS`]);

  return {
    apiKey,
    enabled: enabled && Boolean(apiKey),
    id,
    label: premiumProviderLabels[id],
    timeoutMs:
      Number.isFinite(timeoutValue) && timeoutValue > 0 ? timeoutValue : 12000,
  };
}

export function isPremiumProviderInScope(chain: string | undefined) {
  const id = resolveProductChain(chain).id;
  return id === "sui-testnet" || id === "sui-mainnet";
}

export function premiumProviderLabel(id: PremiumProviderId) {
  return premiumProviderLabels[id];
}
