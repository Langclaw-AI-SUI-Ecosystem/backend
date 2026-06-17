import type { WalletAuthInput } from "../lib/server/wallet-auth";
import { readProductChainId } from "../lib/chain-config";
import {
  readUsageVaultAdminStatus,
  usageErrorResponse,
  verifyUsageVaultWithdrawal,
} from "../lib/usage";

type AdminRequestBody = {
  amountMist?: unknown;
  chain?: unknown;
  recipient?: unknown;
  txHash?: unknown;
  wallet?: WalletAuthInput;
};

export async function handleAdminUsageVaultStatus(request: Request) {
  let body: AdminRequestBody;

  try {
    body = (await request.json()) as AdminRequestBody;
  } catch {
    return Response.json(
      { error: "Request body must be valid JSON." },
      { status: 400 }
    );
  }

  try {
    const payload = await readUsageVaultAdminStatus(
      body.wallet ?? {},
      readProductChainId(body.chain)
    );

    return Response.json(payload);
  } catch (error) {
    return usageErrorResponse(error);
  }
}

export async function handleAdminUsageVaultWithdrawalVerify(request: Request) {
  let body: AdminRequestBody;

  try {
    body = (await request.json()) as AdminRequestBody;
  } catch {
    return Response.json(
      { error: "Request body must be valid JSON." },
      { status: 400 }
    );
  }

  try {
    const payload = await verifyUsageVaultWithdrawal({
      amountMist: body.amountMist,
      chain: readProductChainId(body.chain),
      recipient: body.recipient,
      txHash: body.txHash,
      wallet: body.wallet ?? {},
    });

    return Response.json(payload);
  } catch (error) {
    return usageErrorResponse(error);
  }
}
