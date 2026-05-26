import { useEffect, useState, useRef, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { listen } from "@tauri-apps/api/event";
import "./main.css";

const win = getCurrentWebviewWindow();

interface ScreenshotRecord {
  id: string;
  created_at: number;
  width: number;
  height: number;
  thumb: string;
  file_path: string;
}

export default function Main() {
  const [hasPermission, setHasPermission] = useState<boolean | null>(null);
  const [requesting, setRequesting] = useState(false);
  const [countdown, setCountdown] = useState<number | null>(null);
  const [history, setHistory] = useState<ScreenshotRecord[]>([]);
  const [copyingId, setCopyingId] = useState<string | null>(null);
  const countdownRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    invoke<boolean>("check_screen_capture_permission").then(setHasPermission);
    loadHistory();
    const unlistenClose  = win.onCloseRequested((e) => { e.preventDefault(); win.hide(); });
    // Refresh history instantly when a new screenshot is saved or one is deleted
    const unlistenSaved  = listen("screenshot-saved",  () => loadHistory());
    const unlistenDeleted = listen("history-changed",  () => loadHistory());
    return () => {
      unlistenClose.then(f => f());
      unlistenSaved.then(f => f());
      unlistenDeleted.then(f => f());
    };
  }, []);

  const loadHistory = async () => {
    const records = await invoke<ScreenshotRecord[]>("get_screenshot_history").catch(() => []);
    setHistory(records);
  };

  const handleCapture = async (cmd: string) => {
    try {
      await invoke(cmd);
    } catch (e) {
      if (e === "no_permission") setHasPermission(false);
    }
  };

  const handleRequestPermission = async () => {
    setRequesting(true);
    const granted = await invoke<boolean>("request_screen_capture_permission");
    setRequesting(false);
    if (granted) setHasPermission(true);
  };

  const handleDelayedCapture = useCallback((delaySecs: number) => {
    if (countdown !== null) return; // already running
    let remaining = delaySecs;
    setCountdown(remaining);
    countdownRef.current = setInterval(() => {
      remaining--;
      if (remaining <= 0) {
        if (countdownRef.current) clearInterval(countdownRef.current);
        setCountdown(null);
        handleCapture("start_region_capture");
      } else {
        setCountdown(remaining);
      }
    }, 1000);
  }, [countdown]);

  const cancelCountdown = () => {
    if (countdownRef.current) clearInterval(countdownRef.current);
    setCountdown(null);
  };

  const handleCopyHistory = async (id: string) => {
    setCopyingId(id);
    await invoke("copy_history_item", { id }).catch(() => {});
    setTimeout(() => setCopyingId(null), 1200);
    setTimeout(loadHistory, 200);
  };

  const handleClearHistory = async () => {
    await invoke("clear_screenshot_history");
    setHistory([]);
  };

  const handleDeleteItem = async (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    await invoke("delete_history_item", { id }).catch(() => {});
    setHistory(prev => prev.filter(r => r.id !== id));
  };

  const formatTime = (ts: number) => {
    const d = new Date(ts * 1000);
    const h = d.getHours().toString().padStart(2, "0");
    const m = d.getMinutes().toString().padStart(2, "0");
    return `${h}:${m}`;
  };

  return (
    <div className="main-root">
      {/* Title bar */}
      <div className="titlebar" data-tauri-drag-region>
        <img src="/icon.png" className="tb-icon" alt="" />
        <span className="tb-title">截图工具</span>
        <button className="tb-btn" title="设置" onClick={() => invoke("open_settings")}>
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="3"/>
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
          </svg>
        </button>
      </div>

      <div className="main-body">
        {/* Permission warning */}
        {hasPermission === false && (
          <div className="perm-bar">
            <span>⚠️</span>
            <span className="perm-bar-text">需要<strong>屏幕录制权限</strong>才能截取内容</span>
            <button className="perm-bar-btn" onClick={handleRequestPermission} disabled={requesting}>
              {requesting ? "…" : "授权"}
            </button>
          </div>
        )}

        {/* Countdown overlay */}
        {countdown !== null && (
          <div className="countdown-bar">
            <span className="countdown-num">{countdown}</span>
            <span className="countdown-text">秒后截图</span>
            <button className="countdown-cancel" onClick={cancelCountdown}>取消</button>
          </div>
        )}

        {/* Capture buttons */}
        <div className="capture-row">
          <button className="capture-btn" onClick={() => handleCapture("start_region_capture")}>
            <div className="capture-btn-icon">
              <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <path d="M3 7V5a2 2 0 0 1 2-2h2M17 3h2a2 2 0 0 1 2 2v2M21 17v2a2 2 0 0 1-2 2h-2M7 21H5a2 2 0 0 1-2-2v-2"/>
              </svg>
            </div>
            <div className="capture-btn-label">区域截图</div>
            <div className="capture-btn-key">⌘ ⇧ A</div>
          </button>

          <button className="capture-btn" onClick={() => handleCapture("start_fullscreen_capture")}>
            <div className="capture-btn-icon">
              <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <rect x="2" y="3" width="20" height="14" rx="2"/>
                <path d="M8 21h8M12 17v4"/>
              </svg>
            </div>
            <div className="capture-btn-label">全屏截图</div>
            <div className="capture-btn-key">⌘ ⇧ F</div>
          </button>
        </div>

        {/* Delay capture row */}
        <div className="delay-row">
          <span className="delay-label">延时截图：</span>
          {[3, 5, 10].map((secs) => (
            <button
              key={secs}
              className="delay-btn"
              disabled={countdown !== null}
              onClick={() => handleDelayedCapture(secs)}
            >
              {secs}秒
            </button>
          ))}
        </div>

        {/* History section */}
        <div className="history-header">
          <span className="section-label">最近截图</span>
          {history.length > 0 && (
            <button className="history-clear" onClick={handleClearHistory} title="清空历史">清空</button>
          )}
        </div>

        {history.length > 0 ? (
          <div className="history-grid">
            {history.map((item) => (
              <div
                key={item.id}
                className={`history-item ${copyingId === item.id ? "copying" : ""}`}
                title={`${item.width}×${item.height}  ${formatTime(item.created_at)}`}
                onClick={() => handleCopyHistory(item.id)}
              >
                <img
                  src={`data:image/jpeg;base64,${item.thumb}`}
                  className="history-thumb"
                  alt="screenshot"
                  draggable={false}
                />
                <div className="history-time">{formatTime(item.created_at)}</div>
                {copyingId === item.id && <div className="history-copied">已复制</div>}
                <button
                  className="history-delete"
                  title="删除"
                  onClick={(e) => handleDeleteItem(e, item.id)}
                >✕</button>
              </div>
            ))}
          </div>
        ) : (
          <div className="history-empty">
            <div className="history-empty-icon">🖼</div>
            <div>截图后将显示在这里</div>
            <div className="history-empty-sub">点击缩略图可快速复制</div>
          </div>
        )}
      </div>

      <div className="main-footer">
        关闭窗口后仍在菜单栏运行 · <kbd>Esc</kbd> 可取消截图
      </div>
    </div>
  );
}
