import ElkBundled from "elkjs/lib/elk.bundled.js";
import type { ELK as ElkInterface, ElkExtendedEdge, ElkNode, ElkPoint } from "elkjs/lib/elk-api.js";

import type { LayoutGraph, LayoutGraphEdge, LayoutGraphNode } from "./layout_graph.js";
import type { GenericRecord, SceneEdgeSpec, SceneFrameSpec, SceneNodeSpec } from "./scene_spec.js";

const ELKConstructor = ElkBundled as unknown as { new (): ElkInterface };
const elk = new ELKConstructor();

const getDirection = (graph: LayoutGraph): "RIGHT" | "DOWN" => {
  return graph.document.layout === "flow-down" ? "DOWN" : "RIGHT";
};

const getLaneId = (node: LayoutGraphNode, graph: LayoutGraph): string | null => {
  if (node.lane) {
    return node.lane;
  }
  const customLane = node.customData?.lane;
  if (typeof customLane === "string" && customLane.length > 0) {
    return customLane;
  }
  const owningLane = graph.swimlanes.find((lane) => (lane.children ?? []).includes(node.id));
  return owningLane?.id ?? null;
};

const getOrderedNodes = (graph: LayoutGraph): LayoutGraphNode[] => {
  const direction = getDirection(graph);
  return [...graph.nodes].sort((left, right) => {
    if (left.laneOrder !== right.laneOrder) {
      return left.laneOrder - right.laneOrder;
    }

    const leftPrimary = direction === "RIGHT" ? (left.columnIndex ?? left.order) : (left.rowIndex ?? left.order);
    const rightPrimary = direction === "RIGHT" ? (right.columnIndex ?? right.order) : (right.rowIndex ?? right.order);
    if (leftPrimary !== rightPrimary) {
      return leftPrimary - rightPrimary;
    }

    const leftSecondary = direction === "RIGHT" ? (left.rowIndex ?? left.order) : (left.columnIndex ?? left.order);
    const rightSecondary = direction === "RIGHT" ? (right.rowIndex ?? right.order) : (right.columnIndex ?? right.order);
    if (leftSecondary !== rightSecondary) {
      return leftSecondary - rightSecondary;
    }

    return left.order - right.order;
  });
};

const buildElkRoot = (graph: LayoutGraph, orderedNodes: LayoutGraphNode[]): ElkNode => {
  const direction = getDirection(graph);
  const layerGap = direction === "RIGHT" ? graph.document.gapX : graph.document.gapY;
  const siblingGap = direction === "RIGHT" ? graph.document.gapY : graph.document.gapX;

  const children: ElkNode[] = orderedNodes.map((node) => ({
    id: node.id,
    width: node.width,
    height: node.height,
  }));
  const edges: ElkExtendedEdge[] = graph.edges.map((edge) => ({
    id: edge.id,
    sources: [edge.from],
    targets: [edge.to],
  }));

  return {
    id: "root",
    layoutOptions: {
      "elk.algorithm": "layered",
      "elk.direction": direction,
      "elk.edgeRouting": "ORTHOGONAL",
      "elk.spacing.nodeNode": String(Math.max(32, siblingGap)),
      "org.eclipse.elk.layered.spacing.nodeNodeBetweenLayers": String(Math.max(48, layerGap)),
      "org.eclipse.elk.layered.considerModelOrder.strategy": "NODES_AND_EDGES",
      "org.eclipse.elk.layered.crossingMinimization.forceNodeModelOrder": "true",
      "org.eclipse.elk.padding": `[top=${graph.document.padding},left=${graph.document.padding},bottom=${graph.document.padding},right=${graph.document.padding}]`,
    },
    children,
    edges,
  };
};

const collectEdgeRoutes = (edges: ElkExtendedEdge[] | undefined): Map<string, ElkPoint[]> => {
  const routes = new Map<string, ElkPoint[]>();
  for (const edge of edges ?? []) {
    const sections = Array.isArray(edge.sections) ? edge.sections : [];
    if (sections.length === 0 || !edge.id) {
      continue;
    }
    const points: ElkPoint[] = [];
    for (const section of sections) {
      points.push(section.startPoint);
      for (const bend of section.bendPoints ?? []) {
        points.push(bend);
      }
      points.push(section.endPoint);
    }
    const deduped = points.filter((point, index) => {
      const previous = points[index - 1];
      return !previous || previous.x !== point.x || previous.y !== point.y;
    });
    if (deduped.length >= 2) {
      routes.set(edge.id, deduped);
    }
  }
  return routes;
};

