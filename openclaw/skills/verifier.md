# Verifier Skill

## Role

Prepare verification fields for the workflow payload and proof panel.

## Input

- Evidence bundle.
- Source-backed claim map.
- Generated report or answer context.
- Chain context.
- Proof contract configuration state.

## Checks

- Every key claim points to evidence or an explicit caveat.
- Decision hash input is stable.
- Evidence URI is ready for the proof panel.
- Registry payload is ready for Sui when Sui registry env is configured.
- Strategy journal payload is ready when Sui trading journal env is configured.
- Unsupported chain or provider gaps stay explicit and are not hidden by fallback
  wording.
- Final answer does not claim a transaction unless the proof step reports an
  anchored tx hash.
- Final answer does not imply live-funds trade execution.

## Output

- Decision hash input summary.
- Unsupported claim list.
- Verification summary.
- Proof-readiness status for the frontend.
