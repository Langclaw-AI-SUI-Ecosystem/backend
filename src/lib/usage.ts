import { randomUUID } from "node:crypto";

import { formatUnits } from "viem";

import {
  AccountAuthError,
  createVerifiedWalletAccount,
  requireAccountAuth,
  requireWalletAccount,
  type AccountAuthInput,
  type AuthenticatedAccount,
} from "./server/account-auth";
import {
  defaultProductChain,
  getProductChain,
  readChainEnv,
  type ProductChainConfig,
  type ProductChainId,
} from "./chain-config";
import {
  createWalletSessionForVerifiedAddress,
  normalizeSuiAddress,
  type WalletAuthInput,
} from "./server/wallet-auth";
import {
  createSuiClient,
  DEFAULT_SUI_RPC_URL,
  findSuiEvent,
  isSuiTxSuccess,
  normalizeSuiPackageId,
} from "./sui-onchain";
import { getSupabaseAdmin } from "./supabase/server";
import type {
  ModelUsageReceipt,
  ZeroGComputeStatus,
  ZeroGTokenUsage,
} from "./langclaw/types";
import { getDefaultOpenAIModel, getOpenAIBaseUrl } from "./openai/responses";
import {
  applyMarkupNeuron,
  buildUsageMeter,
  calculateMarkupNeuron,
  calculateTokenCostNeuron,
  mapUiTokenUsage,
  type ProviderUsageTrace,
  readUsageMarkupBps,
  selectUsageCost,
} from "./usage-pricing";

type UsageWallet = {
  address: string;
};

type UsageAccountRow = {
  available_neuron: string | number;
  chain_id?: string | number;
  chain_slug?: string;
  reserved_neuron: string | number;
  native_symbol?: string;
  lifetime_charged_neuron: string | number;
  lifetime_deposited_neuron: string | number;
  wallet_address: string;
  wallet_user_id: string;
};

type UsageRpcRow = Record<string, unknown>;

type UsageVaultAdminContext = {
  adminCapObjectId: string;
  adminCapOwner?: string;
  adminCapType?: string;
  chain: ProductChainConfig;
  context: Awaited<ReturnType<typeof requireWalletUsageContext>>;
  isAdmin: boolean;
  packageId: string;
  vaultObjectId: string;
};

export type UsageQuoteInput = {
  chain?: ProductChainId;
  estimatedCompletionTokens?: number;
  estimatedPromptTokens?: number;
  imageCount?: number;
  model?: string;
  service?: "audio" | "chat" | "image";
};

export type UsageQuote = {
  chain: ProductChainId;
  chainId: number;
  chainName: string;
  model: string;
  nativeSymbol: string;
  endpoint: string;
  promptPriceNeuron: string;
  completionPriceNeuron: string;
  imagePriceNeuron?: string;
  promptPriceUsd?: string;
  completionPriceUsd?: string;
  imagePriceUsd?: string;
  estimatedPromptTokens: number;
  estimatedCompletionTokens: number;
  estimatedCostNeuron: string;
  estimatedCost0G: string;
  estimatedCostMnt: string;
  estimatedCostNative: string;
  priceFetchedAt: string;
};

export type UsageReservation = {
  chain: ProductChainId;
  chainId: number;
  chainName: string;
  reservationId: string;
  wallet: string;
  nativeSymbol: string;
  model: string;
  promptPriceNeuron: string;
  completionPriceNeuron: string;
  estimatedPromptTokens: number;
  estimatedCompletionTokens: number;
  reservedNeuron: string;
  balanceBefore: string;
  balanceAfterReserve: string;
};

export class UsageHttpError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export function usageErrorResponse(error: unknown) {
  if (error instanceof UsageHttpError) {
    return Response.json({ error: error.message }, { status: error.status });
  }

  return Response.json(
    { error: error instanceof Error ? error.message : "Usage billing failed." },
    { status: 500 }
  );
}

function usageDatabaseErrorMessage(message?: string) {
  const raw = message?.trim();

  if (
    raw?.includes("langclaw_usage_accounts_chain_slug_check") ||
    raw?.includes("langclaw_usage_accounts_native_symbol_check") ||
    raw?.includes("langclaw_usage_deposits_tx_hash_format")
  ) {
    return "Usage database is not migrated for Sui credits. Apply the Sui usage migrations, then retry crediting the same transaction.";
  }

  return raw || "Usage billing failed.";
}

export async function readUsageBalance(
  authInput: AccountAuthInput,
  chainInput?: ProductChainId
) {
  const chain = getProductChain(chainInput ?? defaultProductChain);
  const context = await requireUsageContext(authInput);
  const account = await ensureUsageAccount(
    context.walletUser.id,
    context.wallet,
    chain
  );
  const quote = await buildUsageQuote({ chain: chain.id }).catch(() => undefined);

  return {
    chain: chain.id,
    chainId: chain.chainId,
    chainName: chain.name,
    configured: true,
    nativeSymbol: chain.billingCurrency.symbol,
    wallet: context.wallet.address,
    balance: accountToBalance(account, chain),
    quote,
  };
}

