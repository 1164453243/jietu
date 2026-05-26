import { useEffect, useState } from "react";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import Overlay from "./windows/overlay/Overlay";
import Editor from "./windows/editor/Editor";
import Settings from "./windows/settings/Settings";
import Main from "./windows/main/Main";
import Pin from "./windows/pin/Pin";
import "./App.css";

type WindowType = "overlay" | "editor" | "settings" | "pin" | "main";

function getWindowType(): WindowType {
  // Primary: detect by window label (works for all windows including dynamically created ones)
  try {
    const label = getCurrentWebviewWindow().label;
    if (label === "overlay") return "overlay";
    if (label === "editor") return "editor";
    if (label === "settings") return "settings";
    if (label.startsWith("pin_") || label === "pin") return "pin";
    if (label === "main") return "main";
  } catch (_) {}
  // Fallback: hash-based detection
  const hash = window.location.hash.replace(/^#\/?/, "");
  if (hash === "overlay") return "overlay";
  if (hash === "editor") return "editor";
  if (hash === "settings") return "settings";
  if (hash === "pin") return "pin";
  return "main";
}

export default function App() {
  const [windowType] = useState<WindowType>(getWindowType);

  useEffect(() => {
    // Hash changes are no longer used for routing (label-based), but keep listener for safety
  }, []);

  if (windowType === "overlay") return <Overlay />;
  if (windowType === "editor") return <Editor />;
  if (windowType === "settings") return <Settings />;
  if (windowType === "pin") return <Pin />;
  return <Main />;
}
