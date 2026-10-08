export interface OpalClipInfo {
  index: number; frames: number; width: number; height: number;
  /** Visible box inside the video cell: [x, y, w, h]. Feet = box[1] + box[3]. */
  box: [number, number, number, number];
}
export interface OpalAsset {
  id: number; frames: number; fps: number; bytes: number; vram: number;
  atlas: [number, number]; layer: [number, number];
  clips: Record<string, OpalClipInfo>;
}
export interface OpalRuntime {
  gl: WebGL2RenderingContext;
  /** Decode an .opal file once into GPU memory. `scale` < 1 stores smaller frames (0.5 = 1/4 memory). */
  load(url: string | URL, opts?: { scale?: number; mipmaps?: boolean }): Promise<OpalAsset>;
  /** Advance animations by `dt` seconds and draw everything (one instanced draw per file). */
  render(dt: number): void;
  /** Spawn a sprite; x/y is the center of the clip's video cell in canvas pixels. Negative scale mirrors horizontally. */
  spawn(asset: OpalAsset, clip: string, x: number, y: number, scale?: number): number;
  set(id: number, x: number, y: number, scale?: number, opacity?: number): void;
  play(asset: OpalAsset, id: number, clip: string): void;
  speed(id: number, speed: number): void;
  /** 0..1 through the current clip (keeps growing past 1 for a finished one-shot). */
  progress(id: number): number;
  done(id: number): boolean;
  kill(id: number): void;
}
/** Opal's own WebGL2 runtime on `canvas`. */
export function createOpal(canvas: HTMLCanvasElement, wasmUrl?: string | URL): Promise<OpalRuntime>;

export interface OpalClip {
  name: string; first: number; count: number; loop: boolean;
  rect: [number, number, number, number]; origin: [number, number]; src: [number, number];
}
export interface OpalFile {
  version: number; width: number; height: number; codedWidth: number; codedHeight: number;
  fps: number; codec: string; description: Uint8Array; clips: OpalClip[];
  frames: { offset: number; size: number; key: boolean }[]; data: Uint8Array;
}
export function parseOpal(buffer: ArrayBuffer | Uint8Array): OpalFile;

export interface DecodedFrame { page: number; x: number; y: number; w: number; h: number }
export interface DecodedClip extends OpalClip { frames: DecodedFrame[] }
export interface DecodedOpal { fps: number; scale: number; pages: (HTMLCanvasElement | ImageBitmap)[]; clips: Record<string, DecodedClip> }
/** Decode all clips into RGBA frames on canvas pages (for PixiJS, three.js, Canvas2D…). */
export function decodeOpal(src: string | URL | ArrayBuffer | Uint8Array, opts?: { scale?: number; pageSize?: number; bitmaps?: boolean }): Promise<DecodedOpal>;
