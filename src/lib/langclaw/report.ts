import type {
  DiscoverSignals,
  ProviderError,
  ProviderTraceEntry,
  ResearchReport,
  ResearchReportConfidence,
  ResearchReportEntity,
  ResearchReportKind,
  ResearchReportSeverity,
  ResearchReportTable,
  SourceCard,
} from "./types";
import type {
  OnChainPlanSummary,
  OnChainToolFinalPayload,
  OnChainToolResult,
} from "../onchain-tools/types";
import { getDexScreenerChainId } from "../onchain-tools/chains";
import {
  isDirectProviderIssue,
  isUsableDirectProviderResult,
} from "../onchain-tools/evidence";

type BuildOnChainResearchReportInput = {
  answer?: string;
  caveat: string;
  generatedAt: string;
  plan: OnChainPlanSummary;
  recommendation: string;
  tools: OnChainToolResult[];
};

type BuildWorkflowResearchReportInput = {
  errors: ProviderError[];
  generatedAt: string;
  onChain?: OnChainToolFinalPayload;
  onChainSkippedReason?: string;
  providerTrace?: ProviderTraceEntry[];
  signals: DiscoverSignals;
  sources: SourceCard[];
  topic: string;
};

type NormalizedPair = {
  id: string;
  label: string;
  pairAddress?: string;
  reserveUsd?: number;
  volume24hUsd?: number;
  turnover24h?: number;
  priceChange24h?: number;
  txns24h?: number;
  toolId: string;
};

type NormalizedRow = {
  id: string;
  label: string;
  metrics: Record<string, string | number | null>;
  toolId: string;
};

type ResearchReportSection = ResearchReport["sections"][number];

type DefiProtocolAggregate = {
  key: string;
  label: string;
  labelSource: "protocol" | "yield";
  toolIds: Set<string>;
  protocolTvlUsd?: number;
  poolTvlUsdSum: number;
  bestApy?: number;
  apyPct1D?: number;
  apyPct7D?: number;
  tvlPct1D?: number;
  tvlPct7D?: number;
  poolCount: number;
};

type DefiProtocolRank = {
  id: string;
  label: string;
  coverage: "composite" | "context-only" | "tvl+apy";
  momentumScore?: number;
  poolCount: number;
  score: number;
  severity: ResearchReportSeverity;
  summary: string;
  toolIds: string[];
  tvlUsd?: number;
  bestApy?: number;
};

type TokenDiscoveryAggregate = {
  key: string;
  label?: string;
  tokenAddress?: string;
  boostAmount?: number;
  liquidityUsd?: number;
  volume24hUsd?: number;
  priceChange24h?: number;
  poolCount: number;
  bestFeedRank?: number;
  latestUpdatedAt?: number;
  hasBoost: boolean;
  hasPool: boolean;
  hasProfile: boolean;
  toolIds: Set<string>;
};

type TokenDiscoveryRank = {
  id: string;
  label: string;
  coverage: "boost+pool" | "multi-source" | "single-source";
  score: number;
  severity: ResearchReportSeverity;
  summary: string;
  toolIds: string[];
  tokenAddress?: string;
  boostAmount?: number;
  liquidityUsd?: number;
  volume24hUsd?: number;
  priceChange24h?: number;
  poolCount: number;
};

export function buildOnChainResearchReport(
  input: BuildOnChainResearchReportInput
): ResearchReport {
  const kind = inferOnChainReportKind(input.plan);

  if (kind === "liquidity-anomaly") {
    return buildLiquidityAnomalyReport(input);
  }

  if (kind === "smart-money") {
    return buildSmartMoneyReport(input);
  }

  if (kind === "defi-yield") {
    return buildDefiYieldReport(input);
  }

  if (kind === "token-discovery") {
    return buildTokenDiscoveryReport(input);
  }

  return buildMarketBriefReport(input);
}

export function buildWorkflowResearchReport(
  input: BuildWorkflowResearchReportInput
): ResearchReport {
  const baseOnChainReport = input.onChain?.report;
  const kind = inferWorkflowReportKind(input.topic, baseOnChainReport);
  const sourceCounts = summarizeSourceCounts(input.sources);
  const socialSentence = buildSocialEvidenceSentence(input.sources, sourceCounts);
  const onChainSentence = input.signals.onchain.summary;
  const combinedSentence = input.signals.combined.summary;
  const directMetricsAvailable = Boolean(
    baseOnChainReport?.entities.length || baseOnChainReport?.tables.length
  );
  const entities =
    kind === "mixed-research" && !directMetricsAvailable
      ? []
      : (baseOnChainReport?.entities ?? []);
  const tables =
    kind === "mixed-research" && !directMetricsAvailable
      ? []
      : (baseOnChainReport?.tables ?? []);
  const sections = [
    {
      id: "combined-view",
      title: "Combined View",
      markdown: combinedSentence,
      sourceIds: input.signals.combined.sourceIds,
      toolIds: input.signals.combined.toolIds,
    },
    {
      id: "social-view",
      title: "Social Context",
      markdown: socialSentence,
      sourceIds: input.signals.social.sourceIds,
      toolIds: input.signals.social.toolIds,
    },
    {
      id: "onchain-view",
      title: "On-chain View",
      markdown: onChainSentence,
      sourceIds: input.signals.onchain.sourceIds,
      toolIds: input.signals.onchain.toolIds,
    },
    ...(baseOnChainReport?.sections
      ?.filter(
        (section) =>
          section.id !== "signal-summary" &&
          section.id !== "conclusion" &&
          section.id !== "data-context"
      )
      .map((section) => ({
        ...section,
        title:
          kind === "mixed-research" ? `On-chain: ${section.title}` : section.title,
      })) ?? []),
    {
      id: "data-context",
      title: "Data Context",
      markdown: buildWorkflowDataContext({
        onChain: input.onChain,
        onChainSkippedReason: input.onChainSkippedReason,
        sourceCounts,
      }),
      sourceIds: input.sources.map((source) => source.id),
      toolIds: input.onChain?.tools.map((tool) => tool.commandId) ?? [],
    },
    {
      id: "conclusion",
      title: "Conclusion",
      markdown:
        directMetricsAvailable && baseOnChainReport?.kind === kind
          ? baseOnChainReport.bottomLine
          : buildWorkflowBottomLine(kind, input.signals, directMetricsAvailable),
      sourceIds: input.signals.combined.sourceIds,
      toolIds: input.signals.combined.toolIds,
    },
  ];
  const caveats = uniqueStrings([
    ...(baseOnChainReport?.caveats ?? []),
    ...buildWorkflowCaveats(input, kind),
  ]);
  const recommendations = uniqueStrings([
    ...(baseOnChainReport?.recommendations ?? []),
    buildWorkflowRecommendation(input.signals, kind),
  ]);

  return {
    kind,
    title: buildWorkflowReportTitle(kind, input.topic, input.onChain?.plan.chainName),
    asOfUtc: input.generatedAt,
    executiveSummary:
      directMetricsAvailable && baseOnChainReport?.kind === kind
        ? baseOnChainReport.executiveSummary
        : `${input.topic}: ${combinedSentence}`,
    bottomLine:
      directMetricsAvailable && baseOnChainReport?.kind === kind
        ? baseOnChainReport.bottomLine
        : buildWorkflowBottomLine(kind, input.signals, directMetricsAvailable),
    confidence: deriveWorkflowConfidence(input.signals, directMetricsAvailable),
    entities,
    tables,
    sections,
    caveats,
    recommendations,
  };
}