export async function buildUsageQuote(
  input: UsageQuoteInput = {}
): Promise<UsageQuote> {
  const chain = getProductChain(input.chain ?? defaultProductChain);
  const price = await readActiveModelPrice(input);
  const estimatedPromptTokens =
    input.estimatedPromptTokens ??
    readPositiveInt(process.env.LANGCLAW_USAGE_ESTIMATED_PROMPT_TOKENS, 6000);
  const estimatedCompletionTokens =
    input.estimatedCompletionTokens ??
    readEstimatedCompletionUnits(input, price.imagePriceNeuron);
  const estimatedCost = BigInt(calculateTokenCostNeuron({
    promptPriceNeuron: price.promptPriceNeuron,
    completionPriceNeuron: price.completionPriceNeuron,
    promptTokens: estimatedPromptTokens,
    completionTokens: estimatedCompletionTokens,
  }));

  return {
    chain: chain.id,
    chainId: chain.chainId,
    chainName: chain.name,
    model: price.model,
    nativeSymbol: chain.billingCurrency.symbol,
    endpoint: price.endpoint,
    promptPriceNeuron: price.promptPriceNeuron,
    completionPriceNeuron: price.completionPriceNeuron,
    imagePriceNeuron: price.imagePriceNeuron,
    promptPriceUsd: price.promptPriceUsd,
    completionPriceUsd: price.completionPriceUsd,
    imagePriceUsd: price.imagePriceUsd,
    estimatedPromptTokens,
    estimatedCompletionTokens,
    estimatedCostNeuron: estimatedCost.toString(),
    estimatedCost0G: formatBillingAmount(estimatedCost, chain),
    estimatedCostMnt: formatBillingAmount(estimatedCost, chain),
    estimatedCostNative: formatBillingAmount(estimatedCost, chain),
    priceFetchedAt: new Date(price.fetchedAt).toISOString(),
  };
}

export async function reserveResearchUsage(
  authInput: AccountAuthInput,
  quoteInput: UsageQuoteInput = {},
  chainInput?: ProductChainId
): Promise<UsageReservation> {
  const chain = getProductChain(chainInput ?? quoteInput.chain ?? defaultProductChain);
  const context = await requireUsageContext(authInput);
  const quote = await buildUsageQuote({ ...quoteInput, chain: chain.id });
  const reservationId = randomUUID();
  const reservedNeuron = quote.estimatedCostNeuron;
  const { data, error } = await context.supabase.rpc(
    "langclaw_usage_reserve_balance",
    {
      p_completion_price_neuron: quote.completionPriceNeuron,
      p_chain_id: chain.chainId,
      p_chain_slug: chain.id,
      p_estimated_completion_tokens: quote.estimatedCompletionTokens,
      p_estimated_prompt_tokens: quote.estimatedPromptTokens,
      p_model: quote.model,
      p_native_symbol: chain.billingCurrency.symbol,
      p_prompt_price_neuron: quote.promptPriceNeuron,
      p_reservation_id: reservationId,
      p_reserved_neuron: reservedNeuron,
      p_wallet_address: context.wallet.address,
      p_wallet_user_id: context.walletUser.id,
    }
  );

  if (error) {
    if (error.message.toLowerCase().includes("insufficient_balance")) {
      throw new UsageHttpError(
        402,
        `Insufficient ${chain.billingCurrency.symbol} balance.`
      );
    }

    throw new UsageHttpError(500, usageDatabaseErrorMessage(error.message));
  }

  const row = firstRpcRow(data);

  if (!row) {
    throw new UsageHttpError(500, "Usage reservation was not created.");
  }

  return {
    chain: chain.id,
    chainId: chain.chainId,
    chainName: chain.name,
    reservationId,
    wallet: context.wallet.address,
    model: quote.model,
    nativeSymbol: chain.billingCurrency.symbol,
    promptPriceNeuron: quote.promptPriceNeuron,
    completionPriceNeuron: quote.completionPriceNeuron,
    estimatedPromptTokens: quote.estimatedPromptTokens,
    estimatedCompletionTokens: quote.estimatedCompletionTokens,
    reservedNeuron,
    balanceBefore: readDecimalString(row.balance_before_neuron),
    balanceAfterReserve: readDecimalString(row.balance_after_neuron),
  };
}

export async function readUsageReservation(
  authInput: AccountAuthInput,
  reservationId: string,
  chainInput?: ProductChainId
): Promise<UsageReservation> {
  const chain = getProductChain(chainInput ?? defaultProductChain);
  const context = await requireUsageContext(authInput);
  const reservations = context.supabase.from(
    "langclaw_usage_reservations"
  ) as ReturnType<typeof context.supabase.from> & {
    select: (columns: string) => any;
  };
  const { data, error } = await reservations
    .select(
      "id,wallet_address,chain_slug,chain_id,native_symbol,model,prompt_price_neuron,completion_price_neuron,estimated_prompt_tokens,estimated_completion_tokens,reserved_neuron,balance_before_neuron,balance_after_reserve_neuron,status"
    )
    .eq("id", reservationId)
    .eq("wallet_user_id", context.walletUser.id)
    .eq("chain_slug", chain.id)
    .maybeSingle();

  if (error) {
    throw new UsageHttpError(500, usageDatabaseErrorMessage(error.message));
  }

  if (!data) {
    throw new UsageHttpError(404, "Usage reservation was not found.");
  }

  return {
    chain: chain.id,
    chainId: chain.chainId,
    chainName: chain.name,
    reservationId: (data as UsageRpcRow).id as string,
    wallet: String((data as UsageRpcRow).wallet_address),
    model: String((data as UsageRpcRow).model),
    nativeSymbol: String(
      (data as UsageRpcRow).native_symbol || chain.billingCurrency.symbol
    ),
    promptPriceNeuron: readDecimalString((data as UsageRpcRow).prompt_price_neuron),
    completionPriceNeuron: readDecimalString(
      (data as UsageRpcRow).completion_price_neuron
    ),
    estimatedPromptTokens: Number((data as UsageRpcRow).estimated_prompt_tokens),
    estimatedCompletionTokens: Number(
      (data as UsageRpcRow).estimated_completion_tokens
    ),
    reservedNeuron: readDecimalString((data as UsageRpcRow).reserved_neuron),
    balanceBefore: readDecimalString((data as UsageRpcRow).balance_before_neuron),
    balanceAfterReserve: readDecimalString(
      (data as UsageRpcRow).balance_after_reserve_neuron
    ),
  };
}

