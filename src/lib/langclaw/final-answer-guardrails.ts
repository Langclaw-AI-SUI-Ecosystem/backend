import type { OnChainToolFinalPayload, OnChainToolResult } from "../onchain-tools/types";
import {
  isDirectProviderIssue,
  isUsableDirectProviderResult,
} from "../onchain-tools/evidence";
import type {
  DiscoverSignals,
  FinalAnswer,
  ProviderError,
  ProviderTraceEntry,
  ResearchReport,
  ResearchReportTable,
} from "./types";

type FinalAnswerGuardrailInput = {
  errors: ProviderError[];
  providerTrace?: ProviderTraceEntry[];
  report?: ResearchReport;
  signals: DiscoverSignals;
  onChain?: OnChainToolFinalPayload;
  onChainSkippedReason?: string;
};

type FinalAnswerGuardrails = {
  structuredCaveat: string;
  proofNarrativePolicy: string;
};

export function buildFinalAnswerGuardrails(
  input: FinalAnswerGuardrailInput
): FinalAnswerGuardrails {
  return {
    structuredCaveat: buildStructuredFinalAnswerCaveat(input),
    proofNarrativePolicy:
      "Do not claim evidenceUri, storage upload, prepared or anchored Sui proof, Sui anchoring, chain writes, or transaction submission status in the final answer. Proof state is reported separately by the workflow payload.",
  };
}

export function buildStructuredFinalAnswerCaveat(
  input: FinalAnswerGuardrailInput
) {
  if (input.report?.kind === "smart-money") {
    return "Wallet labels, retention, sell pressure, and second-source checks may be incomplete. No market transaction was executed.";
  }

  if (input.report?.caveats.length) {
    return input.report.caveats.join(" ");
  }

  const { onChain, onChainSkippedReason, signals } = input;
  const directFailures = getDirectOnChainResults(onChain, "failed");
  const directSuccesses = onChain?.tools.filter(isUsableDirectProviderResult) ?? [];
  const localSuccesses = onChain?.tools.filter(
    (tool) => tool.provider === "local" && tool.status === "success"
  ) ?? [];
  const failures = collectFailureNotes(input);
  const notes: string[] = [];

  if (failures.length) {
    notes.push(`Coverage gaps reduced confidence: ${failures.join("; ")}.`);
  }

  if (onChainSkippedReason) {
    notes.push(`On-chain enrichment was skipped: ${normalizeSentence(onChainSkippedReason)}.`);
  } else if (onChain) {
    if (!directSuccesses.length && localSuccesses.length) {
      notes.push(
        "The on-chain output stayed analysis-only because direct provider confirmation was incomplete."
      );
    } else if (!directSuccesses.length && directFailures.length) {
      notes.push(
        "Direct smart-money or wallet-flow rows were not available."
      );
    } else if (directSuccesses.length && directFailures.length) {
      notes.push(
        "The on-chain output was mixed because some direct providers failed while others returned usable evidence."
      );
    }
  }

  if (signals.combined.status === "partial") {
    notes.push(
      "The combined signal is partial, so treat this brief as directional research rather than final confirmation."
    );
  } else if (signals.combined.status === "failed") {
    notes.push(
      "The combined signal failed, so this brief should not be treated as a verified market claim."
    );
  } else if (signals.combined.status === "skipped") {
    notes.push(
      "The combined signal was skipped, so this brief is incomplete and should be treated cautiously."
    );
  } else {
    notes.push(
      "Review this brief manually before treating it as a final market claim."
    );
  }

  notes.push(
    "Langclaw did not buy, sell, swap, or execute market transactions."
  );

  return notes.join(" ");
}

export function applyFinalAnswerGuardrails(
  answer: FinalAnswer,
  input: FinalAnswerGuardrailInput
): FinalAnswer {
  const { structuredCaveat } = buildFinalAnswerGuardrails(input);
  const strippedMarkdown = stripTrailingCaveatSection(answer.answerMarkdown || answer.answer);
  const markdown = input.report?.kind === "smart-money"
    ? prepareSmartMoneyMarkdown(strippedMarkdown, input.report)
    : strippedMarkdown;
  const answerMarkdown =
    input.report?.kind === "smart-money"
      ? markdown
      : markdown
        ? `${markdown}\n\nCaveat: ${structuredCaveat}`
        : `Caveat: ${structuredCaveat}`;

  return {
    ...answer,
    caveat: structuredCaveat,
    answerMarkdown,
  };
}

