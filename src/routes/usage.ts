import type { WalletAuthInput } from "../lib/server/wallet-auth";
import { readProductChainId } from "../lib/chain-config";
import {
  buildUsageQuote,
  buildWithdrawRequestForChain,
  readUsageBalance,
  readUsageVaultInfo,
  usageErrorResponse,
  verifyUsageDeposit,
} from "../lib/usage";

type UsageRequestBody = {
  chain?: unknown;
  wallet?: WalletAuthInput;
  txHash?: unknown;
  reference?: unknown;
};

export async function handleUsageBalance(request: Request) {
  let body: UsageRequestBody;

  try {
    body = (await request.json()) as UsageRequestBody;
  } catch {
    return Response.json(
      { error: "Request body must be valid JSON." },
      { status: 400 }
    );
  }

  try {
    const payload = await readUsageBalance({
      request,
      wallet: body.wallet ?? {},
    }, readProductChainId(body.chain));

    return Response.json(payload);
  } catch (error) {
    return usageErrorResponse(error);
  }
}

export async function handleUsageQuote(request?: Request) {
  try {
    const body = request ? await request.json().catch(() => ({})) : {};
    const quote = await buildUsageQuote({
      chain: readProductChainId((body as UsageRequestBody).chain),
    });

    return Response.json({
      configured: true,
      quote,
    });
  } catch (error) {
    return usageErrorResponse(error);
  }
}

export async function handleUsageVaultInfo(request?: Request) {
  try {
    const body = request ? await request.json().catch(() => ({})) : {};
    const vault = await readUsageVaultInfo(readProductChainId((body as UsageRequestBody).chain));

    return Response.json(vault);
  } catch (error) {
    return usageErrorResponse(error);
  }
}

export async function handleUsageDepositVerify(request: Request) {
  let body: UsageRequestBody;

  try {
    body = (await request.json()) as UsageRequestBody;
  } catch {
    return Response.json(
      { error: "Request body must be valid JSON." },
      { status: 400 }
    );
  }

  try {
    const payload = await verifyUsageDeposit({
      reference: body.reference,
      chain: readProductChainId(body.chain),
      txHash: body.txHash,
      wallet: body.wallet ?? {},
    });

    return Response.json(payload);
  } catch (error) {
    return usageErrorResponse(error);
  }
}

export async function handleUsageWithdrawRequest(request: Request) {
  let body: UsageRequestBody;

  try {
    body = (await request.json()) as UsageRequestBody;
  } catch {
    return Response.json(
      { error: "Request body must be valid JSON." },
      { status: 400 }
    );
  }

  try {
    const payload = await buildWithdrawRequestForChain(
      body.wallet ?? {},
      readProductChainId(body.chain)
    );

    return Response.json(payload);
  } catch (error) {
    return usageErrorResponse(error);
  }
}
