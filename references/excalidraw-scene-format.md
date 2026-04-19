# Excalidraw Scene Format

Use `.excalidraw` JSON as the canonical persisted format.

## Expected top-level keys
- `type`
- `version`
- `source`
- `elements`
- `appState`
- `files`

## Input flavors
- Normal scene: `type: "excalidraw"`
- Clipboard JSON: `type: "excalidraw/clipboard"`
- Library JSON: `type: "excalidrawlib"`

## Practical guidance
- Normalize clipboard JSON into a full scene before saving.
- Treat `files` as part of the scene contract whenever image elements are present.
- Do not assume a hand-edited scene contains all defaults. Run repair or restore before export.
- Preserve `customData` unless the user explicitly asks to remove it.

## What the scripts do
- `repair_scene.ts` restores missing defaults and can normalize clipboard JSON into a scene.
- `inspect_scene.ts` reports duplicate IDs, missing file references, invisible elements, and frame or binding issues.
- `verify_scene.ts` exports the normalized scene to SVG, captures a PNG preview, and writes a verification report.
