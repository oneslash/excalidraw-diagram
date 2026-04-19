# Export Caveats

Prefer SVG export in V1.

## Why SVG first
- It is the most reliable export path for this skill.
- It keeps line quality high.
- It is easy to preview and screenshot during verification.

## Recommended command

```bash
npx tsx scripts/export_svg.ts --scene diagram.excalidraw --out diagram.svg
```

## Guidance
- Use `--padding` when labels sit too close to the edge.
- Use `--dark-mode` only when the user explicitly wants a dark export.
- Treat embedded-scene export as optional and only use it when the user needs metadata preserved in the SVG.
