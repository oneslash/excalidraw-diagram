# Mermaid Notes

Use Mermaid as a convert-in format, not as the canonical persisted format.

## V1 promise
- Support Mermaid flowcharts well.
- Refuse non-flowcharts clearly.
- Reject non-editable results. A single embedded image is not acceptable output.

## Recommended command

```bash
npx tsx scripts/convert_mermaid.ts --input diagram.mmd --out diagram.excalidraw --verify
```

## Guidance
- If the Mermaid input does not look like a flowchart, fail clearly and suggest rewriting it as a flowchart or using SceneSpec.
- If conversion falls back to an image or produces too little editable geometry, fail instead of returning it.
- When the Mermaid input is intended to become an operational flow, prefer the clean flowchart preset after conversion.
- Verify the preview PNG after conversion because Mermaid layout can still produce awkward labels or spacing.
