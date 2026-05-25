import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import "./settings.css";

interface HotkeyConfig {
  region: string;
  fullscreen: string;
}

interface AppSettings {
  save_path: string;
  format: string;
  auto_save: boolean;
  keep_history: boolean;
  history_limit: number;
}

const DEFAULT_HOTKEYS: HotkeyConfig = {
  region: "CommandOrControl+Shift+A",
  fullscreen: "CommandOrControl+Shift+F",
};

const DEFAULT_SETTINGS: AppSettings = {
  save_path: "",
  format: "png",
  auto_save: false,
  keep_history: true,
  history_limit: 30,
};

const SHORTCUT_LABELS: Record<string, string> = {
  region: "区域截图",
  fullscreen: "全屏截图",
};

export default function Settings() {
  const [hotkeys, setHotkeys] = useState<HotkeyConfig>(DEFAULT_HOTKEYS);
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [recording, setRecording] = useState<keyof HotkeyConfig | null>(null);
  const [conflicts, setConflicts] = useState<Partial<Record<keyof HotkeyConfig, string>>>({});
  const [saved, setSaved] = useState(false);
  const [activeTab, setActiveTab] = useState<"hotkeys" | "general" | "privacy">("general");

  useEffect(() => {
    invoke<HotkeyConfig | null>("get_hotkey_config").then((cfg) => { if (cfg) setHotkeys(cfg); });
    invoke<AppSettings | null>("get_settings").then((s) => { if (s) setSettings(s); });
  }, []);

  // ── Hotkey recording ────────────────────────────────────────────────────────
  const onKeyDown = async (e: React.KeyboardEvent) => {
    if (!recording) return;
    e.preventDefault(); e.stopPropagation();
    const mods: string[] = [];
    if (e.metaKey || e.ctrlKey) mods.push("CommandOrControl");
    if (e.altKey) mods.push("Alt");
    if (e.shiftKey) mods.push("Shift");
    const code = e.key;
    if (["Control", "Meta", "Alt", "Shift"].includes(code)) return;
    if (mods.length === 0) { if (code === "Escape") { setRecording(null); return; } return; }
    const shortcut = [...mods, code.toUpperCase()].join("+");
    const newHotkeys = { ...hotkeys, [recording]: shortcut };
    const conflict = await invoke<string | null>("check_shortcut_conflict", { shortcut, ignoreKey: recording });
    setConflicts((prev) => ({ ...prev, [recording]: conflict ?? undefined }));
    setHotkeys(newHotkeys);
    setRecording(null);
  };

  // ── Save ────────────────────────────────────────────────────────────────────
  const handleSave = async () => {
    const hasConflict = Object.values(conflicts).some(Boolean);
    if (hasConflict) return;
    await invoke("save_hotkey_config", { config: hotkeys });
    await invoke("save_settings", { settings });
    setSaved(true);
    setTimeout(() => setSaved(false), 1800);
  };

  const handleReset = () => {
    setHotkeys(DEFAULT_HOTKEYS);
    setSettings(DEFAULT_SETTINGS);
    setConflicts({});
  };

  const pickFolder = async () => {
    const dir = await openDialog({ directory: true, title: "选择截图保存文件夹" });
    if (typeof dir === "string") setSettings((s) => ({ ...s, save_path: dir }));
  };

  // ── Render ──────────────────────────────────────────────────────────────────
  return (
    <div className="settings-root" onKeyDown={onKeyDown} tabIndex={0} autoFocus>
      <div className="settings-header">
        <div className="settings-icon">⚙</div>
        <div>
          <div className="settings-title">设置</div>
          <div className="settings-subtitle">截图工具配置</div>
        </div>
      </div>

      {/* Tab bar */}
      <div className="settings-tabs">
        {(["general", "hotkeys", "privacy"] as const).map((tab) => (
          <button
            key={tab}
            className={`tab-btn ${activeTab === tab ? "active" : ""}`}
            onClick={() => setActiveTab(tab)}
          >
            {tab === "general" ? "通用" : tab === "hotkeys" ? "快捷键" : "隐私与历史"}
          </button>
        ))}
      </div>

      <div className="settings-section">

        {/* ── General tab ─────────────────────────────── */}
        {activeTab === "general" && (
          <>
            <div className="section-label">保存设置</div>

            <div className="setting-row">
              <div className="setting-info">
                <div className="setting-name">默认保存路径</div>
                <div className="setting-desc">为空时每次保存弹出选择框</div>
              </div>
              <div className="setting-control path-row">
                <input
                  className="path-input"
                  value={settings.save_path}
                  placeholder="未设置，点击选择…"
                  readOnly
                  onClick={pickFolder}
                />
                {settings.save_path && (
                  <button className="path-clear" onClick={() => setSettings((s) => ({ ...s, save_path: "" }))}>✕</button>
                )}
                <button className="path-browse" onClick={pickFolder}>选择</button>
              </div>
            </div>

            <div className="setting-row">
              <div className="setting-info">
                <div className="setting-name">图片格式</div>
              </div>
              <div className="setting-control">
                <select
                  className="format-select"
                  value={settings.format}
                  onChange={(e) => setSettings((s) => ({ ...s, format: e.target.value }))}
                >
                  <option value="png">PNG（无损）</option>
                  <option value="jpg">JPEG（较小）</option>
                </select>
              </div>
            </div>

            <div className="setting-row">
              <div className="setting-info">
                <div className="setting-name">自动保存</div>
                <div className="setting-desc">每次截图完成后自动存入默认路径</div>
              </div>
              <div className="setting-control">
                <label className="toggle">
                  <input
                    type="checkbox"
                    checked={settings.auto_save}
                    onChange={(e) => setSettings((s) => ({ ...s, auto_save: e.target.checked }))}
                  />
                  <span className="toggle-slider" />
                </label>
              </div>
            </div>
          </>
        )}

        {/* ── Hotkeys tab ─────────────────────────────── */}
        {activeTab === "hotkeys" && (
          <>
            <div className="section-label">全局快捷键</div>
            {(Object.keys(hotkeys) as (keyof HotkeyConfig)[]).map((key) => (
              <div key={key} className="hotkey-row">
                <span className="hotkey-name">{SHORTCUT_LABELS[key]}</span>
                <div className="hotkey-right">
                  <button
                    className={`hotkey-input ${recording === key ? "recording" : ""} ${conflicts[key] ? "conflict" : ""}`}
                    onClick={() => setRecording(key)}
                    title="点击后按下新快捷键"
                  >
                    {recording === key ? "请按下快捷键…" : formatShortcut(hotkeys[key])}
                  </button>
                  {conflicts[key] && <span className="conflict-tip">⚠ {conflicts[key]}</span>}
                </div>
              </div>
            ))}
            <div className="hotkey-hint">点击快捷键框后按下新组合键（需包含 Ctrl / Cmd），ESC 取消</div>
          </>
        )}

        {/* ── Privacy tab ─────────────────────────────── */}
        {activeTab === "privacy" && (
          <>
            <div className="section-label">历史记录</div>

            <div className="setting-row">
              <div className="setting-info">
                <div className="setting-name">保存截图历史</div>
                <div className="setting-desc">在主界面显示最近截图缩略图</div>
              </div>
              <div className="setting-control">
                <label className="toggle">
                  <input
                    type="checkbox"
                    checked={settings.keep_history}
                    onChange={(e) => setSettings((s) => ({ ...s, keep_history: e.target.checked }))}
                  />
                  <span className="toggle-slider" />
                </label>
              </div>
            </div>

            <div className="setting-row">
              <div className="setting-info">
                <div className="setting-name">最多保存条数</div>
              </div>
              <div className="setting-control">
                <select
                  className="format-select"
                  value={settings.history_limit}
                  onChange={(e) => setSettings((s) => ({ ...s, history_limit: Number(e.target.value) }))}
                >
                  {[10, 20, 30, 50].map((n) => (
                    <option key={n} value={n}>{n} 条</option>
                  ))}
                </select>
              </div>
            </div>
          </>
        )}
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