export function renderResearchReportMarkdown(report: ResearchReport) {
  const lines: string[] = [
    `# ${report.title}`,
    "",
    report.executiveSummary,
    "",
    `- Confidence: ${report.confidence}`,
    `- Report type: ${report.kind}`,
    `- As of: ${formatUtc(report.asOfUtc)}`,
  ];

  if (report.entities.length) {
    lines.push("", "## Ranked Entities", "");

    for (const entity of report.entities) {
      const metrics = formatMetrics(entity.metrics);
      lines.push(
        `- ${entity.rank}. ${entity.label} (${entity.severity})${entity.summary ? `: ${entity.summary}` : ""}${metrics ? ` Metrics: ${metrics}.` : ""}`
      );
    }
  }

  for (const table of report.tables) {
    lines.push("", `## ${table.title}`, "");

    if (table.description) {
      lines.push(table.description, "");
    }

    lines.push(renderMarkdownTable(table));
  }

  for (const section of report.sections) {
    lines.push("", `## ${section.title}`, "", section.markdown);
  }

  lines.push("", "## Bottom Line", "", report.bottomLine);

  if (report.recommendations.length) {
    lines.push("", "## Recommendations", "");
    for (const recommendation of report.recommendations) {
      lines.push(`- ${recommendation}`);
    }
  }

  if (report.caveats.length) {
    lines.push("", "## Caveats", "");
    for (const caveat of report.caveats) {
      lines.push(`- ${caveat}`);
    }
  }

  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

function buildLiquidityAnomalyReport(
  input: BuildOnChainResearchReportInput
): ResearchReport {
  const pairs = collectDexPairs(input.tools, input.plan.chain)
    .map((pair) => ({
      ...pair,
      severity: classifyLiquiditySeverity(pair),
    }))
    .sort(
      (left, right) =>
        compareSeverity(left.severity, right.severity) ||
        compareNumber(right.turnover24h, left.turnover24h) ||
        compareNumber(right.volume24hUsd, left.volume24hUsd)
    );
  const topPair = pairs[0];
  const entities: ResearchReportEntity[] = pairs.map((pair, index) => ({
    id: pair.id,
    label: pair.label,
    category: "dex-pair",
    rank: index + 1,
    severity: pair.severity,
    summary: describeLiquidityPair(pair),
    metrics: {
      pairAddress: pair.pairAddress ?? null,
      priceChange24h: roundNumber(pair.priceChange24h),
      reserveUsd: roundNumber(pair.reserveUsd),
      turnover24h: roundNumber(pair.turnover24h),
      txns24h: pair.txns24h ?? null,
      volume24hUsd: roundNumber(pair.volume24hUsd),
    },
    sourceIds: [],
    toolIds: [pair.toolId],
  }));
  const tables: ResearchReportTable[] = pairs.length
    ? [
        {
          id: "anomaly-table",
          title: "Anomaly Table",
          description:
            "Turnover is computed as 24h volume divided by current pool reserves when both fields are available.",
          columns: [
            "pair",
            "pool",
            "reserveUsd",
            "volume24hUsd",
            "turnover24h",
            "priceChange24h",
            "txns24h",
            "severity",
          ],
          rows: pairs.map((pair) => ({
            pair: pair.label,
            pool: pair.pairAddress ?? "Not available",
            priceChange24h: roundNumber(pair.priceChange24h),
            reserveUsd: roundNumber(pair.reserveUsd),
            severity: classifyLiquiditySeverity(pair),
            turnover24h: roundNumber(pair.turnover24h),
            txns24h: pair.txns24h ?? null,
            volume24hUsd: roundNumber(pair.volume24hUsd),
          })),
        },
      ]
    : [];
  const caveats = buildOnChainReportCaveats(input);

  return {
    kind: "liquidity-anomaly",
    title: `${input.plan.chainName} DEX Pairs - Liquidity Anomaly Screen`,
    asOfUtc: input.generatedAt,
    executiveSummary: topPair
      ? `This run returned a ranked pair shortlist from partial coverage for ${input.plan.chainName}. ${input.plan.chainName}'s clearest liquidity anomaly right now is ${topPair.label}, where the pool shows ${formatUsd(topPair.reserveUsd)} in reserves against ${formatUsd(topPair.volume24hUsd)} of 24h volume and a ${formatRatio(topPair.turnover24h)} turnover ratio.`
      : `${input.plan.chainName} liquidity anomaly screen ran, but this run did not return pair-level metrics strong enough for a ranked anomaly table.`,
    bottomLine: topPair
      ? `Prioritize ${topPair.label} for follow-up because it combines the strongest reserve, turnover, and price-move stress in this run.`
      : "Treat this as a narrative market brief until pair-level metrics are available.",
    confidence: pairs.length ? deriveOnChainConfidence(input.tools) : "insufficient",
    entities,
    tables,
    sections: [
      {
        id: "signal-summary",
        title: "Signal Summary",
        markdown: topPair
          ? `${topPair.label} is the primary anomaly in this run. ${describeLiquidityPair(topPair)}`
          : "No ranked pair-level anomaly could be produced from the current tool outputs.",
        sourceIds: [],
        toolIds: pairs.map((pair) => pair.toolId),
      },
      {
        id: "data-context",
        title: "Data Context",
        markdown:
          "This screen uses current pair reserve, 24h volume, price change, and transaction activity. It highlights liquidity stress and pool fragility, not confirmed LP add/remove flow.",
        sourceIds: [],
        toolIds: pairs.map((pair) => pair.toolId),
      },
      {
        id: "conclusion",
        title: "Conclusion",
        markdown: topPair
          ? `The current anomaly set is concentrated rather than broad. ${topPair.label} is the highest-priority follow-up pool in this run.`
          : "The run did not produce enough pair-level evidence for a strong liquidity anomaly conclusion.",
        sourceIds: [],
        toolIds: pairs.map((pair) => pair.toolId),
      },
    ],
    caveats,
    recommendations: [input.recommendation],
  };
}

function buildSmartMoneyReport(
  input: BuildOnChainResearchReportInput
): ResearchReport {
  const rows = collectStructuredRows(input.tools, (tool) => tool.domain === "smart_money");
  const entities: ResearchReportEntity[] = rows.map((row, index) => ({
    id: row.id,
    label: row.label,
    category: classifySmartMoneyReportRow(row),
    rank: index + 1,
    severity: classifySmartMoneyReportRow(row) === "large-flow-watchlist"
      ? "watch"
      : index === 0
        ? "high"
        : "medium",
    summary: summarizeSmartMoneyReportRow(row),
    metrics: row.metrics,
    sourceIds: [],
    toolIds: [row.toolId],
  }));
  const caveats = buildOnChainReportCaveats(input);
  const localOnly =
    !entities.length &&
    input.tools.some((tool) => tool.provider === "local" && tool.status === "success");
  const title = buildSmartMoneyReportTitle(input.plan, input.tools);
  const hasRows = entities.length > 0;
  const surfSummary = readSurfSmartMoneyText(input.tools, "summary");
  const surfBottomLine = readSurfSmartMoneyText(input.tools, "bottomLine");
  const surfSections = readSurfSmartMoneySections(input.tools);
  const confirmedEntities = entities.filter((entity) => entity.category === "confirmed-smart-money");
  const candidateEntities = entities.filter((entity) => entity.category === "candidate-smart-money");
  const watchlistEntities = entities.filter((entity) => entity.category === "large-flow-watchlist");
  const sellPressureEntities = entities.filter((entity) => entity.category === "sell-pressure-watchlist");
  const excludedEntities = entities.filter((entity) => entity.category === "excluded-address");
  const hasConfirmed = entities.some((entity) => entity.category === "confirmed-smart-money");
  const hasCandidate = entities.some((entity) => entity.category === "candidate-smart-money");
  const hasWatchlistOnly = entities.some((entity) => entity.category === "large-flow-watchlist") && !hasConfirmed && !hasCandidate;
  const accumulatorRows = rows.filter(isAccumulatorSmartMoneyRow);
  const smartMoneyTableTitle = hasWatchlistOnly
    ? "Large DEX-Buy Watchlist"
    : hasConfirmed
      ? "Confirmed and Candidate Smart-Money Wallets"
      : "Candidate Smart-Money Wallets";
  const smartMoneyLimits = buildSmartMoneyLimitsMarkdown({
    hasRows,
    plan: input.plan,
    rows,
    tools: input.tools,
  });
  const smartMoneySections = hasRows && surfSections.length
    ? applySmartMoneyContextualLimits(
        surfSections,
        smartMoneyLimits,
        input.tools.map((tool) => tool.commandId)
      )
    : [
        {
          id: "read",
          title: "Read",
          markdown: hasRows
            ? `Headline. ${input.plan.chainName} has smart-money accumulation rows. DEX-only rows are large-flow watchlist entries until labels, CEX flow, retention, and balance deltas are confirmed.`
            : `Headline. Smart-money signal is weak. The output stays ${localOnly ? "analysis-only" : "coverage-limited"} because direct wallet-flow rows are missing.`,
          sourceIds: [],
          toolIds: input.tools.map((tool) => tool.commandId),
        },
        {
          id: "evidence",
          title: "Evidence",
          markdown: hasRows
            ? `Evidence. Direct provider rows returned ${entities.length} wallet-flow row(s). The table uses only fields returned by the provider output and does not promote DEX-only rows to confirmed smart money.`
            : "Evidence. No ranked wallet table is emitted because Nansen and Dune-style row-level outputs were empty or unavailable. Social and context signals remain useful for research direction, but they are not direct wallet-flow proof.",
          sourceIds: [],
          toolIds: input.tools.map((tool) => tool.commandId),
        },
        {
          id: "confirmed-smart-money",
          title: "Confirmed smart money",
          markdown: confirmedEntities.length
            ? summarizeSmartMoneyCandidates(confirmedEntities)
            : "None. No row had enough label and retention evidence to mark it as confirmed smart money.",
          sourceIds: [],
          toolIds: confirmedEntities.flatMap((entity) => entity.toolIds),
        },
        {
          id: "candidate-smart-money",
          title: "Candidate smart money",
          markdown: candidateEntities.length
            ? summarizeSmartMoneyCandidates(candidateEntities)
            : "None. Rows need wallet labels plus retention, sell pressure, exchange-flow, or second-source checks before promotion.",
          sourceIds: [],
          toolIds: candidateEntities.flatMap((entity) => entity.toolIds),
        },
        {
          id: "large-flow-watchlist",
          title: "Large-flow watchlist",
          markdown: watchlistEntities.length
            ? summarizeSmartMoneyCandidates(watchlistEntities)
            : hasRows
              ? "No DEX-only large-flow rows were classified in this report."
              : "No wallet candidates are ranked. A ranked list needs direct wallet-flow metrics with enough wallet enrichment.",
          sourceIds: [],
          toolIds: watchlistEntities.flatMap((entity) => entity.toolIds),
        },
        ...(sellPressureEntities.length
          ? [
              {
                id: "cex-sell-pressure",
                title: "CEX sell pressure",
                markdown: summarizeSmartMoneyCandidates(sellPressureEntities),
                sourceIds: [],
                toolIds: sellPressureEntities.flatMap((entity) => entity.toolIds),
              },
            ]
          : []),
        {
          id: "excluded-addresses",
          title: "Excluded addresses",
          markdown: excludedEntities.length
            ? summarizeSmartMoneyCandidates(excludedEntities)
            : "None detected from available provider labels and heuristics.",
          sourceIds: [],
          toolIds: excludedEntities.flatMap((entity) => entity.toolIds),
        },
        {
          id: "limits",
          title: "Limits",
          markdown: smartMoneyLimits,
          sourceIds: [],
          toolIds: input.tools.map((tool) => tool.commandId),
        },
        {
          id: "data-source-diagnostics",
          title: "Data source diagnostics",
          markdown: buildSmartMoneyDataSourceDiagnostic(input.tools),
          sourceIds: [],
          toolIds: input.tools.map((tool) => tool.commandId),
        },
        {
          id: "follow-up-checks-performed",
          title: "Follow-up checks performed",
          markdown: hasRows
            ? "Parsed direct wallet-flow rows, checked available row fields for wallet labels and infrastructure hints, separated DEX-only rows from smart-money classifications, and preserved provider diagnostics."
            : "Checked provider outputs for direct wallet-flow rows. No standard wallet enrichment check could produce a ranking without row-level data.",
          sourceIds: [],
          toolIds: input.tools.map((tool) => tool.commandId),
        },
        {
          id: "checks-unavailable",
          title: "Checks unavailable",
          markdown: "Unavailable when providers do not return the fields: wallet label lookup, definitive contract or EOA status, wallet net worth, holder retention after buy, sell pressure after buy, exchange-flow matching, complete wallet history, and second-source validation.",
          sourceIds: [],
          toolIds: input.tools.map((tool) => tool.commandId),
        },
        {
          id: "conclusion",
          title: "Conclusion",
          markdown: hasRows
            ? "Confidence is limited unless wallet labels, retention, sell pressure, exchange-flow matching, and a second source are available. Use DEX-only rows as a monitor set."
            : "Confidence is low. Standard smart-money follow-up checks need row-level provider data before they can produce a wallet ranking.",
          sourceIds: [],
          toolIds: input.tools.map((tool) => tool.commandId),
        },
        {
          id: "what-would-improve-confidence",
          title: "What would improve confidence",
          markdown:
            "Confidence would improve with wallet labels, contract or EOA status, wallet net worth, retention after buy, sell pressure after buy, exchange-flow matching, repeated accumulation history, DeFi activity, and second-source validation.",
          sourceIds: [],
          toolIds: input.tools.map((tool) => tool.commandId),
        },
      ];

  return {
    kind: "smart-money",
    title,
    asOfUtc: input.generatedAt,
    executiveSummary: hasRows
      ? surfSummary ||
        `The clearest signal is ${accumulatorRows.length ? (hasWatchlistOnly ? "large DEX-buy flow" : "candidate smart-money flow") : "CEX sell-pressure flow"} on ${input.plan.chainName}. ${entities.length} direct row(s) are available, but DEX-only rows stay as watchlist entries until labels, retention, sell pressure, and second-source checks support a stronger classification.`
      : `Smart-money signal is still weak for ${input.plan.chainName}. Social and context signals can still guide directional research, but they do not create a wallet ranking by themselves.`,
    bottomLine: hasRows
      ? surfBottomLine ||
        "Confidence stays limited until wallet labels, holder retention, sell pressure, exchange-flow matching, wallet net worth, and a second on-chain source are available."
      : "Confidence is low because direct wallet-flow rows were unavailable. Standard follow-up checks were attempted where provider data existed, and unavailable checks are listed in the report.",
    confidence: hasRows ? deriveOnChainConfidence(input.tools) : "low",
    entities,
    tables: hasRows ? buildSmartMoneyTables(rows, accumulatorRows, smartMoneyTableTitle) : [],
    sections: smartMoneySections,
    caveats,
    recommendations: [input.recommendation],
  };
}

function buildSmartMoneyReportTitle(
  plan: OnChainPlanSummary,
  tools: OnChainToolResult[]
) {
  const target = readSurfSmartMoneyTarget(tools);
  const ticker = formatSmartMoneyTicker(
    shouldShowSmartMoneyTicker(plan, target) ? target.symbol : undefined
  );

  return ticker
    ? `${plan.chainName} (${ticker}) - Smart-Money Accumulation Watch`
    : `${plan.chainName} Smart-Money Accumulation Watch`;
}

function formatSmartMoneyTicker(symbol: string | undefined) {
  const normalized = symbol?.trim().replace(/^\$/, "");

  return normalized ? `$${normalized.toUpperCase()}` : undefined;
}

function shouldShowSmartMoneyTicker(
  plan: OnChainPlanSummary,
  target: ReturnType<typeof readSurfSmartMoneyTarget>
) {
  if (!target.symbol) {
    return false;
  }

  const query = `${plan.rawQuery ?? ""} ${plan.query ?? ""}`;
  const explicitTokenFocus =
    /\$[a-z0-9._-]{2,20}\b/i.test(query) ||
    /\b(?:for|of|token|coin|asset)\s+\$?[a-z0-9._-]{2,20}\b/i.test(query) ||
    /0x[a-f0-9]{40}/i.test(query);
  if (target.externalTokenSignal) {
    return explicitTokenFocus;
  }

  const broadTarget =
    target.mode === "broad-chain" || target.mode === "chain-default";

  return explicitTokenFocus || !broadTarget;
}

type SmartMoneyLimitsInput = {
  hasRows: boolean;
  plan: OnChainPlanSummary;
  rows: NormalizedRow[];
  tools: OnChainToolResult[];
};

function applySmartMoneyContextualLimits(
  sections: ResearchReportSection[],
  limitsMarkdown: string,
  toolIds: string[]
) {
  let replaced = false;
  const nextSections = sections.map((section) => {
    if (!/^limits$/i.test(section.title)) {
      return section;
    }

    replaced = true;
    return {
      ...section,
      id: "limits",
      markdown: limitsMarkdown,
      sourceIds: [],
      title: "Limits",
      toolIds,
    };
  });

  if (replaced) {
    return nextSections;
  }

  const conclusionIndex = nextSections.findIndex((section) =>
    /^conclusion$/i.test(section.title)
  );
  const limitsSection: ResearchReportSection = {
    id: "limits",
    markdown: limitsMarkdown,
    sourceIds: [],
    title: "Limits",
    toolIds,
  };

  if (conclusionIndex === -1) {
    return [...nextSections, limitsSection];
  }

  return [
    ...nextSections.slice(0, conclusionIndex),
    limitsSection,
    ...nextSections.slice(conclusionIndex),
  ];
}

function buildSmartMoneyLimitsMarkdown(input: SmartMoneyLimitsInput) {
  if (!input.hasRows) {
    return "Row-level coverage gap. Direct wallet-flow rows were unavailable, so there is no safe basis for wallet names, token-flow amounts, retention behavior, sell pressure, or a ranked accumulator table.";
  }

  const target = readSurfSmartMoneyTarget(input.tools);
  const requestedChainName =
    target.requestedChainName || input.plan.chainName;
  const sourceChainName =
    target.chainName ||
    firstSmartMoneyMetric(input.rows, "sourceChain") ||
    requestedChainName;
  const targetLabel = target.symbol
    ? `$${target.symbol}`
    : target.mode === "broad-chain"
      ? `${requestedChainName} token flow`
      : "token flow";
  const sourceChains = uniqueSmartMoneyMetrics(input.rows, "sourceChain");
  const sourceTables = uniqueSmartMoneyMetrics(input.rows, "sourceTable");
  const windows = uniqueSmartMoneyMetrics(input.rows, "window");
  const labelsUnavailable = input.rows.some((row) =>
    isUnavailableSmartMoneyMetric(row.metrics.walletLabel)
  );
  const missingChecks = summarizeUnavailableSmartMoneyChecks(input.rows);
  const classification = summarizeSmartMoneyClassification(input.rows);
  const sourceSurface = sourceChains.length
    ? `${joinReadableList(sourceChains)} ${describeSmartMoneySourceSurface(sourceTables)}`
    : `${sourceChainName} ${describeSmartMoneySourceSurface(sourceTables)}`;
  const sourceSuffix = sourceTables.length
    ? ` Source table: ${sourceTables.slice(0, 2).join(", ")}.`
    : "";
  const nativeGap = buildSmartMoneyNativeCoverageGap(target, requestedChainName);
  const externalScope = target.externalTokenSignal
    ? ` External token signal. The token rows came from ${sourceChainName}. They are low-confidence external context for ${requestedChainName}, not ${requestedChainName} chain-level activity.`
    : "";
  const tokenFocus = buildSmartMoneyTokenFocus(target, targetLabel);
  const windowText = windows.length
    ? `${joinReadableList(windows.slice(0, 3))}${windows.length > 3 ? `, plus ${windows.length - 3} more windows` : ""}`
    : "the returned provider window";
  const cexFlowSources = describeSmartMoneyCexFlowSources(sourceTables);
  const exchangeFlowContext = input.rows.some(isCexFlowRow)
    ? `It included CEX withdrawal or deposit matching from ${cexFlowSources}, but did not include complete holder balance deltas, wallet net worth, complete wallet history, or independent second-source validation.`
    : "It did not include complete holder balance deltas, exchange-flow matching, wallet net worth, complete wallet history, or independent second-source validation.";

  return [
    `Coverage gap. This scan used ${sourceSurface} for ${tokenFocus}.${sourceSuffix}${nativeGap ? ` ${nativeGap}` : ""}${externalScope} ${exchangeFlowContext}`,
    `Smart-money labeling gap. ${labelsUnavailable ? "The candidate wallets are mostly unlabeled in the returned rows." : "Wallet labels are only as complete as the returned provider fields."} A large DEX buy can still come from a router, market maker, OTC desk, CEX-related wallet, or internal operational wallet. The correct classification stays ${classification}, not confirmed smart-money accumulation.`,
    `Sample window. The ranking reflects ${windowText}, not a full long-term balance-delta study. Unavailable or incomplete checks: ${missingChecks}. Treat the table as a monitor set until labels and post-buy behavior support a stronger claim.`,
  ].join("\n\n");
}

function describeSmartMoneySourceSurface(sourceTables: string[]) {
  const hasDex = sourceTables.some((table) => /dex/i.test(table));
  const hasCex = sourceTables.some((table) => /cex/i.test(table));
  const hasHolderSnapshot = sourceTables.some((table) =>
    /blockvision|coin\/holders|holder/i.test(table)
  );

  if (hasDex && hasCex) {
    return "row-level DEX trade and CEX flow surfaces";
  }

  if (hasCex) {
    return "row-level CEX flow surface";
  }

  if (hasHolderSnapshot) {
    return "holder snapshot surface";
  }

  return "row-level DEX trade surface";
}

function describeSmartMoneyCexFlowSources(sourceTables: string[]) {
  const hasCexFlowTable = sourceTables.some((table) => /cex\.flows/i.test(table));
  const hasLabeledTransferTable = sourceTables.some((table) =>
    /tokens\.transfers|labels\.addresses|cex token transfers/i.test(table)
  );

  if (hasCexFlowTable && hasLabeledTransferTable) {
    return "Dune cex.flows rows and labeled Dune token transfers";
  }

  if (hasLabeledTransferTable) {
    return "labeled Dune token transfers";
  }

  if (hasCexFlowTable) {
    return "Dune cex.flows rows";
  }

  return "the returned CEX-labeled rows";
}

function readSurfSmartMoneyTarget(tools: OnChainToolResult[]) {
  for (const tool of tools) {
    if (tool.domain !== "smart_money" || tool.status !== "success") {
      continue;
    }

    const record = asRecord(tool.data);
    const target = asRecord(record?.target);

    if (!target) {
      continue;
    }

    return {
      chainName: readString(target.chainName),
      externalTokenSignal: target.externalTokenSignal === true,
      mode: readString(target.mode) || readString(target.resolution),
      requestedChainName: readString(target.requestedChainName),
      symbol: readString(target.symbol),
      tokenAddress: readString(target.tokenAddress),
      tokenAddressChainName: readString(target.tokenAddressChainName),
    };
  }

  return {};
}

function buildSmartMoneyTokenFocus(
  target: ReturnType<typeof readSurfSmartMoneyTarget>,
  fallbackLabel: string
) {
  if (target.tokenAddress) {
    const chain = target.tokenAddressChainName
      ? ` on ${target.tokenAddressChainName}`
      : "";
    const scope = target.externalTokenSignal && target.requestedChainName
      ? ` as external token context for ${target.requestedChainName}`
      : "";
    return `${target.symbol ? `$${target.symbol}` : fallbackLabel} contract ${target.tokenAddress}${chain}${scope}`;
  }

  if (target.mode === "broad-chain") {
    return `${fallbackLabel} as a chain-level scan`;
  }

  return fallbackLabel;
}

function buildSmartMoneyNativeCoverageGap(
  target: ReturnType<typeof readSurfSmartMoneyTarget>,
  chainName: string
) {
  if (
    !target.tokenAddress ||
    !target.tokenAddressChainName ||
    sameChainName(target.tokenAddressChainName, chainName)
  ) {
    return "";
  }

  return `${chainName}-native holder and transfer coverage was not confirmed by this row set.`;
}

function summarizeSmartMoneyClassification(rows: NormalizedRow[]) {
  const categories = uniqueStrings(
    rows.map((row) => humanizeSmartMoneyValue(formatCell(row.metrics.smartMoneyStatus)))
  );

  if (!categories.length) {
    return "large-flow watchlist or candidate status";
  }

  if (categories.length === 1) {
    return categories[0];
  }

  return joinReadableList(categories);
}

function summarizeUnavailableSmartMoneyChecks(rows: NormalizedRow[]) {
  const hasCexFlow = rows.some(isCexFlowRow);
  const checks = [
    ["wallet labels", rows.some((row) => isUnavailableSmartMoneyMetric(row.metrics.walletLabel))],
    ["contract or EOA status", rows.some((row) => isUnavailableSmartMoneyMetric(row.metrics.walletType))],
    ["wallet net worth", rows.some((row) => isUnavailableSmartMoneyMetric(row.metrics.walletNetWorth))],
    ["post-buy retention", rows.some((row) => isUnavailableSmartMoneyMetric(row.metrics.retentionAfterBuy))],
    ["post-buy sell pressure", rows.some((row) => isUnavailableSmartMoneyMetric(row.metrics.sellPressureAfterBuy))],
    ["exchange-flow matching", !hasCexFlow],
    ["complete wallet history", true],
    ["second-source validation", true],
  ]
    .filter(([, unavailable]) => unavailable)
    .map(([label]) => label as string);

  return joinReadableList(checks);
}

function uniqueSmartMoneyMetrics(rows: NormalizedRow[], key: string) {
  return uniqueStrings(rows.map((row) => formatSmartMoneyMetricForText(row.metrics[key])));
}

function firstSmartMoneyMetric(rows: NormalizedRow[], key: string) {
  return uniqueSmartMoneyMetrics(rows, key)[0];
}

function formatSmartMoneyMetricForText(value: string | number | null | undefined) {
  if (value == null || value === "") {
    return undefined;
  }

  return humanizeSmartMoneyValue(formatCell(value));
}

function isUnavailableSmartMoneyMetric(value: string | number | null | undefined) {
  if (value == null || value === "") {
    return true;
  }

  return /^unavailable|unknown|not available$/i.test(String(value).trim());
}

function sameChainName(left: string, right: string) {
  return left.trim().toLowerCase() === right.trim().toLowerCase();
}

function buildSmartMoneyDataSourceDiagnostic(tools: OnChainToolResult[]) {
  const rows = tools
    .filter((tool) => tool.domain === "smart_money")
    .map((tool) => {
      const status = tool.status === "success" && isUsableDirectProviderResult(tool)
        ? "usable rows"
        : tool.status === "success"
          ? "no usable rows"
          : "unavailable";
      const provider = providerLabel(tool.provider);
      const attempts = tool.attemptedProviders?.length
        ? tool.attemptedProviders.map(providerLabel).join(", ")
        : provider;
      const note = tool.status === "success" && isUsableDirectProviderResult(tool)
        ? "Rows parsed for ranking."
        : tool.status === "success"
          ? "No row-level wallet-flow rows returned."
          : "Source unavailable for this analysis.";

      return `| ${provider} | ${status} | ${attempts} | ${note} |`;
    });

  return [
    "| Provider | Status | Attempts | Notes |",
    "| --- | --- | --- | --- |",
    ...(rows.length
      ? rows
      : ["| on-chain provider | unavailable | n/a | No smart-money tool output was available. |"]),
  ].join("\n");
}

function joinReadableList(values: string[]) {
  if (values.length <= 2) {
    return values.join(" and ");
  }

  return `${values.slice(0, -1).join(", ")}, and ${values[values.length - 1]}`;
}

function summarizeSmartMoneyCandidates(entities: ResearchReportEntity[]) {
  const top = entities.slice(0, 3);
  const lines = top.map((entity, index) => {
    const metrics = formatSmartMoneyMetrics(entity.metrics);
    const rowLabel =
      entity.category === "large-flow-watchlist"
        ? "watchlist row"
        : entity.category === "confirmed-smart-money"
          ? "confirmed row"
          : "candidate";
    const prefix =
      index === 0
        ? `Best ${rowLabel}`
        : index === 1
          ? `Second ${rowLabel}`
          : `Third ${rowLabel}`;

    return metrics
      ? `${prefix}: ${entity.label}. Retrieved metrics: ${metrics}.`
      : `${prefix}: ${entity.label}.`;
  });

  if (entities.length > top.length) {
    lines.push(
      `${entities.length - top.length} more row(s) are available in the ranking table.`
    );
  }

  return lines.join("\n");
}

function formatSmartMoneyMetrics(metrics: Record<string, string | number | null>) {
  const metricPairs: Array<[string, string]> = [
    ["signal", "signal"],
    ["tokenSymbol", "token"],
    ["netToken", "amount"],
    ["netAmount", "amount"],
    ["amount", "amount"],
    ["netUsd", "USD value"],
    ["usd", "USD value"],
    ["balance", "balance"],
    ["percentageOfSupply", "supply share"],
    ["trades", "trades"],
    ["transfers", "transfers"],
    ["rank", "rank"],
    ["sourceCex", "CEX"],
    ["source_cex", "CEX"],
    ["window", "window"],
    ["tokenCategory", "category"],
    ["smartMoneyStatus", "status"],
  ];
  const seen = new Set<string>();
  const values: string[] = [];

  for (const [key, label] of metricPairs) {
    if (seen.has(label)) {
      continue;
    }

    const value = metrics[key];

    if (value == null || value === "") {
      continue;
    }

    values.push(`${label}: ${humanizeSmartMoneyValue(formatCell(value))}`);
    seen.add(label);
  }

  return values.join(", ");
}

function classifySmartMoneyReportRow(row: NormalizedRow) {
  const status = readString(row.metrics.smartMoneyStatus);
  const signal = readString(row.metrics.signal) ?? "";

  if (status === "sell_pressure_watchlist" || /cex deposit/i.test(signal)) {
    return "sell-pressure-watchlist";
  }

  if (status === "confirmed_smart_money") {
    return "confirmed-smart-money";
  }

  if (status === "candidate_smart_money") {
    return "candidate-smart-money";
  }

  if (status === "excluded_address") {
    return "excluded-address";
  }

  if (status === "large_flow_watchlist") {
    return "large-flow-watchlist";
  }

  const walletLabel = readString(row.metrics.walletLabel) ?? "";
  const retention = readString(row.metrics.retentionAfterBuy) ?? "";
  const sellPressure = readString(row.metrics.sellPressureAfterBuy) ?? "";
  const followUpCheck = retention || sellPressure;
  const hasWalletEvidence =
    walletLabel && !/^unavailable$/i.test(walletLabel) &&
    followUpCheck &&
    !/^unavailable$/i.test(followUpCheck);

  if (/dex buy/i.test(signal) && !hasWalletEvidence) {
    return "large-flow-watchlist";
  }

  if (/cex withdrawal/i.test(signal)) {
    return "candidate-smart-money";
  }

  return "candidate-smart-money";
}

function summarizeSmartMoneyReportRow(row: NormalizedRow) {
  const category = classifySmartMoneyReportRow(row);

  if (isHolderSnapshotRow(row)) {
    return category === "excluded-address"
      ? "Labeled holder snapshot row for an exchange, router, bridge, or other infrastructure address."
      : "Sui holder snapshot row. Treat it as a concentration watchlist entry until balance delta or trade-flow evidence confirms accumulation.";
  }

  if (category === "confirmed-smart-money") {
    return "Confirmed smart-money wallet-flow from provider labels and follow-up checks.";
  }

  if (category === "candidate-smart-money") {
    return "Candidate smart-money wallet-flow with partial enrichment.";
  }

  if (category === "excluded-address") {
    return "Excluded infrastructure, exchange, router, pool, bridge, or market-maker row.";
  }

  if (category === "sell-pressure-watchlist") {
    return "CEX deposit or exchange inflow row. This is sell-pressure context, not accumulation.";
  }

  if (/cex withdrawal/i.test(readString(row.metrics.signal) ?? "")) {
    return "CEX withdrawal signal. Candidate accumulation only until labels and retention support it.";
  }

  return "Large DEX-buy candidate. Not confirmed smart money without labels, retention, sell-pressure, and second-source checks.";
}

function readSurfSmartMoneyText(
  tools: OnChainToolResult[],
  key: "bottomLine" | "summary"
) {
  for (const tool of tools) {
    if (tool.provider !== "surf" || tool.status !== "success") {
      continue;
    }

    const record = asRecord(tool.data);
    const value = readString(record?.[key]);

    if (value) {
      return value;
    }
  }

  return undefined;
}

function readSurfSmartMoneySections(
  tools: OnChainToolResult[]
): ResearchReportSection[] {
  for (const tool of tools) {
    if (tool.provider !== "surf" || tool.status !== "success") {
      continue;
    }

    const sections: ResearchReportSection[] = [];

    for (const [index, item] of readArrayFromUnknown(
      tool.data,
      "sections"
    ).entries()) {
      const record = asRecord(item);
      const title = readString(record?.title);
      const markdown = readString(record?.markdown);

      if (!title || !markdown) {
        continue;
      }

      sections.push({
        id: normalizeSectionId(title, index),
        title: normalizeSmartMoneySectionTitle(title),
        markdown: sanitizeSmartMoneyMarkdown(markdown),
        sourceIds: [],
        toolIds: [tool.commandId],
      });
    }

    if (sections.length) {
      return sections;
    }
  }

  return [];
}

function normalizeSectionId(title: string, index: number) {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  return slug || `section-${index + 1}`;
}

function buildSmartMoneyTables(
  rows: NormalizedRow[],
  accumulatorRows: NormalizedRow[],
  smartMoneyTableTitle: string
) {
  const tables: ResearchReportTable[] = [];
  const holderRows = rows.filter(isHolderSnapshotRow);
  const flowRows = rows.filter((row) => !isHolderSnapshotRow(row));
  const flowAccumulatorRows = accumulatorRows.filter(
    (row) => !isHolderSnapshotRow(row)
  );
  const dexTable = buildDexAccumulationTable(flowRows.filter(isDexBuyRow));
  const cexWithdrawalTable = buildCexWithdrawalTable(
    flowRows.filter(isCexWithdrawalRow)
  );
  const cexDepositTable = buildCexDepositTable(flowRows.filter(isCexDepositRow));
  const cexAddressContextTable = buildCexAddressContextTable(
    flowRows.filter(isCexAddressContextRow)
  );
  const holderTable = buildSuiHolderSnapshotTable(holderRows);

  if (dexTable) {
    tables.push(dexTable);
  }

  if (cexWithdrawalTable) {
    tables.push(cexWithdrawalTable);
  }

  if (cexDepositTable) {
    tables.push(cexDepositTable);
  }

  if (cexAddressContextTable) {
    tables.push(cexAddressContextTable);
  }

  if (holderTable) {
    tables.push(holderTable);
  }

  if (flowAccumulatorRows.length) {
    tables.push(buildSmartMoneyTable(flowAccumulatorRows, smartMoneyTableTitle));
  }

  if (tables.length) {
    return tables;
  }

  return [buildSmartMoneyTable(rows, smartMoneyTableTitle)];
}

function buildDexAccumulationTable(rows: NormalizedRow[]) {
  if (!rows.length) {
    return undefined;
  }

  return {
    id: "dex-accumulation-table",
    title: "DEX Accumulation",
    description:
      "DEX rows are large-flow watchlist entries unless wallet labels, retention, sell pressure, and second-source validation support a stronger classification.",
    columns: ["Wallet", "Signal", "Token", "Net amount", "Net USD", "Trades", "Window"],
    rows: rows.map((row) => ({
      "Net USD": readSmartMoneyUsdMetric(row.metrics) || "Not available",
      "Net amount": readSmartMoneyAmountMetric(row.metrics) || "Not available",
      "Signal": humanizeSmartMoneyValue(readSmartMoneyMetric(row.metrics, "signal") || "DEX buy"),
      "Token": readSmartMoneyTokenMetric(row.metrics) || "Not available",
      "Trades": readSmartMoneyMetric(row.metrics, "trades") || "Not available",
      "Wallet": row.label,
      "Window": readSmartMoneyMetric(row.metrics, "window") || "Not available",
    })),
  };
}

function buildCexWithdrawalTable(rows: NormalizedRow[]) {
  if (!rows.length) {
    return undefined;
  }

  return {
    id: "cex-withdrawal-table",
    title: "CEX Withdrawal Candidates",
    description:
      "CEX withdrawals show tokens leaving identified exchange addresses toward recipient wallets. They are stronger accumulation context than DEX-only rows, but still need wallet identity and retention checks.",
    columns: cexCandidateColumns(),
    rows: buildCexCandidateRows(rows, "CEX withdrawal", "cex exchange outflow"),
  };
}

function buildCexDepositTable(rows: NormalizedRow[]) {
  if (!rows.length) {
    return undefined;
  }

  return {
    id: "cex-deposit-table",
    title: "CEX Deposit / Sell Pressure",
    description:
      "CEX deposits show tokens moving from wallets into identified exchange addresses. These rows are sell-pressure context, not accumulation candidates.",
    columns: cexCandidateColumns(),
    rows: buildCexCandidateRows(rows, "CEX deposit", "cex sell-pressure flow"),
  };
}

function buildCexAddressContextTable(rows: NormalizedRow[]) {
  if (!rows.length) {
    return undefined;
  }

  return {
    id: "cex-address-context-table",
    title: "Sui CEX Candidate Context",
    description:
      "CEX address labels show known exchange-controlled Sui addresses. This is label context, not withdrawal proof or accumulation by itself.",
    columns: cexCandidateColumns(),
    rows: buildCexCandidateRows(rows, "CEX address label", "CEX address context"),
  };
}

function cexCandidateColumns() {
  return [
    "Rank",
    "Wallet",
    "Token",
    "Flow type",
    "Amount",
    "USD value",
    "Category",
    "Time window",
  ];
}

function buildCexCandidateRows(
  rows: NormalizedRow[],
  fallbackFlowType: string,
  fallbackCategory: string
) {
  return rows.map((row, index) => ({
    "Amount": readSmartMoneyAmountMetric(row.metrics) || "Not available",
    "Category": buildCexCandidateCategory(row, fallbackCategory),
    "Flow type": buildCexFlowType(row, fallbackFlowType),
    "Rank": index + 1,
    "Time window": readSmartMoneyMetric(row.metrics, "window") || "Not available",
    "Token": readSmartMoneyTokenMetric(row.metrics) || "Not available",
    "USD value": readSmartMoneyUsdMetric(row.metrics) || "Not available",
    "Wallet": row.label,
  }));
}

function buildCexFlowType(row: NormalizedRow, fallback: string) {
  const signal = humanizeSmartMoneyValue(
    readSmartMoneyMetric(row.metrics, "signal") || fallback
  );
  const cexName = readCexName(row.metrics);

  if (!cexName) {
    return signal;
  }

  if (/withdrawal/i.test(signal)) {
    return `${signal} from ${cexName}`;
  }

  if (/deposit/i.test(signal)) {
    return `${signal} to ${cexName}`;
  }

  return `${signal} (${cexName})`;
}

function buildCexCandidateCategory(row: NormalizedRow, fallback: string) {
  const category = humanizeSmartMoneyValue(
    readSmartMoneyMetric(row.metrics, "tokenCategory") ||
    readSmartMoneyMetric(row.metrics, "category") ||
    fallback
  );
  const cexName = readCexName(row.metrics);

  return cexName && !category.toLowerCase().includes(cexName.toLowerCase())
    ? `${cexName} ${category}`
    : category;
}

function readCexName(metrics: Record<string, string | number | null>) {
  return readSmartMoneyMetric(metrics, "sourceCex") ||
    readSmartMoneyMetric(metrics, "source_cex") ||
    readSmartMoneyMetric(metrics, "cex") ||
    undefined;
}

function buildSuiHolderSnapshotTable(rows: NormalizedRow[]) {
  if (!rows.length) {
    return undefined;
  }

  return {
    id: "sui-holder-snapshot-table",
    title: "Sui Holder Snapshot",
    description:
      "BlockVision holder rows show current token concentration and labels. They are not DEX accumulation rows unless trade-flow or balance-delta evidence confirms accumulation.",
    columns: [
      "Wallet/Entity",
      "Token",
      "Balance",
      "Supply %",
      "Rank",
      "Label",
      "Status",
    ],
    rows: rows.map((row) => ({
      "Balance": readSmartMoneyMetric(row.metrics, "balance") ||
        readSmartMoneyAmountMetric(row.metrics) ||
        "Not available",
      "Label": readSmartMoneyMetric(row.metrics, "walletLabel") ||
        readSmartMoneyMetric(row.metrics, "label") ||
        "Unlabeled",
      "Rank": readSmartMoneyMetric(row.metrics, "rank") || "Not available",
      "Status": humanizeSmartMoneyValue(
        readSmartMoneyMetric(row.metrics, "smartMoneyStatus") ||
        readSmartMoneyMetric(row.metrics, "status") ||
        classifySmartMoneyReportRow(row)
      ),
      "Supply %": readSmartMoneyMetric(row.metrics, "percentageOfSupply") ||
        readSmartMoneyMetric(row.metrics, "percentage") ||
        "Not available",
      "Token": readSmartMoneyTokenMetric(row.metrics) || "Not available",
      "Wallet/Entity": row.label,
    })),
  };
}

function buildSmartMoneyTable(rows: NormalizedRow[], title: string) {
  const columns = [
    "Wallet",
    "Token",
    "Signal",
    "Amount",
    "USD value",
    "Trades",
    "Window",
    "Category",
    "Status",
  ];

  return {
    id: "smart-money-table",
    title,
    columns,
    rows: rows.map((row) => ({
      "Amount": readSmartMoneyMetric(row.metrics, "netToken") ||
        readSmartMoneyMetric(row.metrics, "netMnt") ||
        readSmartMoneyMetric(row.metrics, "netAmount") ||
        readSmartMoneyMetric(row.metrics, "amount") ||
        "Not available",
      "Category": humanizeSmartMoneyValue(
        readSmartMoneyMetric(row.metrics, "tokenCategory") ||
        readSmartMoneyMetric(row.metrics, "category") ||
        "Not available"
      ),
      "Signal": humanizeSmartMoneyValue(
        readSmartMoneyMetric(row.metrics, "signal") ||
        (readSmartMoneyMetric(row.metrics, "net_flow_7d_usd") ||
          readSmartMoneyMetric(row.metrics, "net_flow_30d_usd") ||
          readSmartMoneyMetric(row.metrics, "netFlowUsd")
          ? "Net flow"
          : "Not available")
      ),
      "Status": humanizeSmartMoneyValue(
        readSmartMoneyMetric(row.metrics, "smartMoneyStatus") ||
        readSmartMoneyMetric(row.metrics, "status") ||
        classifySmartMoneyReportRow(row)
      ),
      "Token": readSmartMoneyMetric(row.metrics, "tokenSymbol") ||
        readSmartMoneyMetric(row.metrics, "token") ||
        readSmartMoneyMetric(row.metrics, "symbol") ||
        "Not available",
      "Trades": readSmartMoneyMetric(row.metrics, "trades") ||
        readSmartMoneyMetric(row.metrics, "transfers") ||
        "Not available",
      "USD value": readSmartMoneyMetric(row.metrics, "netUsd") ||
        readSmartMoneyMetric(row.metrics, "usd") ||
        readSmartMoneyMetric(row.metrics, "usd_value") ||
        readSmartMoneyMetric(row.metrics, "usdValue") ||
        readSmartMoneyMetric(row.metrics, "amount_usd") ||
        readSmartMoneyMetric(row.metrics, "amountUsd") ||
        readSmartMoneyMetric(row.metrics, "net_flow_7d_usd") ||
        readSmartMoneyMetric(row.metrics, "net_flow_30d_usd") ||
        readSmartMoneyMetric(row.metrics, "netFlowUsd") ||
        "Not available",
      "Wallet": row.label,
      "Window": readSmartMoneyMetric(row.metrics, "window") || "Not available",
    })),
  };
}

function readSmartMoneyAmountMetric(metrics: Record<string, string | number | null>) {
  return readSmartMoneyMetric(metrics, "netToken") ||
    readSmartMoneyMetric(metrics, "netMnt") ||
    readSmartMoneyMetric(metrics, "netAmount") ||
    readSmartMoneyMetric(metrics, "amount");
}

function readSmartMoneyTokenMetric(metrics: Record<string, string | number | null>) {
  return readSmartMoneyMetric(metrics, "tokenSymbol") ||
    readSmartMoneyMetric(metrics, "token") ||
    readSmartMoneyMetric(metrics, "symbol");
}

function readSmartMoneyUsdMetric(metrics: Record<string, string | number | null>) {
  return readSmartMoneyMetric(metrics, "netUsd") ||
    readSmartMoneyMetric(metrics, "usd") ||
    readSmartMoneyMetric(metrics, "usd_value") ||
    readSmartMoneyMetric(metrics, "usdValue") ||
    readSmartMoneyMetric(metrics, "amount_usd") ||
    readSmartMoneyMetric(metrics, "amountUsd") ||
    readSmartMoneyMetric(metrics, "net_flow_7d_usd") ||
    readSmartMoneyMetric(metrics, "net_flow_30d_usd") ||
    readSmartMoneyMetric(metrics, "netFlowUsd");
}

function readSmartMoneyMetric(
  metrics: Record<string, string | number | null>,
  key: string
) {
  const value = metrics[key];

  if (value == null || value === "") {
    return "";
  }

  return formatCell(value);
}

function isAccumulatorSmartMoneyRow(row: NormalizedRow) {
  const category = classifySmartMoneyReportRow(row);

  return (
    !isHolderSnapshotRow(row) &&
    category !== "sell-pressure-watchlist" &&
    category !== "excluded-address"
  );
}

function isDexBuyRow(row: NormalizedRow) {
  return /dex buy/i.test(readString(row.metrics.signal) ?? "");
}

function isHolderSnapshotRow(row: NormalizedRow) {
  const sourceTable = readString(row.metrics.sourceTable) ?? "";
  const signal = readString(row.metrics.signal) ?? "";
  const diagnostic = readString(row.metrics.dataSourceDiagnostic) ?? "";
  const holderFlag = readString(row.metrics.holderSnapshot) ?? "";

  return (
    /^true$/i.test(holderFlag) ||
    /blockvision|coin\/holders|holder snapshot/i.test(sourceTable) ||
    /holder snapshot/i.test(diagnostic) ||
    /^(labeled holder|top holder)$/i.test(signal)
  );
}

function isCexWithdrawalRow(row: NormalizedRow) {
  return /cex withdrawal/i.test(readString(row.metrics.signal) ?? "");
}

function isCexDepositRow(row: NormalizedRow) {
  return /cex deposit/i.test(readString(row.metrics.signal) ?? "");
}

function isCexAddressContextRow(row: NormalizedRow) {
  const signal = readString(row.metrics.signal) ?? "";
  const sourceTable = readString(row.metrics.sourceTable) ?? "";

  return /cex address label/i.test(signal) || /cex\.addresses/i.test(sourceTable);
}

function isCexFlowRow(row: NormalizedRow) {
  return isCexWithdrawalRow(row) || isCexDepositRow(row);
}

function normalizeSmartMoneySectionTitle(title: string) {
  const normalized = title.trim().toLowerCase().replace(/[\s-]+/g, "_");
  const titles: Record<string, string> = {
    candidate_smart_money: "Candidate smart money",
    confirmed_smart_money: "Confirmed smart money",
    data_source_diagnostics: "Data source diagnostics",
    excluded_addresses: "Excluded addresses",
    large_flow_watchlist: "Large-flow watchlist",
    limitations: "Limits",
    sell_pressure_watchlist: "CEX sell pressure",
  };

  return titles[normalized] ?? title;
}

function sanitizeSmartMoneyMarkdown(markdown: string) {
  return humanizeSmartMoneyValue(markdown).replace(/\u2014/g, "-");
}

function humanizeSmartMoneyValue(value: string) {
  return value
    .replace(/\bconfirmed_smart_money\b/gi, "confirmed smart money")
    .replace(/\bcandidate_smart_money\b/gi, "candidate smart money")
    .replace(/\blarge_flow_watchlist\b/gi, "large-flow watchlist")
    .replace(/\blarge-flow-watchlist\b/gi, "large-flow watchlist")
    .replace(/\bexcluded_addresses\b/gi, "excluded addresses")
    .replace(/\bexcluded_address\b/gi, "excluded address")
    .replace(/\bsell_pressure_watchlist\b/gi, "sell-pressure watchlist")
    .replace(/\bsell-pressure-watchlist\b/gi, "sell-pressure watchlist")
    .replace(/\bdata_source_diagnostics\b/gi, "data source diagnostics")
    .replace(/\bnon-stable-token-accumulation\b/gi, "non-stable token accumulation")
    .replace(/\bstablecoin-dry-powder-flow\b/gi, "stablecoin dry-powder flow")
    .replace(/\bwrapped-major-asset-flow\b/gi, "wrapped major asset flow")
    .replace(/\bexcluded-infrastructure-flow\b/gi, "excluded infrastructure flow");
}

function buildDefiYieldReport(
  input: BuildOnChainResearchReportInput
): ResearchReport {
  const protocols = collectDefiProtocolRanks(
    input.tools,
    input.plan.chain,
    input.plan.chainName
  );
  const entities: ResearchReportEntity[] = protocols.map((protocol, index) => ({
    id: protocol.id,
    label: protocol.label,
    category: "defi-protocol",
    rank: index + 1,
    severity: protocol.severity,
    summary: protocol.summary,
    metrics: {
      score: roundNumber(protocol.score),
      tvlUsd: roundNumber(protocol.tvlUsd),
      bestApy: roundNumber(protocol.bestApy),
      momentumScore: roundNumber(protocol.momentumScore),
      poolCount: protocol.poolCount,
      coverage: protocol.coverage,
    },
    sourceIds: [],
    toolIds: protocol.toolIds,
  }));
  const topProtocol = protocols[0];
  const hasPartialCoverage = protocols.some(
    (protocol) => protocol.coverage !== "composite"
  );
  const coverageSummary = summarizeDefiCoverage(protocols);

  return {
    kind: "defi-yield",
    title: `${input.plan.chainName} Yield and TVL Brief`,
    asOfUtc: input.generatedAt,
    executiveSummary: topProtocol
      ? hasPartialCoverage
        ? `This run returned a ranked shortlist from partial coverage for ${input.plan.chainName}. ${describeDefiLeader(topProtocol)}`
        : `This run returned ${entities.length} ranked ${input.plan.chainName} protocols by TVL and yield momentum. ${describeDefiLeader(topProtocol)}`
      : `This run returned narrative DeFi context for ${input.plan.chainName}, but not enough row-level data for a ranked yield table.`,
    bottomLine: entities.length
      ? hasPartialCoverage
        ? `Use the ranked shortlist as best-effort ${input.plan.chainName} research, then confirm protocol risk, token mechanics, and missing momentum inputs manually.`
        : "Use the ranked yield rows as a shortlist, then confirm pool risk and token mechanics manually."
      : "Treat this as a narrative DeFi brief until direct pool rows are available.",
    confidence: entities.length ? deriveOnChainConfidence(input.tools) : "low",
    entities,
    tables: entities.length
      ? [
          {
            id: "yield-table",
            title: "Yield Ranking",
            description:
              `Score combines ${input.plan.chainName} TVL percentile, best APY percentile, and momentum when direct change fields are available. Protocol TVL falls back to summed ${input.plan.chainName} pool TVL when direct protocol TVL is missing.`,
            columns: [
              "rank",
              "protocol",
              "score",
              "tvlUsd",
              "bestApy",
              "momentumScore",
              "poolCount",
              "coverage",
            ],
            rows: entities.map((entity) => ({
              bestApy: entity.metrics.bestApy,
              coverage: entity.metrics.coverage,
              momentumScore: entity.metrics.momentumScore,
              poolCount: entity.metrics.poolCount,
              protocol: entity.label,
              rank: entity.rank,
              score: entity.metrics.score,
              tvlUsd: entity.metrics.tvlUsd,
            })),
          },
        ]
      : [],
    sections: [
      {
        id: "signal-summary",
        title: "Signal Summary",
        markdown: entities.length
          ? hasPartialCoverage
            ? `Ranked shortlist from partial coverage. ${coverageSummary}`
            : `Direct ${input.plan.chainName} protocol TVL and yield rows were aggregated into a composite-ranked shortlist. ${coverageSummary}`
          : "No direct yield pool table was emitted because the run lacked row-level metrics.",
        sourceIds: [],
        toolIds: input.tools.map((tool) => tool.commandId),
      },
      {
        id: "data-context",
        title: "Data Context",
        markdown:
          `Protocol scores combine ${input.plan.chainName} TVL percentile, best APY percentile, and momentum when direct change fields are available. When direct protocol TVL is missing, the report falls back to summed ${input.plan.chainName} pool TVL. When momentum fields are missing or coverage is incomplete, the shortlist degrades to TVL + APY or context-only instead of fabricating a stronger ranking.`,
        sourceIds: [],
        toolIds: input.tools.map((tool) => tool.commandId),
      },
      {
        id: "conclusion",
        title: "Conclusion",
        markdown: entities.length
          ? hasPartialCoverage
            ? "The current shortlist is usable for DeFi triage, but partial coverage means any claim about yield momentum still needs manual confirmation."
            : "The strongest-ranked protocols are usable for research triage, but they still need manual risk review."
          : "This DeFi run is useful for context only until pool-level rows are available.",
        sourceIds: [],
        toolIds: input.tools.map((tool) => tool.commandId),
      },
    ],
    caveats: buildOnChainReportCaveats(input),
    recommendations: [input.recommendation],
  };
}

function buildTokenDiscoveryReport(
  input: BuildOnChainResearchReportInput
): ResearchReport {
  const tokens = collectTokenDiscoveryRanks(input.tools, input.plan.chain);
  const entities: ResearchReportEntity[] = tokens.map((token, index) => ({
    id: token.id,
    label: token.label,
    category: "token",
    rank: index + 1,
    severity: token.severity,
    summary: token.summary,
    metrics: {
      score: roundNumber(token.score),
      tokenAddress: token.tokenAddress ?? null,
      boostAmount: roundNumber(token.boostAmount),
      liquidityUsd: roundNumber(token.liquidityUsd),
      volume24hUsd: roundNumber(token.volume24hUsd),
      priceChange24h: roundNumber(token.priceChange24h),
      poolCount: token.poolCount,
      coverage: token.coverage,
    },
    sourceIds: [],
    toolIds: token.toolIds,
  }));
  const topToken = tokens[0];
  const coverageSummary = summarizeTokenDiscoveryCoverage(tokens);

  return {
    kind: "token-discovery",
    title: `${input.plan.chainName} Token Discovery Brief`,
    asOfUtc: input.generatedAt,
    executiveSummary: topToken
      ? `This run returned a ranked on-chain shortlist from partial coverage for ${input.plan.chainName}. ${describeTokenDiscoveryLeader(topToken)}`
      : `This run returned token discovery context for ${input.plan.chainName}, but not enough chain-scoped token rows for a ranked shortlist.`,
    bottomLine: entities.length
      ? "Use the ranked on-chain token shortlist as best-effort research, then confirm liquidity, holders, token risk, and provider gaps manually."
      : "Treat this as narrative token discovery context until direct chain-scoped token rows are available.",
    confidence: entities.length ? deriveOnChainConfidence(input.tools) : "low",
    entities,
    tables: entities.length
      ? [
          {
            id: "token-discovery-table",
            title: "Token Discovery Ranking",
            description:
              "Score combines observed boost amount, pool liquidity or activity, provider feed rank, and profile recency when those direct fields are available. Rows are filtered to the requested analysis chain.",
            columns: [
              "rank",
              "token",
              "score",
              "tokenAddress",
              "boostAmount",
              "liquidityUsd",
              "volume24hUsd",
              "priceChange24h",
              "poolCount",
              "coverage",
            ],
            rows: entities.map((entity) => ({
              boostAmount: entity.metrics.boostAmount,
              coverage: entity.metrics.coverage,
              liquidityUsd: entity.metrics.liquidityUsd,
              poolCount: entity.metrics.poolCount,
              priceChange24h: entity.metrics.priceChange24h,
              rank: entity.rank,
              score: entity.metrics.score,
              token: entity.label,
              tokenAddress: entity.metrics.tokenAddress,
              volume24hUsd: entity.metrics.volume24hUsd,
            })),
          },
        ]
      : [],
    sections: [
      {
        id: "signal-summary",
        title: "Signal Summary",
        markdown: entities.length
          ? `Ranked on-chain shortlist from partial coverage. ${coverageSummary}`
          : "No ranked token table was emitted because direct chain-scoped token rows were incomplete.",
        sourceIds: [],
        toolIds: input.tools.map((tool) => tool.commandId),
      },
      {
        id: "data-context",
        title: "Data Context",
        markdown:
          "Token discovery rankings use only observed provider fields: DEX Screener boosts/profiles/search rows and GeckoTerminal trending/new pool rows. Global feeds are filtered to the requested analysis chain. Missing names, symbols, liquidity, or activity fields are left unavailable rather than inferred.",
        sourceIds: [],
        toolIds: input.tools.map((tool) => tool.commandId),
      },
      {
        id: "conclusion",
        title: "Conclusion",
        markdown: entities.length
          ? "The shortlist is usable for discovery triage, but partial provider coverage means each token still needs direct liquidity, holder, and contract-risk review."
          : "The run is informative but not enough for a token shortlist until chain-scoped token rows are available.",
        sourceIds: [],
        toolIds: input.tools.map((tool) => tool.commandId),
      },
    ],
    caveats: buildOnChainReportCaveats(input),
    recommendations: [input.recommendation],
  };
}

function buildMarketBriefReport(
  input: BuildOnChainResearchReportInput
): ResearchReport {
  const caveats = buildOnChainReportCaveats(input);

  return {
    kind: "market-brief",
    title: `${input.plan.chainName} Market Brief`,
    asOfUtc: input.generatedAt,
    executiveSummary:
      input.answer ||
      `This ${input.plan.chainName} market brief summarizes the direct and synthesized on-chain evidence returned in the current run.`,
    bottomLine:
      "Use this brief as a research summary, not as a substitute for direct manual verification.",
    confidence: deriveOnChainConfidence(input.tools),
    entities: [],
    tables: [],
    sections: [
      {
        id: "signal-summary",
        title: "Signal Summary",
        markdown: summarizeToolResults(input.tools),
        sourceIds: [],
        toolIds: input.tools.map((tool) => tool.commandId),
      },
      {
        id: "data-context",
        title: "Data Context",
        markdown:
          "This market brief stays narrative-first because the run did not return a compatible ranked-table data shape.",
        sourceIds: [],
        toolIds: input.tools.map((tool) => tool.commandId),
      },
      {
        id: "conclusion",
        title: "Conclusion",
        markdown:
          "The current output is suitable for contextual market monitoring, but not for quantitative ranking.",
        sourceIds: [],
        toolIds: input.tools.map((tool) => tool.commandId),
      },
    ],
    caveats,
    recommendations: [input.recommendation],
  };
}

function inferOnChainReportKind(plan: OnChainPlanSummary): ResearchReportKind {
  if (plan.intent === "smart-money") {
    return "smart-money";
  }

  if (plan.intent === "defi") {
    const text = [plan.rawQuery, plan.query].filter(Boolean).join(" ");
    const hasQuantitativeDefiText =
      /\b(apy|farm|momentum|pool|pools|protocol|protocols|rank|ranking|tvl|yield)\b/i.test(
        text
      );
    const hasDefiRankingTools = plan.commands.some(
      (command) =>
        command.domain === "yield_pools" ||
        command.commandId.startsWith("yield_pools.") ||
        command.commandId === "defi_tvl.defillama_protocols"
    );

    return hasQuantitativeDefiText || hasDefiRankingTools
      ? "defi-yield"
      : "market-brief";
  }

  if (plan.intent === "trading-signal") {
    return /\b(liquid\w*|anomal\w*|pair|pool|slippage|route)\b/i.test(
      [plan.rawQuery, plan.query].filter(Boolean).join(" ")
    )
      ? "liquidity-anomaly"
      : "market-brief";
  }

  if (
    plan.intent === "token-discovery" ||
    plan.commands.some((command) => command.domain === "token_discovery")
  ) {
    return "token-discovery";
  }

  return "market-brief";
}

function inferWorkflowReportKind(
  topic: string,
  baseOnChainReport?: ResearchReport
): ResearchReportKind {
  if (
    baseOnChainReport?.kind === "token-discovery" &&
    (baseOnChainReport.entities.length || baseOnChainReport.tables.length)
  ) {
    return "token-discovery";
  }

  if (/\bsmart[-\s]money|whale|accumulat\w*|holder flow\b/i.test(topic)) {
    return "smart-money";
  }

  if (/\b(liquid\w*|anomal\w*|pair|pool|slippage|route)\b/i.test(topic)) {
    return "liquidity-anomaly";
  }

  if (/\b(yield|apy|farm)\b/i.test(topic)) {
    return "defi-yield";
  }

  if (baseOnChainReport?.entities.length || baseOnChainReport?.tables.length) {
    return baseOnChainReport.kind;
  }

  return "mixed-research";
}

function buildWorkflowReportTitle(
  kind: ResearchReportKind,
  topic: string,
  chainName?: string
) {
  const prefix = chainName || "Langclaw";

  if (kind === "liquidity-anomaly") {
    return `${prefix} liquidity anomaly report`;
  }

  if (kind === "smart-money") {
    return `${prefix} smart money report`;
  }

  if (kind === "defi-yield") {
    return `${prefix} DeFi yield report`;
  }

  if (kind === "token-discovery") {
    return `${prefix} token discovery report`;
  }

  if (kind === "market-brief") {
    return `${prefix} market brief`;
  }

  return `${prefix} combined research report: ${topic}`;
}

function deriveOnChainConfidence(
  tools: OnChainToolResult[]
): ResearchReportConfidence {
  const directSuccesses = tools.filter(isUsableDirectProviderResult).length;
  const directFailures = tools.filter(isDirectProviderIssue).length;

  if (directSuccesses >= 3 && directFailures === 0) {
    return "high";
  }

  if (directSuccesses >= 2) {
    return "medium";
  }

  if (directSuccesses >= 1 || tools.some((tool) => tool.provider === "local" && tool.status === "success")) {
    return "low";
  }

  return "insufficient";
}

function deriveWorkflowConfidence(
  signals: DiscoverSignals,
  directMetricsAvailable: boolean
): ResearchReportConfidence {
  if (signals.combined.status === "success") {
    return directMetricsAvailable ? "high" : "medium";
  }

  if (signals.combined.status === "partial") {
    return directMetricsAvailable ? "medium" : "low";
  }

  if (signals.combined.status === "failed") {
    return "insufficient";
  }

  return "low";
}

function buildOnChainReportCaveats(
  input: BuildOnChainResearchReportInput
) {
  if (input.plan.intent === "smart-money") {
    const notes = [
      input.tools.some(isDirectProviderIssue)
        ? "Some wallet-level checks were unavailable, so classifications stay provisional."
        : undefined,
      "No transaction was signed or executed.",
    ];

    return uniqueStrings(notes.filter((note): note is string => Boolean(note)));
  }

  const notes = uniqueStrings([
    input.caveat,
    ...input.tools
      .filter(isDirectProviderIssue)
      .map((tool) => formatOnChainProviderIssue(tool)),
  ]);

  return notes.filter(Boolean);
}

function buildWorkflowCaveats(
  input: BuildWorkflowResearchReportInput,
  kind: ResearchReportKind
) {
  if (kind === "smart-money") {
    const hasSourceGap =
      input.errors.length > 0 ||
      input.signals.combined.status === "partial" ||
      (input.providerTrace ?? []).some((entry) => entry.status === "failed") ||
      Boolean(input.onChainSkippedReason);

    return hasSourceGap
      ? ["Some wallet-level checks were unavailable, so classifications stay provisional."]
      : [];
  }

  const sectionalCaveat =
    input.signals.combined.caveat ||
    [input.signals.social.caveat, input.signals.onchain.caveat]
      .filter(Boolean)
      .join(" ");

  const notes = [
    ...input.errors.map(
      (error) =>
        `${providerLabel(error.provider)} failed (${normalizeSentence(error.message)}).`
    ),
    ...(input.providerTrace ?? [])
      .filter((entry) => entry.status === "failed")
      .map((entry) => formatProviderTraceIssue(entry)),
    sectionalCaveat,
    input.onChainSkippedReason,
  ];

  return uniqueStrings(notes.filter(Boolean));
}

function formatOnChainProviderIssue(tool: OnChainToolResult) {
  if (tool.domain === "smart_money") {
    return `${providerLabel(tool.provider)} row-level wallet-flow coverage was unavailable.`;
  }

  return `${providerLabel(tool.provider)} failed (${normalizeSentence(tool.error || tool.summary)}).`;
}

function formatProviderTraceIssue(entry: ProviderTraceEntry) {
  if (/row-level smart-money|wallet-flow coverage/i.test(entry.message)) {
    return `${providerLabel(entry.provider)} row-level wallet-flow coverage was unavailable.`;
  }

  return `${providerLabel(entry.provider)} failed (${normalizeSentence(entry.message)}).`;
}

function buildWorkflowRecommendation(
  signals: DiscoverSignals,
  kind: ResearchReportKind
) {
  if (kind === "smart-money") {
    return "Use confirmed smart-money only when labels, retention, sell pressure, and second-source checks support it. Keep DEX-only rows in the large-flow watchlist.";
  }

  if (kind === "liquidity-anomaly") {
    return "Follow up on the top-ranked pair with holder, large-swap, and LP-change checks before escalating the anomaly.";
  }

  if (kind === "token-discovery") {
    return "Use the ranked token shortlist for discovery triage, then confirm liquidity, holders, and token risk with direct checks.";
  }

  if (signals.combined.status === "partial") {
    return "Use the current report as directional research and rerun once the failed providers are fixed or replaced.";
  }

  return "Use the report as a research starting point, then confirm the strongest signal manually before making a final claim.";
}

function buildWorkflowBottomLine(
  kind: ResearchReportKind,
  signals: DiscoverSignals,
  directMetricsAvailable: boolean
) {
  if (kind === "smart-money") {
    return directMetricsAvailable
      ? "Social and on-chain evidence can support a smart-money watchlist, but DEX-only rows are not confirmed smart money."
      : "Social and context signals can still guide directional research, but wallet-flow rows are needed before ranking accumulation wallets.";
  }

  if (kind === "liquidity-anomaly") {
    return directMetricsAvailable
      ? "The top-ranked pool is the best follow-up target, but this remains a pool-stress screen rather than a confirmed LP migration report."
      : "No direct pair-level table was available, so treat the anomaly brief as narrative-only.";
  }

  if (kind === "defi-yield") {
    return directMetricsAvailable
      ? "Use the ranked DeFi shortlist as best-effort research, then confirm protocol risk and missing momentum fields manually."
      : "No direct protocol-level ranking table was available, so treat the DeFi brief as narrative-only.";
  }

  if (kind === "token-discovery") {
    return directMetricsAvailable
      ? "Use the ranked on-chain token shortlist as best-effort research, then confirm liquidity, holders, and token risk manually."
      : "No direct chain-scoped token ranking table was available, so treat the discovery brief as narrative-only.";
  }

  if (signals.combined.status === "success") {
    return "The combined social and on-chain brief is usable, but it should still be reviewed manually before becoming a final market claim.";
  }

  if (signals.combined.status === "partial") {
    return "The combined brief is partial, so treat it as directional research rather than a verified conclusion.";
  }

  return "The current run did not produce a dependable combined view.";
}

function buildWorkflowDataContext({
  onChain,
  onChainSkippedReason,
  sourceCounts,
}: {
  onChain?: OnChainToolFinalPayload;
  onChainSkippedReason?: string;
  sourceCounts: Record<string, number>;
}) {
  const sourceText = Object.entries(sourceCounts)
    .filter(([, count]) => count > 0)
    .map(([provider, count]) => `${provider}: ${count}`)
    .join(", ");
  const onChainText = onChain
    ? `On-chain enrichment returned ${onChain.tools.length} tool result(s) on ${onChain.plan.chain}.`
    : onChainSkippedReason || "On-chain enrichment was not available for this run.";

  return [
    sourceText ? `Source coverage: ${sourceText}.` : "Source coverage was limited in this run.",
    onChainText,
    "Quantitative tables appear only when the current run includes direct row-level metrics from tools or providers.",
  ].join(" ");
}

function buildSocialEvidenceSentence(
  sources: SourceCard[],
  sourceCounts: Record<string, number>
) {
  if (!sources.length) {
    return "No source-backed social or public context evidence was collected in this run.";
  }

  const parts: string[] = [];

  if (sourceCounts.X) {
    parts.push(`${sourceCounts.X} X post(s)`);
  }

  if (sourceCounts.Surf) {
    parts.push(`${sourceCounts.Surf} Surf item(s)`);
  }

  if (sourceCounts.Docs) {
    parts.push(`${sourceCounts.Docs} docs/reference page(s)`);
  }

  if (sourceCounts.HackQuest) {
    parts.push(`${sourceCounts.HackQuest} HackQuest item(s)`);
  }

  if (sourceCounts.GitHub) {
    parts.push(`${sourceCounts.GitHub} GitHub repo or builder reference(s)`);
  }

  return `Social and public context evidence included ${parts.join(", ")}.`;
}

function summarizeSourceCounts(sources: SourceCard[]) {
  const counts: Record<string, number> = {
    Docs: 0,
    Elfa: 0,
    GitHub: 0,
    HackQuest: 0,
    Surf: 0,
    X: 0,
  };

  for (const source of sources) {
    if (source.provider === "Tavily") {
      counts.Docs += 1;
      continue;
    }

    if (source.provider === "HackQuest") {
      counts.HackQuest += 1;
      continue;
    }

    counts[source.provider] = (counts[source.provider] ?? 0) + 1;
  }

  return counts;
}

function collectDexPairs(tools: OnChainToolResult[], chain: string) {
  const pairs: NormalizedPair[] = [];
  const dexChainId = getDexScreenerChainId(chain).toLowerCase();

  for (const tool of tools) {
    if (tool.status !== "success") {
      continue;
    }

    if (tool.provider === "dexscreener") {
      for (const item of readArrayFromUnknown(tool.data, "pairs")) {
        const record = asRecord(item);

        if (!record) {
          continue;
        }

        const rowChainId = readString(record.chainId)?.toLowerCase();

        if (rowChainId && rowChainId !== dexChainId) {
          continue;
        }

        const baseSymbol = readNestedString(record, ["baseToken", "symbol"]);
        const quoteSymbol = readNestedString(record, ["quoteToken", "symbol"]);
        const reserveUsd = readNestedNumber(record, ["liquidity", "usd"]);
        const volume24hUsd = readNestedNumber(record, ["volume", "h24"]);
        const turnover24h =
          reserveUsd && volume24hUsd ? volume24hUsd / reserveUsd : undefined;
        const priceChange24h = readNestedNumber(record, ["priceChange", "h24"]);
        const buys = readNestedNumber(record, ["txns", "h24", "buys"]) ?? 0;
        const sells = readNestedNumber(record, ["txns", "h24", "sells"]) ?? 0;
        const pairAddress = readString(record.pairAddress);

        pairs.push({
          id: pairAddress || `${baseSymbol}-${quoteSymbol}-${tool.commandId}`,
          label: [baseSymbol || "Unknown", quoteSymbol || "Unknown"].join(" / "),
          pairAddress,
          priceChange24h,
          reserveUsd,
          toolId: tool.commandId,
          turnover24h,
          txns24h: buys + sells || undefined,
          volume24hUsd,
        });
      }
    }

    if (tool.provider === "geckoterminal") {
      const candidates = [
        ...readArrayFromUnknown(tool.data, "data"),
        ...readArrayFromUnknown(tool.data, "attributes.top_pools"),
      ];
      const root = asRecord(tool.data);

      if (root && !candidates.length && root.data) {
        candidates.push(root.data);
      }

      for (const item of candidates) {
        const record = asRecord(item);

        if (!record) {
          continue;
        }

        const networkId = readString(record.id)?.split("_")[0]?.toLowerCase();

        if (networkId && networkId !== dexChainId) {
          continue;
        }

        const attributes = asRecord(record.attributes) ?? record;
        const label =
          readString(attributes.name) ||
          [readString(attributes.base_token_symbol), readString(attributes.quote_token_symbol)]
            .filter(Boolean)
            .join(" / ") ||
          "Unknown / Unknown";
        const pairAddress =
          extractTrailingAddress(readString(record.id)) ||
          readString(attributes.address);
        const reserveUsd =
          readNestedNumber(attributes, ["reserve_in_usd"]) ??
          readNestedNumber(attributes, ["reserve_usd"]);
        const volume24hUsd =
          readNestedNumber(attributes, ["volume_usd", "h24"]) ??
          readNestedNumber(attributes, ["volume_usd", "24h"]) ??
          readNestedNumber(attributes, ["volume_usd"]);
        const turnover24h =
          reserveUsd && volume24hUsd ? volume24hUsd / reserveUsd : undefined;
        const priceChange24h =
          readNestedNumber(attributes, ["price_change_percentage", "h24"]) ??
          readNestedNumber(attributes, ["price_change_24h"]);
        const buys =
          readNestedNumber(attributes, ["transactions", "h24", "buys"]) ?? 0;
        const sells =
          readNestedNumber(attributes, ["transactions", "h24", "sells"]) ?? 0;

        pairs.push({
          id: pairAddress || `${label}-${tool.commandId}`,
          label,
          pairAddress,
          priceChange24h,
          reserveUsd,
          toolId: tool.commandId,
          turnover24h,
          txns24h: buys + sells || undefined,
          volume24hUsd,
        });
      }
    }
  }

  return pairs;
}

function collectStructuredRows(
  tools: OnChainToolResult[],
  predicate: (tool: OnChainToolResult) => boolean
) {
  const rows: NormalizedRow[] = [];

  for (const tool of tools) {
    if (tool.status !== "success" || tool.provider === "local" || !predicate(tool)) {
      continue;
    }

    const candidates = [
      ...readArrayFromUnknown(tool.data, "rows"),
      ...readArrayFromUnknown(tool.data, "data"),
      ...readArrayFromUnknown(tool.data, "result.rows"),
      ...readArrayFromUnknown(tool.data, "results"),
      ...readArrayFromUnknown(tool.data, "items"),
    ];

    for (const item of candidates) {
      const record = asRecord(item);

      if (!record) {
        continue;
      }

      if (tool.domain === "smart_money" && !isSmartMoneyReportRow(record)) {
        continue;
      }

      const label =
        tool.domain === "smart_money"
          ? readString(record.wallet) ||
            readString(record.walletAddress) ||
            readString(record.address) ||
            readString(record.account) ||
            readString(record.owner) ||
            readString(record.from) ||
            readString(record.to) ||
            readString(record.label) ||
            tool.title
          : readString(record.symbol) ||
            readString(record.name) ||
            readString(record.label) ||
            readString(record.wallet) ||
            readString(record.address) ||
            readString(record.token) ||
            tool.title;
      const metrics = normalizeMetrics(record);

      rows.push({
        id: readString(record.id) || readString(record.address) || `${tool.commandId}-${rows.length + 1}`,
        label,
        metrics,
        toolId: tool.commandId,
      });
    }
  }

  const rowLimit = rows.some(isSmartMoneyLikeRow)
    ? 80
    : 12;

  return dedupeRows(rows).slice(0, rowLimit);
}

function isSmartMoneyLikeRow(row: NormalizedRow) {
  const signal = readString(row.metrics.signal) ?? "";
  const sourceTable = readString(row.metrics.sourceTable) ?? "";

  return (
    row.toolId.startsWith("smart_money.") ||
    row.toolId === "dune.sui_accumulation_flow" ||
    row.toolId === "nansen.smart_money_netflow" ||
    Boolean(readString(row.metrics.smartMoneyStatus)) ||
    /^(dex buy|cex withdrawal|cex deposit|cex address label|labeled holder|top holder)$/i.test(signal) ||
    /dex_sui|tokens_sui|cex\.addresses|holder snapshot|coin\/holders/i.test(sourceTable)
  );
}

function isSmartMoneyReportRow(record: Record<string, unknown>) {
  const wallet =
    readString(record.wallet) ||
    readString(record.walletAddress) ||
    readString(record.address) ||
    readString(record.account) ||
    readString(record.owner) ||
    readString(record.from) ||
    readString(record.to) ||
    readString(record.label);

  if (!wallet) {
    return false;
  }

  const metricKeys = [
    "amount",
    "balance",
    "netAmount",
    "net_flow_7d_usd",
    "net_flow_30d_usd",
    "netFlowUsd",
    "netMnt",
    "netToken",
    "netTokenRaw",
    "netUsd",
    "normalizedTokenAmount",
    "signal",
    "tokenFlow",
    "trades",
    "transfers",
    "txHash",
    "usd",
    "value",
    "window",
  ];

  return metricKeys.some((key) => hasReportRowValue(record[key]));
}

function hasReportRowValue(value: unknown) {
  if (value === null || value === undefined) {
    return false;
  }

  if (Array.isArray(value)) {
    return value.length > 0;
  }

  if (typeof value === "object") {
    return Object.keys(value).length > 0;
  }

  return String(value).trim().length > 0;
}

function collectYieldRows(tools: OnChainToolResult[]) {
  const rows = collectStructuredRows(
    tools,
    (tool) => tool.domain === "yield_pools" || tool.domain === "defi_tvl"
  );

  return rows.sort((left, right) => compareNumber(readMetricNumber(right.metrics, "apy"), readMetricNumber(left.metrics, "apy")) || compareNumber(readMetricNumber(right.metrics, "tvlUsd"), readMetricNumber(left.metrics, "tvlUsd")));
}

function collectTokenDiscoveryRanks(
  tools: OnChainToolResult[],
  chain: string
) {
  const aggregates = new Map<string, TokenDiscoveryAggregate>();
  const dexChainId = getDexScreenerChainId(chain).toLowerCase();

  for (const tool of tools) {
    if (
      tool.status !== "success" ||
      tool.provider === "local" ||
      tool.domain !== "token_discovery"
    ) {
      continue;
    }

    const records = readDiscoveryRecords(tool.data);

    records.forEach((record, index) => {
      if (tool.provider === "dexscreener") {
        collectDexScreenerTokenRecord({
          aggregates,
          dexChainId,
          feedRank: index + 1,
          record,
          toolId: tool.commandId,
        });
        return;
      }

      if (tool.provider === "geckoterminal") {
        collectGeckoTerminalTokenRecord({
          aggregates,
          dexChainId,
          feedRank: index + 1,
          record,
          toolId: tool.commandId,
        });
      }
    });
  }

  return scoreTokenDiscoveryAggregates(Array.from(aggregates.values()));
}

function collectDexScreenerTokenRecord({
  aggregates,
  dexChainId,
  feedRank,
  record,
  toolId,
}: {
  aggregates: Map<string, TokenDiscoveryAggregate>;
  dexChainId: string;
  feedRank: number;
  record: Record<string, unknown>;
  toolId: string;
}) {
  const rowChainId = readString(record.chainId)?.toLowerCase();

  if (rowChainId !== dexChainId) {
    return;
  }

  const tokenAddress =
    readNestedString(record, ["baseToken", "address"]) ||
    readString(record.tokenAddress);
  const key = buildTokenDiscoveryKey(dexChainId, tokenAddress, record, toolId, feedRank);
  const aggregate = getOrCreateTokenDiscoveryAggregate(aggregates, key, tokenAddress);
  const label =
    readString(record.symbol) ||
    readString(record.name) ||
    readNestedString(record, ["baseToken", "symbol"]) ||
    readNestedString(record, ["baseToken", "name"]);
  const boostAmount = readNumberField(record, [
    "totalAmount",
    "amount",
    "boostAmount",
  ]);
  const liquidityUsd = readNestedNumber(record, ["liquidity", "usd"]);
  const volume24hUsd = readNestedNumber(record, ["volume", "h24"]);
  const priceChange24h = readNestedNumber(record, ["priceChange", "h24"]);
  const updatedAt = readTimestamp(record.updatedAt);
  const hasPoolMetrics =
    liquidityUsd !== undefined ||
    volume24hUsd !== undefined ||
    priceChange24h !== undefined ||
    Boolean(readString(record.pairAddress));

  updateTokenDiscoveryAggregate(aggregate, {
    boostAmount,
    feedRank,
    hasBoost: toolId.includes("boost") || boostAmount !== undefined,
    hasPool: hasPoolMetrics,
    hasProfile: toolId.includes("profile"),
    label,
    liquidityUsd,
    priceChange24h,
    toolId,
    updatedAt,
    volume24hUsd,
  });
}

function collectGeckoTerminalTokenRecord({
  aggregates,
  dexChainId,
  feedRank,
  record,
  toolId,
}: {
  aggregates: Map<string, TokenDiscoveryAggregate>;
  dexChainId: string;
  feedRank: number;
  record: Record<string, unknown>;
  toolId: string;
}) {
  const networkId = readString(record.id)?.split("_")[0]?.toLowerCase();

  if (networkId && networkId !== dexChainId) {
    return;
  }

  const attributes = asRecord(record.attributes) ?? record;
  const tokenAddress = readGeckoTokenAddress(record, attributes);
  const key = buildTokenDiscoveryKey(dexChainId, tokenAddress, record, toolId, feedRank);
  const aggregate = getOrCreateTokenDiscoveryAggregate(aggregates, key, tokenAddress);
  const label =
    readString(attributes.base_token_symbol) ||
    readNestedString(record, ["base_token", "symbol"]) ||
    readString(attributes.name);
  const liquidityUsd =
    readNestedNumber(attributes, ["reserve_in_usd"]) ??
    readNestedNumber(attributes, ["reserve_usd"]);
  const volume24hUsd =
    readNestedNumber(attributes, ["volume_usd", "h24"]) ??
    readNestedNumber(attributes, ["volume_usd", "24h"]) ??
    readNestedNumber(attributes, ["volume_usd"]);
  const priceChange24h =
    readNestedNumber(attributes, ["price_change_percentage", "h24"]) ??
    readNestedNumber(attributes, ["price_change_24h"]);

  updateTokenDiscoveryAggregate(aggregate, {
    feedRank,
    hasPool: true,
    label,
    liquidityUsd,
    priceChange24h,
    toolId,
    volume24hUsd,
  });
}

function readDiscoveryRecords(value: unknown) {
  const candidates = [
    ...(Array.isArray(value) ? value : []),
    ...readArrayFromUnknown(value, "pairs"),
    ...readArrayFromUnknown(value, "data"),
    ...readArrayFromUnknown(value, "results"),
    ...readArrayFromUnknown(value, "items"),
    ...readArrayFromUnknown(value, "attributes.top_pools"),
  ];

  return candidates
    .map((item) => asRecord(item))
    .filter((item): item is Record<string, unknown> => Boolean(item));
}

function buildTokenDiscoveryKey(
  chain: string,
  tokenAddress: string | undefined,
  record: Record<string, unknown>,
  toolId: string,
  feedRank: number
) {
  const fallback =
    readString(record.id) ||
    readString(record.url) ||
    readString(record.pairAddress) ||
    `${toolId}-${feedRank}`;

  return `${chain}:${(tokenAddress || fallback).toLowerCase()}`;
}

function getOrCreateTokenDiscoveryAggregate(
  aggregates: Map<string, TokenDiscoveryAggregate>,
  key: string,
  tokenAddress?: string
) {
  const existing = aggregates.get(key);

  if (existing) {
    if (!existing.tokenAddress && tokenAddress) {
      existing.tokenAddress = tokenAddress;
    }

    return existing;
  }

  const aggregate: TokenDiscoveryAggregate = {
    key,
    tokenAddress,
    hasBoost: false,
    hasPool: false,
    hasProfile: false,
    poolCount: 0,
    toolIds: new Set<string>(),
  };
  aggregates.set(key, aggregate);

  return aggregate;
}

function updateTokenDiscoveryAggregate(
  aggregate: TokenDiscoveryAggregate,
  update: {
    boostAmount?: number;
    feedRank: number;
    hasBoost?: boolean;
    hasPool?: boolean;
    hasProfile?: boolean;
    label?: string;
    liquidityUsd?: number;
    priceChange24h?: number;
    toolId: string;
    updatedAt?: number;
    volume24hUsd?: number;
  }
) {
  if (update.label && shouldReplaceTokenLabel(aggregate.label, aggregate.tokenAddress)) {
    aggregate.label = normalizeTokenLabel(update.label);
  }

  if (update.boostAmount !== undefined) {
    aggregate.boostAmount = Math.max(aggregate.boostAmount ?? 0, update.boostAmount);
  }

  if (update.liquidityUsd !== undefined) {
    aggregate.liquidityUsd = Math.max(aggregate.liquidityUsd ?? 0, update.liquidityUsd);
  }

  if (update.volume24hUsd !== undefined) {
    aggregate.volume24hUsd = Math.max(aggregate.volume24hUsd ?? 0, update.volume24hUsd);
  }

  if (
    update.priceChange24h !== undefined &&
    (aggregate.priceChange24h === undefined ||
      Math.abs(update.priceChange24h) > Math.abs(aggregate.priceChange24h))
  ) {
    aggregate.priceChange24h = update.priceChange24h;
  }

  if (update.hasPool) {
    aggregate.hasPool = true;
    aggregate.poolCount += 1;
  }

  aggregate.hasBoost = aggregate.hasBoost || Boolean(update.hasBoost);
  aggregate.hasProfile = aggregate.hasProfile || Boolean(update.hasProfile);
  aggregate.bestFeedRank =
    aggregate.bestFeedRank === undefined
      ? update.feedRank
      : Math.min(aggregate.bestFeedRank, update.feedRank);
  aggregate.latestUpdatedAt =
    update.updatedAt === undefined
      ? aggregate.latestUpdatedAt
      : Math.max(aggregate.latestUpdatedAt ?? 0, update.updatedAt);
  aggregate.toolIds.add(update.toolId);
}

function scoreTokenDiscoveryAggregates(
  aggregates: TokenDiscoveryAggregate[]
) {
  const enriched = aggregates.filter(
    (aggregate) =>
      aggregate.tokenAddress ||
      aggregate.label ||
      aggregate.boostAmount !== undefined ||
      aggregate.poolCount > 0
  );
  const boostValues = enriched
    .map((item) => item.boostAmount)
    .filter((value): value is number => value !== undefined);
  const liquidityValues = enriched
    .map((item) => logMetric(item.liquidityUsd))
    .filter((value): value is number => value !== undefined);
  const volumeValues = enriched
    .map((item) => logMetric(item.volume24hUsd))
    .filter((value): value is number => value !== undefined);
  const priceMoveValues = enriched
    .map((item) =>
      item.priceChange24h === undefined ? undefined : Math.abs(item.priceChange24h)
    )
    .filter((value): value is number => value !== undefined);
  const feedRankValues = enriched
    .map((item) =>
      item.bestFeedRank === undefined ? undefined : -item.bestFeedRank
    )
    .filter((value): value is number => value !== undefined);
  const recencyValues = enriched
    .map((item) => item.latestUpdatedAt)
    .filter((value): value is number => value !== undefined);

  return enriched
    .map((aggregate) => {
      const boostScore =
        aggregate.boostAmount === undefined
          ? undefined
          : percentileRank(boostValues, aggregate.boostAmount);
      const poolScore = weightedAverage([
        {
          value:
            aggregate.liquidityUsd === undefined
              ? undefined
              : percentileRank(liquidityValues, logMetric(aggregate.liquidityUsd) ?? 0),
          weight: 0.45,
        },
        {
          value:
            aggregate.volume24hUsd === undefined
              ? undefined
              : percentileRank(volumeValues, logMetric(aggregate.volume24hUsd) ?? 0),
          weight: 0.35,
        },
        {
          value:
            aggregate.priceChange24h === undefined
              ? undefined
              : percentileRank(priceMoveValues, Math.abs(aggregate.priceChange24h)),
          weight: 0.2,
        },
      ]);
      const sourceRankScore =
        aggregate.bestFeedRank === undefined
          ? undefined
          : percentileRank(feedRankValues, -aggregate.bestFeedRank);
      const recencyScore =
        aggregate.latestUpdatedAt === undefined
          ? undefined
          : percentileRank(recencyValues, aggregate.latestUpdatedAt);
      const score =
        weightedAverage([
          { value: boostScore, weight: 0.35 },
          { value: poolScore, weight: 0.35 },
          { value: sourceRankScore, weight: 0.2 },
          { value: recencyScore, weight: 0.1 },
        ]) ?? 0;
      const coverage = determineTokenDiscoveryCoverage(aggregate);
      const label = aggregate.label || shortTokenAddress(aggregate.tokenAddress);

      return {
        boostAmount: aggregate.boostAmount,
        coverage,
        id: aggregate.key,
        label,
        liquidityUsd: aggregate.liquidityUsd,
        poolCount: aggregate.poolCount,
        priceChange24h: aggregate.priceChange24h,
        score,
        severity: severityForTokenCoverage(coverage),
        summary: describeTokenDiscoveryCandidate({
          aggregate,
          coverage,
        }),
        tokenAddress: aggregate.tokenAddress,
        toolIds: Array.from(aggregate.toolIds),
        volume24hUsd: aggregate.volume24hUsd,
      } satisfies TokenDiscoveryRank;
    })
    .sort(
      (left, right) =>
        compareNumber(right.score, left.score) ||
        compareNumber(right.boostAmount, left.boostAmount) ||
        compareNumber(right.liquidityUsd, left.liquidityUsd) ||
        left.label.localeCompare(right.label)
    )
    .slice(0, 12);
}

function determineTokenDiscoveryCoverage(
  aggregate: TokenDiscoveryAggregate
): TokenDiscoveryRank["coverage"] {
  if (aggregate.hasBoost && aggregate.hasPool) {
    return "boost+pool";
  }

  const sourceCount = [
    aggregate.hasBoost,
    aggregate.hasPool,
    aggregate.hasProfile,
  ].filter(Boolean).length;

  if (sourceCount >= 2 || aggregate.toolIds.size >= 2) {
    return "multi-source";
  }

  return "single-source";
}

function severityForTokenCoverage(coverage: TokenDiscoveryRank["coverage"]) {
  if (coverage === "boost+pool") {
    return "high";
  }

  if (coverage === "multi-source") {
    return "medium";
  }

  return "watch";
}

function collectDefiProtocolRanks(
  tools: OnChainToolResult[],
  chain: string,
  chainName: string
) {
  const normalizedChain = chain.toLowerCase();
  const aggregates = new Map<string, DefiProtocolAggregate>();

  for (const tool of tools) {
    if (
      tool.status !== "success" ||
      tool.provider === "local" ||
      (tool.domain !== "defi_tvl" && tool.domain !== "yield_pools")
    ) {
      continue;
    }

    for (const record of readToolRecords(tool.data)) {
      if (tool.domain === "defi_tvl") {
        collectProtocolTvlRecord(aggregates, record, normalizedChain, tool.commandId);
        continue;
      }

      collectYieldPoolRecord(aggregates, record, normalizedChain, tool.commandId);
    }
  }

  return scoreDefiProtocolAggregates(
    Array.from(aggregates.values()),
    chainName
  ).slice(0, 12);
}

function collectProtocolTvlRecord(
  aggregates: Map<string, DefiProtocolAggregate>,
  record: Record<string, unknown>,
  chain: string,
  toolId: string
) {
  if (!recordMatchesChain(record, chain)) {
    return;
  }

  const rawLabel =
    readString(record.name) ||
    readString(record.slug) ||
    readString(record.project) ||
    readString(record.id);

  if (!rawLabel) {
    return;
  }

  const aggregate = getOrCreateDefiProtocolAggregate(
    aggregates,
    normalizeProtocolKey(rawLabel),
    rawLabel,
    "protocol"
  );
  const tvlUsd =
    readChainTvl(record, chain) ??
    readNumberField(record, ["tvlUsd", "tvl", "totalLiquidityUsd"]);

  if (tvlUsd !== undefined) {
    aggregate.protocolTvlUsd = Math.max(aggregate.protocolTvlUsd ?? 0, tvlUsd);
  }

  aggregate.tvlPct1D =
    firstDefined(
      aggregate.tvlPct1D,
      readNumberField(record, ["change_1d", "change1d", "tvlPct1D", "tvlChange1d"])
    );
  aggregate.tvlPct7D =
    firstDefined(
      aggregate.tvlPct7D,
      readNumberField(record, ["change_7d", "change7d", "tvlPct7D", "tvlChange7d"])
    );
  aggregate.toolIds.add(toolId);
}

function collectYieldPoolRecord(
  aggregates: Map<string, DefiProtocolAggregate>,
  record: Record<string, unknown>,
  chain: string,
  toolId: string
) {
  const poolChain = readString(record.chain)?.toLowerCase();

  if (poolChain !== chain) {
    return;
  }

  const rawLabel =
    readString(record.project) ||
    readString(record.name) ||
    readString(record.protocol) ||
    readString(record.id);

  if (!rawLabel) {
    return;
  }

  const aggregate = getOrCreateDefiProtocolAggregate(
    aggregates,
    normalizeProtocolKey(rawLabel),
    rawLabel,
    "yield"
  );
  const poolTvlUsd = readNumberField(record, ["tvlUsd", "tvl", "totalLiquidityUsd"]);
  const apy = readNumberField(record, ["apy", "apyBase", "apyReward"]);

  aggregate.poolCount += 1;
  aggregate.poolTvlUsdSum += poolTvlUsd ?? 0;
  aggregate.toolIds.add(toolId);

  if (apy !== undefined && (aggregate.bestApy === undefined || apy > aggregate.bestApy)) {
    aggregate.bestApy = apy;
    aggregate.apyPct1D = readNumberField(record, [
      "apyPct1D",
      "apyBase1d",
      "apy1d",
      "apyChange1d",
    ]);
    aggregate.apyPct7D = readNumberField(record, [
      "apyPct7D",
      "apyBase7d",
      "apy7d",
      "apyChange7d",
    ]);
  }
}

function scoreDefiProtocolAggregates(
  aggregates: DefiProtocolAggregate[],
  chainName: string
) {
  const enriched = aggregates
    .map((aggregate) => {
      const tvlUsd =
        aggregate.protocolTvlUsd !== undefined
          ? aggregate.protocolTvlUsd
          : aggregate.poolTvlUsdSum > 0
            ? aggregate.poolTvlUsdSum
            : undefined;
      const momentumScore = calculateMomentumScore(aggregate);

      return {
        aggregate,
        bestApy: aggregate.bestApy,
        momentumComponent:
          momentumScore === undefined ? undefined : normalizeMomentumComponent(momentumScore),
        momentumScore,
        tvlUsd,
      };
    })
    .filter(
      (item) =>
        item.tvlUsd !== undefined ||
        item.bestApy !== undefined ||
        item.momentumScore !== undefined
    );
  const tvlValues = enriched
    .map((item) =>
      item.tvlUsd === undefined ? undefined : Math.log10(Math.max(item.tvlUsd, 1))
    )
    .filter((value): value is number => value !== undefined);
  const apyValues = enriched
    .map((item) => item.bestApy)
    .filter((value): value is number => value !== undefined);

  return enriched
    .map((item) => {
      const hasDirectProtocolTvl = item.aggregate.protocolTvlUsd !== undefined;
      const tvlScore =
        item.tvlUsd === undefined
          ? undefined
          : percentileRank(tvlValues, Math.log10(Math.max(item.tvlUsd, 1)));
      const apyScore =
        item.bestApy === undefined ? undefined : percentileRank(apyValues, item.bestApy);
      const coverage = determineDefiCoverage({
        bestApy: item.bestApy,
        hasDirectProtocolTvl,
        momentumScore: item.momentumScore,
        tvlUsd: item.tvlUsd,
      });
      const score = weightedAverage([
        { value: tvlScore, weight: 0.45 },
        { value: apyScore, weight: 0.35 },
        { value: item.momentumComponent, weight: 0.2 },
      ]);

      return {
        bestApy: item.bestApy,
        coverage,
        id: item.aggregate.key,
        label: item.aggregate.label,
        momentumScore: item.momentumScore,
        poolCount: item.aggregate.poolCount,
        score: score ?? 0,
        severity: severityForDefiCoverage(coverage),
        summary: describeDefiProtocol({
          bestApy: item.bestApy,
          chainName,
          coverage,
          hasDirectProtocolTvl,
          momentumScore: item.momentumScore,
          poolCount: item.aggregate.poolCount,
          tvlUsd: item.tvlUsd,
        }),
        toolIds: Array.from(item.aggregate.toolIds),
        tvlUsd: item.tvlUsd,
      } satisfies DefiProtocolRank;
    })
    .sort(
      (left, right) =>
        compareNumber(right.score, left.score) ||
        compareNumber(right.tvlUsd, left.tvlUsd) ||
        compareNumber(right.bestApy, left.bestApy) ||
        left.label.localeCompare(right.label)
    );
}

function getOrCreateDefiProtocolAggregate(
  aggregates: Map<string, DefiProtocolAggregate>,
  key: string,
  rawLabel: string,
  source: "protocol" | "yield"
) {
  const existing = aggregates.get(key);

  if (existing) {
    if (source === "protocol" && existing.labelSource !== "protocol") {
      existing.label = formatProtocolLabel(rawLabel);
      existing.labelSource = source;
    }

    return existing;
  }

  const aggregate: DefiProtocolAggregate = {
    key,
    label: formatProtocolLabel(rawLabel),
    labelSource: source,
    poolCount: 0,
    poolTvlUsdSum: 0,
    toolIds: new Set<string>(),
  };
  aggregates.set(key, aggregate);

  return aggregate;
}

function determineDefiCoverage({
  bestApy,
  hasDirectProtocolTvl,
  momentumScore,
  tvlUsd,
}: {
  bestApy?: number;
  hasDirectProtocolTvl: boolean;
  momentumScore?: number;
  tvlUsd?: number;
}): DefiProtocolRank["coverage"] {
  if (
    hasDirectProtocolTvl &&
    tvlUsd !== undefined &&
    bestApy !== undefined &&
    momentumScore !== undefined
  ) {
    return "composite";
  }

  if (tvlUsd !== undefined && bestApy !== undefined) {
    return "tvl+apy";
  }

  return "context-only";
}

function severityForDefiCoverage(coverage: DefiProtocolRank["coverage"]) {
  if (coverage === "composite") {
    return "high";
  }

  if (coverage === "tvl+apy") {
    return "medium";
  }

  return "watch";
}

function describeDefiProtocol({
  bestApy,
  chainName,
  coverage,
  hasDirectProtocolTvl,
  momentumScore,
  poolCount,
  tvlUsd,
}: {
  bestApy?: number;
  chainName: string;
  coverage: DefiProtocolRank["coverage"];
  hasDirectProtocolTvl: boolean;
  momentumScore?: number;
  poolCount: number;
  tvlUsd?: number;
}) {
  const tvlText =
    tvlUsd !== undefined
      ? `${formatUsd(tvlUsd)} ${chainName} TVL${hasDirectProtocolTvl ? "" : " from summed pool coverage"}`
      : `direct ${chainName} TVL was unavailable`;
  const apyText =
    bestApy !== undefined ? `${formatPercent(bestApy)} best APY` : "direct APY was unavailable";
  const momentumText =
    momentumScore !== undefined
      ? `${formatPercent(momentumScore)} momentum`
      : "momentum fields were incomplete";
  const basisText =
    coverage === "composite"
      ? "Composite ranking used TVL, APY, and momentum."
      : coverage === "tvl+apy"
        ? "Ranking fell back to TVL + APY because the full composite inputs were incomplete."
        : "Ranking used limited direct context only.";

  return `${tvlText}, ${apyText}, ${momentumText}. ${poolCount} ${chainName} pool(s) contributed to this protocol view. ${basisText}`;
}

function describeDefiLeader(protocol: DefiProtocolRank) {
  const parts = [
    `${protocol.label} leads the current view`,
    protocol.tvlUsd !== undefined ? `with ${formatUsd(protocol.tvlUsd)} TVL` : undefined,
    protocol.bestApy !== undefined ? `${formatPercent(protocol.bestApy)} best APY` : undefined,
    protocol.momentumScore !== undefined
      ? `${formatPercent(protocol.momentumScore)} momentum`
      : undefined,
  ].filter(Boolean);

  return `${parts.join(" and ")}.`;
}

function summarizeDefiCoverage(protocols: DefiProtocolRank[]) {
  const coverageCounts = protocols.reduce(
    (counts, protocol) => {
      counts[protocol.coverage] += 1;
      return counts;
    },
    {
      composite: 0,
      "context-only": 0,
      "tvl+apy": 0,
    } satisfies Record<DefiProtocolRank["coverage"], number>
  );
  const parts = [
    coverageCounts.composite
      ? `${coverageCounts.composite} protocol(s) used composite scoring`
      : undefined,
    coverageCounts["tvl+apy"]
      ? `${coverageCounts["tvl+apy"]} protocol(s) fell back to TVL + APY`
      : undefined,
    coverageCounts["context-only"]
      ? `${coverageCounts["context-only"]} protocol(s) stayed context-only`
      : undefined,
  ].filter(Boolean);

  return parts.length ? `${parts.join("; ")}.` : "Coverage details were limited.";
}

function describeTokenDiscoveryLeader(token: TokenDiscoveryRank) {
  const parts = [
    `${token.label} leads the current view`,
    token.boostAmount !== undefined
      ? `with ${token.boostAmount.toLocaleString("en-US")} observed boost amount`
      : undefined,
    token.liquidityUsd !== undefined
      ? `${formatUsd(token.liquidityUsd)} liquidity`
      : undefined,
    token.volume24hUsd !== undefined
      ? `${formatUsd(token.volume24hUsd)} 24h volume`
      : undefined,
  ].filter(Boolean);

  return `${parts.join(" and ")}.`;
}

function describeTokenDiscoveryCandidate({
  aggregate,
  coverage,
}: {
  aggregate: TokenDiscoveryAggregate;
  coverage: TokenDiscoveryRank["coverage"];
}) {
  const parts = [
    aggregate.tokenAddress
      ? `Token address ${shortTokenAddress(aggregate.tokenAddress)}`
      : "Token address was unavailable",
    aggregate.boostAmount !== undefined
      ? `boost amount ${aggregate.boostAmount.toLocaleString("en-US")}`
      : undefined,
    aggregate.liquidityUsd !== undefined
      ? `liquidity ${formatUsd(aggregate.liquidityUsd)}`
      : undefined,
    aggregate.volume24hUsd !== undefined
      ? `24h volume ${formatUsd(aggregate.volume24hUsd)}`
      : undefined,
    aggregate.priceChange24h !== undefined
      ? `24h price move ${formatPercent(aggregate.priceChange24h)}`
      : undefined,
  ].filter(Boolean);
  const basis =
    coverage === "boost+pool"
      ? "Ranking used observed boost and pool evidence."
      : coverage === "multi-source"
        ? "Ranking used multiple observed discovery sources."
        : "Ranking used a single observed discovery source.";

  return `${parts.join(", ")}. ${aggregate.poolCount} pool row(s) contributed. ${basis}`;
}

function summarizeTokenDiscoveryCoverage(tokens: TokenDiscoveryRank[]) {
  const coverageCounts = tokens.reduce(
    (counts, token) => {
      counts[token.coverage] += 1;
      return counts;
    },
    {
      "boost+pool": 0,
      "multi-source": 0,
      "single-source": 0,
    } satisfies Record<TokenDiscoveryRank["coverage"], number>
  );
  const parts = [
    coverageCounts["boost+pool"]
      ? `${coverageCounts["boost+pool"]} token(s) used boost+pool coverage`
      : undefined,
    coverageCounts["multi-source"]
      ? `${coverageCounts["multi-source"]} token(s) used multi-source coverage`
      : undefined,
    coverageCounts["single-source"]
      ? `${coverageCounts["single-source"]} token(s) stayed single-source`
      : undefined,
  ].filter(Boolean);

  return parts.length ? `${parts.join("; ")}.` : "Coverage details were limited.";
}

function calculateMomentumScore(aggregate: DefiProtocolAggregate) {
  const values = [
    { value: aggregate.apyPct1D, weight: 0.35 },
    { value: aggregate.apyPct7D, weight: 0.35 },
    { value: aggregate.tvlPct1D, weight: 0.15 },
    { value: aggregate.tvlPct7D, weight: 0.15 },
  ].filter((item) => item.value !== undefined);

  if (!values.length) {
    return undefined;
  }

  const totalWeight = values.reduce((sum, item) => sum + item.weight, 0);
  const weightedValue = values.reduce(
    (sum, item) => sum + clampNumber(item.value ?? 0, -100, 100) * item.weight,
    0
  );

  return totalWeight > 0 ? weightedValue / totalWeight : undefined;
}

function normalizeMomentumComponent(value: number) {
  return clampNumber((clampNumber(value, -100, 100) + 100) / 2, 0, 100);
}

function percentileRank(values: number[], value: number) {
  if (!values.length) {
    return undefined;
  }

  if (values.length === 1) {
    return 100;
  }

  const sorted = [...values].sort((left, right) => left - right);
  const firstIndex = sorted.findIndex((item) => item === value);
  const lastIndex = sorted.length - 1 - [...sorted].reverse().findIndex((item) => item === value);
  const averageIndex = firstIndex >= 0 ? (firstIndex + lastIndex) / 2 : sorted.findIndex((item) => item > value);
  const normalizedIndex =
    averageIndex >= 0 ? averageIndex : sorted.length - 1;

  return (normalizedIndex / (sorted.length - 1)) * 100;
}

function weightedAverage(values: Array<{ value?: number; weight: number }>) {
  const available = values.filter((item) => item.value !== undefined);

  if (!available.length) {
    return undefined;
  }

  const totalWeight = available.reduce((sum, item) => sum + item.weight, 0);
  const weightedValue = available.reduce(
    (sum, item) => sum + (item.value ?? 0) * item.weight,
    0
  );

  return totalWeight > 0 ? weightedValue / totalWeight : undefined;
}

function clampNumber(value: number, minimum: number, maximum: number) {
  return Math.min(Math.max(value, minimum), maximum);
}

function readToolRecords(value: unknown) {
  const candidates = [
    ...(Array.isArray(value) ? value : []),
    ...readArrayFromUnknown(value, "rows"),
    ...readArrayFromUnknown(value, "data"),
    ...readArrayFromUnknown(value, "result.rows"),
    ...readArrayFromUnknown(value, "results"),
    ...readArrayFromUnknown(value, "items"),
  ];

  return candidates
    .map((item) => asRecord(item))
    .filter((item): item is Record<string, unknown> => Boolean(item));
}

function recordMatchesChain(record: Record<string, unknown>, chain: string) {
  const directChain = readString(record.chain)?.toLowerCase();

  if (directChain === chain) {
    return true;
  }

  if (Array.isArray(record.chains)) {
    return record.chains.some(
      (item) => typeof item === "string" && item.toLowerCase() === chain
    );
  }

  const chainTvls = asRecord(record.chainTvls);

  if (!chainTvls) {
    return false;
  }

  return Object.keys(chainTvls).some((key) => key.toLowerCase() === chain);
}

function readChainTvl(record: Record<string, unknown>, chain: string) {
  const chainTvls = asRecord(record.chainTvls);

  if (!chainTvls) {
    return undefined;
  }

  for (const [key, value] of Object.entries(chainTvls)) {
    if (key.toLowerCase() !== chain) {
      continue;
    }

    const directValue = readNumberValue(value);

    if (directValue !== undefined) {
      return directValue;
    }

    const chainRecord = asRecord(value);

    if (!chainRecord) {
      continue;
    }

    return readNumberField(chainRecord, ["tvl", "tvlUsd", "totalLiquidityUsd"]);
  }

  return undefined;
}

function readNumberField(record: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = readNumberValue(record[key]);

    if (value !== undefined) {
      return value;
    }
  }

  return undefined;
}