export async function settleResearchUsage({
  computeStatus,
  providerTrace,
  reservation,
  routerTrace,
  topic,
  tokenUsage,
}: {
  computeStatus?: ZeroGComputeStatus;
  reservation: UsageReservation;
  providerTrace?: ProviderUsageTrace;
  routerTrace?: ProviderUsageTrace;
  topic: string;
  tokenUsage?: ZeroGTokenUsage;
}): Promise<ModelUsageReceipt> {
  const supabase = getSupabaseAdmin();

  if (!supabase) {
    throw new UsageHttpError(503, "Supabase service role key is required.");
  }

  const promptTokens = tokenUsage?.promptTokens ?? tokenUsage?.inputTokens ?? 0;
  const completionTokens =
    tokenUsage?.completionTokens ?? tokenUsage?.outputTokens ?? 0;
  const totalTokens =
    tokenUsage?.totalTokens ||
    (promptTokens || completionTokens ? promptTokens + completionTokens : 0);
  const selection = selectUsageCost({
    completionPriceNeuron: reservation.completionPriceNeuron,
    computeStatus,
    promptPriceNeuron: reservation.promptPriceNeuron,
    providerTrace: providerTrace ?? routerTrace,
    reservedNeuron: reservation.reservedNeuron,
    tokenUsage,
  });
  const trace = providerTrace ?? routerTrace;
  const rawCostNeuron = selection.chargedRawNeuron;
  const markupBps = readUsageMarkupBps();
  const markupNeuron = calculateMarkupNeuron(rawCostNeuron, markupBps);
  const chargedNeuron = applyMarkupNeuron(rawCostNeuron, markupBps);
  const uiTokenUsage = mapUiTokenUsage({
    ...(tokenUsage ?? {}),
    totalTokens: tokenUsage?.totalTokens ?? (totalTokens || undefined),
  });

  const { data, error } = await supabase.rpc(
    "langclaw_usage_finalize_reservation",
    {
      p_charged_neuron: chargedNeuron,
      p_completion_tokens: completionTokens,
      p_prompt_tokens: promptTokens,
      p_reservation_id: reservation.reservationId,
      p_status: selection.status,
      p_topic: topic,
      p_total_tokens: totalTokens,
    }
  );

  if (error) {
    throw new UsageHttpError(500, usageDatabaseErrorMessage(error.message));
  }

  const row = firstRpcRow(data);

  if (!row) {
    throw new UsageHttpError(500, "Usage charge was not finalized.");
  }

  return {
    wallet: reservation.wallet,
    chain: reservation.chain,
    chainId: reservation.chainId,
    chainName: reservation.chainName,
    nativeSymbol: reservation.nativeSymbol,
    model: reservation.model,
    requestId: trace?.requestId,
    provider: trace?.provider,
    teeVerified: trace?.teeVerified,
    ...uiTokenUsage,
    promptPriceNeuron: reservation.promptPriceNeuron,
    completionPriceNeuron: reservation.completionPriceNeuron,
    reservedNeuron: reservation.reservedNeuron,
    rawCostNeuron,
    markupBps,
    markupNeuron,
    chargedNeuron: readDecimalString(row.charged_neuron),
    releasedNeuron: readDecimalString(row.released_neuron),
    balanceBefore: reservation.balanceBefore,
    balanceAfter: readDecimalString(row.balance_after_neuron),
    costSource: selection.costSource,
    totalCostNeuron: rawCostNeuron === "0" ? undefined : rawCostNeuron,
    meter: buildUsageMeter({
      model: reservation.model,
      tokenUsage: uiTokenUsage,
      totalConsumeNeuron: readDecimalString(row.charged_neuron),
    }),
    status: readUsageStatus(row.status),
  };
}

export function buildDeveloperModeUsageReceipt({
  account,
  chainInput,
  model,
  providerTrace,
  tokenUsage,
}: {
  account: AuthenticatedAccount;
  chainInput?: ProductChainId;
  model?: string;
  providerTrace?: ProviderUsageTrace;
  tokenUsage?: ZeroGTokenUsage;
}): ModelUsageReceipt {
  const chain = getProductChain(chainInput ?? defaultProductChain);
  const promptTokens = tokenUsage?.promptTokens ?? tokenUsage?.inputTokens ?? 0;
  const completionTokens =
    tokenUsage?.completionTokens ?? tokenUsage?.outputTokens ?? 0;
  const totalTokens =
    tokenUsage?.totalTokens ||
    (promptTokens || completionTokens ? promptTokens + completionTokens : 0);
  const uiTokenUsage = mapUiTokenUsage({
    ...(tokenUsage ?? {}),
    totalTokens: tokenUsage?.totalTokens ?? (totalTokens || undefined),
  });
  const selectedModel = model || getDefaultOpenAIModel();

  return {
    wallet: account.walletUser.walletAddress,
    chain: chain.id,
    chainId: chain.chainId,
    chainName: chain.name,
    nativeSymbol: chain.billingCurrency.symbol,
    model: selectedModel,
    requestId: providerTrace?.requestId,
    provider: providerTrace?.provider,
    teeVerified: providerTrace?.teeVerified,
    ...uiTokenUsage,
    promptPriceNeuron: "0",
    completionPriceNeuron: "0",
    reservedNeuron: "0",
    rawCostNeuron: "0",
    markupBps: 0,
    markupNeuron: "0",
    chargedNeuron: "0",
    releasedNeuron: "0",
    balanceBefore: "0",
    balanceAfter: "0",
    costSource: "reserved-estimate",
    meter: buildUsageMeter({
      model: selectedModel,
      tokenUsage: uiTokenUsage,
      totalConsumeNeuron: "0",
    }),
    status: "estimated",
  };
}