function prepareSmartMoneyMarkdown(markdown: string, report: ResearchReport) {
  const sanitized = sanitizeSmartMoneyVisibleMarkdown(markdown);

  return sanitizeSmartMoneyVisibleMarkdown(
    paragraphizeSmartMoneyNarrativeSections(
      injectSmartMoneyLimitsSection(
        injectSmartMoneyTable(
          injectSmartMoneyEvidenceTable(sanitized, report),
          report
        ),
        report
      )
    )
  );
}

function getSmartMoneyReportTable(report: ResearchReport) {
  return report.tables.find(
    (item) => item.rows.length && item.id === "smart-money-table"
  ) ?? report.tables.find(
    (item) => item.rows.length && !isSmartMoneyEvidenceTableId(item.id)
  );
}

function getSmartMoneyEvidenceTables(report: ResearchReport) {
  return report.tables.filter(
    (item) => item.rows.length && isSmartMoneyEvidenceTableId(item.id)
  );
}

function isSmartMoneyEvidenceTableId(id: string) {
  return /^(dex-accumulation-table|cex-withdrawal-table|cex-deposit-table|cex-address-context-table)$/.test(id);
}

function injectSmartMoneyTable(markdown: string, report: ResearchReport) {
  const table = getSmartMoneyReportTable(report);

  if (!table) {
    return markdown;
  }

  const block = [
    table.title
      ? `**${sanitizeSmartMoneyVisibleMarkdown(table.title)}**`
      : undefined,
    renderMarkdownTable(table),
    "",
    "Rows above are candidates or watchlist entries unless wallet labels, retention, sell pressure, and second-source checks support a stronger classification.",
  ]
    .filter((value): value is string => value !== undefined)
    .join("\n");
  const candidatesSection = findMarkdownSection(
    markdown,
    /^Candidates(?:\s*\([^)\n]*\))?$/i
  );

  if (candidatesSection) {
    if (containsSmartMoneyTable(candidatesSection.content)) {
      return replaceMarkdownSection(
        markdown,
        candidatesSection,
        "Candidates",
        candidatesSection.content
      );
    }

    return replaceMarkdownSection(markdown, candidatesSection, "Candidates", block);
  }

  if (containsSmartMoneyTable(markdown)) {
    return markdown;
  }

  return [markdown, "", "## Candidates", "", block].filter(Boolean).join("\n");
}

function injectSmartMoneyEvidenceTable(
  markdown: string,
  report: ResearchReport
) {
  const evidenceTables = getSmartMoneyEvidenceTables(report);
  const fallbackTable = getSmartMoneyReportTable(report);

  if (!evidenceTables.length && !fallbackTable) {
    return markdown;
  }

  const evidenceSection = findMarkdownSection(
    markdown,
    /^Evidence(?:\s*\([^)\n]*\))?$/i
  );
  const evidenceTable = evidenceTables.length
    ? renderEvidenceTables(evidenceTables)
    : fallbackTable
      ? renderEvidenceTable(fallbackTable)
      : "";

  if (evidenceSection) {
    if (containsMarkdownTable(evidenceSection.content)) {
      const missingEvidence = evidenceTables.filter(
        (table) => table.title && !evidenceSection.content.includes(table.title)
      );

      if (missingEvidence.length) {
        return replaceMarkdownSection(
          markdown,
          evidenceSection,
          "Evidence",
          [
            evidenceSection.content,
            renderEvidenceTables(missingEvidence),
          ].filter(Boolean).join("\n\n")
        );
      }

      return replaceMarkdownSection(
        markdown,
        evidenceSection,
        "Evidence",
        evidenceSection.content
      );
    }

    return replaceMarkdownSection(
      markdown,
      evidenceSection,
      "Evidence",
      [evidenceSection.content, evidenceTable].filter(Boolean).join("\n\n")
    );
  }

  const candidatesSection = findMarkdownSection(
    markdown,
    /^Candidates(?:\s*\([^)\n]*\))?$/i
  );

  if (candidatesSection) {
    const before = markdown.slice(0, candidatesSection.headingStart);
    const after = markdown.slice(candidatesSection.headingStart);

    return `${before.trimEnd()}\n\n${candidatesSection.headingLevel} Evidence\n\n${evidenceTable}\n\n${after.trimStart()}`;
  }

  return [markdown, "", "## Evidence", "", evidenceTable]
    .filter(Boolean)
    .join("\n");
}

