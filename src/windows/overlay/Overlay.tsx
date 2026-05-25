import { useEffect, useRef, useState, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import { writeImage } from "@tauri-apps/plugin-clipboard-manager";
import "./overlay.css";

// ── Types ─────────────────────────────────────────────────────────────────────

interface ScreenSnapshot {
  data: string; width: number; height: number; x: number; y: number; scale: number;
}
interface Selection { startX: number; startY: number; endX: number; endY: number; }
interface FrozenSel { x: number; y: number; w: number; h: number; }
interface WindowInfo { x: number; y: number; width: number; height: number; title: string; app_name: string; }
type Phase = "selecting" | "editing";
export type ToolType = "pointer" | "rect" | "circle" | "arrow" | "pen" | "text" | "number" | "mosaic";
type EditAction = "idle" | "drawing" | "moving" | "resizing";

export interface Annotation {
  id: string; type: ToolType;
  x: number; y: number; x2?: number; y2?: number;
  text?: string; num?: number;
  points?: { x: number; y: number }[];
  color: string; strokeWidth: number;
}

// ── Constants ─────────────────────────────────────────────────────────────────

const COLORS = ["#ff3b30", "#ff9500", "#ffcc00", "#34c759", "#007aff", "#ffffff", "#000000"];
const STROKES: [number, string][] = [[2, "S"], [4, "M"], [6, "L"]];
const TOOLS: { t: ToolType; icon: string; label: string }[] = [
  { t: "rect",   icon: "▭", label: "矩形"  },
  { t: "circle", icon: "◯", label: "椭圆"  },
  { t: "arrow",  icon: "↗", label: "箭头"  },
  { t: "pen",    icon: "✏", label: "画笔"  },
  { t: "text",   icon: "T", label: "文字"  },
  { t: "number", icon: "①", label: "序号"  },
  { t: "mosaic", icon: "⊞", label: "马赛克" },
];

// ── Selection geometry ────────────────────────────────────────────────────────

function selHandles(s: FrozenSel): [number, number][] {
  const { x, y, w, h } = s;
  return [
    [x,       y      ], [x+w/2, y      ], [x+w,   y      ],
    [x,       y+h/2  ],                   [x+w,   y+h/2  ],
    [x,       y+h    ], [x+w/2, y+h    ], [x+w,   y+h    ],
  ];
}
function hitHandle(s: FrozenSel, cx: number, cy: number): number {
  for (const [i, [hx, hy]] of selHandles(s).entries())
    if (Math.hypot(cx-hx, cy-hy) <= 8) return i;
  return -1;
}
function inside(s: FrozenSel, cx: number, cy: number) {
  return cx >= s.x && cx <= s.x+s.w && cy >= s.y && cy <= s.y+s.h;
}
const HANDLE_CURSORS = ["nw-resize","n-resize","ne-resize","w-resize","e-resize","sw-resize","s-resize","se-resize"];

// ── Annotation drawing (pure, no React state) ─────────────────────────────────

function drawOneAnnotation(ctx: CanvasRenderingContext2D, a: Annotation, bgCanvas?: HTMLCanvasElement | null) {
  ctx.save();
  ctx.strokeStyle = a.color; ctx.fillStyle = a.color;
  ctx.lineWidth = a.strokeWidth; ctx.lineCap = "round"; ctx.lineJoin = "round";
  const x1 = a.x, y1 = a.y, x2 = a.x2 ?? a.x, y2 = a.y2 ?? a.y;

  switch (a.type) {
    case "rect":
      ctx.strokeRect(x1, y1, x2-x1, y2-y1);
      break;
    case "circle": {
      const rx = Math.abs(x2-x1)/2, ry = Math.abs(y2-y1)/2;
      ctx.beginPath();
      ctx.ellipse(x1+(x2-x1)/2, y1+(y2-y1)/2, rx, ry, 0, 0, Math.PI*2);
      ctx.stroke();
      break;
    }
    case "arrow": {
      const dx = x2-x1, dy = y2-y1, len = Math.sqrt(dx*dx+dy*dy);
      if (len < 2) break;
      const angle = Math.atan2(dy, dx), hl = Math.min(20, len*0.4);
      ctx.beginPath();
      ctx.moveTo(x1, y1); ctx.lineTo(x2, y2);
      ctx.lineTo(x2-hl*Math.cos(angle-0.4), y2-hl*Math.sin(angle-0.4));
      ctx.moveTo(x2, y2);
      ctx.lineTo(x2-hl*Math.cos(angle+0.4), y2-hl*Math.sin(angle+0.4));
      ctx.stroke();
      break;
    }
    case "pen":
      if (!a.points || a.points.length < 2) break;
      ctx.beginPath();
      ctx.moveTo(a.points[0].x, a.points[0].y);
      a.points.slice(1).forEach(p => ctx.lineTo(p.x, p.y));
      ctx.stroke();
      break;
    case "text":
      ctx.font = `${Math.max(16, a.strokeWidth*6)}px -apple-system, sans-serif`;
      ctx.fillText(a.text ?? "", x1, y1);
      break;
    case "number": {
      const r = 12 + a.strokeWidth*2;
      ctx.beginPath(); ctx.arc(x1, y1, r, 0, Math.PI*2); ctx.fill();
      ctx.fillStyle = "#fff";
      ctx.font = `bold ${r}px -apple-system, sans-serif`;
      ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.fillText(String(a.num ?? 1), x1, y1);
      ctx.textAlign = "start"; ctx.textBaseline = "alphabetic";
      break;
    }
    case "mosaic": {
      const bx = Math.min(x1,x2), by = Math.min(y1,y2);
      const bw = Math.abs(x2-x1), bh = Math.abs(y2-y1);
      if (bw < 2 || bh < 2) break;
      const sz = 12;
      const tW = Math.max(1, Math.ceil(bw/sz));
      const tH = Math.max(1, Math.ceil(bh/sz));
      const tmp = document.createElement("canvas");
      tmp.width = tW; tmp.height = tH;
      const tc = tmp.getContext("2d")!;
      // Sample from background canvas (clean, pre-annotations) for accurate mosaic
      const src = bgCanvas ?? ctx.canvas;
      tc.drawImage(src, bx, by, bw, bh, 0, 0, tW, tH);
      ctx.save();
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(tmp, 0, 0, tW, tH, bx, by, bw, bh);
      ctx.imageSmoothingEnabled = true;
      ctx.restore();
      break;
    }
  }
  ctx.restore();
}

function drawHandles(ctx: CanvasRenderingContext2D, handles: [number,number][]) {
  handles.forEach(([hx, hy]) => {
    ctx.beginPath(); ctx.arc(hx, hy, 4, 0, Math.PI*2);
    ctx.fillStyle = "#fff"; ctx.fill();
    ctx.strokeStyle = "#1677ff"; ctx.lineWidth = 1.5; ctx.stroke();
  });
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function Overlay() {
  const bgRef   = useRef<HTMLCanvasElement>(null);
  const selRef  = useRef<HTMLCanvasElement>(null);
  const annRef  = useRef<HTMLCanvasElement>(null);
  const textRef = useRef<HTMLInputElement>(null);

  const [phase,       setPhase]       = useState<Phase>("selecting");
  const [frozenSel,   setFrozenSel]   = useState<FrozenSel | null>(null);
  const [tooltip,     setTooltip]     = useState({ x: 0, y: 0, w: 0, h: 0 });
  const [showTip,     setShowTip]     = useState(false);
  const [toast,       setToast]       = useState("");
  const [annCursor,   setAnnCursor]   = useState("crosshair");
  const [tool,        setTool]        = useState<ToolType>("rect");
  const [color,       setColor]       = useState("#ff3b30");
  const [strokeWidth, setStrokeWidth] = useState(2);
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  const [, setAnnHistory]             = useState<Annotation[][]>([]);
  const [textPos,     setTextPos]     = useState<{ x: number; y: number } | null>(null);
  const [nextNum,     setNextNum]     = useState(1);

  // Refs for perf-sensitive drawing (avoid React re-renders on every mousemove)
  const frozenSelRef   = useRef<FrozenSel | null>(null);
  const annotationsRef = useRef<Annotation[]>([]);
  const activeAnn      = useRef<Annotation | null>(null); // in-progress annotation
  const toolRef        = useRef<ToolType>("rect");
  const colorRef       = useRef("#ff3b30");
  const strokeRef      = useRef(2);
  const nextNumRef     = useRef(1);
  const snapScaleRef   = useRef(1);  // physical-pixel scale factor (2 on Retina)

  // Offscreen canvas pre-baking background + committed annotations.
  // Rebuilt only on commit/undo/clear — never during a mouse-move hot path.
  const committedBaseRef = useRef<HTMLCanvasElement | null>(null);

  const selecting    = useRef(false);
  const mouseReady   = useRef(false); // guard against synthetic events on open
  const sel          = useRef<Selection>({ startX:0, startY:0, endX:0, endY:0 });
  const editAction   = useRef<EditAction>("idle");

  // Window detection: populated once after snapshot loads
  const windowListRef    = useRef<WindowInfo[]>([]);
  const hoveredWindowRef = useRef<WindowInfo | null>(null);
  const resizeIdx    = useRef(-1);
  const dragOrigin   = useRef<{ mx: number; my: number; sel: FrozenSel } | null>(null);

  // Keep refs in sync with state
  useEffect(() => { frozenSelRef.current = frozenSel; }, [frozenSel]);
  useEffect(() => { annotationsRef.current = annotations; }, [annotations]);
  useEffect(() => { toolRef.current = tool; }, [tool]);
  useEffect(() => { colorRef.current = color; }, [color]);
  useEffect(() => { strokeRef.current = strokeWidth; }, [strokeWidth]);
  useEffect(() => { nextNumRef.current = nextNum; }, [nextNum]);

  const showFlash = useCallback((msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(""), 2000);
  }, []);

  // ── Background ──────────────────────────────────────────────────────────────

  useEffect(() => {
    invoke<ScreenSnapshot | null>("get_screen_snapshot").then((snap) => {
      if (!snap) return;
      snapScaleRef.current = snap.scale;
      const bg = bgRef.current;
      if (!bg) return;
      bg.width  = window.innerWidth;
      bg.height = window.innerHeight;
      const img = new Image();
      img.onload = async () => {
        bg.getContext("2d")!.drawImage(img, 0, 0, bg.width, bg.height);
        // Load window list (captured at same time as screenshot)
        const wins = await invoke<WindowInfo[]>("get_window_list").catch(() => []);
        windowListRef.current = wins;

        const preselect = await invoke<boolean>("take_preselect_all");
        if (preselect) {
          const fs = { x:0, y:0, w:window.innerWidth, h:window.innerHeight };
          frozenSelRef.current = fs;
          setFrozenSel(fs);
          setPhase("editing");
        }
      };
      img.src = `data:image/png;base64,${snap.data}`;
    });
  }, []);

  // ── Selection canvas drawing ─────────────────────────────────────────────────

  const drawSel = useCallback((s: Selection, isDragging: boolean) => {
    const canvas = selRef.current; if (!canvas) return;
    // Set dimensions only once — the overlay window never resizes
    if (canvas.width !== window.innerWidth) { canvas.width = window.innerWidth; canvas.height = window.innerHeight; }
    const ctx = canvas.getContext("2d")!;
    const W = canvas.width, H = canvas.height;
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = "rgba(0,0,0,0.45)";
    ctx.fillRect(0, 0, W, H);

    const x = Math.min(s.startX, s.endX), y = Math.min(s.startY, s.endY);
    const w = Math.abs(s.endX-s.startX), h = Math.abs(s.endY-s.startY);

    if (isDragging && w > 2) {
      ctx.clearRect(x, y, w, h);
      ctx.strokeStyle = "#1677ff"; ctx.lineWidth = 1.5; ctx.strokeRect(x, y, w, h);
      drawHandles(ctx, selHandles({x,y,w,h}));
      if (w > 40) {
        const label = `${Math.round(w)} × ${Math.round(h)}`;
        ctx.font = "12px -apple-system,sans-serif";
        const lw = ctx.measureText(label).width;
        const lx = Math.min(Math.max(x+(w-lw-10)/2, 2), W-lw-12);
        const ly = Math.min(y+h+18, H-4);
        ctx.fillStyle = "rgba(0,0,0,0.65)";
        ctx.beginPath(); ctx.roundRect(lx-4, ly-13, lw+14, 18, 3); ctx.fill();
        ctx.fillStyle = "#fff"; ctx.fillText(label, lx+3, ly);
      }
    } else if (!isDragging) {
      // Highlight hovered window to indicate it will be auto-selected on click
      const hw = hoveredWindowRef.current;
      if (hw) {
        ctx.clearRect(hw.x, hw.y, hw.width, hw.height);
        ctx.strokeStyle = "#1677ff"; ctx.lineWidth = 2;
        ctx.strokeRect(hw.x, hw.y, hw.width, hw.height);
        // Window name label
        if (hw.app_name || hw.title) {
          const label = hw.app_name || hw.title;
          ctx.font = "12px -apple-system,sans-serif";
          const lw2 = ctx.measureText(label).width;
          const lx2 = Math.max(hw.x + 4, 2);
          const ly2 = Math.max(hw.y - 6, 16);
          ctx.fillStyle = "#1677ff";
          ctx.beginPath(); ctx.roundRect(lx2 - 4, ly2 - 13, lw2 + 12, 18, 3); ctx.fill();
          ctx.fillStyle = "#fff"; ctx.fillText(label, lx2 + 2, ly2);
        }
      }
      // Crosshair
      ctx.strokeStyle = "rgba(255,255,255,0.45)"; ctx.lineWidth = 0.5;
      ctx.beginPath();
      ctx.moveTo(s.endX, 0); ctx.lineTo(s.endX, H);
      ctx.moveTo(0, s.endY); ctx.lineTo(W, s.endY);
      ctx.stroke();
    }
  }, []);

  const drawEditSel = useCallback((s: FrozenSel) => {
    const canvas = selRef.current; if (!canvas) return;
    if (canvas.width !== window.innerWidth) { canvas.width = window.innerWidth; canvas.height = window.innerHeight; }
    const ctx = canvas.getContext("2d")!;
    const W = canvas.width, H = canvas.height;
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = "rgba(0,0,0,0.45)"; ctx.fillRect(0, 0, W, H);
    ctx.clearRect(s.x, s.y, s.w, s.h);
    ctx.strokeStyle = "#1677ff"; ctx.lineWidth = 1.5; ctx.strokeRect(s.x, s.y, s.w, s.h);
    drawHandles(ctx, selHandles(s));
  }, []);

  useEffect(() => {
    drawSel({ startX:0, startY:0, endX:0, endY:0 }, false);
  }, [drawSel]);

  useEffect(() => {
    if (phase === "editing" && frozenSel) drawEditSel(frozenSel);
  }, [phase, frozenSel, drawEditSel]);

  // ── Annotation canvas: full redraw from committed annotations ────────────────

  const renderCommitted = useCallback((anns: Annotation[], fs: FrozenSel | null = null) => {
    const canvas = annRef.current; if (!canvas) return;
    const s = fs ?? frozenSelRef.current; if (!s) return;

    // Rebuild the offscreen committed base (only called on annotation commit/undo/clear — not hot path)
    if (!committedBaseRef.current) committedBaseRef.current = document.createElement("canvas");
    const base = committedBaseRef.current;
    base.width  = canvas.width  = window.innerWidth;
    base.height = canvas.height = window.innerHeight;
    const bctx = base.getContext("2d")!;
    bctx.clearRect(0, 0, base.width, base.height);
    if (bgRef.current) bctx.drawImage(bgRef.current, 0, 0);
    anns.forEach(a => drawOneAnnotation(bctx, a, bgRef.current));
    bctx.save();
    bctx.globalCompositeOperation = "destination-in";
    bctx.fillStyle = "#000"; bctx.fillRect(s.x, s.y, s.w, s.h);
    bctx.restore();

    // Copy to the visible annotation canvas
    const ctx = canvas.getContext("2d")!;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(base, 0, 0);
  }, []);

  useEffect(() => {
    if (phase === "editing") renderCommitted(annotations);
  }, [annotations, phase, renderCommitted]);

  // ── Imperative in-progress annotation drawing (no React state) ──────────────
  // Hot path: copies the pre-baked committed base (O(1)), then clips + draws
  // only the active shape.  No dimension reset, no background re-render.

  const renderWithActive = useCallback((active: Annotation) => {
    const canvas = annRef.current; if (!canvas) return;
    const s = frozenSelRef.current; if (!s) return;
    const ctx = canvas.getContext("2d")!;

    // Copy pre-baked committed state — a single drawImage is O(1)
    const base = committedBaseRef.current;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (base) {
      ctx.drawImage(base, 0, 0);
    } else {
      // Fallback (first frame before committedBase is ready)
      if (bgRef.current) ctx.drawImage(bgRef.current, 0, 0);
      annotationsRef.current.forEach(a => drawOneAnnotation(ctx, a, bgRef.current));
      ctx.save();
      ctx.globalCompositeOperation = "destination-in";
      ctx.fillStyle = "#000"; ctx.fillRect(s.x, s.y, s.w, s.h);
      ctx.restore();
    }

    // Draw the in-progress shape, clipped to the selection rectangle
    ctx.save();
    ctx.beginPath(); ctx.rect(s.x, s.y, s.w, s.h); ctx.clip();
    drawOneAnnotation(ctx, active, bgRef.current);
    ctx.restore();
  }, []);

  // ── Mouse: selecting phase ───────────────────────────────────────────────────

  useEffect(() => {
    const up = (e: MouseEvent) => {
      if (!selecting.current || phase !== "selecting") return;
      selecting.current = false;
      const s = sel.current;
      const x = Math.round(Math.min(s.startX, s.endX));
      const y = Math.round(Math.min(s.startY, s.endY));
      const w = Math.round(Math.abs(s.endX-s.startX));
      const h = Math.round(Math.abs(s.endY-s.startY));
      if (w < 8 || h < 8) {
        // Click without drag — auto-select the hovered window if any
        const hw = hoveredWindowRef.current;
        if (hw && hw.width > 8 && hw.height > 8) {
          const fs = { x: hw.x, y: hw.y, w: hw.width, h: hw.height };
          frozenSelRef.current = fs;
          setFrozenSel(fs);
          setPhase("editing");
          setShowTip(false);
        } else {
          // No window under cursor — just redraw crosshair
          drawSel({ startX: e.clientX, startY: e.clientY, endX: e.clientX, endY: e.clientY }, false);
        }
        return;
      }
      const fs = { x, y, w, h };
      frozenSelRef.current = fs;
      setFrozenSel(fs);
      setPhase("editing");
      setShowTip(false);
    };
    window.addEventListener("mouseup", up);
    return () => window.removeEventListener("mouseup", up);
  }, [phase, drawSel]);

  const onSelDown = (e: React.MouseEvent) => {
    if (e.button !== 0 || phase !== "selecting" || !mouseReady.current) return;
    selecting.current = true;
    sel.current = { startX: e.clientX, startY: e.clientY, endX: e.clientX, endY: e.clientY };
    setShowTip(false);
  };

  const onSelMove = (e: React.MouseEvent) => {
    if (phase !== "selecting") return;
    mouseReady.current = true;
    sel.current.endX = e.clientX;
    sel.current.endY = e.clientY;

    // Track which window is under the cursor (only when not actively dragging)
    if (!selecting.current) {
      const cx = e.clientX, cy = e.clientY;
      // Windows from xcap are ordered front-to-back; find the front-most one
      const hovered = windowListRef.current.find(w =>
        cx >= w.x && cy >= w.y &&
        cx <= w.x + w.width && cy <= w.y + w.height
      );
      hoveredWindowRef.current = hovered ?? null;
    }

    drawSel(sel.current, selecting.current);
    if (selecting.current) {
      const lw = Math.round(Math.abs(sel.current.endX-sel.current.startX));
      const lh = Math.round(Math.abs(sel.current.endY-sel.current.startY));
      const scale = snapScaleRef.current;
      setTooltip({ x: e.clientX, y: e.clientY,
        w: Math.round(lw * scale), h: Math.round(lh * scale) });
      setShowTip(true);
    }
  };

  // ── Mouse: annotation / move / resize ────────────────────────────────────────

  const onAnnDown = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const cx = e.clientX, cy = e.clientY;
    const fs = frozenSelRef.current; if (!fs) return;

    const hi = hitHandle(fs, cx, cy);
    if (hi !== -1) {
      editAction.current = "resizing";
      resizeIdx.current  = hi;
      dragOrigin.current = { mx: cx, my: cy, sel: { ...fs } };
      return;
    }
    if (toolRef.current === "pointer" && inside(fs, cx, cy)) {
      editAction.current = "moving";
      dragOrigin.current = { mx: cx, my: cy, sel: { ...fs } };
      return;
    }
    if (toolRef.current === "pointer") return;
    if (toolRef.current === "text") {
      setTextPos({ x: cx, y: cy });
      setTimeout(() => textRef.current?.focus(), 30);
      return;
    }
    if (toolRef.current === "number") {
      const ann: Annotation = {
        id: `ann_${Date.now()}`, type: "number",
        x: cx, y: cy, num: nextNumRef.current,
        color: colorRef.current, strokeWidth: strokeRef.current,
      };
      setAnnHistory(h => [...h, annotationsRef.current]);
      setAnnotations(prev => { const next = [...prev, ann]; annotationsRef.current = next; return next; });
      setNextNum(n => { nextNumRef.current = n+1; return n+1; });
      return;
    }
    // Start drawing
    editAction.current = "drawing";
    const ann: Annotation = {
      id: `ann_${Date.now()}`, type: toolRef.current,
      x: cx, y: cy, x2: cx, y2: cy,
      color: colorRef.current, strokeWidth: strokeRef.current,
    };
    if (toolRef.current === "pen") ann.points = [{ x: cx, y: cy }];
    activeAnn.current = ann;
    setAnnHistory(h => [...h, annotationsRef.current]);
  };

  const onAnnMove = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const cx = e.clientX, cy = e.clientY;
    const fs = frozenSelRef.current;

    if (editAction.current === "moving" && dragOrigin.current && fs) {
      const dx = cx-dragOrigin.current.mx, dy = cy-dragOrigin.current.my;
      const o = dragOrigin.current.sel;
      const W = window.innerWidth, H = window.innerHeight;
      const nfs = {
        x: Math.max(0, Math.min(o.x+dx, W-o.w)),
        y: Math.max(0, Math.min(o.y+dy, H-o.h)),
        w: o.w, h: o.h,
      };
      frozenSelRef.current = nfs;
      setFrozenSel(nfs);
      return;
    }

    if (editAction.current === "resizing" && dragOrigin.current && fs) {
      const dx = cx-dragOrigin.current.mx, dy = cy-dragOrigin.current.my;
      const o = dragOrigin.current.sel;
      let { x, y, w, h } = o;
      const hi = resizeIdx.current;
      if (hi===0||hi===1||hi===2) { y+=dy; h-=dy; }
      if (hi===5||hi===6||hi===7) { h+=dy; }
      if (hi===0||hi===3||hi===5) { x+=dx; w-=dx; }
      if (hi===2||hi===4||hi===7) { w+=dx; }
      if (w>=8 && h>=8) { frozenSelRef.current = {x,y,w,h}; setFrozenSel({x,y,w,h}); }
      return;
    }

    if (editAction.current === "drawing" && activeAnn.current) {
      const ann = activeAnn.current;
      if (ann.type === "pen") {
        const pts = ann.points!;
        const prev = pts[pts.length - 1];
        pts.push({ x: cx, y: cy }); // O(1) mutation — no array allocation
        // Draw only the new segment directly on the visible canvas — O(1) per frame
        const canvas = annRef.current; if (!canvas) return;
        const s = frozenSelRef.current!;
        const ctx = canvas.getContext("2d")!;
        ctx.save();
        ctx.beginPath(); ctx.rect(s.x, s.y, s.w, s.h); ctx.clip();
        ctx.strokeStyle = ann.color;
        ctx.lineWidth = ann.strokeWidth;
        ctx.lineCap = "round"; ctx.lineJoin = "round";
        ctx.beginPath();
        ctx.moveTo(prev.x, prev.y);
        ctx.lineTo(cx, cy);
        ctx.stroke();
        ctx.restore();
      } else {
        ann.x2 = cx; ann.y2 = cy;
        renderWithActive(ann);
      }
      return;
    }

    // Cursor update
    if (!fs) return;
    const hi2 = hitHandle(fs, cx, cy);
    if (hi2 !== -1) setAnnCursor(HANDLE_CURSORS[hi2]);
    else if (toolRef.current === "pointer" && inside(fs, cx, cy)) setAnnCursor("move");
    else if (toolRef.current === "pointer") setAnnCursor("default");
    else setAnnCursor("crosshair");
  }, [renderWithActive]);

  const onAnnUp = () => {
    if (editAction.current === "drawing" && activeAnn.current) {
      const ann = { ...activeAnn.current };
      if (ann.type === "pen" && ann.points) ann.points = [...ann.points];
      setAnnotations(prev => { const next = [...prev, ann]; annotationsRef.current = next; return next; });
    }
    activeAnn.current  = null;
    editAction.current = "idle";
    resizeIdx.current  = -1;
    dragOrigin.current = null;
  };

  const submitText = (text: string) => {
    if (!textPos || !text.trim()) { setTextPos(null); return; }
    const ann: Annotation = {
      id: `ann_${Date.now()}`, type: "text",
      x: textPos.x, y: textPos.y, text,
      color: colorRef.current, strokeWidth: strokeRef.current,
    };
    setAnnHistory(h => [...h, annotationsRef.current]);
    setAnnotations(prev => { const next = [...prev, ann]; annotationsRef.current = next; return next; });
    setTextPos(null);
  };

  const undo = useCallback(() => {
    setAnnHistory(h => {
      if (!h.length) return h;
      const prev = h[h.length-1];
      annotationsRef.current = prev;
      setAnnotations(prev);
      if (prev.length < annotationsRef.current.length)
        setNextNum(n => { const nv = Math.max(1, n-1); nextNumRef.current = nv; return nv; });
      return h.slice(0, -1);
    });
  }, []);

  // ── Export ────────────────────────────────────────────────────────────────────

  /** Scale annotation coordinates from overlay-space to crop-relative physical pixels. */
  const scaleAnnotation = useCallback((a: Annotation, origin: FrozenSel, scale: number): Annotation => ({
    ...a,
    x:  (a.x  - origin.x) * scale,
    y:  (a.y  - origin.y) * scale,
    x2: a.x2 !== undefined ? (a.x2 - origin.x) * scale : undefined,
    y2: a.y2 !== undefined ? (a.y2 - origin.y) * scale : undefined,
    points: a.points?.map(p => ({ x: (p.x - origin.x) * scale, y: (p.y - origin.y) * scale })),
    strokeWidth: a.strokeWidth * scale,
  }), []);

  /**
   * Build a full-resolution (physical-pixel) canvas by:
   *  1. Calling crop_region in Rust to get the clean Retina crop.
   *  2. Drawing annotations at physical scale on top.
   * Fixes both the Retina quality issue and the mosaic background-sampling bug.
   */
  const buildHiResCanvas = useCallback(async (): Promise<HTMLCanvasElement | null> => {
    const fs = frozenSelRef.current; if (!fs) return null;
    const scale = snapScaleRef.current;

    const cleanData: string = await invoke<string>("crop_region", {
      x: fs.x, y: fs.y, w: fs.w, h: fs.h,
    }).catch(() => "");
    if (!cleanData) return null;

    const cleanImg = new Image();
    await new Promise<void>(res => { cleanImg.onload = () => res(); cleanImg.src = `data:image/png;base64,${cleanData}`; });

    const pw = cleanImg.naturalWidth;
    const ph = cleanImg.naturalHeight;

    // Separate clean-background canvas for correct mosaic sampling
    const cleanBg = document.createElement("canvas");
    cleanBg.width = pw; cleanBg.height = ph;
    cleanBg.getContext("2d")!.drawImage(cleanImg, 0, 0);

    // Output canvas: clean background + scaled annotations
    const out = document.createElement("canvas");
    out.width = pw; out.height = ph;
    const ctx = out.getContext("2d")!;
    ctx.drawImage(cleanImg, 0, 0);
    annotationsRef.current.forEach(a =>
      drawOneAnnotation(ctx, scaleAnnotation(a, fs, scale), cleanBg)
    );
    return out;
  }, [scaleAnnotation]);

  const handleCopy = useCallback(async () => {
    const c = await buildHiResCanvas(); if (!c) return;
    const b64 = c.toDataURL("image/png").split(",")[1];
    const bytes = new Uint8Array(atob(b64).split("").map(ch => ch.charCodeAt(0)));
    await writeImage(bytes);
    invoke("save_to_history", { data: b64, width: c.width, height: c.height }).catch(() => {});
    showFlash("已复制到剪贴板");
    setTimeout(() => invoke("close_overlay"), 600);
  }, [buildHiResCanvas, showFlash]);

  const handleSave = useCallback(async () => {
    const c = await buildHiResCanvas(); if (!c) return;
    const filePath = await save({
      filters: [{ name: "PNG 图片", extensions: ["png"] }, { name: "JPEG 图片", extensions: ["jpg"] }],
      defaultPath: `截图_${Date.now()}.png`,
    });
    if (!filePath) return;
    const data = c.toDataURL("image/png").split(",")[1];
    await invoke("save_image", { path: filePath, data });
    invoke("save_to_history", { data, width: c.width, height: c.height }).catch(() => {});
    showFlash("已保存");
    setTimeout(() => invoke("close_overlay"), 800);
  }, [buildHiResCanvas, showFlash]);

  const handlePin = useCallback(async () => {
    const c = await buildHiResCanvas(); if (!c) return;
    const data = c.toDataURL("image/png").split(",")[1];
    await invoke("pin_from_overlay", { data });
  }, [buildHiResCanvas]);

  const handleOpenEditor = useCallback(() => {
    const fs = frozenSelRef.current; if (!fs) return;
    invoke("do_region_capture", { x: fs.x, y: fs.y, width: fs.w, height: fs.h });
  }, []);

  // ── Keyboard ──────────────────────────────────────────────────────────────────

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (phase === "editing") {
          // First Esc: deselect and go back to selecting
          frozenSelRef.current = null;
          setFrozenSel(null);
          setAnnotations([]); annotationsRef.current = [];
          setAnnHistory([]); setNextNum(1); nextNumRef.current = 1;
          setPhase("selecting");
          drawSel({ startX: 0, startY: 0, endX: 0, endY: 0 }, false);
        } else {
          invoke("close_overlay");
        }
        return;
      }
      if (phase !== "editing") return;
      if ((e.metaKey||e.ctrlKey) && e.key === "z") { e.preventDefault(); undo(); }
      if ((e.metaKey||e.ctrlKey) && e.key === "c") { e.preventDefault(); handleCopy(); }
      if ((e.metaKey||e.ctrlKey) && e.key === "s") { e.preventDefault(); handleSave(); }
      if (e.key === "Enter") { e.preventDefault(); handleCopy(); }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [phase, undo, handleCopy, handleSave, drawSel]);

  // ── Toolbar position ──────────────────────────────────────────────────────────

  const tbStyle = (): React.CSSProperties => {
    const fs = frozenSel; if (!fs) return { display: "none" };
    const { x, y, w, h } = fs;
    const TH = 40, TW = 500, GAP = 8;
    const left = Math.max(4, Math.min(x+(w-TW)/2, window.innerWidth-TW-4));
    const below = y+h+GAP;
    const top = below+TH > window.innerHeight-4 ? Math.max(4, y-TH-GAP) : below;
    return { left, top };
  };

  // ── Render ────────────────────────────────────────────────────────────────────

  return (
    <div className="overlay-root" tabIndex={0} autoFocus>
      <canvas ref={bgRef} className="overlay-bg" />
      <canvas
        ref={selRef}
        className="overlay-canvas"
        style={{ pointerEvents: phase === "selecting" ? "auto" : "none" }}
        onMouseDown={onSelDown}
        onMouseMove={onSelMove}
      />
      {phase === "editing" && (
        <canvas
          ref={annRef}
          className="overlay-canvas"
          style={{ cursor: annCursor }}
          onMouseDown={onAnnDown}
          onMouseMove={onAnnMove}
          onMouseUp={onAnnUp}
          onMouseLeave={onAnnUp}
        />
      )}

      {textPos && (
        <input
          ref={textRef}
          className="overlay-text-input"
          style={{ left: textPos.x, top: textPos.y, color }}
          placeholder="输入文字，回车确认"
          onKeyDown={e => {
            if (e.key === "Enter") submitText(e.currentTarget.value);
            if (e.key === "Escape") setTextPos(null);
          }}
          onBlur={e => submitText(e.currentTarget.value)}
        />
      )}

      {showTip && phase === "selecting" && (
        <div className="overlay-tooltip" style={{ left: tooltip.x+14, top: tooltip.y+14 }}>
          {tooltip.w} × {tooltip.h}
        </div>
      )}

      {phase === "selecting" && <div className="overlay-hint">拖拽选择区域 · ESC 取消</div>}

      {phase === "editing" && frozenSel && (
        <div className="overlay-toolbar" style={tbStyle()}>
          <div className="otb-group">
            {TOOLS.map(({ t, icon, label }) => (
              <button key={t} className={`otb-btn ${tool===t?"active":""}`} title={label}
                onClick={() => { setTool(t); toolRef.current = t; }}>
                {icon}
              </button>
            ))}
          </div>
          <div className="otb-sep" />
          <div className="otb-group">
            {COLORS.map(c => (
              <button key={c} className={`otb-color ${color===c?"active":""}`}
                style={{ background: c }}
                onClick={() => { setColor(c); colorRef.current = c; }} />
            ))}
          </div>
          <div className="otb-sep" />
          <div className="otb-group">
            {STROKES.map(([w]) => (
              <button key={w} className={`otb-btn ${strokeWidth===w?"active":""}`}
                onClick={() => { setStrokeWidth(w); strokeRef.current = w; }}>
                <span className="otb-stroke-dot" style={{ width: w+4, height: w+4 }} />
              </button>
            ))}
          </div>
          <div className="otb-sep" />
          <div className="otb-group">
            <button className="otb-btn" title="撤销 ⌘Z" onClick={undo}>↩</button>
            <button className="otb-btn" title="清空标注" onClick={() => {
              setAnnotations([]); annotationsRef.current = [];
              setAnnHistory([]); setNextNum(1); nextNumRef.current = 1;
            }}>⊘</button>
          </div>
          <div className="otb-sep" />
          <div className="otb-group">
            <button className="otb-btn otb-pin"   title="钉图"              onClick={handlePin}>📌</button>
            <button className="otb-btn otb-edit"  title="打开编辑器"         onClick={handleOpenEditor}>✏️</button>
            <button className="otb-btn otb-copy"  title="复制 Enter"        onClick={handleCopy}>✓ 复制</button>
            <button className="otb-btn otb-save"  title="保存 ⌘S"           onClick={handleSave}>💾</button>
            <button className="otb-btn otb-close" title="重选 ESC / 关闭 ESC×2" onClick={() => {
              frozenSelRef.current = null; setFrozenSel(null);
              setAnnotations([]); annotationsRef.current = [];
              setAnnHistory([]); setNextNum(1); nextNumRef.current = 1;
              setPhase("selecting");
              drawSel({ startX: 0, startY: 0, endX: 0, endY: 0 }, false);
            }}>↺</button>
            <button className="otb-btn otb-quit" title="关闭截图" onClick={() => invoke("close_overlay")}>✕</button>
          </div>
        </div>
      )}

      {toast && <div className="overlay-toast">{toast}</div>}
    </div>
  );
}
