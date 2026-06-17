import { runPrivateMemoryWorkflow } from "../lib/memory-workflow";
import {
  AccountAuthError,
  accountAuthErrorResponse,
  requireAccountAuth,
  requireTelegramLinkedAccount,
} from "../lib/server/account-auth";
import type { WalletAuthInput } from "../lib/server/wallet-auth";
import {
  AutomationHttpError,
  automationErrorResponse,
  readAutomationSettings,
} from "../lib/automation/service";
import {
  buildDeveloperModeUsageReceipt,
  refundResearchUsage,
  reserveResearchUsage,
  settleResearchUsage,
  usageErrorResponse,
  type UsageReservation,
} from "../lib/usage";

export async function handleDiscover(request: Request) {
  let topic = "";
  let wallet: WalletAuthInput = {};
  let reservation: UsageReservation | undefined;

  try {
    const body = (await request.json()) as {
      topic?: unknown;
      wallet?: WalletAuthInput;
    };
    topic = typeof body.topic === "string" ? body.topic.trim() : "";
    wallet = body.wallet ?? {};
  } catch {
    return Response.json(
      { error: "Request body must be valid JSON." },
      { status: 400 }
    );
  }

  if (!topic) {
    return Response.json(
      { error: "Topic is required for Auto Discovery." },
      { status: 400 }
    );
  }

  try {
    const account = await requireAccountAuth({ request, wallet });

    await requireTelegramLinkedAccount(account);
    const settings = await readAutomationSettings({ account });
    const developerModeEnabled = settings.developerModeEnabled;

    if (!developerModeEnabled) {
      reservation = await reserveResearchUsage({ account });
    }

    const payload = await runPrivateMemoryWorkflow({
      topic,
      ownerAddress: account.walletUser.walletAddress,
    });
    const proof = payload.proof ?? payload.zeroG;
    const providerTrace = proof?.compute
      ? {
          billing: proof.compute.billing,
          provider: proof.compute.provider,
          requestId: proof.compute.requestId,
          teeVerified: proof.compute.teeVerified,
        }
      : undefined;

    payload.usage = reservation
      ? await settleResearchUsage({
          computeStatus: proof?.compute?.status,
          reservation,
          providerTrace,
          tokenUsage: proof?.compute?.usage,
          topic,
        })
      : buildDeveloperModeUsageReceipt({
          account,
          model: proof?.compute?.usedModel ?? proof?.compute?.model,
          providerTrace,
          tokenUsage: proof?.compute?.usage,
        });

    return Response.json(payload);
  } catch (error) {
    if (reservation) {
      await refundResearchUsage(
        reservation,
        error instanceof Error ? error.message : "Discovery failed."
      ).catch(() => undefined);
    }

    if (error instanceof AccountAuthError) {
      return accountAuthErrorResponse(error);
    }

    if (error instanceof AutomationHttpError) {
      return automationErrorResponse(error);
    }

    return usageErrorResponse(error);
  }
}