export async function refundResearchUsage(
  reservation: UsageReservation,
  reason: string
): Promise<ModelUsageReceipt> {
  const supabase = getSupabaseAdmin();

  if (!supabase) {
    throw new UsageHttpError(503, "Supabase service role key is required.");
  }

  const { data, error } = await supabase.rpc(
    "langclaw_usage_refund_reservation",
    {
      p_reason: reason,
      p_reservation_id: reservation.reservationId,
    }
  );

  if (error) {
    throw new UsageHttpError(500, usageDatabaseErrorMessage(error.message));
  }

  const row = firstRpcRow(data);

  return {
    wallet: reservation.wallet,
    chain: reservation.chain,
    chainId: reservation.chainId,
    chainName: reservation.chainName,
    nativeSymbol: reservation.nativeSymbol,
    model: reservation.model,
    promptPriceNeuron: reservation.promptPriceNeuron,
    completionPriceNeuron: reservation.completionPriceNeuron,
    reservedNeuron: reservation.reservedNeuron,
    rawCostNeuron: "0",
    markupBps: readUsageMarkupBps(),
    markupNeuron: "0",
    chargedNeuron: "0",
    releasedNeuron: row
      ? readDecimalString(row.released_neuron)
      : reservation.reservedNeuron,
    balanceBefore: reservation.balanceBefore,
    balanceAfter: row
      ? readDecimalString(row.balance_after_neuron)
      : reservation.balanceBefore,
    costSource: "reserved-estimate",
    meter: buildUsageMeter({
      model: reservation.model,
      totalConsumeNeuron: "0",
    }),
    status: "failed_after_charge",
  };
}

export async function verifyUsageDeposit({
  chain: chainInput = defaultProductChain,
  reference,
  txHash,
  wallet: walletInput,
}: {
  chain?: ProductChainId;
  reference?: unknown;
  txHash?: unknown;
  wallet: WalletAuthInput;
}) {
  const chain = getProductChain(chainInput);
  const hash = readTxHash(txHash);
  const { packageId } = readUsageVaultConfig(chain);
  const rpcUrl =
    readChainEnv(chain, "CHAIN_RPC_URL", chain.rpcUrl) || DEFAULT_SUI_RPC_URL;
  const client = await createSuiClient(rpcUrl, chain.suiNetwork);
  const block = await client.getTransactionBlock({
    digest: hash,
    options: { showEvents: true, showEffects: true },
  });

  if (!isSuiTxSuccess(block)) {
    throw new UsageHttpError(400, "Deposit transaction did not succeed.");
  }

  const depositEventType = `${packageId}::usage_vault::Deposited`;
  const depositEvent = findSuiEvent(block, depositEventType);

  if (!depositEvent) {
    throw new UsageHttpError(400, "Deposit event was not found.");
  }

  const parsed = (depositEvent.parsedJson ?? {}) as {
    payer?: string;
    amount?: string | number;
    deposit_reference?: number[];
  };

  if (typeof parsed.payer !== "string" || parsed.amount === undefined) {
    throw new UsageHttpError(400, "Deposit event payload is incomplete.");
  }

  // `amount` is reported in MIST (1e-9 SUI); the Move event already emits it as
  // the smallest on-chain unit, which the ledger consumes directly as neuron.
  const amountNeuron = BigInt(parsed.amount).toString();

  if (BigInt(amountNeuron) <= 0n) {
    throw new UsageHttpError(400, "Deposit amount must be greater than zero.");
  }

  const payerAddress = normalizeDepositAddress(parsed.payer);

  if (!payerAddress) {
    throw new UsageHttpError(400, "Deposit event payer is invalid.");
  }

  const claimedAddress = normalizeDepositAddress(walletInput.address);

  if (claimedAddress && claimedAddress !== payerAddress) {
    throw new UsageHttpError(403, "Wallet mismatch.");
  }

  const { context, walletSession } = await resolveDepositUsageContext(
    walletInput,
    payerAddress
  );

  if (normalizeDepositAddress(context.wallet.address) !== payerAddress) {
    throw new UsageHttpError(403, "Deposit event wallet mismatch.");
  }

  const onchainReference = encodeDepositReference(parsed.deposit_reference);
  const expectedReference = readOptionalReference(reference);

  if (
    expectedReference &&
    onchainReference.toLowerCase() !== expectedReference.toLowerCase()
  ) {
    throw new UsageHttpError(400, "Deposit reference mismatch.");
  }

  const { data, error } = await context.supabase.rpc(
    "langclaw_usage_credit_deposit",
    {
      p_amount_neuron: amountNeuron,
      p_block_number: readDecimalString(block.checkpoint),
      p_chain_id: chain.chainId,
      p_chain_slug: chain.id,
      p_log_index: 0,
      p_reference: onchainReference,
      p_tx_hash: hash,
      p_native_symbol: chain.billingCurrency.symbol,
      p_wallet_address: context.wallet.address,
      p_wallet_user_id: context.walletUser.id,
    }
  );

  if (error) {
    throw new UsageHttpError(500, usageDatabaseErrorMessage(error.message));
  }

  const row = firstRpcRow(data);

  if (!row) {
    throw new UsageHttpError(500, "Deposit was not credited.");
  }

  return {
    chain: chain.id,
    chainId: chain.chainId,
    chainName: chain.name,
    configured: true,
    nativeSymbol: chain.billingCurrency.symbol,
    wallet: context.wallet.address,
    walletSession,
    txHash: hash,
    amountNeuron,
    amount0G: formatBillingAmount(BigInt(amountNeuron), chain),
    amountMnt: formatBillingAmount(BigInt(amountNeuron), chain),
    amountNative: formatBillingAmount(BigInt(amountNeuron), chain),
    credited: readBoolean(row.credited),
    balanceBefore: readDecimalString(row.balance_before_neuron),
    balanceAfter: readDecimalString(row.balance_after_neuron),
  };
}

