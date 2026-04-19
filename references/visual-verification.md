# Visual Verification

Always verify generated or edited diagrams before returning them.

## Recommended pattern

```bash
npx tsx scripts/create_scene.ts --spec spec.json --out diagram.excalidraw --verify
```

or

```bash
npx tsx scripts/verify_scene.ts --scene diagram.excalidraw
```

## What verification does
- exports the scene to SVG
- captures a PNG preview screenshot from the SVG
- writes a JSON verification report
- runs scene inspection to surface obvious structural issues
- hard-fails blank scenes, image-only scenes, detached bindings, and suspiciously low editable geometry counts
- flags sparse layouts, crowded labels, overlaps, detached arrows, crossings, and frame containment issues

## What you still need to inspect manually
- labels are readable
- arrows point to the intended shapes
- frames wrap the intended nodes
- the diagram is not clipped or strangely spaced

## Return behavior
- If the preview looks wrong, revise the scene and verify again.
- If verification fails, treat that as a real build failure unless you intentionally passed a warning budget such as `--max-warnings 5` for a stress case.
- Do not declare the diagram finished until the preview PNG looks good.
