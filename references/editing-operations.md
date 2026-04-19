# Editing Operations

Use structured patch specs for deterministic scene edits.

## Structure

```json
{
  "operations": [
    { "op": "rename", "id": "db", "label": "Aurora Cluster" },
    { "op": "move", "id": "db", "x": 620, "y": 260 },
    { "op": "set-style", "id": "db", "style": { "backgroundColor": "#fff4d6" } },
    { "op": "add-node", "node": { "id": "queue", "kind": "rectangle", "label": "Queue", "x": 430, "y": 260 } },
    { "op": "connect", "id": "api-queue", "from": "api", "to": "queue", "label": "enqueue" },
    { "op": "frame", "id": "backend-frame", "name": "Backend", "children": ["api", "db", "queue"] },
    { "op": "delete", "id": "old-cache" }
  ]
}
```

## Supported operations
- `rename`
- `move`
- `set-style`
- `add-node`
- `connect`
- `frame`
- `delete`

## Rules
- Use stable IDs.
- Prefer a new `connect` operation over trying to mutate raw arrow geometry.
- Use `frame` to group existing nodes visually.
- Use `set-style` only for a small set of visible style changes.
- Do not use arbitrary raw element mutation in V1.

## After editing
- Prefer `edit_scene.ts --verify` so the skill exports the result, captures a preview screenshot, and surfaces any obvious visual issues before returning.