export async function buildWithdrawRequest(walletInput: WalletAuthInput) {
  return buildWithdrawRequestForChain(walletInput, defaultProductChain);
}

export function buildUsageVaultInfo(chainInput: ProductChainId) {
  const chain = getProductChain(chainInput);
  const { adminCapObjectId, packageId, vaultObjectId } =
    readUsageVaultConfig(chain);

  return {
    adminCapObjectId,
    chain: chain.id,
    chainId: chain.chainId,
    chainName: chain.name,
    configured: true,
    billingCurrency: {
      decimals: chain.billingCurrency.decimals,
      name: chain.billingCurrency.name,
      symbol: chain.billingCurrency.symbol,
    },
    depositFunctionName: "deposit",
    module: "usage_vault",
    moveCallTarget: `${packageId}::usage_vault::deposit`,
    nativeSymbol: chain.billingCurrency.symbol,
    network: chain.suiNetwork,
    vaultPackageId: packageId,
    vaultObjectId,
  };
}

export async function readUsageVaultInfo(chainInput: ProductChainId) {
  const chain = getProductChain(chainInput);
  const vault = buildUsageVaultInfo(chain.id);
  const rpcUrl =
    readChainEnv(chain, "CHAIN_RPC_URL", chain.rpcUrl) || DEFAULT_SUI_RPC_URL;
  const client = await createSuiClient(rpcUrl, chain.suiNetwork);

  const [packageObject, vaultObject] = await Promise.all([
    client.getObject({
      id: vault.vaultPackageId,
      options: { showType: true },
    }),
    client.getObject({
      id: vault.vaultObjectId,
      options: { showType: true },
    }),
  ]);

  if (packageObject.error || !packageObject.data?.objectId) {
    throw new UsageHttpError(
      503,
      `Configured usage vault package was not found on ${chain.name}. Publish usage_vault on ${chain.name} and update SUI_LANGCLAW_USAGE_VAULT_PACKAGE_ID.`
    );
  }

  if (vaultObject.error || !vaultObject.data?.objectId) {
    throw new UsageHttpError(
      503,
      `Configured usage vault object was not found on ${chain.name}. Publish usage_vault on ${chain.name} and update SUI_LANGCLAW_USAGE_VAULT_OBJECT_ID.`
    );
  }

  const vaultObjectType = vaultObject.data.type;

  if (vaultObjectType && !vaultObjectType.includes("::usage_vault::Vault")) {
    throw new UsageHttpError(
      503,
      `Configured usage vault object is not a usage_vault::Vault on ${chain.name}. Check SUI_LANGCLAW_USAGE_VAULT_OBJECT_ID.`
    );
  }

  return {
    ...vault,
    vaultObjectType,
  };
}

export async function readUsageVaultAdminStatus(
  walletInput: WalletAuthInput,
  chainInput: ProductChainId
) {
  const admin = await requireUsageVaultAdminContext(walletInput, chainInput);

  return {
    adminCapObjectId: admin.adminCapObjectId,
    adminCapOwner: admin.adminCapOwner,
    adminCapType: admin.adminCapType,
    chain: admin.chain.id,
    chainId: admin.chain.chainId,
    chainName: admin.chain.name,
    configured: true,
    isAdmin: admin.isAdmin,
    nativeSymbol: admin.chain.billingCurrency.symbol,
    network: admin.chain.suiNetwork,
    vaultObjectId: admin.vaultObjectId,
    vaultPackageId: admin.packageId,
    wallet: admin.context.wallet.address,
  };
}

