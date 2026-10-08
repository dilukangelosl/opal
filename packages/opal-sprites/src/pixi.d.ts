import type { AnimatedSprite, Texture } from 'pixi.js';
export { decodeOpal, parseOpal } from './index';
export interface PixiOpal {
  fps: number;
  /** Texture arrays per clip: `new AnimatedSprite(asset.clips.run)`. */
  clips: Record<string, Texture[]>;
  loops(name: string): boolean;
  /** Anchor that puts the clip's feet (lowest visible pixel) at the sprite's y. */
  feetAnchor(name: string): { x: number; y: number };
  /** AnimatedSprite at the clip's frame rate, playing by default. */
  sprite(name: string, opts?: { play?: boolean; anchor?: { x: number; y: number } }): AnimatedSprite;
  destroy(): void;
}
export function loadOpal(src: string | URL | ArrayBuffer | Uint8Array, opts?: { scale?: number; pageSize?: number }): Promise<PixiOpal>;
