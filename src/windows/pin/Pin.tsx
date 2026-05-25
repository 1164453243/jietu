import { useEffect, useRef, useState, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import { PhysicalSize } from "@tauri-apps/api/dpi";
import "./pin.css";


interface MenuPos { x: number; y: number; }

export default function Pin() {
  const [imgData, setImgData] = useState<string | null>(null);
  const [showClose, setShowClose] = useState(false);
  const [menuPos, setMenuPos] = useState<MenuPos | null>(null);
  const [opacity, setOpacity] = useState(100);
  const [copying, setCopying] = useState(false);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const imgSize = useRef<{ w: number; h: number } | null>(null);
  const win = getCurrentWebviewWindow();

  useEffect(() => {
    invoke<string | null>("get_capture_data").then((data) => {
      if (!data) return;
      setImgData(data);
      const img = new Image();
      img.onload = () => { imgSize.current = { w: img.naturalWidth, h: img.naturalHeight }; };
      img.src = `data:image/png;base64,${data}`;
    });
  }, []);

  const onMouseDown = (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest(".pin-close-btn, .pin-menu")) return;
    win.startDragging();
  };

  const onMouseEnter = () => {
    if (hideTimer.current) clearTimeout(hideTimer.current);
    setShowClose(true);
  };

  const onMouseLeave = () => {
    hideTimer.current = setTimeout(() => setShowClose(false), 800);
  };

  const onWheel = async (e: React.WheelEvent) => {
    e.preventDefault();
    if (!imgSize.current) return;
    const factor = e.deltaY < 0 ? 1.1 : 0.9;
    const outerSize = await win.outerSize();
    let nw = Math.round(outerSize.width * factor);
    const aspect = imgSize.current.w / imgSize.current.h;
    let nh = Math.round(nw / aspect);
    nw = Math.max(80, Math.min(1600, nw));
    nh = Math.max(60, Math.min(1200, nh));
    await win.setSize(new PhysicalSize(nw, nh));
  };

  const onContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    setMenuPos({ x: e.clientX, y: e.clientY });
  };

  const closeMenu = () => setMenuPos(null);

  const handleCopy = async () => {
    if (!imgData) return;
    setCopying(true);
    await invoke("copy_image_data", { data: imgData }).catch(() => {});
    setTimeout(() => setCopying(false), 1000);
    closeMenu();
  };

  const handleSave = async () => {
    if (!imgData) return;
    closeMenu();
    const path = await saveDialog({
      defaultPath: "截图.png",
      filters: [
        { name: "PNG 图片", extensions: ["png"] },
        { name: "JPEG 图片", extensions: ["jpg"] },
      ],
    });
    if (path) {
      await invoke("save_image", { path, data: imgData }).catch(() => {});
    }
  };

  const handleOpacityChange = useCallback((value: number) => {
    setOpacity(value);
    document.documentElement.style.opacity = String(value / 100);
  }, []);

  // Clamp menu position so it doesn't overflow the viewport
  const menuLeft = menuPos ? Math.min(menuPos.x, window.innerWidth - 180) : 0;
  const menuTop  = menuPos ? Math.min(menuPos.y, window.innerHeight - 210) : 0;

  return (
    <div
      className="pin-root"
      onMouseDown={onMouseDown}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      onWheel={onWheel}
      onContextMenu={onContextMenu}
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

      {showClose && !menuPos && (
        <button
          className="pin-close-btn"
          onMouseDown={(e) => e.stopPropagation()}
          onClick={() => win.close()}
          title="关闭"
        >
          ✕
        </button>
      )}

      {menuPos && (
        <>
          <div className="pin-menu-overlay" onMouseDown={closeMenu} />
          <div
            className="pin-menu"
            style={{ left: menuLeft, top: menuTop }}
            onMouseDown={(e) => e.stopPropagation()}
          >
            <button className="pin-menu-item" onClick={handleCopy}>
              {copying ? "已复制 ✓" : "复制图片"}
            </button>
            <button className="pin-menu-item" onClick={handleSave}>
              另存为…
            </button>
            <div className="pin-menu-sep" />
            <div className="pin-menu-opacity">
              <span className="pin-menu-opacity-label">透明度 {opacity}%</span>
              <input
                type="range"
                min={10}
                max={100}
                value={opacity}
                className="pin-menu-slider"
                onChange={(e) => handleOpacityChange(Number(e.target.value))}
              />
            </div>
            <div className="pin-menu-sep" />
            <button
              className="pin-menu-item pin-menu-danger"
              onMouseDown={(e) => e.stopPropagation()}
              onClick={() => win.close()}
            >
              关闭
            </button>
          </div>
        </>
      )}
    </div>
  );
}
