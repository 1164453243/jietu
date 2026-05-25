import { invoke } from "@tauri-apps/api/core";
import "./main.css";

export default function Main() {
  return (
    <div className="main-root">
      <div className="main-logo">
        <img src="/icon.png" alt="logo" width={52} height={52} />
      </div>
      <div className="main-name">截图工具</div>
      <div className="main-actions">
        <button onClick={() => invoke("start_region_capture")}>
          区域截图
          <span className="shortcut">⌘⇧A</span>
        </button>
        <button onClick={() => invoke("start_fullscreen_capture")}>
          全屏截图
          <span className="shortcut">⌘⇧F</span>
        </button>
        <button className="secondary" onClick={() => invoke("open_settings")}>
          设置
        </button>
      </div>
    </div>
  );
}