export async function verifyUsageVaultWithdrawal({
  amountMist,
  chain: chainInput = defaultProductChain,
  recipient,
  txHash,
  wallet: walletInput,
}: {
  amountMist?: unknown;
  chain?: ProductChainId;
  recipient?: unknown;
  txHash?: unknown;
  wallet: WalletAuthInput;
}) {
  const hash = readTxHash(txHash);
  const admin = await requireUsageVaultAdminContext(walletInput, chainInput);

  if (!admin.isAdmin) {
    throw new UsageHttpError(403, "Connected wallet does not own the vault AdminCap.");
  }

  const rpcUrl =
    readChainEnv(admin.chain, "CHAIN_RPC_URL", admin.chain.rpcUrl) ||
    DEFAULT_SUI_RPC_URL;
  const client = await createSuiClient(rpcUrl, admin.chain.suiNetwork);
  const block = await client.getTransactionBlock({
    digest: hash,
    options: { showEvents: true, showEffects: true },
  });

  if (!isSuiTxSuccess(block)) {
    throw new UsageHttpError(400, "Withdrawal transaction did not succeed.");
  }

  const withdrawEvent = findSuiEvent(
    block,
    `${admin.packageId}::usage_vault::Withdrawn`
  );

  if (!withdrawEvent) {
    throw new UsageHttpError(400, "Withdrawal event was not found.");
  }

  const parsed = (withdrawEvent.parsedJson ?? {}) as {
    admin?: string;
    amount?: string | number;
    balance_after?: string | number;
    recipient?: string;
  };
  const eventAdmin = normalizeDepositAddress(parsed.admin);
  const eventRecipient = normalizeDepositAddress(parsed.recipient);

  if (
    !eventAdmin ||
    !eventRecipient ||
    parsed.amount === undefined ||
    parsed.balance_after === undefined
  ) {
    throw new UsageHttpError(400, "Withdrawal event payload is incomplete.");
  }

  if (eventAdmin !== admin.context.wallet.address) {
    throw new UsageHttpError(403, "Withdrawal admin wallet mismatch.");
  }

  const expectedRecipient = readOptionalSuiAddress(recipient);

  if (expectedRecipient && expectedRecipient !== eventRecipient) {
    throw new UsageHttpError(400, "Withdrawal recipient mismatch.");
  }

  const amountNeuron = BigInt(parsed.amount).toString();
  const expectedAmount = readOptionalPositiveMist(amountMist);

  if (expectedAmount && expectedAmount !== amountNeuron) {
    throw new UsageHttpError(400, "Withdrawal amount mismatch.");
  }

  const balanceAfterNeuron = readDecimalString(parsed.balance_after);
  const withdrawals = admin.context.supabase.from(
    "langclaw_usage_vault_withdrawals"
  ) as ReturnType<typeof admin.context.supabase.from> & {
    upsert: (values: Record<string, unknown>, options?: unknown) => any;
  };
  const { data, error } = await withdrawals
    .upsert(
      {
        admin_wallet_address: admin.context.wallet.address,
        admin_wallet_user_id: admin.context.walletUser.id,
        amount_neuron: amountNeuron,
        balance_after_neuron: balanceAfterNeuron,
        block_number: readDecimalString(block.checkpoint),
        chain_id: admin.chain.chainId,
        chain_slug: admin.chain.id,
        event_seq: readEventSeq(withdrawEvent.id?.eventSeq),
        native_symbol: admin.chain.billingCurrency.symbol,
        recipient_address: eventRecipient,
        status: "confirmed",
        tx_hash: hash,
      },
      { onConflict: "chain_slug,tx_hash" }
    )
    .select(
      "tx_hash,admin_wallet_address,recipient_address,amount_neuron,balance_after_neuron,created_at"
    )
    .single();

  if (error || !data) {
    throw new UsageHttpError(
      500,
      error
        ? usageDatabaseErrorMessage(error.message)
        : "Withdrawal audit record was not saved."
    );
  }

  const row = data as UsageRpcRow;

  return {
    amountNative: formatBillingAmount(BigInt(amountNeuron), admin.chain),
    amountNeuron,
    balanceAfterNative: formatBillingAmount(BigInt(balanceAfterNeuron), admin.chain),
    balanceAfterNeuron,
    chain: admin.chain.id,
    chainId: admin.chain.chainId,
    chainName: admin.chain.name,
    configured: true,
    nativeSymbol: admin.chain.billingCurrency.symbol,
    recorded: true,
    recipient: eventRecipient,
    txHash: readString(row.tx_hash) || hash,
    wallet: admin.context.wallet.address,
  };
}

export async function buildWithdrawRequestForChain(
  walletInput: WalletAuthInput,
  chainInput: ProductChainId
) {
  const chain = getProductChain(chainInput);
  const context = await requireWalletUsageContext(walletInput);
  const account = await ensureUsageAccount(
    context.walletUser.id,
    context.wallet,
    chain
  );
  const vault = buildUsageVaultInfo(chain.id);

  return {
    ...vault,
    wallet: context.wallet.address,
    functionName: "withdraw",
    balance: accountToBalance(account, chain),
    note:
      "Vault withdrawals are admin-only on Sui: usage_vault::withdraw(&AdminCap, &mut Vault, amount, recipient) must be called by the vault admin. The connected wallet cannot self-withdraw.",
  };
}

async function requireUsageVaultAdminContext(
  walletInput: WalletAuthInput,
  chainInput: ProductChainId
): Promise<UsageVaultAdminContext> {
  const chain = getProductChain(chainInput);
  const context = await requireWalletUsageContext(walletInput);
  const { adminCapObjectId, packageId, vaultObjectId } =
    readUsageVaultConfig(chain);

  if (!adminCapObjectId) {
    throw new UsageHttpError(
      503,
      `${chain.envPrefix}_LANGCLAW_USAGE_VAULT_ADMIN_CAP_OBJECT_ID is not configured.`
    );
  }

  const rpcUrl =
    readChainEnv(chain, "CHAIN_RPC_URL", chain.rpcUrl) || DEFAULT_SUI_RPC_URL;
  const client = await createSuiClient(rpcUrl, chain.suiNetwork);
  const adminCap = await client.getObject({
    id: adminCapObjectId,
    options: { showOwner: true, showType: true },
  });
  const adminCapOwner = readSuiObjectOwnerAddress(adminCap);
  const walletAddress = normalizeDepositAddress(context.wallet.address);

  if (!walletAddress) {
    throw new UsageHttpError(401, "Wallet address is invalid.");
  }

  const isAdmin = Boolean(
    adminCapOwner && adminCapOwner.toLowerCase() === walletAddress.toLowerCase()
  );

  return {
    adminCapObjectId,
    adminCapOwner,
    adminCapType: readSuiObjectType(adminCap),
    chain,
    context: {
      ...context,
      wallet: { address: walletAddress },
    },
    isAdmin,
    packageId,
    vaultObjectId,
  };
}

async function requireUsageContext(authInput: AccountAuthInput) {
  try {
    const account = await requireAccountAuth(authInput);

    return {
      supabase: account.supabase,
      wallet: { address: account.walletUser.walletAddress },
      walletUser: { id: account.walletUser.id },
    };
  } catch (error) {
    throw mapUsageAuthError(error);
  }
}

async function requireWalletUsageContext(walletInput: WalletAuthInput) {
  try {
    const account = await requireWalletAccount(walletInput);

    return {
      supabase: account.supabase,
      wallet: { address: account.walletUser.walletAddress },
      walletUser: { id: account.walletUser.id },
    };
  } catch (error) {
    throw mapUsageAuthError(error);
  }
}

