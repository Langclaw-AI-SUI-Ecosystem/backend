import {
  createWalletChallenge,
  verifyWalletSession,
  WalletAuthError,
  type WalletAuthInput,
} from "../lib/server/wallet-auth";

type WalletChallengeBody = {
  address?: unknown;
  chainId?: unknown;
  purpose?: unknown;
};

type WalletSessionBody = {
  wallet?: WalletAuthInput;
};

export async function handleWalletChallenge(request: Request) {
  let body: WalletChallengeBody;

  try {
    body = (await request.json()) as WalletChallengeBody;
  } catch {
    return Response.json(
      { configured: true, error: "Request body must be valid JSON." },
      { status: 400 }
    );
  }

  try {
    return Response.json({
      challenge: createWalletChallenge({
        address: body.address,
        chainId: body.chainId,
        purpose: body.purpose,
        request,
      }),
      configured: true,
    });
  } catch (error) {
    return walletAuthErrorResponse(error);
  }
}

export async function handleWalletSession(request: Request) {
  let body: WalletSessionBody;

  try {
    body = (await request.json()) as WalletSessionBody;
  } catch {
    return Response.json(
      { configured: true, error: "Request body must be valid JSON." },
      { status: 400 }
    );
  }

  try {
    const wallet = await verifyWalletSession(body.wallet ?? {}, {
      requiredPurpose: "session",
    });

    if (!wallet?.sessionToken || !wallet.sessionExpiresAt) {
      return Response.json(
        { configured: true, error: "Wallet challenge is invalid or expired." },
        { status: 401 }
      );
    }

    return Response.json({
      configured: true,
      wallet: {
        address: wallet.address,
        sessionExpiresAt: wallet.sessionExpiresAt,
        sessionToken: wallet.sessionToken,
      },
    });
  } catch (error) {
    return walletAuthErrorResponse(error);
  }
}

function walletAuthErrorResponse(error: unknown) {
  if (error instanceof WalletAuthError) {
    return Response.json(
      { configured: true, error: error.message },
      { status: error.status }
    );
  }

  return Response.json(
    {
      configured: true,
      error:
        error instanceof Error
          ? error.message
          : "Wallet authentication failed.",
    },
    { status: 500 }
  );
}
