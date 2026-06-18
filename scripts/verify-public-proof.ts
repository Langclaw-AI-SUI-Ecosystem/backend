const aggregator = "https://aggregator.walrus-mainnet.walrus.space";
const rpc = "https://fullnode.mainnet.sui.io:443";
const keyServer = "https://43-129-56-85.sslip.io/seal";
const keyServerId =
  "0x86b608dcb3fcb9c629cfe6d865681977d1decb219a2eb98eb6058b87377feaf3";
const transactions = [
  "aK7QiQdnbEXKtrHSZ5qifWcbfcBbu7UsFHsDjDFfR1H",
  "AtTXAV8bTRdUCEJjWuUQvhhdHzepksYKkkCMUqNKCEZ7",
];
const blobs = [
  "dFpx2A6pTOfEL41vTsOmMPo6LTMZ9aWlHsR24FwnanA",
  "UCTZMMFfYKM9OHwjYd9TfehDGp-D6akMt-7T4tsM_Uc",
  "25sqhXLdWpMukoZ5snq-3uVi473W0X5aSNUtVanPIeo",
];

async function main() {
  console.log("Langclaw public mainnet proof\n");

  for (const blobId of blobs) {
    const response = await fetch(`${aggregator}/v1/blobs/${blobId}`);
    const body = await response.arrayBuffer();
    assert(response.ok, `Walrus blob ${blobId} returned ${response.status}`);
    assert(body.byteLength > 0, `Walrus blob ${blobId} is empty`);
    console.log(`PASS Walrus ${blobId} (${body.byteLength} bytes)`);
  }

  const serviceResponse = await fetch(
    `${keyServer}/v1/service?service_id=${keyServerId}`,
    {
      headers: {
        "Client-Sdk-Type": "typescript",
        "Client-Sdk-Version": "1.1.3",
      },
    }
  );
  const service = (await serviceResponse.json()) as { service_id?: string };
  assert(serviceResponse.ok, `Seal service returned ${serviceResponse.status}`);
  assert(service.service_id === keyServerId, "Seal service ID does not match Sui");
  console.log(`PASS Seal key server ${keyServerId}`);

  for (const transaction of transactions) {
    const rpcResponse = await fetch(rpc, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "sui_getTransactionBlock",
        params: [transaction, { showEffects: true }],
      }),
    });
    const rpcBody = (await rpcResponse.json()) as {
      error?: { message?: string };
      result?: { effects?: { status?: { status?: string } } };
    };
    assert(rpcResponse.ok, `Sui RPC returned ${rpcResponse.status}`);
    assert(!rpcBody.error, rpcBody.error?.message || "Sui RPC rejected proof");
    assert(
      rpcBody.result?.effects?.status?.status === "success",
      `Sui transaction ${transaction} is not successful`
    );
    console.log(`PASS Sui transaction ${transaction}`);
  }
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

main().catch((error) => {
  console.error("FAIL", error instanceof Error ? error.message : error);
  process.exit(1);
});
