export type StrategyAction = "buy" | "sell" | "hold" | "exit";

export type StrategyRecordStatus =
  | "backtested"
  | "paper-opened"
  | "paper-closed";

export type StrategyBacktestParams = {
  initialCapitalUsd: number;
  maxHoldHours: number;
  minLiquidityUsd: number;
  minMomentumBps: number;
  minVolumeMultiple: number;
  stopLossBps: number;
  takeProfitBps: number;
};

export type StrategyMarketBar = {
  liquidityUsd: number;
  netWhaleFlowUsd?: number;
  pairAddress: string;
  priceUsd: number;
  timestamp: string;
  txCount?: number;
  volumeUsd: number;
};

export type StrategyTrade = {
  entryAt: string;
  entryPriceUsd: number;
  exitAt: string;
  exitPriceUsd: number;
  holdHours: number;
  pnlBps: number;
  pnlUsd: number;
  reason: string;
};

export type StrategyEquityPoint = {
  equityUsd: number;
  timestamp: string;
};

export type StrategyMetrics = {
  finalEquityUsd: number;
  initialCapitalUsd: number;
  maxDrawdownBps: number;
  totalPnlBps: number;
  totalPnlUsd: number;
  tradeCount: number;
  winRate: number;
};

export type StrategySignal = {
  action: StrategyAction;
  confidence: number;
  liquidityUsd: number;
  momentumBps: number;
  priceUsd: number;
  rationale: string;
  volumeUsd: number;
};

export type TradingJournalProof = {
  action: StrategyAction;
  agentId: string;
  chain: string;
  chainId: number;
  chainName?: string;
  decisionHash: string;
  error?: string;
  evidenceUri: string;
  explorerUrl?: string;
  journalAddress?: string;
  pnlBps: number;
  recordId?: string;
  resultHash: string;
  status: "anchored" | "failed" | "pending" | "prepared";
  strategyStatus: StrategyRecordStatus;
  txHash?: string;
};

export type StrategyBacktestPayload = {
  bars: StrategyMarketBar[];
  chain: string;
  chainId: number;
  chainName: string;
  equityCurve: StrategyEquityPoint[];
  generatedAt: string;
  latestSignal: StrategySignal;
  market: string;
  metrics: StrategyMetrics;
  pairAddress: string;
  params: StrategyBacktestParams;
  proof?: TradingJournalProof;
  queryId: string;
  runId: string;
  sourceUrl: string;
  strategyId: string;
  title: string;
  trades: StrategyTrade[];
};

export type StrategyScanCandidate = {
  latestSignal: StrategySignal;
  latestTimestamp: string;
  market: string;
  metrics: StrategyMetrics;
  pairAddress: string;
  rank: number;
  rowCount: number;
  score: number;
  scoreReason: string;
  totalVolumeUsd: number;
};

export type StrategyScanPayload = {
  bestBacktest: StrategyBacktestPayload;
  chain: string;
  chainId: number;
  chainName: string;
  candidates: StrategyScanCandidate[];
  generatedAt: string;
  queryId: string;
  scannedPairs: number;
  selectedPairAddress: string;
  sourceUrl: string;
};

export type StrategyPaperTradePayload = {
  action: StrategyAction;
  chain: string;
  chainId: number;
  chainName: string;
  confidence: number;
  generatedAt: string;
  market: string;
  notionalUsd: number;
  pairAddress: string;
  proof: TradingJournalProof;
  rationale: string;
  referenceBacktestRunId: string;
  runId: string;
  strategyId: string;
};

export type StrategyRunRecord = {
  action: StrategyAction;
  agentId: string;
  chain?: string;
  chainId?: number;
  chainName?: string;
  createdAt: string;
  decisionHash: string;
  evidenceUri: string;
  explorerUrl?: string;
  market: string;
  pnlBps: number;
  recordId: string;
  recorder: string;
  resultHash: string;
  runId: string;
  status: StrategyRecordStatus;
  strategyId: string;
  txHash?: string;
};

export type StrategyRunsPayload = {
  chain: string;
  chainId: number;
  chainName: string;
  configured: boolean;
  error?: string;
  journalAddress?: string;
  nextRecordId: string;
  records: StrategyRunRecord[];
};
