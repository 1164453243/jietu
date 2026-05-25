import { useEffect, useState } from "react";
import Overlay from "./windows/overlay/Overlay";
import Editor from "./windows/editor/Editor";
import Settings from "./windows/settings/Settings";
import Main from "./windows/main/Main";
import Pin from "./windows/pin/Pin";
import "./App.css";

type WindowType = "overlay" | "editor" | "settings" | "pin" | "main";

function getWindowType(): WindowType {
  const hash = window.location.hash.replace("#", "").replace("/", "");
  if (hash === "overlay") return "overlay";
  if (hash === "editor") return "editor";
  if (hash === "settings") return "settings";
  if (hash === "pin") return "pin";
  return "main";
}

export default function App() {
  const [windowType, setWindowType] = useState<WindowType>(getWindowType());

  useEffect(() => {
    const handler = () => setWindowType(getWindowType());
    window.addEventListener("hashchange", handler);
    return () => window.removeEventListener("hashchange", handler);
  }, []);

  if (windowType === "overlay") return <Overlay />;
  if (windowType === "editor") return <Editor />;
  if (windowType === "settings") return <Settings />;
  if (windowType === "pin") return <Pin />;
  return <Main />;
}
