import { getIntegrationOverview, getWalrusReadiness } from "../lib/readiness";

export async function handleIntegrations() {
  return Response.json({
    configured: true,
    integrations: getIntegrationOverview(),
  });
}

export async function handleWalrusReadiness(request: Request) {
  let ownerAddress: string | undefined;

  try {
    const body = (await request.json().catch(() => ({}))) as {
      ownerAddress?: unknown;
      strictMainnet?: unknown;
    };
    ownerAddress =
      typeof body.ownerAddress === "string" ? body.ownerAddress : undefined;
    const strictMainnet = body.strictMainnet === true;
    const report = await getWalrusReadiness(ownerAddress, { strictMainnet });

    return Response.json(report, { status: report.ready ? 200 : 503 });
  } catch {
    // Empty / invalid body is fine: report global readiness.
  }

  const report = await getWalrusReadiness(ownerAddress);

  return Response.json(report, { status: report.ready ? 200 : 503 });
}
