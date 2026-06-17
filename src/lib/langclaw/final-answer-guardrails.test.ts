import assert from "node:assert/strict";
import { test } from "node:test";
import { applyFinalAnswerGuardrails } from "./final-answer-guardrails";
import type { DiscoverSignals, FinalAnswer, ResearchReport } from "./types";

const signals: DiscoverSignals = {
  combined: {
    providers: ["Surf"],
    sourceIds: [],
    status: "success",
    summary: "Combined signal is usable.",
    toolIds: [],
  },
  onchain: {
    providers: ["Surf"],
    sourceIds: [],
    status: "success",
    summary: "On-chain rows are usable.",
    toolIds: ["smart_money.surf"],
  },
  social: {
    providers: ["Surf"],
    sourceIds: [],
    status: "partial",
    summary: "Social context is partial.",
    toolIds: [],
  },
};

test("smart-money guardrails inject deterministic report table", () => {
  const report: ResearchReport = {
    asOfUtc: "2026-05-23T00:00:00.000Z",
    bottomLine: "Confidence is limited until labels and retention are available.",
    caveats: ["DEX buy rows are not confirmed smart money."],
    confidence: "medium",
    entities: [],
    executiveSummary:
      "The clearest signal is a large DEX-buy watchlist, not confirmed smart money.",
    kind: "smart-money",
    recommendations: ["Add wallet labels and retention checks to improve confidence."],
    sections: [
      {
        id: "read",
        markdown: "Large-flow watchlist only.",
        sourceIds: [],
        title: "Read",
        toolIds: [],
      },
      {
        id: "evidence",
        markdown: "Rows came from DEX buys.",
        sourceIds: [],
        title: "Evidence",
        toolIds: [],
      },
      {
        id: "large-flow-watchlist",
        markdown: "Rows stay in large_flow_watchlist until enrichment is available.",
        sourceIds: [],
        title: "large_flow_watchlist",
        toolIds: [],
      },
    ],
    tables: [
      {
        columns: [
          "Wallet",
          "Token",
          "Signal",
          "Amount",
          "USD value",
          "Trades",
          "Window",
          "Category",
          "Status",
        ],
        id: "smart-money-table",
        rows: [
          {
            Amount: "357K MNT",
            Category: "non-stable-token-accumulation",
            Signal: "DEX buy",
            Status: "large_flow_watchlist",
            Token: "MNT",
            Trades: 256,
            "USD value": "$223K",
            Wallet: "0xb33b...a52e",
            Window: "2026-05-16 to 2026-05-21",
          },
        ],
        title: "Large DEX-Buy Watchlist",
      },
    ],
    title: "Ethereum ($MNT) - Smart-Money Accumulation Watch",
  };
  const answer: FinalAnswer = {
    answer: "Bad raw answer.",
    answerMarkdown: [
      "Surf-style research note - confirmed_smart_money",
      "",
      "## Candidates (large-flow watchlist, not confirmed smart money)",
      "",
      "- 0xb33b...a52e - MNT: 357K DEX buy.",
    ].join("\n"),
    bullets: [],
    generatedBy: "Final Conclusion Agent",
  };

  const guarded = applyFinalAnswerGuardrails(answer, {
    errors: [],
    report,
    signals,
  });

  assert.match(guarded.answerMarkdown ?? "", /large-flow watchlist/);
  assert.doesNotMatch(guarded.answerMarkdown ?? "", /Surf-style/i);
  assert.match(guarded.answerMarkdown ?? "", /## Evidence\n\n\| Evidence \| Value \| Status \|/);
  assert.match(guarded.answerMarkdown ?? "", /\| Rows parsed \| 1 \| Available \|/);
  assert.match(
    guarded.answerMarkdown ?? "",
    /\| Token bucket \| non-stable token accumulation \| Reported \|/
  );
  assert.match(guarded.answerMarkdown ?? "", /\| Wallet \| Token \| Signal \|/);
  assert.match(guarded.answerMarkdown ?? "", /\| 0xb33b\.\.\.a52e \| MNT \| DEX buy \|/);
  assert.match(guarded.answerMarkdown ?? "", /## Candidates\n\n\*\*Large DEX-Buy Watchlist\*\*/);
  assert.doesNotMatch(guarded.answerMarkdown ?? "", /Candidates \(large-flow/i);
  assert.doesNotMatch(guarded.answerMarkdown ?? "", /^- 0xb33b/m);
  assert.match(
    guarded.answerMarkdown ?? "",
    /Rows above are candidates or watchlist entries/
  );
  assert.match(
    guarded.answerMarkdown ?? "",
    /\| 0xb33b\.\.\.a52e \| MNT \| DEX buy \|[^\n]*\n\nRows above are candidates or watchlist entries/
  );
  assert.doesNotMatch(
    guarded.answerMarkdown ?? "",
    /confirmed_smart_money|large_flow_watchlist|data_source_diagnostics|\u2014/i
  );
});

test("smart-money guardrails do not duplicate an existing wallet table", () => {
  const report: ResearchReport = {
    asOfUtc: "2026-05-23T00:00:00.000Z",
    bottomLine: "Rows are watchlist only.",
    caveats: ["DEX buy rows are not confirmed smart money."],
    confidence: "medium",
    entities: [],
    executiveSummary: "Large DEX-buy watchlist.",
    kind: "smart-money",
    recommendations: [],
    sections: [],
    tables: [
      {
        columns: ["Wallet", "Token", "Signal"],
        id: "smart-money-table",
        rows: [
          {
            Signal: "DEX buy",
            Token: "MNT",
            Wallet: "0xb33b...a52e",
          },
        ],
        title: "Large DEX-Buy Watchlist",
      },
    ],
    title: "Smart-money watch",
  };
  const answer: FinalAnswer = {
    answer: "Already has table.",
    answerMarkdown: [
      "## Candidates",
      "",
      "| Wallet | Token | Signal |",
      "| --- | --- | --- |",
      "| 0xb33b...a52e | MNT | DEX buy |",
    ].join("\n"),
    bullets: [],
    generatedBy: "Final Conclusion Agent",
  };

  const guarded = applyFinalAnswerGuardrails(answer, {
    errors: [],
    report,
    signals,
  });
  const tableHeaders = [...(guarded.answerMarkdown ?? "").matchAll(/\| Wallet \| Token \| Signal \|/g)];

  assert.equal(tableHeaders.length, 1);
});

test("smart-money guardrails preserve an existing evidence table", () => {
  const report: ResearchReport = {
    asOfUtc: "2026-05-23T00:00:00.000Z",
    bottomLine: "Rows are watchlist only.",
    caveats: ["DEX buy rows are not confirmed smart money."],
    confidence: "medium",
    entities: [],
    executiveSummary: "Large DEX-buy watchlist.",
    kind: "smart-money",
    recommendations: [],
    sections: [],
    tables: [
      {
        columns: ["Wallet", "Token", "Signal"],
        id: "smart-money-table",
        rows: [
          {
            Signal: "DEX buy",
            Token: "MNT",
            Wallet: "0xb33b...a52e",
          },
        ],
        title: "Large DEX-Buy Watchlist",
      },
    ],
    title: "Smart-money watch",
  };
  const answer: FinalAnswer = {
    answer: "Already has evidence table.",
    answerMarkdown: [
      "## Evidence",
      "",
      "| Evidence | Value | Status |",
      "| --- | --- | --- |",
      "| Existing | Table | Preserved |",
      "",
      "## Candidates",
      "",
      "| Wallet | Token | Signal |",
      "| --- | --- | --- |",
      "| 0xb33b...a52e | MNT | DEX buy |",
    ].join("\n"),
    bullets: [],
    generatedBy: "Final Conclusion Agent",
  };

  const guarded = applyFinalAnswerGuardrails(answer, {
    errors: [],
    report,
    signals,
  });
  const evidenceHeaders = [
    ...(guarded.answerMarkdown ?? "").matchAll(/\| Evidence \| Value \| Status \|/g),
  ];

  assert.equal(evidenceHeaders.length, 1);
  assert.match(guarded.answerMarkdown ?? "", /\| Existing \| Table \| Preserved \|/);
});

test("smart-money guardrails append CEX context when evidence table already exists", () => {
  const report: ResearchReport = {
    asOfUtc: "2026-06-17T00:00:00.000Z",
    bottomLine: "Rows are watchlist only.",
    caveats: ["CEX labels are address context, not withdrawal proof."],
    confidence: "medium",
    entities: [],
    executiveSummary: "Sui DEX rows returned and CEX label context is available.",
    kind: "smart-money",
    recommendations: [],
    sections: [],
    tables: [
      {
        columns: ["Wallet", "Signal", "Token", "Net amount", "Net USD", "Trades", "Window"],
        id: "dex-accumulation-table",
        rows: [
          {
            "Net USD": "$119K",
            "Net amount": "179K",
            Signal: "DEX buy",
            Token: "SUI",
            Trades: 134,
            Wallet: "0x1234...abcd",
            Window: "2026-06-16 to 2026-06-17",
          },
        ],
        title: "DEX Accumulation",
      },
      {
        columns: [
          "Rank",
          "Wallet",
          "Token",
          "Flow type",
          "Amount",
          "USD value",
          "Category",
          "Time window",
        ],
        id: "cex-address-context-table",
        rows: [
          {
            Amount: "Not available",
            Category: "Binance CEX address context",
            "Flow type": "CEX address label (Binance)",
            Rank: 1,
            "Time window": "2026-06-16 to 2026-06-17",
            Token: "Not available",
            "USD value": "Not available",
            Wallet: "Binance 1",
          },
        ],
        title: "Sui CEX Candidate Context",
      },
      {
        columns: ["Wallet", "Token", "Signal"],
        id: "smart-money-table",
        rows: [
          {
            Signal: "DEX buy",
            Token: "SUI",
            Wallet: "0x1234...abcd",
          },
        ],
        title: "Large DEX-Buy Watchlist",
      },
    ],
    title: "Sui Smart-Money Accumulation Watch",
  };
  const answer: FinalAnswer = {
    answer: "Existing evidence table.",
    answerMarkdown: [
      "## Evidence",
      "",
      "| Evidence | Value | Status |",
      "| --- | --- | --- |",
      "| Existing | Table | Preserved |",
      "",
      "## Candidates",
      "",
      "| Wallet | Token | Signal |",
      "| --- | --- | --- |",
      "| 0x1234...abcd | SUI | DEX buy |",
    ].join("\n"),
    bullets: [],
    generatedBy: "Final Conclusion Agent",
  };

  const guarded = applyFinalAnswerGuardrails(answer, {
    errors: [],
    report,
    signals,
  });

  assert.match(guarded.answerMarkdown ?? "", /\| Existing \| Table \| Preserved \|/);
  assert.match(guarded.answerMarkdown ?? "", /\*\*Sui CEX Candidate Context\*\*/);
  assert.match(guarded.answerMarkdown ?? "", /CEX address label/);
  assert.match(guarded.answerMarkdown ?? "", /Binance CEX address context/);
  assert.match(guarded.answerMarkdown ?? "", /\| 0x1234\.\.\.abcd \| SUI \| DEX buy \|/);
});

test("smart-money guardrails inject DEX and CEX evidence tables", () => {
  const report: ResearchReport = {
    asOfUtc: "2026-05-23T00:00:00.000Z",
    bottomLine: "Rows are watchlist only.",
    caveats: ["DEX and CEX rows are not confirmed smart money."],
    confidence: "medium",
    entities: [],
    executiveSummary: "CEX withdrawal and DEX buy rows returned.",
    kind: "smart-money",
    recommendations: [],
    sections: [],
    tables: [
      {
        columns: ["Wallet", "Signal", "Token", "Net amount", "Net USD", "Trades", "Window"],
        id: "dex-accumulation-table",
        rows: [
          {
            "Net USD": "$119K",
            "Net amount": "179K",
            Signal: "DEX buy",
            Token: "MNT",
            Trades: 134,
            Wallet: "0xb33b...a52e",
            Window: "2026-05-20 to 2026-05-21",
          },
        ],
        title: "DEX Accumulation",
      },
      {
        columns: [
          "Rank",
          "Wallet",
          "Token",
          "Flow type",
          "Amount",
          "USD value",
          "Category",
          "Time window",
        ],
        id: "cex-withdrawal-table",
        rows: [
          {
            Amount: "177K",
            Category: "Bybit cex exchange outflow",
            "Flow type": "CEX withdrawal from Bybit",
            Rank: 1,
            "Time window": "2026-05-21 to 2026-05-21",
            Token: "MNT",
            "USD value": "$120K",
            Wallet: "0xbdb3...47b6",
          },
        ],
        title: "CEX Withdrawal Candidates",
      },
      {
        columns: ["Wallet", "Token", "Signal"],
        id: "smart-money-table",
        rows: [
          {
            Signal: "CEX withdrawal",
            Token: "MNT",
            Wallet: "0xbdb3...47b6",
          },
        ],
        title: "Candidate Smart-Money Wallets",
      },
    ],
    title: "Mantle Smart-Money Accumulation Watch",
  };
  const answer: FinalAnswer = {
    answer: "No tables yet.",
    answerMarkdown: "## Evidence\n\nProvider rows returned.\n\n## Candidates\n\nCandidates pending.",
    bullets: [],
    generatedBy: "Final Conclusion Agent",
  };

  const guarded = applyFinalAnswerGuardrails(answer, {
    errors: [],
    report,
    signals,
  });

  assert.match(guarded.answerMarkdown ?? "", /\*\*DEX Accumulation\*\*/);
  assert.match(guarded.answerMarkdown ?? "", /\*\*CEX Withdrawal Candidates\*\*/);
  assert.match(guarded.answerMarkdown ?? "", /\| Rank \| Wallet \| Token \| Flow type \|/);
  assert.match(guarded.answerMarkdown ?? "", /\| 1 \| 0xbdb3\.\.\.47b6 \| MNT \| CEX withdrawal from Bybit \|/);
  assert.match(guarded.answerMarkdown ?? "", /\*\*Candidate Smart-Money Wallets\*\*/);
});

test("smart-money guardrails turn narrative sections into paragraphs", () => {
  const report: ResearchReport = {
    asOfUtc: "2026-05-23T00:00:00.000Z",
    bottomLine: "Rows are watchlist only.",
    caveats: ["DEX buy rows are not confirmed smart money."],
    confidence: "medium",
    entities: [],
    executiveSummary: "Large DEX-buy watchlist.",
    kind: "smart-money",
    recommendations: [],
    sections: [],
    tables: [],
    title: "Smart-money watch",
  };
  const answer: FinalAnswer = {
    answer: "Bulleted sections.",
    answerMarkdown: [
      "## Read",
      "",
      "- First read sentence.",
      "- Second read sentence.",
      "",
      "## Limits",
      "",
      "- First limit.",
      "- Second limit.",
      "",
      "## Conclusion",
      "",
      "- First conclusion.",
      "- Second conclusion.",
    ].join("\n"),
    bullets: [],
    generatedBy: "Final Conclusion Agent",
  };

  const guarded = applyFinalAnswerGuardrails(answer, {
    errors: [],
    report,
    signals,
  });

  assert.match(
    guarded.answerMarkdown ?? "",
    /## Read\n\nFirst read sentence\. Second read sentence\./
  );
  assert.match(
    guarded.answerMarkdown ?? "",
    /## Limits\n\nFirst limit\. Second limit\./
  );
  assert.match(
    guarded.answerMarkdown ?? "",
    /## Conclusion\n\nFirst conclusion\. Second conclusion\./
  );
  assert.doesNotMatch(guarded.answerMarkdown ?? "", /^- First/m);
});

test("smart-money guardrails replace generic limits with report limits", () => {
  const report: ResearchReport = {
    asOfUtc: "2026-05-23T00:00:00.000Z",
    bottomLine: "Rows are watchlist only.",
    caveats: ["DEX buy rows are not confirmed smart money."],
    confidence: "medium",
    entities: [],
    executiveSummary: "Large DEX-buy watchlist.",
    kind: "smart-money",
    recommendations: [],
    sections: [
      {
        id: "limits",
        markdown:
          "Coverage gap. This scan used Ethereum row-level DEX trade surface for $MNT contract 0x3c3a81e81dc49a522a592e762a7e711c06bf354 on Ethereum as external token context for Mantle. Mantle-native holder and transfer coverage was not confirmed by this row set. External token signal. The token rows came from Ethereum. They are low-confidence external context for Mantle, not Mantle chain-level activity.\n\nSmart-money labeling gap. The candidate wallets are mostly unlabeled in the returned rows. The correct classification stays large-flow watchlist, not confirmed smart-money accumulation.\n\nSample window. The ranking reflects 2026-05-20 to 2026-05-21, not a full long-term balance-delta study.",
        sourceIds: [],
        title: "Limits",
        toolIds: [],
      },
    ],
    tables: [],
    title: "Smart-money watch",
  };
  const answer: FinalAnswer = {
    answer: "Generic limits.",
    answerMarkdown: [
      "## Limits",
      "",
      "Smart-money labels can be incomplete here.",
      "",
      "## Conclusion",
      "",
      "Use as watchlist.",
    ].join("\n"),
    bullets: [],
    generatedBy: "Final Conclusion Agent",
  };

  const guarded = applyFinalAnswerGuardrails(answer, {
    errors: [],
    report,
    signals,
  });

  assert.match(guarded.answerMarkdown ?? "", /Mantle-native holder and transfer coverage/);
  assert.match(guarded.answerMarkdown ?? "", /not Mantle chain-level activity/);
  assert.match(guarded.answerMarkdown ?? "", /2026-05-20 to 2026-05-21/);
  assert.doesNotMatch(guarded.answerMarkdown ?? "", /Smart-money labels can be incomplete here/);
});
