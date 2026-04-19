---
name: excalidraw-diagram
description: Create, edit, convert, repair, inspect, verify, and export Excalidraw diagrams and `.excalidraw` scene files. Use this skill when a request mentions Excalidraw, `.excalidraw` or Excalidraw clipboard JSON, Mermaid-to-Excalidraw conversion, scene normalization or repair, visual verification of generated diagrams, or exporting Excalidraw diagrams to SVG. Do not use it for React or Next.js embedding, app integration, or collaboration server work.
---

Use this skill for deterministic, file-based Excalidraw work.

## Default workflow
1. Identify the input:
   - prose intent only
   - compact scene spec JSON
   - existing `.excalidraw` scene
   - Excalidraw clipboard JSON
   - Mermaid flowchart
2. If the input is an existing scene, inspect it first with `scripts/inspect_scene.ts`.
3. Choose the main script:
   - `scripts/create_scene.ts` for new diagrams from the compact scene spec
   - `scripts/edit_scene.ts` for deterministic edits to an existing scene
   - `scripts/repair_scene.ts` for normalization and repair
   - `scripts/convert_mermaid.ts` for Mermaid flowcharts
   - `scripts/export_svg.ts` for SVG export only
4. Always verify graph output before declaring success:
   - pass `--verify` to `create_scene.ts`, `edit_scene.ts`, `repair_scene.ts`, or `convert_mermaid.ts`, or run `scripts/verify_scene.ts`
   - verification exports SVG, captures a PNG preview screenshot, and writes a verification JSON report
   - verification is now a gate, not a hint: blank scenes, image-only scenes, detached bindings, and too-few editable elements fail by default
   - use `--max-warnings` only when you intentionally want to inspect a known-bad stress case
   - inspect the PNG preview with the available image tools and confirm it looks right
5. Keep the source `.excalidraw` file unless the user explicitly asked for export only.

## Rules
- Prefer the compact scene spec in `references/compact-scene-spec.md` for new diagrams.
- Prefer the patch operations in `references/editing-operations.md` for edits.
- Treat raw `.excalidraw` JSON as the source of truth for edit, repair, inspect, verify, and export tasks.
- Preserve element IDs unless the task requires regeneration.
- Preserve the `files` map whenever image elements are present.
- Preserve `customData` unless the task explicitly removes it.
- After text changes that affect layout, run repair with refreshed text dimensions or use the built-in `--verify` pass.
- Mermaid conversion is flowchart-only. If the input is not a Mermaid flowchart, refuse clearly and suggest rewriting it as a flowchart or using `create_scene.ts` with a SceneSpec.
- Mermaid flowchart conversion must fail if conversion collapses into an image fallback or otherwise loses editable geometry.
- Prefer `document.preset: "clean-flowchart"` for process diagrams, swimlanes, operational runbooks, and dense architecture flows.
- Use the richer flowchart primitives in `references/compact-scene-spec.md` instead of hand-placing everything:
  - `swimlanes`
  - `outcomeRows`
  - `callouts`
  - node `role` values like `branch-split`, `merge-point`, and `terminator`
- Treat verification warnings about sparse layouts, crowded labels, detached arrows, crossings, or frame containment as real issues to address before returning a diagram.
- `create_scene.ts` and `repair_scene.ts` will try iterative cleanup before failing:
  - widen crowded containers
  - reroute edges
  - rebalance swimlane / frame children
- Manual-positioned create specs may be gently nudged to resolve obvious overlaps during scene creation.
- Prefer SVG export in V1.
- Do not use this skill for embedding Excalidraw in React or Next.js applications.

## References
- `references/excalidraw-scene-format.md`
- `references/compact-scene-spec.md`
- `references/editing-operations.md`
- `references/mermaid-notes.md`
- `references/export-caveats.md`
- `references/visual-verification.md`

## Validation
Run `python3 scripts/quick_validate.py .` after changing this skill.
