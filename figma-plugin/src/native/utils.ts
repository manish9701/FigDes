export function resolve(id: string | null | undefined): BaseNode {
  if (!id || id === 'page') return figma.currentPage;
  const n = figma.getNodeById(id);
  if (!n) throw new Error(`Node ${id} not found`);
  return n;
}

export function asScene(n: BaseNode): SceneNode {
  if (n.type === 'PAGE' || n.type === 'DOCUMENT') throw new Error('Expected a SceneNode');
  return n as SceneNode;
}

export function serialize(n: BaseNode) {
  if (n.type === 'PAGE' || n.type === 'DOCUMENT') return { id: n.id, type: n.type, name: n.name };
  const sn = n as SceneNode;
  return { id: sn.id, type: sn.type, name: sn.name, x: sn.x, y: sn.y, width: sn.width, height: sn.height };
}