function injectSmartMoneyLimitsSection(
  markdown: string,
  report: ResearchReport
) {
  const limits = report.sections.find((section) => /^limits$/i.test(section.title));

  if (!limits?.markdown) {
    return markdown;
  }

  const limitsContent = sanitizeSmartMoneyVisibleMarkdown(limits.markdown);
  const limitsSection = findMarkdownSection(markdown, /^Limits$/i);

  if (limitsSection) {
    return replaceMarkdownSection(
      markdown,
      limitsSection,
      "Limits",
      limitsContent
    );
  }

  const conclusionSection = findMarkdownSection(markdown, /^Conclusion$/i);

  if (conclusionSection) {
    const before = markdown.slice(0, conclusionSection.headingStart);
    const after = markdown.slice(conclusionSection.headingStart);

    return `${before.trimEnd()}\n\n${conclusionSection.headingLevel} Limits\n\n${limitsContent}\n\n${after.trimStart()}`;
  }

  return [markdown, "", "## Limits", "", limitsContent]
    .filter(Boolean)
    .join("\n");
}

function containsSmartMoneyTable(markdown: string) {
  return /\|\s*Wallet\s*\|\s*Token\s*\|/i.test(markdown);
}

function containsMarkdownTable(markdown: string) {
  return /\|.+\|\s*\n\|\s*[-:]+/m.test(markdown);
}

function renderEvidenceTable(table: ResearchReportTable) {
  const rows = table.rows;
  const flowType = summarizeUniqueColumn(rows, "Signal") ||
    summarizeUniqueColumn(rows, "Flow type");
  const evidenceRows = [
    ["Row source", flowType, "Available"],
    ["Rows parsed", `${rows.length}`, rows.length ? "Available" : "Unavailable"],
    ["Token bucket", summarizeUniqueColumn(rows, "Category"), "Reported"],
    ["Flow type", flowType, "Reported"],
    ["Classification", summarizeUniqueColumn(rows, "Status"), "Watchlist until enriched"],
    [
      "Unavailable checks",
      "Wallet labels, retention, sell pressure, and second-source validation unless present in provider rows",
      "Limits confidence",
    ],
  ];

  return renderStaticMarkdownTable(
    ["Evidence", "Value", "Status"],
    evidenceRows
  );
}

function renderEvidenceTables(tables: ResearchReportTable[]) {
  return tables
    .map((table) =>
      [
        table.title
          ? `**${sanitizeSmartMoneyVisibleMarkdown(table.title)}**`
          : undefined,
        table.description
          ? sanitizeSmartMoneyVisibleMarkdown(table.description)
          : undefined,
        renderMarkdownTable(table),
      ]
        .filter((value): value is string => Boolean(value))
        .join("\n\n")
    )
    .join("\n\n");
}

function summarizeUniqueColumn(
  rows: ResearchReportTable["rows"],
  column: string
) {
  const values = [
    ...new Set(
      rows
        .map((row) => formatTableCell(row[column]))
        .filter((value) => value && value !== "Not available")
    ),
  ];

  if (!values.length) {
    return "Not available";
  }

  const topValues = values.slice(0, 4).join(", ");
  return values.length > 4 ? `${topValues}, +${values.length - 4} more` : topValues;
}

function renderStaticMarkdownTable(columns: string[], rows: string[][]) {
  const header = `| ${columns.map(escapeMarkdownCell).join(" | ")} |`;
  const divider = `| ${columns.map(() => "---").join(" | ")} |`;
  const body = rows.map(
    (row) => `| ${row.map((value) => escapeMarkdownCell(value)).join(" | ")} |`
  );

  return [header, divider, ...body].join("\n");
}

