import { useEffect, useRef, useState, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import { writeImage } from "@tauri-apps/plugin-clipboard-manager";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { useCaptureStore, type ToolType, type Annotation } from "../../store/captureStore";
import "./editor.css";

const COLORS = ["#ff3b30", "#ff9500", "#ffcc00", "#34c759", "#007aff", "#ffffff", "#000000"];
const STROKE_WIDTHS = [2, 4, 6];

export default function Editor() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const [imgData, setImgData] = useState<string | null>(null);
  const [imgSize, setImgSize] = useState({ w: 0, h: 0 });
  const [drawing, setDrawing] = useState(false);
  const [activeId, setActiveId] = useState<string | null>(null);
  // x/y = canvas natural coords (for annotation), screenX/screenY = area-relative px (for input overlay)
  const [textPos, setTextPos] = useState<{ x: number; y: number; screenX: number; screenY: number } | null>(null);
  const [flash, setFlash] = useState("");
  const textInputRef = useRef<HTMLInputElement>(null);

  const {
    tool, color, strokeWidth, annotations,
    setTool, setColor, setStrokeWidth,
    addAnnotation, updateAnnotation, undo, reset,
  } = useCaptureStore();

  // ── Image load ──────────────────────────────────────────────────────────────
  useEffect(() => {
    invoke<string | null>("get_capture_data").then((data) => {
      if (!data) return;
      setImgData(data);
      const img = new Image();
      img.onload = () => {
        setImgSize({ w: img.naturalWidth, h: img.naturalHeight });
        imgRef.current = img;
      };
      img.src = `data:image/png;base64,${data}`;
    });
  }, []);

  // ── Canvas render ───────────────────────────────────────────────────────────
  const drawAnnotation = useCallback((ctx: CanvasRenderingContext2D, a: Annotation) => {
    ctx.save();
    ctx.strokeStyle = a.color;
    ctx.fillStyle = a.color;
    ctx.lineWidth = a.strokeWidth;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";

    const x1 = a.x, y1 = a.y;
    const x2 = a.x2 ?? a.x, y2 = a.y2 ?? a.y;

    switch (a.type) {
      case "rect":
        ctx.strokeRect(x1, y1, x2 - x1, y2 - y1);
        break;
      case "circle": {
        const rx = Math.abs(x2 - x1) / 2, ry = Math.abs(y2 - y1) / 2;
        ctx.beginPath();
        ctx.ellipse(x1 + (x2 - x1) / 2, y1 + (y2 - y1) / 2, rx, ry, 0, 0, Math.PI * 2);
        ctx.stroke();
        break;
      }
      case "arrow": {
        const dx = x2 - x1, dy = y2 - y1;
        const len = Math.sqrt(dx * dx + dy * dy);
        if (len < 2) break;
        const angle = Math.atan2(dy, dx);
        const headLen = Math.min(20, len * 0.4);
        ctx.beginPath();
        ctx.moveTo(x1, y1); ctx.lineTo(x2, y2);
        ctx.lineTo(x2 - headLen * Math.cos(angle - 0.4), y2 - headLen * Math.sin(angle - 0.4));
        ctx.moveTo(x2, y2);
        ctx.lineTo(x2 - headLen * Math.cos(angle + 0.4), y2 - headLen * Math.sin(angle + 0.4));
        ctx.stroke();
        break;
      }
      case "text":
        ctx.font = `${Math.max(16, a.strokeWidth * 6)}px -apple-system, sans-serif`;
        ctx.fillText(a.text ?? "", x1, y1);
        break;
      case "mosaic": {
        const bx = Math.min(x1, x2), by = Math.min(y1, y2);
        const bw = Math.abs(x2 - x1), bh = Math.abs(y2 - y1);
        if (bw < 2 || bh < 2) break;
        const sz = 12;
        for (let px = bx; px < bx + bw; px += sz) {
          for (let py = by; py < by + bh; py += sz) {
            const d = ctx.getImageData(px + sz / 2, py + sz / 2, 1, 1).data;
            ctx.fillStyle = `rgb(${d[0]},${d[1]},${d[2]})`;
            ctx.fillRect(px, py, sz, sz);
          }
        }
        break;
      }
    }
    ctx.restore();
  }, []);

  const renderCanvas = useCallback(() => {
    const canvas = canvasRef.current;
    const img = imgRef.current;
    if (!canvas || !img || imgSize.w === 0) return;
    canvas.width = imgSize.w;
    canvas.height = imgSize.h;
    const ctx = canvas.getContext("2d")!;
    ctx.drawImage(img, 0, 0);
    annotations.forEach((a) => drawAnnotation(ctx, a));
  }, [annotations, imgSize, drawAnnotation]);

  useEffect(() => { renderCanvas(); }, [renderCanvas]);

  // ── Export helpers ──────────────────────────────────────────────────────────
  const canvasToBase64 = useCallback((): string => {
    renderCanvas();
    return canvasRef.current!.toDataURL("image/png").split(",")[1];
  }, [renderCanvas]);

  const showFlash = useCallback((msg: string) => {
    setFlash(msg);
    setTimeout(() => setFlash(""), 1800);
  }, []);

  const handleCopy = useCallback(async () => {
    const b64 = canvasToBase64();
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    await writeImage(bytes);
    showFlash("已复制到剪贴板");
  }, [canvasToBase64, showFlash]);

  const handleSave = useCallback(async () => {
    const filePath = await save({
      filters: [
        { name: "PNG 图片", extensions: ["png"] },
        { name: "JPEG 图片", extensions: ["jpg"] },
      ],
      defaultPath: `截图_${Date.now()}.png`,
    });
    if (!filePath) return;
    const data = canvasToBase64();
    await invoke("save_image", { path: filePath, data });
    showFlash("已保存");
  }, [canvasToBase64, showFlash]);

  // ── Keyboard shortcuts ──────────────────────────────────────────────────────
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "z") { e.preventDefault(); undo(); }
      if ((e.metaKey || e.ctrlKey) && e.key === "c") { e.preventDefault(); handleCopy(); }
      if ((e.metaKey || e.ctrlKey) && e.key === "s") { e.preventDefault(); handleSave(); }
      if (e.key === "Escape") getCurrentWebviewWindow().close();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [undo, handleCopy, handleSave]);

  // ── Canvas mouse events ─────────────────────────────────────────────────────
  const toCanvasCoords = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current!;
    const rect = canvas.getBoundingClientRect();
    return {
      x: (e.clientX - rect.left) * (canvas.width / rect.width),
      y: (e.clientY - rect.top) * (canvas.height / rect.height),
    };
  };

  const onMouseDown = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (tool === "pointer") return;
    if (tool === "text") {
      const { x, y } = toCanvasCoords(e);
      const areaRect = (e.currentTarget.parentElement as HTMLElement).getBoundingClientRect();
      setTextPos({ x, y, screenX: e.clientX - areaRect.left, screenY: e.clientY - areaRect.top });
      setTimeout(() => textInputRef.current?.focus(), 50);
      return;
    }
    const { x, y } = toCanvasCoords(e);
    const id = `ann_${Date.now()}`;
    setActiveId(id);
    setDrawing(true);
    addAnnotation({ id, type: tool, x, y, x2: x, y2: y, color, strokeWidth });
  };

  const onMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!drawing || !activeId) return;
    const { x, y } = toCanvasCoords(e);
    updateAnnotation(activeId, { x2: x, y2: y });
  };

  const onMouseUp = () => { setDrawing(false); setActiveId(null); };

  const submitText = (text: string) => {
    if (!textPos || !text.trim()) { setTextPos(null); return; }
    addAnnotation({ id: `ann_${Date.now()}`, type: "text", x: textPos.x, y: textPos.y, text, color, strokeWidth });
    setTextPos(null);
  };

  // ── Render ──────────────────────────────────────────────────────────────────
  return (
    <div className="editor-root">
      <div className="editor-toolbar">
        <div className="toolbar-group">
          {(["pointer", "rect", "circle", "arrow", "text", "mosaic"] as ToolType[]).map((t) => (
            <button key={t} className={`tool-btn ${tool === t ? "active" : ""}`} title={toolLabel(t)} onClick={() => setTool(t)}>
              {toolIcon(t)}
            </button>
          ))}
        </div>

        <div className="toolbar-divider" />

        <div className="toolbar-group">
          {COLORS.map((c) => (
            <button key={c} className={`color-btn ${color === c ? "active" : ""}`} style={{ background: c }} onClick={() => setColor(c)} />
          ))}
        </div>

        <div className="toolbar-divider" />

        <div className="toolbar-group">
          {STROKE_WIDTHS.map((w) => (
            <button key={w} className={`stroke-btn ${strokeWidth === w ? "active" : ""}`} onClick={() => setStrokeWidth(w)}>
              <div className="stroke-preview" style={{ height: w }} />
            </button>
          ))}
        </div>

        <div className="toolbar-divider" />

        <div className="toolbar-group">
          <button className="action-btn" onClick={undo} title="撤销 ⌘Z">↩</button>
          <button className="action-btn" onClick={reset} title="清空标注">⊘</button>
        </div>

        <div className="toolbar-spacer" />

        <div className="toolbar-group">
          <button className="action-btn pin-btn" onClick={() => invoke("open_pin_window")} title="固定到屏幕最上方">📌 固定</button>
          <button className="action-btn copy-btn" onClick={handleCopy} title="复制 ⌘C">复制</button>
          <button className="action-btn save-btn" onClick={handleSave} title="保存 ⌘S">保存</button>
          <button className="action-btn close-btn" onClick={() => getCurrentWebviewWindow().close()} title="关闭 ESC">✕</button>
        </div>
      </div>

      <div className="editor-canvas-area">
        {imgData ? (
          <>
            <canvas
              ref={canvasRef}
              style={{ maxWidth: "100%", maxHeight: "100%", cursor: tool === "pointer" ? "default" : "crosshair", display: "block" }}
              onMouseDown={onMouseDown}
              onMouseMove={onMouseMove}
              onMouseUp={onMouseUp}
              onMouseLeave={onMouseUp}
            />
            {textPos && (
              <input
                ref={textInputRef}
                className="text-input-overlay"
                style={{ left: textPos.screenX, top: textPos.screenY }}
                placeholder="输入文字，回车确认"
                onKeyDown={(e) => {
                  if (e.key === "Enter") submitText(e.currentTarget.value);
                  if (e.key === "Escape") setTextPos(null);
                }}
                onBlur={(e) => submitText(e.currentTarget.value)}
              />
            )}
          </>
        ) : (
          <div className="editor-loading">加载中…</div>
        )}
      </div>

      {flash && <div className="editor-flash">{flash}</div>}
    </div>
  );
}

function toolLabel(t: ToolType): string {
  const m: Record<ToolType, string> = { pointer: "选择", rect: "矩形", circle: "椭圆", arrow: "箭头", text: "文字", mosaic: "马赛克" };
  return m[t];
}

function toolIcon(t: ToolType): string {
  const m: Record<ToolType, string> = { pointer: "↖", rect: "▭", circle: "◯", arrow: "↗", text: "T", mosaic: "⬛" };
  return m[t];
}
