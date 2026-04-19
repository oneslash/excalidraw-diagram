# Compact Scene Spec

Use this JSON shape when creating new diagrams from prose or structured notes.

## Core Structure

```json
{
  "document": {
    "layout": "flow-right",
    "preset": "clean-flowchart",
    "theme": "light",
    "background": "#f7fafc",
    "padding": 64,
    "gapX": 96,
    "gapY": 72,
    "nodeWidth": 180,
    "nodeHeight": 84,
    "wrapAt": 4,
    "laneGap": 88,
    "laneHeaderHeight": 44,
    "calloutGap": 32,
    "maxWarnings": 0,
    "minimumEditableElements": 2
  },
  "nodes": [
    { "id": "request", "role": "terminator", "label": "Request received", "lane": "intake", "row": 0, "column": 0 },
    { "id": "decision", "role": "branch-split", "label": "Retryable?", "lane": "processing", "row": 0, "column": 0 },
    { "id": "worker", "role": "process", "label": "Run worker", "lane": "processing", "row": 1, "column": 0 },
    { "id": "done", "role": "merge-point", "label": "Done", "lane": "processing", "row": 2, "column": 1 }
  ],
  "edges": [
    { "id": "request-decision", "from": "request", "to": "decision", "label": "validated" },
    { "id": "decision-worker", "from": "decision", "to": "worker", "label": "yes" },
    { "id": "worker-done", "from": "worker", "to": "done", "label": "served" }
  ],
  "swimlanes": [
    { "id": "intake", "label": "Intake" },
    { "id": "processing", "label": "Processing" }
  ],
  "outcomeRows": [
    { "id": "decision-outcomes", "parent": "decision", "children": ["worker", "done"] }
  ],
  "callouts": [
    { "id": "sla-note", "target": "done", "label": "Target response time: 250 ms", "placement": "right" }
  ]
}
```

## Supported Document Fields

- `layout`
  - `flow-right`
  - `flow-down`
  - `manual`
- `preset`
  - `default`
  - `clean-flowchart`
- `theme`
  - `light`
  - `dark`
- `background`
- `padding`
- `gapX`
- `gapY`
- `nodeWidth`
- `nodeHeight`
- `wrapAt`
- `laneGap`
- `laneHeaderHeight`
- `calloutGap`
- `maxWarnings`
- `minimumEditableElements`

## Supported Node Kinds

- `rectangle`
- `ellipse`
- `diamond`
- `text`

## Supported Node Roles

Roles are the preferred way to describe process diagrams because they map to better defaults than raw kinds.

- `process`
- `terminator`
- `decision`
- `data`
- `branch-split`
- `merge-point`
- `callout`

## Supported Node Fields

- `id`
- `kind`
- `role`
- `label`
- `x`
- `y`
- `width`
- `height`
- `lane`
- `row`
- `column`
- `style`
- `customData`

## Supported Higher-Level Flowchart Primitives

### `swimlanes`

Use swimlanes to group nodes into named horizontal bands. Nodes can reference a lane by `lane`, or the lane can list `children`.

```json
{
  "swimlanes": [
    { "id": "intake", "label": "Intake" },
    { "id": "processing", "label": "Processing", "children": ["decision", "worker", "done"] }
  ]
}
```

### `outcomeRows`

Use outcome rows for branch-heavy diagrams where multiple outcomes should align as a structured row instead of being hand-placed.

```json
{
  "outcomeRows": [
    { "id": "decision-outcomes", "parent": "decision", "children": ["worker", "retry", "done"] }
  ]
}
```

### `callouts`

Use callouts for policy notes, SLA notes, rollout notes, or operator guidance that should stay near a target node.

```json
{
  "callouts": [
    { "id": "sla-note", "target": "done", "label": "Escalate after 5 minutes", "placement": "bottom" }
  ]
}
```

Supported `placement` values:

- `right`
- `left`
- `top`
- `bottom`

## Guidance

- Supply stable `id` values. Later patch operations refer to these IDs.
- Prefer `role` over raw `kind` for flowcharts. It gives better defaults for sizing and shape choice.
- Prefer `document.preset: "clean-flowchart"` for operational flows, swimlane diagrams, decision trees, and process runbooks.
- Use `swimlanes`, `outcomeRows`, and `callouts` before falling back to manual `x` and `y`.
- Omit `x` and `y` when the built-in flow layout is good enough.
- Add `x` and `y` only when a node truly needs an exact position.
- Keep labels short when possible, but long labels are now auto-widened during create and repair.
- Manual layouts are still respected, but the create step may nudge overlaps, reroute edges, and rebalance lanes before it accepts the result.
- If verification still fails after auto-repair, treat that as a real diagram failure and revise the spec.
