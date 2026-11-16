import type { LayoutItem } from '../api/contracts.js';

export function layoutExtents(item: LayoutItem) {
  const angle = item.rotation * Math.PI / 180;
  return {
    halfWidth: (Math.abs(Math.cos(angle)) * item.width * 3 + Math.abs(Math.sin(angle)) * item.height * 4) / 6,
    halfHeight: (Math.abs(Math.sin(angle)) * item.width * 3 + Math.abs(Math.cos(angle)) * item.height * 4) / 8
  };
}
export function fitLayoutItem(item: LayoutItem) {
  const extents = layoutExtents(item);
  const scale = Math.min(1, 1 / (2 * extents.halfWidth), 1 / (2 * extents.halfHeight));
  const resized = { ...item, width: item.width * scale, height: item.height * scale };
  const fitted = layoutExtents(resized);
  return { ...resized,
    x: Math.max(fitted.halfWidth, Math.min(1 - fitted.halfWidth, item.x + item.width / 2)) - resized.width / 2,
    y: Math.max(fitted.halfHeight, Math.min(1 - fitted.halfHeight, item.y + item.height / 2)) - resized.height / 2
  };
}