const normalizeUngroupedNodes = (
  graph: LayoutGraph,
  laidOutNodes: LayoutGraphNode[],
  routePoints: Map<string, ElkPoint[]>,
): { nodes: SceneNodeSpec[]; edges: SceneEdgeSpec[]; frames: SceneFrameSpec[]; report: GenericRecord } => {
  const minX = Math.min(...laidOutNodes.map((node) => Number(node.x ?? 0)));
  const minY = Math.min(...laidOutNodes.map((node) => Number(node.y ?? 0)));
  const xShift = graph.document.padding - minX;
  const yShift = graph.document.padding - minY;

  const nodes = laidOutNodes.map((node) => ({
    ...node,
    x: Math.round(Number(node.x ?? 0) + xShift),
    y: Math.round(Number(node.y ?? 0) + yShift),
  }));
  const edges = graph.edges.map((edge) => {
    const points = routePoints.get(edge.id);
    return {
      ...edge,
      customData: points && points.length >= 2
        ? {
            ...(edge.customData ?? {}),
            routePoints: points.map((point) => ({
              x: Math.round(point.x + xShift),
              y: Math.round(point.y + yShift),
            })),
          }
        : edge.customData,
    };
  });

  return {
    nodes,
    edges,
    frames: graph.frames,
    report: {
      layoutEngine: "elk",
      usedSwimlaneBands: false,
      routePointCount: [...routePoints.values()].reduce((sum, points) => sum + points.length, 0),
    },
  };
};

