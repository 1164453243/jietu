import { create } from "zustand";

export type ToolType = "pointer" | "rect" | "circle" | "arrow" | "text" | "mosaic";

export interface Annotation {
  id: string;
  type: ToolType;
  x: number;
  y: number;
  x2?: number;
  y2?: number;
  text?: string;
  color: string;
  strokeWidth: number;
}

interface CaptureStore {
  tool: ToolType;
  color: string;
  strokeWidth: number;
  annotations: Annotation[];
  history: Annotation[][];

  setTool: (t: ToolType) => void;
  setColor: (c: string) => void;
  setStrokeWidth: (w: number) => void;
  addAnnotation: (a: Annotation) => void;
  updateAnnotation: (id: string, patch: Partial<Annotation>) => void;
  undo: () => void;
  redo: () => void;
  reset: () => void;
}

export const useCaptureStore = create<CaptureStore>((set) => ({
  tool: "rect",
  color: "#ff3b30",
  strokeWidth: 2,
  annotations: [],
  history: [],

  setTool: (tool) => set({ tool }),
  setColor: (color) => set({ color }),
  setStrokeWidth: (strokeWidth) => set({ strokeWidth }),

  addAnnotation: (a) =>
    set((s) => ({
      history: [...s.history, s.annotations],
      annotations: [...s.annotations, a],
    })),

  updateAnnotation: (id, patch) =>
    set((s) => ({
      annotations: s.annotations.map((a) => (a.id === id ? { ...a, ...patch } : a)),
    })),

  undo: () =>
    set((s) => {
      if (s.history.length === 0) return s;
      const prev = s.history[s.history.length - 1];
      return { annotations: prev, history: s.history.slice(0, -1) };
    }),

  redo: () => set((s) => s), // simplified — full redo needs future stack

  reset: () => set({ annotations: [], history: [] }),
}));
