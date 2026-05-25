import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import "./pin.css";

export default function Pin() {
  const [imgData, setImgData] = useState<string | null>(null);
  const [showClose, setShowClose] = useState(false);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const win = getCurrentWebviewWindow();

  useEffect(() => {
    invoke<string | null>("get_capture_data").then((data) => {
      if (data) setImgData(data);
    });
  }, []);

  // Drag to move window
  const onMouseDown = (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest(".pin-close-btn")) return;
    win.startDragging();
  };

  const onMouseEnter = () => {
    if (hideTimer.current) clearTimeout(hideTimer.current);
    setShowClose(true);
  };

  const onMouseLeave = () => {
    hideTimer.current = setTimeout(() => setShowClose(false), 800);
  };

  return (
    <div
      className="pin-root"
      onMouseDown={onMouseDown}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
    >
      {imgData ? (
        <img
          src={`data:image/png;base64,${imgData}`}
          className="pin-img"
          draggable={false}
          alt="pinned screenshot"
        />
      ) : (
        <div className="pin-loading">…</div>
      )}

      {showClose && (
        <button
          className="pin-close-btn"
          onClick={() => win.close()}
          title="关闭"
        >
          ✕
        </button>
      )}
    </div>
  );
}