async function resolveDepositUsageContext(
  walletInput: WalletAuthInput,
  txSender: string
) {
  if (hasReusableWalletAuth(walletInput)) {
    const context = await requireWalletUsageContext(walletInput);

    if (normalizeDepositAddress(context.wallet.address) !== txSender) {
      throw new UsageHttpError(403, "Wallet mismatch.");
    }

    return { context, walletSession: undefined };
  }

  const walletSession = createWalletSessionForVerifiedAddress(txSender);
  const account = await createVerifiedWalletAccount(walletSession);

  return {
    context: {
      supabase: account.supabase,
      wallet: { address: account.walletUser.walletAddress },
      walletUser: { id: account.walletUser.id },
    },
    walletSession,
  };
}

function hasReusableWalletAuth(walletInput: WalletAuthInput) {
  return Boolean(
    walletInput.sessionToken ||
      (typeof walletInput.message === "string" &&
        typeof walletInput.signature === "string")
  );
}

async function ensureUsageAccount(
  walletUserId: string,
  wallet: UsageWallet,
  chain: ProductChainConfig
): Promise<UsageAccountRow> {
  const supabase = getSupabaseAdmin();

  if (!supabase) {
    throw new UsageHttpError(503, "Supabase service role key is required.");
  }

  const accounts = supabase.from("langclaw_usage_accounts") as ReturnType<
    typeof supabase.from
  > & {
    upsert: (values: Record<string, unknown>, options?: unknown) => any;
  };
  const { data, error } = await accounts
    .upsert(
      {
        chain_id: chain.chainId,
        chain_slug: chain.id,
        native_symbol: chain.billingCurrency.symbol,
        wallet_address: wallet.address,
        wallet_user_id: walletUserId,
      },
      { onConflict: "wallet_user_id,chain_slug" }
    )
    .select(
      "wallet_user_id,wallet_address,chain_slug,chain_id,native_symbol,available_neuron,reserved_neuron,lifetime_deposited_neuron,lifetime_charged_neuron"
    )
    .single();

  if (error || !data) {
    throw new UsageHttpError(
      500,
      error
        ? usageDatabaseErrorMessage(error.message)
        : "Unable to read usage balance."
    );
  }

  return data as unknown as UsageAccountRow;
}

function mapUsageAuthError(error: unknown) {
  if (error instanceof AccountAuthError) {
    return new UsageHttpError(error.status, error.message);
  }

  return error;
}

async function readActiveModelPrice(input: UsageQuoteInput = {}) {
  const endpoint = getOpenAIBaseUrl();
  const model = input.model?.trim() || getDefaultOpenAIModel("chat");
  const promptPriceNeuron = readNeuronString(
    process.env.OPENAI_PROMPT_PRICE_NEURON_PER_TOKEN ||
      process.env.LANGCLAW_USAGE_PROMPT_PRICE_NEURON ||
      "1"
  );
  const completionPriceNeuron = readNeuronString(
    process.env.OPENAI_COMPLETION_PRICE_NEURON_PER_TOKEN ||
      process.env.LANGCLAW_USAGE_COMPLETION_PRICE_NEURON ||
      "5"
  );

  if (!promptPriceNeuron || !completionPriceNeuron) {
    throw new UsageHttpError(
      503,
      `OpenAI model ${model} usage pricing is not configured.`
    );
  }

  return {
    model,
    endpoint,
    promptPriceNeuron,
    completionPriceNeuron,
    imagePriceNeuron: undefined,
    promptPriceUsd:
      readString(process.env.OPENAI_PROMPT_PRICE_USD_PER_TOKEN) || undefined,
    completionPriceUsd:
      readString(process.env.OPENAI_COMPLETION_PRICE_USD_PER_TOKEN) || undefined,
    imagePriceUsd: undefined,
    fetchedAt: Date.now(),
  };
}

function readEstimatedCompletionUnits(
  input: UsageQuoteInput,
  imagePriceNeuron?: string
) {
  if (input.estimatedCompletionTokens !== undefined) {
    return input.estimatedCompletionTokens;
  }

  if (input.service === "image" && imagePriceNeuron) {
    return Math.max(1, input.imageCount ?? 1);
  }

  if (input.service === "audio") {
    return readPositiveInt(
      process.env.LANGCLAW_USAGE_ESTIMATED_AUDIO_COMPLETION_TOKENS,
      1200
    );
  }

  return readPositiveInt(
    process.env.LANGCLAW_USAGE_ESTIMATED_COMPLETION_TOKENS,
    1200
  );
}

function accountToBalance(account: UsageAccountRow, chain: ProductChainConfig) {
  const availableNeuron = readDecimalString(account.available_neuron);
  const reservedNeuron = readDecimalString(account.reserved_neuron);
  const lifetimeDepositedNeuron = readDecimalString(
    account.lifetime_deposited_neuron
  );
  const lifetimeChargedNeuron = readDecimalString(
    account.lifetime_charged_neuron
  );

  return {
    chain: chain.id,
    chainId: chain.chainId,
    nativeSymbol: chain.billingCurrency.symbol,
    availableNeuron,
    available0G: formatBillingAmount(BigInt(availableNeuron), chain),
    availableMnt: formatBillingAmount(BigInt(availableNeuron), chain),
    availableNative: formatBillingAmount(BigInt(availableNeuron), chain),
    reservedNeuron,
    reserved0G: formatBillingAmount(BigInt(reservedNeuron), chain),
    reservedMnt: formatBillingAmount(BigInt(reservedNeuron), chain),
    reservedNative: formatBillingAmount(BigInt(reservedNeuron), chain),
    lifetimeDepositedNeuron,
    lifetimeDeposited0G: formatBillingAmount(BigInt(lifetimeDepositedNeuron), chain),
    lifetimeDepositedMnt: formatBillingAmount(BigInt(lifetimeDepositedNeuron), chain),
    lifetimeDepositedNative: formatBillingAmount(BigInt(lifetimeDepositedNeuron), chain),
    lifetimeChargedNeuron,
    lifetimeCharged0G: formatBillingAmount(BigInt(lifetimeChargedNeuron), chain),
    lifetimeChargedMnt: formatBillingAmount(BigInt(lifetimeChargedNeuron), chain),
    lifetimeChargedNative: formatBillingAmount(BigInt(lifetimeChargedNeuron), chain),
  };
}

