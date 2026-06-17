# Source Normalizer Skill

## Role

Normalize every discovered item into the Langclaw `SourceCard` model.

## Input

- Raw social posts or public web results.
- Raw GitHub repositories.
- Raw docs pages.
- Raw HackQuest pages.
- Provider-specific evidence rows or source URLs when exposed by TypeScript
  tools.

## Output Shape

```text
id
type
title
url
author
publishedAt
excerpt
metrics
provider
```

## Rules

- Deduplicate by stable URL or source ID.
- Keep excerpts short and factual.
- Preserve provider names exactly as returned by the TypeScript layer.
- Do not transform provider errors into source cards.
- Keep Sui-specific evidence tied to Sui source URLs or tool IDs.

## Output

- Deduplicated source cards.
- Provider-specific metadata.
- Clean excerpts for evidence storage.
- Neutral source records that can support either a report or a chat answer.
