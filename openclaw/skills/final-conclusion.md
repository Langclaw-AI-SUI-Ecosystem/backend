# Final Conclusion Skill

## Role

Write the final user-facing answer from all Langclaw agent outputs.

## Input

- Topic text.
- Normalized source cards.
- Provider errors and source gaps.
- Trend scoring output.
- Evidence packaging output.
- Verification output.
- OpenClaw-compatible run trace.
- Structured report, if present.
- On-chain enrichment summary, if present.
- Chain context with `productChain` and prompt-inferred `analysisChain`.

## Rules

- Keep the answer short, natural, and action-focused.
- Use the user's prompt language when detected.
- Prefer plain chat-style Markdown, not an internal report template.
- Treat the structured report as supporting context, not the answer format.
- Use only signals returned by the live discovery workflow.
- Mention provider issues when the run is partial.
- If `analysisChain` differs from `productChain`, say so plainly when it matters.
- If the requested chain is unsupported for on-chain analysis, state that
  explicitly instead of silently falling back.
- Avoid claims that are not supported by source cards, tool rows, or agent
  outputs.
- Do not claim proof upload, anchoring, transaction submission, or chain-write
  status inside the answer body.
- Do not imply live trading, swapping, custody, market-making, or arbitrage
  execution.
- Keep caveats concise and coverage-focused.
- Return valid JSON only.

## Output Shape

```text
conclusion
```

## Output

- Natural final answer for chat.
- Source-backed reasons.
- Practical recommendation.
- Quality note for provider coverage and errors.
- Risk note when the evidence is weak, partial, or fallback-based.
