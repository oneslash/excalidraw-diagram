import {
  getSizedNode,
  mergeDocument,
  type DocumentSpec,
  type SceneCalloutSpec,
  type SceneEdgeSpec,
  type SceneFrameSpec,
  type SceneNodeSpec,
  type SceneOutcomeRowSpec,
  type SceneSpec,
  type SceneSwimlaneSpec,
} from "./scene_spec.js";

export type LayoutEngine = "legacy" | "elk";

export type LayoutGraphNode = SceneNodeSpec & {
  width: number;
  height: number;
  order: number;
  laneOrder: number;
  rowIndex: number | null;
  columnIndex: number | null;
};

export type LayoutGraphEdge = SceneEdgeSpec & {
  id: string;
  order: number;
};

export type LayoutGraph = {
  document: Required<DocumentSpec>;
  nodes: LayoutGraphNode[];
  edges: LayoutGraphEdge[];
  frames: SceneFrameSpec[];
  swimlanes: SceneSwimlaneSpec[];
  callouts: SceneCalloutSpec[];
  usesRichFlowchartPrimitives: boolean;
  hasGridHints: boolean;
};

export type LayoutSelection = {
  engine: LayoutEngine;
  reason: string;
};

export const assignOutcomeRowsToNodes = (
  nodes: SceneSpec["nodes"],
  outcomeRows: SceneOutcomeRowSpec[],
): void => {
  if (!nodes || outcomeRows.length === 0) {
    return;
  }

  const nodeMap = new Map(nodes.map((node) => [node.id, node]));
  for (const row of outcomeRows) {
    const parent = nodeMap.get(row.parent);
    const baseRow = Number(parent?.row ?? 0) + 1;
    const baseColumn = Number(parent?.column ?? 0);
    row.children.forEach((childId, index) => {
      const child = nodeMap.get(childId);
      if (!child) {
        return;
      }
      child.row = child.row ?? baseRow;
      child.column = child.column ?? (baseColumn + index);
      if (row.lane && !child.lane) {
        child.lane = row.lane;
      }
    });
  }
};

const getLaneOrderMap = (swimlanes: SceneSwimlaneSpec[], nodes: SceneNodeSpec[]): Map<string, number> => {
  const laneOrder = new Map<string, number>();
  swimlanes.forEach((lane, index) => {
    laneOrder.set(lane.id, index);
  });
  for (const node of nodes) {
    const laneId = node.lane ?? node.customData?.lane;
    if (!laneId || laneOrder.has(laneId)) {
      continue;
    }
    laneOrder.set(laneId, laneOrder.size);
  }
  return laneOrder;
};

export const buildLayoutGraph = (input: {
  nodes: SceneNodeSpec[];
  edges: SceneEdgeSpec[];
  frames: SceneFrameSpec[];
  swimlanes: SceneSwimlaneSpec[];
  callouts: SceneCalloutSpec[];
  document?: DocumentSpec;
  usesRichFlowchartPrimitives: boolean;
}): LayoutGraph => {
  const document = mergeDocument(input.document);
  const laneOrder = getLaneOrderMap(input.swimlanes, input.nodes);
  const nodes = input.nodes.map((node, index) => {
    const sized = getSizedNode(node, document);
    const laneId = sized.lane ?? sized.customData?.lane;
    return {
      ...sized,
      width: Number(sized.width ?? document.nodeWidth),
      height: Number(sized.height ?? document.nodeHeight),
      order: index,
      laneOrder: laneId ? (laneOrder.get(laneId) ?? laneOrder.size) : Number.MAX_SAFE_INTEGER,
      rowIndex: sized.row === undefined ? null : Number(sized.row),
      columnIndex: sized.column === undefined ? null : Number(sized.column),
    };
  });
  const edges = input.edges.map((edge, index) => ({
    ...edge,
    id: edge.id ?? `${edge.from}->${edge.to}#${index + 1}`,
    order: index,
  }));

  return {
    document,
    nodes,
    edges,
    frames: input.frames,
    swimlanes: input.swimlanes,
    callouts: input.callouts,
    usesRichFlowchartPrimitives: input.usesRichFlowchartPrimitives,
    hasGridHints: nodes.some((node) => node.rowIndex !== null || node.columnIndex !== null),
  };
};

export const selectLayoutEngine = (graph: LayoutGraph): LayoutSelection => {
  if (graph.document.layout === "manual") {
    return {
      engine: "legacy",
      reason: "manual layout remains on the deterministic legacy path",
    };
  }

  if (graph.swimlanes.length > 0) {
    return {
      engine: "legacy",
      reason: "swimlane diagrams stay on the tuned legacy path until ELK lane banding is cleaner",
    };
  }

  if (graph.document.preset === "clean-flowchart" && graph.nodes.length >= 4) {
    return {
      engine: "elk",
      reason: "clean-flowchart scenes now prefer ELK as the primary layout engine",
    };
  }

  if (graph.hasGridHints && graph.edges.length >= 3) {
    return {
      engine: "elk",
      reason: "row or column hints plus multiple edges benefit from layered graph layout",
    };
  }

  if (graph.nodes.length >= 6 && graph.edges.length >= 5) {
    return {
      engine: "elk",
      reason: "larger connected diagrams benefit from graph-aware layout before repair",
    };
  }

  return {
    engine: "legacy",
    reason: "small scenes stay on the lighter deterministic layout path",
  };
};
