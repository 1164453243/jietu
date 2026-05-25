import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import "./overlay.css";

interface ScreenSnapshot {
  data: string;
  width: number;
  height: number;
  x: number;
  y: number;
  scale: number;
}

interface Selection {
  startX: number;
  startY: number;
  endX: number;
  endY: number;
}

export default function Overlay() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const bgCanvasRef = useRef<HTMLCanvasElement>(null);
  const [snapshot, setSnapshot] = useState<ScreenSnapshot | null>(null);
  const [tooltip, setTooltip] = useState({ x: 0, y: 0, w: 0, h: 0 });
  const [showTooltip, setShowTooltip] = useState(false);

  const selecting = useRef(false);
  const sel = useRef<Selection>({ startX: 0, startY: 0, endX: 0, endY: 0 });

  // Load background screenshot
  useEffect(() => {
    invoke<ScreenSnapshot | null>("get_screen_snapshot").then((snap) => {
      if (!snap) return;
      setSnapshot(snap);

      const bgCanvas = bgCanvasRef.current;
      if (!bgCanvas) return;
      bgCanvas.width = window.innerWidth;
      bgCanvas.height = window.innerHeight;

      const img = new Image();
      img.onload = () => {
        const ctx = bgCanvas.getContext("2d")!;
        ctx.drawImage(img, 0, 0, bgCanvas.width, bgCanvas.height);
      };
      img.src = `data:image/png;base64,${snap.data}`;
    });
  }, []);

  // Overlay canvas draw
  const draw = (canvas: HTMLCanvasElement, s: Selection, isSelecting: boolean) => {
    const ctx = canvas.getContext("2d")!;
    const { width: W, height: H } = canvas;

    ctx.clearRect(0, 0, W, H);

    const x = Math.min(s.startX, s.endX);
    const y = Math.min(s.startY, s.endY);
    const w = Math.abs(s.endX - s.startX);
    const h = Math.abs(s.endY - s.startY);

    // Dark dim overlay
    ctx.fillStyle = "rgba(0,0,0,0.45)";
    ctx.fillRect(0, 0, W, H);

    if (isSelecting || w > 2) {
      // Cut out selection (show real screen beneath)
      ctx.clearRect(x, y, w, h);

      // Selection border
      ctx.strokeStyle = "#1890ff";
      ctx.lineWidth = 1.5;
      ctx.strokeRect(x, y, w, h);

      // Corner handles
      const handles = [
        [x, y], [x + w / 2, y], [x + w, y],
        [x, y + h / 2], [x + w, y + h / 2],
        [x, y + h], [x + w / 2, y + h], [x + w, y + h],
      ];
      ctx.fillStyle = "#1890ff";
      handles.forEach(([hx, hy]) => {
        ctx.fillRect(hx - 3, hy - 3, 6, 6);
      });
    }

    // Crosshair on cursor (only while moving before selection)
    if (!isSelecting && w <= 2) {
      ctx.strokeStyle = "rgba(255,255,255,0.5)";
      ctx.lineWidth = 0.5;
      ctx.beginPath();
      ctx.moveTo(s.endX, 0); ctx.lineTo(s.endX, H);
      ctx.moveTo(0, s.endY); ctx.lineTo(W, s.endY);
      ctx.stroke();
    }
  };

  const initCanvas = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
  };

  useEffect(() => {
    initCanvas();
    window.addEventListener("resize", initCanvas);
    return () => window.removeEventListener("resize", initCanvas);
  }, []);

  const getPos = (e: React.MouseEvent) => ({
    x: e.clientX,
    y: e.clientY,
  });

  const onMouseDown = (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    const { x, y } = getPos(e);
    selecting.current = true;
    sel.current = { startX: x, startY: y, endX: x, endY: y };
    setShowTooltip(false);
  };

  const onMouseMove = (e: React.MouseEvent) => {
    const { x, y } = getPos(e);
    const canvas = canvasRef.current;
    if (!canvas) return;

    if (!selecting.current) {
      sel.current.endX = x;
      sel.current.endY = y;
      draw(canvas, sel.current, false);
      return;
    }

    sel.current.endX = x;
    sel.current.endY = y;
    draw(canvas, sel.current, true);

    const w = Math.abs(sel.current.endX - sel.current.startX);
    const h = Math.abs(sel.current.endY - sel.current.startY);
    setTooltip({ x, y, w: Math.round(w), h: Math.round(h) });
    setShowTooltip(true);
  };

  const onMouseUp = async (_e: React.MouseEvent) => {
    if (!selecting.current) return;
    selecting.current = false;

    const s = sel.current;
    const x = Math.round(Math.min(s.startX, s.endX));
    const y = Math.round(Math.min(s.startY, s.endY));
    const w = Math.round(Math.abs(s.endX - s.startX));
    const h = Math.round(Math.abs(s.endY - s.startY));

    if (w < 4 || h < 4) return;

    // Convert logical → global screen coords
    const snap = snapshot;
    const globalX = snap ? snap.x + Math.round(x * snap.scale) : x;
    const globalY = snap ? snap.y + Math.round(y * snap.scale) : y;
    const globalW = snap ? Math.round(w * snap.scale) : w;
    const globalH = snap ? Math.round(h * snap.scale) : h;

    try {
      await invoke("do_region_capture", {
        x: globalX,
        y: globalY,
        width: globalW,
        height: globalH,
      });
    } catch (err) {
      console.error("capture error:", err);
    }
  };

  const onKeyDown = async (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      await invoke("close_overlay");
    }
  };

  return (
    <div className="overlay-root" tabIndex={0} onKeyDown={onKeyDown} autoFocus>
      {/* Background: screenshot of screen before overlay opened */}
      <canvas ref={bgCanvasRef} className="overlay-bg" />
      {/* Interactive selection canvas */}
      <canvas
        ref={canvasRef}
        className="overlay-canvas"
        onMouseDown={onMouseDown}
        onMouseMove={onMouseMove}
        onMouseUp={onMouseUp}
      />
      {showTooltip && (
        <div
          className="overlay-tooltip"
          style={{ left: tooltip.x + 12, top: tooltip.y + 12 }}
        >
          {tooltip.w} × {tooltip.h}
        </div>
      )}
      <div className="overlay-hint">拖拽选择区域 · ESC 取消</div>
    </div>
  );
}
