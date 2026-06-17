import { runPrivateMemoryWorkflow } from "../lib/memory-workflow";
import {
  accountAuthErrorResponse,
  requireAccountAuth,
  requireTelegramLinkedAccount,
} from "../lib/server/account-auth";
import type { WalletAuthInput } from "../lib/server/wallet-auth";
import {
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

export async function handleDiscoverStream(request: Request) {
  let topic = "";
  let wallet: WalletAuthInput = {};

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

  const account = await requireAccountAuth({ request, wallet }).catch((error) => ({
    error,
  }));

  if ("error" in account) {
    return accountAuthErrorResponse(account.error);
  }

  const telegram = await requireTelegramLinkedAccount(account).catch((error) => ({
    error,
  }));

  if ("error" in telegram) {
    return accountAuthErrorResponse(telegram.error);
  }

  const settings = await readAutomationSettings({ account }).catch((error) => ({
    error,
  }));

  if ("error" in settings) {
    return automationErrorResponse(settings.error);
  }

  let reservation: UsageReservation | undefined;

  if (!settings.developerModeEnabled) {
    const usageReservation = await reserveResearchUsage({ account }).catch(
      (error) => ({
        error,
      })
    );

    if ("error" in usageReservation) {
      return usageErrorResponse(usageReservation.error);
    }

    reservation = usageReservation;
  }

  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      let settled = false;
      const write = (payload: unknown) => {
        controller.enqueue(encoder.encode(`${JSON.stringify(payload)}\n`));
      };

      try {
        const payload = await runPrivateMemoryWorkflow({
          topic,
          ownerAddress: account.walletUser.walletAddress,
          onEvent: (event) => {
            write({ type: "progress", event });
          },
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
        settled = true;

        write({ type: "result", payload });
      } catch (error) {
        if (reservation && !settled) {
          await refundResearchUsage(
            reservation,
            error instanceof Error ? error.message : "Discovery failed."
          ).catch(() => undefined);
        }

        write({
          type: "error",
          error: error instanceof Error ? error.message : "Discovery failed.",
        });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive",
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "X-Accel-Buffering": "no",
    },
  });
}
