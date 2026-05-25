import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import "./settings.css";

interface HotkeyConfig {
  region: string;
  fullscreen: string;
}

const DEFAULT_HOTKEYS: HotkeyConfig = {
  region: "CommandOrControl+Shift+A",
  fullscreen: "CommandOrControl+Shift+F",
};

const SHORTCUT_LABELS: Record<string, string> = {
  region: "区域截图",
  fullscreen: "全屏截图",
};

export default function Settings() {
  const [hotkeys, setHotkeys] = useState<HotkeyConfig>(DEFAULT_HOTKEYS);
  const [recording, setRecording] = useState<keyof HotkeyConfig | null>(null);
  const [conflicts, setConflicts] = useState<Partial<Record<keyof HotkeyConfig, string>>>({});
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    invoke<HotkeyConfig | null>("get_hotkey_config").then((cfg) => {
      if (cfg) setHotkeys(cfg);
    });
  }, []);

  const startRecord = (key: keyof HotkeyConfig) => {
    setRecording(key);
  };

  const onKeyDown = async (e: React.KeyboardEvent) => {
    if (!recording) return;
    e.preventDefault();
    e.stopPropagation();

    const mods: string[] = [];
    if (e.metaKey || e.ctrlKey) mods.push("CommandOrControl");
    if (e.altKey) mods.push("Alt");
    if (e.shiftKey) mods.push("Shift");

    const code = e.key;
    if (["Control", "Meta", "Alt", "Shift"].includes(code)) return;
    if (mods.length === 0) {
      if (code === "Escape") { setRecording(null); return; }
      return;
    }

    const shortcut = [...mods, code.toUpperCase()].join("+");
    const newHotkeys = { ...hotkeys, [recording]: shortcut };

    // Check conflict
    const conflict = await invoke<string | null>("check_shortcut_conflict", {
      shortcut,
      ignoreKey: recording,
    });

    setConflicts((prev) => ({
      ...prev,
      [recording]: conflict ?? undefined,
    }));

    setHotkeys(newHotkeys);
    setRecording(null);
  };

  const handleSave = async () => {
    const hasConflict = Object.values(conflicts).some(Boolean);
    if (hasConflict) return;
    await invoke("save_hotkey_config", { config: hotkeys });
    setSaved(true);
    setTimeout(() => setSaved(false), 1800);
  };

  const handleReset = () => {
    setHotkeys(DEFAULT_HOTKEYS);
    setConflicts({});
  };

  return (
    <div className="settings-root" onKeyDown={onKeyDown} tabIndex={0}>
      <div className="settings-header">
        <div className="settings-icon">⌨</div>
        <div>
          <div className="settings-title">设置</div>
          <div className="settings-subtitle">截图工具配置</div>
        </div>
      </div>

      <div className="settings-section">
        <div className="section-label">全局快捷键</div>
        {(Object.keys(hotkeys) as (keyof HotkeyConfig)[]).map((key) => (
          <div key={key} className="hotkey-row">
            <span className="hotkey-name">{SHORTCUT_LABELS[key]}</span>
            <div className="hotkey-right">
              <button
                className={`hotkey-input ${recording === key ? "recording" : ""} ${conflicts[key] ? "conflict" : ""}`}
                onClick={() => startRecord(key)}
                title="点击后按下新快捷键"
              >
                {recording === key
                  ? "请按下快捷键…"
                  : formatShortcut(hotkeys[key])}
              </button>
              {conflicts[key] && (
                <span className="conflict-tip">⚠ {conflicts[key]}</span>
              )}
            </div>
          </div>
        ))}
        <div className="hotkey-hint">点击快捷键框后按下新组合键（需包含 Ctrl / Cmd），ESC 取消</div>
      </div>

      <div className="settings-footer">
        <button className="btn-reset" onClick={handleReset}>恢复默认</button>
        <button
          className="btn-save"
          onClick={handleSave}
          disabled={Object.values(conflicts).some(Boolean)}
        >
          {saved ? "已保存 ✓" : "保存"}
        </button>
      </div>
    </div>
  );
}

function formatShortcut(s: string): string {
  return s
    .replace("CommandOrControl", /Mac|iPhone|iPad/i.test(navigator.platform) ? "⌘" : "Ctrl")
    .replace("Shift", "⇧")
    .replace("Alt", "⌥")
    .replace(/\+/g, " ");
}
