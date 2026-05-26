# 打包说明

## 本机打包（macOS）

```bash
cd jietu
npm run tauri build
```

产物在 `src-tauri/target/release/bundle/`:
- `dmg/截图_0.1.0_x64.dmg`   ← 安装包
- `macos/截图.app`            ← 应用包（可直接运行）

---

## 双平台打包（GitHub Actions）

### 第一步：在 GitHub 创建仓库

```bash
# 在 GitHub 网站新建仓库后：
git remote add origin https://github.com/1164453243/jietu.git
git push -u origin main
```

### 第二步：发布新版本触发构建

```bash
git tag v0.1.0
git push origin v0.1.0
```

GitHub Actions 会自动在以下环境各构建一次：
- `macos-latest` → Apple Silicon `.dmg`
- `macos-latest` → Intel `.dmg`
- `windows-latest` → `.exe` (NSIS) + `.msi` (WiX)

构建完成后在 GitHub Releases 页面下载。

### 手动触发（不打 tag）

在 GitHub → Actions → Release → Run workflow 点击手动触发。

---

## macOS 签名（可选，正式发布时用）

在 GitHub 仓库 Settings → Secrets → Actions 中添加：

| Secret 名 | 说明 |
|-----------|------|
| `APPLE_CERTIFICATE` | .p12 证书的 base64 内容 |
| `APPLE_CERTIFICATE_PASSWORD` | 证书密码 |
| `APPLE_SIGNING_IDENTITY` | 证书名（Developer ID Application: ...） |
| `APPLE_ID` | Apple ID 邮箱 |
| `APPLE_PASSWORD` | App 专用密码 |
| `APPLE_TEAM_ID` | 开发者团队 ID |

没有配置时跳过签名，安装包仍可使用（用户需要在系统偏好 → 安全中手动允许）。

---

## Windows 签名（可选）

在 Secrets 中添加：

| Secret 名 | 说明 |
|-----------|------|
| `WINDOWS_CERTIFICATE` | .p[BUILD.md](BUILD.md)fx 证书的 base64 内容 |
| `WINDOWS_CERTIFICATE_PASSWORD` | 证书密码 |

---
[BUILD.md](BUILD.md)
## 版本更新流程

1. 修改 `src-tauri/tauri.conf.json` 中的 `version`
2. 修改 `src-tauri/Cargo.toml` 中的 `version`
3. 提交代码
4. 打 tag：`git tag v0.2.0 && git push origin v0.2.0`
