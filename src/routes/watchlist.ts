import {
  clearAlphaWatchlist,
  deleteAlphaWatchlistItem,
  listAlphaWatchlist,
  upsertAlphaWatchlistItem,
  watchlistErrorResponse,
  type AlphaWatchlistInput,
} from "../lib/watchlist";
import type { WalletAuthInput } from "../lib/server/wallet-auth";

type WatchlistBody = {
  action?: unknown;
  item?: AlphaWatchlistInput;
  itemId?: unknown;
  wallet?: WalletAuthInput;
};

export async function handleWatchlist(request: Request) {
  const body = await readWatchlistBody(request);

  if ("response" in body) {
    return body.response;
  }

  const auth = { request, wallet: body.wallet ?? {} };

  try {
    if (!body.action || body.action === "list") {
      return Response.json({
        configured: true,
        items: await listAlphaWatchlist(auth),
      });
    }

    if (body.action === "upsert") {
      return Response.json({
        configured: true,
        item: await upsertAlphaWatchlistItem(auth, body.item ?? {}),
      });
    }

    if (body.action === "delete") {
      return Response.json({
        configured: true,
        ...(await deleteAlphaWatchlistItem(auth, body.itemId)),
      });
    }

    if (body.action === "clear") {
      return Response.json({
        configured: true,
        ...(await clearAlphaWatchlist(auth)),
      });
    }

    return Response.json(
      { configured: true, error: "Unsupported action." },
      { status: 400 }
    );
  } catch (error) {
    return watchlistErrorResponse(error);
  }
}

async function readWatchlistBody(
  request: Request
): Promise<WatchlistBody | { response: Response }> {
  try {
    return (await request.json()) as WatchlistBody;
  } catch {
    return {
      response: Response.json(
        { configured: true, error: "Request body must be valid JSON." },
        { status: 400 }
      ),
    };
  }
}