function renderMarkdownTable(table: ResearchReportTable) {
  if (!table.rows.length) {
    return "_No rows available._";
  }

  const columns = table.columns;
  const header = `| ${columns.map(escapeMarkdownCell).join(" | ")} |`;
  const divider = `| ${columns.map(() => "---").join(" | ")} |`;
  const rows = table.rows.map((row) =>
    `| ${columns
      .map((column) => escapeMarkdownCell(formatTableCell(row[column])))
      .join(" | ")} |`
  );

  return [header, divider, ...rows].join("\n");
}

function formatTableCell(value: string | number | null | undefined) {
  if (value == null || value === "") {
    return "Not available";
  }

  if (typeof value === "number") {
    return Number.isInteger(value)
      ? value.toLocaleString("en-US")
      : value.toFixed(2).replace(/\.?0+$/, "");
  }

  return sanitizeSmartMoneyVisibleMarkdown(value);
}

function escapeMarkdownCell(value: string) {
  return value.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

type MarkdownSection = {
  content: string;
  contentEnd: number;
  contentStart: number;
  headingLevel: string;
  headingStart: number;
};

function paragraphizeSmartMoneyNarrativeSections(markdown: string) {
  let output = markdown;
  const narrativeHeadings = [/^Read$/i, /^Limits$/i, /^Conclusion$/i];

  for (const heading of narrativeHeadings) {
    const section = findMarkdownSection(output, heading);

    if (!section) {
      continue;
    }

    const paragraph = normalizeSectionContentToParagraph(section.content);
    output = replaceMarkdownSection(output, section, undefined, paragraph);
  }

  return output;
}

function findMarkdownSection(
  markdown: string,
  headingPattern: RegExp
): MarkdownSection | undefined {
  const headingRegex = /(^|\n)(#{1,6})\s+([^\n]+)\n+/g;
  let match: RegExpExecArray | null;

  while ((match = headingRegex.exec(markdown))) {
    const title = match[3].trim();

    if (!headingPattern.test(title)) {
      continue;
    }

    const headingStart = match.index + match[1].length;
    const contentStart = match.index + match[0].length;
    const rest = markdown.slice(contentStart);
    const nextHeading = rest.search(/\n#{1,6}\s+\S/);
    const contentEnd =
      nextHeading === -1 ? markdown.length : contentStart + nextHeading;

    return {
      content: markdown.slice(contentStart, contentEnd).trim(),
      contentEnd,
      contentStart,
      headingLevel: match[2],
      headingStart,
    };
  }

  return undefined;
}

function replaceMarkdownSection(
  markdown: string,
  section: MarkdownSection,
  title: string | undefined,
  content: string
) {
  const before = markdown.slice(0, section.headingStart).replace(/\s+$/, "");
  const after = markdown.slice(section.contentEnd).trimStart();
  const headingText = title ?? markdown
    .slice(section.headingStart, section.contentStart)
    .replace(/^#{1,6}\s+/, "")
    .trim();
  const normalizedContent = content.trim();
  const sectionMarkdown = `${section.headingLevel} ${headingText}\n\n${normalizedContent}`;

  return [
    before,
    sectionMarkdown,
    after,
  ]
    .filter(Boolean)
    .join("\n\n");
}

function normalizeSectionContentToParagraph(content: string) {
  const lines = content
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (!lines.length || lines.some((line) => /^\|/.test(line))) {
    return content.trim();
  }

  return lines
    .map((line) =>
      line
        .replace(/^[-*•]\s+/, "")
        .replace(/^\d+[.)]\s+/, "")
        .trim()
    )
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

function sanitizeSmartMoneyVisibleMarkdown(markdown: string) {
  return markdown
    .replace(/\u2014/g, "-")
    .replace(/\s*\(this run\)/gi, "")
    .replace(/\bthis run['’]s\s+/gi, "the ")
    .replace(/\bin this run\b/gi, "in this analysis")
    .replace(/\bthis run\b/gi, "this analysis")
    .replace(/\bSurf-style research note\s*-\s*/gi, "")
    .replace(/\bSurf-style research note\b/gi, "")
    .replace(/\bSurf-style\s*-\s*/gi, "")
    .replace(/\bconfirmed_smart_money\b/gi, "confirmed smart money")
    .replace(/\bcandidate_smart_money\b/gi, "candidate smart money")
    .replace(/\blarge_flow_watchlist\b/gi, "large-flow watchlist")
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

function collectFailureNotes({
  errors,
  onChain,
  providerTrace,
}: Pick<FinalAnswerGuardrailInput, "errors" | "onChain" | "providerTrace">) {
  const seen = new Set<string>();
  const notes: string[] = [];

  for (const entry of providerTrace ?? []) {
    if (entry.status !== "failed") {
      continue;
    }

    if (/row-level smart-money|wallet-flow coverage/i.test(entry.message)) {
      pushCoverageGapNote(notes, seen, entry.provider);
      continue;
    }

    pushFailureNote(notes, seen, entry.provider, entry.message);
  }

  for (const error of errors) {
    pushFailureNote(notes, seen, error.provider, error.message);
  }

  for (const tool of onChain?.tools ?? []) {
    if (tool.provider === "local" || !isDirectProviderIssue(tool)) {
      continue;
    }

    if (tool.domain === "smart_money") {
      pushCoverageGapNote(notes, seen, providerLabel(tool.provider));
      continue;
    }

    pushFailureNote(notes, seen, providerLabel(tool.provider), tool.error || tool.summary);
  }

  return notes;
}

function pushFailureNote(
  notes: string[],
  seen: Set<string>,
  provider: string,
  message: string
) {
  const note = `${providerLabel(provider)} failed (${normalizeFailureMessage(message)})`;
  const key = note.toLowerCase();

  if (seen.has(key)) {
    return;
  }

  seen.add(key);
  notes.push(note);
}

function pushCoverageGapNote(
  notes: string[],
  seen: Set<string>,
  provider: string
) {
  const note = `${providerLabel(provider)} row-level wallet-flow coverage was unavailable`;
  const key = note.toLowerCase();

  if (seen.has(key)) {
    return;
  }

  seen.add(key);
  notes.push(note);
}

function normalizeFailureMessage(message: string) {
  const compact = message.replace(/\s+/g, " ").trim();

  if (
    /\b(?:401|402|403|429|5\d\d)\b|payment|required|credit|billing|api[_\s-]?key|token|unauthorized|forbidden/i.test(
      compact
    )
  ) {
    return "source unavailable";
  }

  return compact.length > 120 ? `${compact.slice(0, 117)}...` : compact;
}

function normalizeSentence(message: string) {
  return message.replace(/\s+/g, " ").trim();
}

function providerLabel(provider: string) {
  switch (provider.toLowerCase()) {
    case "surf":
      return "Surf";
    case "elfa":
      return "Elfa";
    case "nansen":
      return "Nansen";
    case "dune":
      return "Dune";
    case "alchemy":
      return "Alchemy";
    case "coingecko":
      return "CoinGecko";
    case "defillama":
      return "DeFiLlama";
    case "dexscreener":
      return "DEX Screener";
    case "etherscan":
      return "Etherscan";
    case "geckoterminal":
      return "GeckoTerminal";
    case "goplus":
      return "GoPlus";
    case "x":
      return "X";
    default:
      return provider;
  }
}

function getDirectOnChainResults(
  onChain: OnChainToolFinalPayload | undefined,
  status: OnChainToolResult["status"]
) {
  if (status === "success") {
    return onChain?.tools.filter(isUsableDirectProviderResult) ?? [];
  }

  if (status === "failed") {
    return onChain?.tools.filter(isDirectProviderIssue) ?? [];
  }

  return onChain?.tools.filter(
    (tool) => tool.provider !== "local" && tool.status === status
  ) ?? [];
}

function stripTrailingCaveatSection(markdown: string) {
  return markdown
    .replace(/\n{2,}#{1,6}\s*Caveats?\s*\n[\s\S]*$/i, "")
    .replace(/\n{2,}Caveat:\s*[\s\S]*$/i, "")
    .replace(/^Caveat:\s*[\s\S]*$/i, "")
    .trim();
}
