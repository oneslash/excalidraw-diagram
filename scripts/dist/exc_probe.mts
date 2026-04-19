import { convertToExcalidrawElements } from '@excalidraw/excalidraw';
const elements = convertToExcalidrawElements([
  { type: 'rectangle', id: 'a', x: 0, y: 0, label: { text: 'This is a long label that should wrap a bit' }, strokeColor: '#000', backgroundColor: 'transparent' },
  { type: 'diamond', id: 'b', x: 0, y: 0, label: { text: 'Decision?' }, strokeColor: '#000', backgroundColor: 'transparent' },
  { type: 'ellipse', id: 'c', x: 0, y: 0, label: { text: 'Start and end' }, strokeColor: '#000', backgroundColor: 'transparent' },
], { regenerateIds: false });
const summary = elements.map((e) => ({
  id: e.id,
  type: e.type,
  x: e.x,
  y: e.y,
  width: (e as any).width,
  height: (e as any).height,
  containerId: (e as any).containerId,
  text: e.type === 'text' ? (e as any).text : undefined,
}));
console.log(JSON.stringify(summary, null, 2));