function readUsageVaultConfig(chain: ProductChainConfig) {
  const packageId = readChainEnv(chain, "LANGCLAW_USAGE_VAULT_PACKAGE_ID");

  if (!packageId) {
    throw new UsageHttpError(
      503,
      `${chain.envPrefix}_LANGCLAW_USAGE_VAULT_PACKAGE_ID is not configured.`
    );
  }

  const vaultObjectId = readChainEnv(chain, "LANGCLAW_USAGE_VAULT_OBJECT_ID");

  if (!vaultObjectId) {
    throw new UsageHttpError(
      503,
      `${chain.envPrefix}_LANGCLAW_USAGE_VAULT_OBJECT_ID is not configured.`
    );
  }

  return {
    adminCapObjectId: normalizeOptionalSuiObjectId(
      readChainEnv(chain, "LANGCLAW_USAGE_VAULT_ADMIN_CAP_OBJECT_ID")
    ),
    packageId: normalizeSuiPackageId(packageId),
    vaultObjectId: normalizeSuiPackageId(vaultObjectId),
  };
}

function normalizeOptionalSuiObjectId(value: string | undefined) {
  if (!value) {
    return undefined;
  }

  return normalizeSuiPackageId(value);
}

function normalizeDepositAddress(value: unknown) {
  try {
    return normalizeSuiAddress(value);
  } catch {
    return undefined;
  }
}

function encodeDepositReference(value: number[] | undefined) {
  if (!Array.isArray(value) || value.length === 0) {
    return "";
  }

  return `0x${value
    .map((byte) => (byte & 0xff).toString(16).padStart(2, "0"))
    .join("")}`;
}

function firstRpcRow(value: unknown): UsageRpcRow | null {
  if (Array.isArray(value)) {
    return (value[0] as UsageRpcRow | undefined) ?? null;
  }

  return value && typeof value === "object" ? (value as UsageRpcRow) : null;
}

function readSuiObjectOwnerAddress(value: unknown) {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const root = value as {
    data?: {
      owner?: {
        AddressOwner?: string;
      };
    };
  };

  return normalizeDepositAddress(root.data?.owner?.AddressOwner);
}

function readSuiObjectType(value: unknown) {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const root = value as { data?: { type?: unknown } };

  return readString(root.data?.type) || undefined;
}

function readOptionalSuiAddress(value: unknown) {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }

  const address = normalizeDepositAddress(value);

  if (!address) {
    throw new UsageHttpError(400, "recipient must be a valid Sui address.");
  }

  return address;
}

function readOptionalPositiveMist(value: unknown) {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }

  const amount = readNeuronString(value);

  if (!amount || BigInt(amount) <= 0n) {
    throw new UsageHttpError(400, "amountMist must be a positive integer string.");
  }

  return amount;
}

function readEventSeq(value: unknown) {
  const raw = readDecimalString(value);

  return raw === "0" && value !== "0" && value !== 0 ? null : Number(raw);
}

function readTxHash(value: unknown) {
  // Sui transaction digests are base58 strings (no leading 0x / fixed hex shape
  // like EVM tx hashes). Accept any non-empty trimmed string.
  if (typeof value !== "string" || value.trim() === "") {
    throw new UsageHttpError(400, "A valid txHash is required.");
  }

  return value.trim();
}

function readOptionalReference(value: unknown) {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }

  if (typeof value !== "string" || !/^0x[a-fA-F0-9]*$/.test(value)) {
    throw new UsageHttpError(400, "reference must be a hex string.");
  }

  return value;
}

function readNeuronString(value: unknown) {
  if (typeof value === "bigint") {
    return value >= 0n ? value.toString() : "";
  }

  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value >= 0 ? String(value) : "";
  }

  if (typeof value !== "string") {
    return "";
  }

  return /^\d+$/.test(value) ? value : "";
}

function readDecimalString(value: unknown) {
  if (typeof value === "number") {
    return Number.isFinite(value) ? String(Math.trunc(value)) : "0";
  }

  if (typeof value === "bigint") {
    return value.toString();
  }

  if (typeof value === "string" && /^\d+$/.test(value)) {
    return value;
  }

  return "0";
}

function readUsageStatus(value: unknown): ModelUsageReceipt["status"] {
  return value === "estimated" ||
    value === "refunded" ||
    value === "failed_after_charge"
    ? value
    : "charged";
}

function readBoolean(value: unknown) {
  return value === true || value === "true";
}

function readString(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function readPositiveInt(value: string | undefined, fallback: number) {
  const parsed = Number.parseInt(value ?? "", 10);

  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function formatBillingAmount(value: bigint, chain: ProductChainConfig) {
  if (chain.billingCurrency.decimals === 18) {
    return formatWeiAsMnt(value);
  }

  return trimDecimal(formatUnits(value, chain.billingCurrency.decimals));
}

function formatWeiAsMnt(value: bigint) {
  return trimDecimal(formatUnits(value, 18));
}

function trimDecimal(value: string) {
  return value.includes(".")
    ? value.replace(/(\.\d*?[1-9])0+$/, "$1").replace(/\.0+$/, "")
    : value;
}