const normalizeSwimlaneNodes = (
  graph: LayoutGraph,
  laidOutNodes: LayoutGraphNode[],
  routePoints: Map<string, ElkPoint[]>,
): { nodes: SceneNodeSpec[]; edges: SceneEdgeSpec[]; frames: SceneFrameSpec[]; report: GenericRecord } => {
  const laneIdsInOrder = graph.swimlanes.map((lane) => lane.id);
  const laneMembership = new Map<string, string | null>(laidOutNodes.map((node) => [node.id, getLaneId(node, graph)]));
  const globalMinX = Math.min(...laidOutNodes.map((node) => Number(node.x ?? 0)));
  const positioned: SceneNodeSpec[] = [];
  const frames: SceneFrameSpec[] = [...graph.frames];
  const laneShifts = new Map<string, { xShift: number; yShift: number }>();
  let currentBand = graph.document.padding;

  const isVerticalFlow = getDirection(graph) === "DOWN";

  for (const lane of graph.swimlanes) {
    const laneNodes = laidOutNodes.filter((node) => laneMembership.get(node.id) === lane.id);
    if (laneNodes.length === 0) {
      continue;
    }

    const laneMinX = Math.min(...laneNodes.map((node) => Number(node.x ?? 0)));
    const laneMinY = Math.min(...laneNodes.map((node) => Number(node.y ?? 0)));
    const laneMaxX = Math.max(...laneNodes.map((node) => Number(node.x ?? 0) + node.width));
    const laneMaxY = Math.max(...laneNodes.map((node) => Number(node.y ?? 0) + node.height));
    const bandStart = isVerticalFlow ? (lane.x ?? currentBand) : (lane.y ?? currentBand);
    const xShift = isVerticalFlow
      ? bandStart + 32 - laneMinX
      : graph.document.padding + 32 - globalMinX;
    const yShift = isVerticalFlow
      ? graph.document.padding + graph.document.laneHeaderHeight + 28 - Math.min(...laidOutNodes.map((node) => Number(node.y ?? 0)))
      : bandStart + graph.document.laneHeaderHeight + 28 - laneMinY;
    laneShifts.set(lane.id, { xShift, yShift });

    positioned.push(...laneNodes.map((node) => ({
      ...node,
      x: Math.round(Number(node.x ?? 0) + xShift),
      y: Math.round(Number(node.y ?? 0) + yShift),
      customData: {
        ...(node.customData ?? {}),
        lane: lane.id,
      },
    })));

    frames.push({
      id: lane.id,
      name: lane.label,
      children: laneNodes.map((node) => node.id),
      style: lane.style,
      customData: {
        ...(lane.customData ?? {}),
        role: "swimlane",
      },
    });

    const bandSize = isVerticalFlow
      ? Math.max(graph.document.nodeWidth, laneMaxX - laneMinX) + graph.document.laneHeaderHeight + 64
      : Math.max(graph.document.nodeHeight, laneMaxY - laneMinY) + graph.document.laneHeaderHeight + 64;
    currentBand = bandStart + bandSize + graph.document.laneGap;
  }

  const unassignedNodes = laidOutNodes.filter((node) => !laneIdsInOrder.includes(laneMembership.get(node.id) ?? ""));
  if (unassignedNodes.length > 0) {
    const unassignedMinX = Math.min(...unassignedNodes.map((node) => Number(node.x ?? 0)));
    const unassignedMinY = Math.min(...unassignedNodes.map((node) => Number(node.y ?? 0)));
    const xShift = isVerticalFlow
      ? currentBand + 32 - unassignedMinX
      : graph.document.padding + 32 - globalMinX;
    const yShift = isVerticalFlow
      ? graph.document.padding + 32 - unassignedMinY
      : currentBand + 32 - unassignedMinY;
    positioned.push(...unassignedNodes.map((node) => ({
      ...node,
      x: Math.round(Number(node.x ?? 0) + xShift),
      y: Math.round(Number(node.y ?? 0) + yShift),
    })));
  }

  const edges = graph.edges.map((edge) => {
    const fromLane = laneMembership.get(edge.from);
    const toLane = laneMembership.get(edge.to);
    const points = routePoints.get(edge.id);
    const laneShift = fromLane && fromLane === toLane ? laneShifts.get(fromLane) : null;
    return {
      ...edge,
      customData: laneShift && points && points.length >= 2
        ? {
            ...(edge.customData ?? {}),
            routePoints: points.map((point) => ({
              x: Math.round(point.x + laneShift.xShift),
              y: Math.round(point.y + laneShift.yShift),
            })),
          }
        : edge.customData,
    };
  });

  return {
    nodes: positioned,
    edges,
    frames,
    report: {
      layoutEngine: "elk",
      usedSwimlaneBands: true,
      swimlaneCount: graph.swimlanes.length,
      routePointCount: edges.reduce((sum, edge) => (
        sum + (Array.isArray(edge.customData?.routePoints) ? edge.customData.routePoints.length : 0)
      ), 0),
    },
  };
};

export const layoutGraphWithElk = async (graph: LayoutGraph): Promise<{
  nodes: SceneNodeSpec[];
  edges: SceneEdgeSpec[];
  frames: SceneFrameSpec[];
  report: GenericRecord;
}> => {
  const orderedNodes = getOrderedNodes(graph);
  const laidOut = await elk.layout(buildElkRoot(graph, orderedNodes));
  const laidOutChildren = Array.isArray(laidOut.children) ? laidOut.children : [];
  const laidOutNodes = orderedNodes.map((node) => {
    const positioned = laidOutChildren.find((candidate: ElkNode) => candidate.id === node.id);
    return {
      ...node,
      x: Number(positioned?.x ?? 0),
      y: Number(positioned?.y ?? 0),
      width: Number(positioned?.width ?? node.width),
      height: Number(positioned?.height ?? node.height),
    };
  });
  const routePoints = collectEdgeRoutes(laidOut.edges);
  const normalized = graph.swimlanes.length > 0
    ? normalizeSwimlaneNodes(graph, laidOutNodes, routePoints)
    : normalizeUngroupedNodes(graph, laidOutNodes, routePoints);

  return {
    nodes: normalized.nodes,
    edges: normalized.edges,
    frames: normalized.frames,
    report: {
      ...normalized.report,
      direction: getDirection(graph),
      nodeCount: graph.nodes.length,
      edgeCount: graph.edges.length,
    },
  };
};