function readNumberValue(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string") {
    const parsed = Number(value);

    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  return undefined;
}

function normalizeProtocolKey(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function formatProtocolLabel(value: string) {
  if (/[A-Z]/.test(value) || /\s/.test(value)) {
    return value.trim();
  }

  return value
    .trim()
    .split(/[-_]+/g)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function firstDefined<T>(...values: Array<T | undefined>) {
  return values.find((value) => value !== undefined);
}

function classifyLiquiditySeverity(pair: NormalizedPair): ResearchReportSeverity {
  const reserveUsd = pair.reserveUsd ?? 0;
  const turnover = pair.turnover24h ?? 0;
  const priceMove = Math.abs(pair.priceChange24h ?? 0);
  const txns = pair.txns24h ?? 0;

  if (reserveUsd > 0 && reserveUsd < 50_000) {
    return "fragile";
  }

  if (turnover >= 1 && (priceMove >= 10 || txns >= 1000)) {
    return "high";
  }

  if (turnover >= 0.4 || priceMove >= 10) {
    return "medium";
  }

  if (turnover > 0 || priceMove > 0 || txns > 0) {
    return "watch";
  }

  return "info";
}

function describeLiquidityPair(pair: NormalizedPair) {
  const parts = [
    pair.reserveUsd !== undefined
      ? `Reserves are ${formatUsd(pair.reserveUsd)}`
      : undefined,
    pair.volume24hUsd !== undefined
      ? `24h volume is ${formatUsd(pair.volume24hUsd)}`
      : undefined,
    pair.turnover24h !== undefined
      ? `turnover is ${formatRatio(pair.turnover24h)}`
      : undefined,
    pair.priceChange24h !== undefined
      ? `24h price move is ${formatPercent(pair.priceChange24h)}`
      : undefined,
    pair.txns24h !== undefined ? `24h transactions total ${pair.txns24h.toLocaleString("en-US")}` : undefined,
  ].filter(Boolean);

  return `${parts.join(", ")}.`;
}

function summarizeToolResults(tools: OnChainToolResult[]) {
  const successful = tools.filter(isUsableDirectProviderResult);
  const failed = tools.filter(isDirectProviderIssue);

  if (!successful.length) {
    return "Direct provider rows were not available in this run.";
  }

  return `The run returned ${successful.length} usable direct provider result(s) and ${failed.length} source gap(s).`;
}

function deriveColumnsFromRows(rows: NormalizedRow[]) {
  const metricKeys = Array.from(
    rows.reduce((set, row) => {
      for (const key of Object.keys(row.metrics)) {
        set.add(key);
      }

      return set;
    }, new Set<string>())
  );

  return ["label", ...metricKeys];
}

function dedupeRows(rows: NormalizedRow[]) {
  const seen = new Set<string>();
  const output: NormalizedRow[] = [];

  for (const row of rows) {
    const key = `${row.label}::${stableMetricKey(row.metrics)}`;

    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    output.push(row);
  }

  return output;
}

function stableMetricKey(metrics: Record<string, string | number | null>) {
  return Object.entries(metrics)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}:${String(value)}`)
    .join("|");
}

function normalizeMetrics(record: Record<string, unknown>) {
  const metrics: Record<string, string | number | null> = {};

  for (const [key, value] of Object.entries(record)) {
    if (key === "id" || key === "label" || key === "name") {
      continue;
    }

    if (typeof value === "number") {
      metrics[key] = roundNumber(value);
    } else if (typeof value === "string") {
      const trimmed = value.trim();
      const parsed = Number(value);
      metrics[key] = isHexIdentifier(trimmed) || !Number.isFinite(parsed) || trimmed === ""
        ? value
        : roundNumber(parsed);
    } else if (value == null) {
      metrics[key] = null;
    }
  }

  return metrics;
}

function isHexIdentifier(value: string) {
  return /^0x[a-f0-9]{8,}$/i.test(value);
}

function readMetricNumber(
  metrics: Record<string, string | number | null>,
  key: string
) {
  const value = metrics[key];

  return typeof value === "number" ? value : undefined;
}

function renderMarkdownTable(table: ResearchReportTable) {
  if (!table.rows.length) {
    return "_No rows available._";
  }

  const columns = table.columns;
  const header = `| ${columns.join(" | ")} |`;
  const divider = `| ${columns.map(() => "---").join(" | ")} |`;
  const rows = table.rows.map((row) =>
    `| ${columns
      .map((column) => escapeMarkdownCell(formatCell(row[column])))
      .join(" | ")} |`
  );

  return [header, divider, ...rows].join("\n");
}

function formatMetrics(metrics: Record<string, string | number | null>) {
  return Object.entries(metrics)
    .filter(([, value]) => value !== null && value !== "")
    .map(([key, value]) => `${key}=${formatCell(value)}`)
    .join(", ");
}

function formatCell(value: string | number | null | undefined) {
  if (value == null || value === "") {
    return "Not available";
  }

  if (typeof value === "number") {
    return Number.isInteger(value)
      ? value.toLocaleString("en-US")
      : value.toFixed(2).replace(/\.?0+$/, "");
  }

  return value;
}

function escapeMarkdownCell(value: string) {
  return value.replace(/\|/g, "\\|");
}

function providerLabel(provider: string) {
  switch (provider.toLowerCase()) {
    case "defillama":
      return "DeFiLlama";
    case "dexscreener":
      return "DEX Screener";
    case "dune":
      return "Dune";
    case "elfa":
      return "Elfa";
    case "goplus":
      return "GoPlus";
    case "nansen":
      return "Nansen";
    case "surf":
      return "Surf";
    case "tavily":
      return "Docs";
    default:
      return provider;
  }
}

function readArrayFromUnknown(value: unknown, path: string) {
  const target = readPath(value, path.split("."));

  return Array.isArray(target) ? target : [];
}

function readPath(value: unknown, path: string[]) {
  let current = value;

  for (const key of path) {
    const record = asRecord(current);

    if (!record) {
      return undefined;
    }

    current = record[key];
  }

  return current;
}

function readNestedString(record: Record<string, unknown>, path: string[]) {
  const value = readPath(record, path);

  return typeof value === "string" ? value : undefined;
}

function readNestedNumber(record: Record<string, unknown>, path: string[]) {
  const value = readPath(record, path);

  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string") {
    const parsed = Number(value);

    return Number.isFinite(parsed) ? parsed : undefined;
  }

  return undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : undefined;
}

function readString(value: unknown) {
  return typeof value === "string" ? value : undefined;
}

function readTimestamp(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string") {
    const parsedNumber = Number(value);

    if (Number.isFinite(parsedNumber)) {
      return parsedNumber;
    }

    const parsedDate = Date.parse(value);

    if (Number.isFinite(parsedDate)) {
      return parsedDate;
    }
  }

  return undefined;
}

function readGeckoTokenAddress(
  record: Record<string, unknown>,
  attributes: Record<string, unknown>
) {
  return (
    readString(attributes.base_token_address) ||
    stripNetworkPrefix(
      readNestedString(record, ["relationships", "base_token", "data", "id"])
    ) ||
    readNestedString(record, ["base_token", "address"])
  );
}

function stripNetworkPrefix(value: string | undefined) {
  if (!value) {
    return undefined;
  }

  const separatorIndex = value.indexOf("_");

  return separatorIndex >= 0 ? value.slice(separatorIndex + 1) : value;
}

function extractTrailingAddress(value: string | undefined) {
  if (!value) {
    return undefined;
  }

  const match = value.match(/(0x[a-fA-F0-9]{40})$/);

  return match?.[1];
}

function shouldReplaceTokenLabel(
  current: string | undefined,
  tokenAddress: string | undefined
) {
  return (
    !current ||
    current === "Unknown" ||
    (tokenAddress !== undefined && current === shortTokenAddress(tokenAddress))
  );
}

function normalizeTokenLabel(value: string) {
  return value.trim();
}

function shortTokenAddress(value: string | undefined) {
  if (!value) {
    return "Unknown token";
  }

  return value.length > 14 ? `${value.slice(0, 6)}...${value.slice(-4)}` : value;
}

function logMetric(value: number | undefined) {
  return value === undefined ? undefined : Math.log10(Math.max(value, 1));
}

function uniqueStrings(values: Array<string | undefined>) {
  const seen = new Set<string>();
  const output: string[] = [];

  for (const value of values) {
    const normalized = value?.trim();

    if (!normalized) {
      continue;
    }

    const key = normalized.toLowerCase();

    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    output.push(normalized);
  }

  return output;
}

function normalizeSentence(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

function roundNumber(value: number | undefined) {
  if (value === undefined || !Number.isFinite(value)) {
    return null;
  }

  return Math.round(value * 100) / 100;
}

function compareNumber(left?: number, right?: number) {
  return (left ?? Number.NEGATIVE_INFINITY) - (right ?? Number.NEGATIVE_INFINITY);
}

function compareSeverity(
  left: ResearchReportSeverity,
  right: ResearchReportSeverity
) {
  const order: ResearchReportSeverity[] = [
    "high",
    "medium",
    "watch",
    "fragile",
    "info",
  ];

  return order.indexOf(left) - order.indexOf(right);
}

function formatUsd(value?: number) {
  if (value === undefined) {
    return "unknown reserves";
  }

  if (value >= 1_000_000) {
    return `$${(value / 1_000_000).toFixed(2).replace(/\.?0+$/, "")}M`;
  }

  if (value >= 1_000) {
    return `$${(value / 1_000).toFixed(1).replace(/\.?0+$/, "")}K`;
  }

  return `$${Math.round(value).toLocaleString("en-US")}`;
}

function formatRatio(value?: number) {
  return value === undefined ? "unknown" : `${roundNumber(value)}x`;
}

function formatPercent(value?: number) {
  return value === undefined ? "unknown" : `${value >= 0 ? "+" : ""}${roundNumber(value)}%`;
}

function formatUtc(value: string) {
  const date = new Date(value);

  return Number.isNaN(date.getTime()) ? value : date.toISOString().replace(".000Z", " UTC");
}
