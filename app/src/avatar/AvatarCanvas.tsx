import { useEffect, useRef } from "preact/hooks";
import type { Character } from "../character/types";
import { follow, hueFor, makeBlinker } from "./level";

interface Props {
  character: Character;
  /** How open the mouth should be right now, 0 to 1. Called every frame. */
  getLevel: () => number;
  size?: number;
  dragRegion?: boolean;
  scale?: number;
}

function drawFace(ctx: CanvasRenderingContext2D, name: string, level: number, blink: number, size: number, sway: number) {
  const hue = hueFor(name);
  const c = size / 2;
  ctx.save();
  ctx.translate(c, c);
  ctx.rotate(sway);
  ctx.translate(-c, -c);

  // Head
  const g = ctx.createRadialGradient(c * 0.8, c * 0.7, size * 0.1, c, c, size * 0.5);
  g.addColorStop(0, `hsl(${hue} 55% 78%)`);
  g.addColorStop(1, `hsl(${hue} 45% 62%)`);
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(c, c, size / 2 - 4, 0, Math.PI * 2);
  ctx.fill();
  ctx.lineWidth = 3;
  ctx.strokeStyle = `hsl(${hue} 40% 40%)`;
  ctx.stroke();

  // Eyes (they squash shut when blinking)
  const eyeY = size * 0.4;
  for (const dx of [-0.17, 0.17]) {
    const ex = c + dx * size;
    ctx.fillStyle = "#fff";
    ctx.beginPath();
    ctx.ellipse(ex, eyeY, size * 0.065, size * 0.07 * (1 - blink * 0.92), 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#1d1b22";
    ctx.beginPath();
    ctx.ellipse(ex + size * 0.008, eyeY, size * 0.032, size * 0.04 * (1 - blink * 0.92), 0, 0, Math.PI * 2);
    ctx.fill();
  }
  // Brows lift a little as the voice gets louder
  ctx.strokeStyle = `hsl(${hue} 35% 28%)`;
  ctx.lineWidth = size * 0.016;
  ctx.lineCap = "round";
  for (const dx of [-0.17, 0.17]) {
    const ex = c + dx * size;
    ctx.beginPath();
    ctx.moveTo(ex - size * 0.06, eyeY - size * (0.1 + level * 0.02));
    ctx.lineTo(ex + size * 0.06, eyeY - size * (0.11 + level * 0.025));
    ctx.stroke();
  }

  // Mouth
  const mw = size * (0.2 + level * 0.06);
  const mh = size * (0.012 + level * 0.15);
  const my = size * 0.64;
  ctx.fillStyle = "#3a1218";
  ctx.beginPath();
  ctx.ellipse(c, my, mw / 2, Math.max(1.5, mh / 2), 0, 0, Math.PI * 2);
  ctx.fill();
  if (level > 0.4) {
    ctx.fillStyle = "#c8636b";
    ctx.beginPath();
    ctx.ellipse(c, my + mh * 0.2, mw * 0.28, mh * 0.2, 0, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.strokeStyle = `hsl(${hue} 40% 32%)`;
  ctx.lineWidth = size * 0.012;
  ctx.beginPath();
  ctx.ellipse(c, my, mw / 2, Math.max(1.5, mh / 2), 0, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
}

/** The built-in cartoon face: blinks, raises its brows, and opens its mouth with the voice. */
export default function AvatarCanvas({ character, getLevel, size = 240, dragRegion = false, scale = 1 }: Props) {
  const ref = useRef<HTMLCanvasElement>(null);
  const latest = useRef({ character, getLevel });
  latest.current = { character, getLevel };

  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(size * dpr);
    canvas.height = Math.round(size * dpr);

    const blinker = makeBlinker();
    let level = 0;
    let last = performance.now();
    let raf = 0;

    const frame = (now: number) => {
      const { character, getLevel } = latest.current;
      level = follow(level, Math.min(1, Math.max(0, getLevel())), now - last);
      last = now;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, size, size);
      drawFace(ctx, character.name, level, blinker(now), size, Math.sin(now / 1700) * 0.012);
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [size]);

  return (
    <canvas
      ref={ref}
      class="avatar-canvas"
      style={{ width: `${size * scale}px`, height: `${size * scale}px` }}
      {...(dragRegion ? { "data-tauri-drag-region": true } : {})}
    />
  );
}
