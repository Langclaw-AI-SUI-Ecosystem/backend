import {
  createMemory,
  deleteManyMemories,
  deleteMemory,
  memoryErrorResponse,
  readMemoryDashboard,
  readMemorySettings,
  updateManyMemoryStatuses,
  updateMemorySettings,
  updateMemoryStatus,
  type MemoryInput,
  type MemorySettingsInput,
} from "../lib/memory";
import type { WalletAuthInput } from "../lib/server/wallet-auth";

type MemoryBody = {
  action?: unknown;
  memory?: MemoryInput;
  memoryId?: unknown;
  memoryIds?: unknown;
  settings?: MemorySettingsInput;
  status?: unknown;
  wallet?: WalletAuthInput;
};

export async function handleMemory(request: Request) {
  const body = await readMemoryBody(request);

  if ("response" in body) {
    return body.response;
  }

  const auth = { request, wallet: body.wallet ?? {} };

  try {
    if (!body.action || body.action === "list") {
      return Response.json(await readMemoryDashboard(auth));
    }

    if (body.action === "create") {
      return Response.json({
        configured: true,
        memory: await createMemory(auth, body.memory ?? {}),
      });
    }

    if (body.action === "status") {
      return Response.json({
        configured: true,
        memory: await updateMemoryStatus(auth, body.memoryId, body.status),
      });
    }

    if (body.action === "bulk-status") {
      return Response.json({
        configured: true,
        memories: await updateManyMemoryStatuses(
          auth,
          body.memoryIds,
          body.status
        ),
      });
    }

    if (body.action === "delete") {
      return Response.json({
        configured: true,
        ...(await deleteMemory(auth, body.memoryId)),
      });
    }

    if (body.action === "bulk-delete") {
      return Response.json({
        configured: true,
        ...(await deleteManyMemories(auth, body.memoryIds)),
      });
    }

    return Response.json(
      { configured: true, error: "Unsupported action." },
      { status: 400 }
    );
  } catch (error) {
    return memoryErrorResponse(error);
  }
}

export async function handleMemorySettings(request: Request) {
  const body = await readMemoryBody(request);

  if ("response" in body) {
    return body.response;
  }

  const auth = { request, wallet: body.wallet ?? {} };

  try {
    if (!body.action || body.action === "get") {
      return Response.json({
        configured: true,
        settings: await readMemorySettings(auth),
      });
    }

    if (body.action === "update") {
      return Response.json({
        configured: true,
        settings: await updateMemorySettings(auth, body.settings ?? {}),
      });
    }

    return Response.json(
      { configured: true, error: "Unsupported action." },
      { status: 400 }
    );
  } catch (error) {
    return memoryErrorResponse(error);
  }
}

async function readMemoryBody(
  request: Request
): Promise<MemoryBody | { response: Response }> {
  try {
    return (await request.json()) as MemoryBody;
  } catch {
    return {
      response: Response.json(
        { configured: true, error: "Request body must be valid JSON." },
        { status: 400 }
      ),
    };
  }
}
