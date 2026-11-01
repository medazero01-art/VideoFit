# VideoFit

> A BetterDiscord plugin that adds **Compress** and **Split** buttons directly to Discord's *"Your files are too powerful"* modal — re-encoding or losslessly splitting oversized videos locally with FFmpeg and attaching them back to your message automatically.

![Platform](https://img.shields.io/badge/platform-Windows-0078D6?logo=windows)
![BetterDiscord](https://img.shields.io/badge/BetterDiscord-Plugin-3E82E5)
![License](https://img.shields.io/badge/license-MIT-green)

---

## ✨ Features

- **Seamless Discord Integration** — Detects when a video exceeds the upload limit (`10 MB`, `50 MB`, `500 MB`, etc.) and injects two action buttons directly inside Discord's upload error modal:
  - **Compress**: Fits the entire video into a single file under the size limit by calculating the optimal target bitrate and resolution (`1080p` / `720p` / `480p` / `360p`), using 2-pass `libx264` CPU encoding or hardware-accelerated `h264_nvenc` (NVIDIA GPU).
  - **Split**: Preserves original quality by splitting the video into parts that each fit within the limit. Uses near-instant **lossless stream copy** (`-c:v copy`) for H.264 videos, with automatic fallback to high-bitrate re-encoding for HEVC/AV1 or sparse keyframes.
- **Zero-Config FFmpeg Setup** — Automatically downloads and verifies (`SHA-256`) a standalone `ffmpeg.exe` binary on first use, or lets you point to your own installation.
- **Smart Batch Queue** — If splitting produces more than 10 parts (Discord's per-message attachment limit), VideoFit attaches the first 10 files and displays a floating queue widget to attach the next batch once sent.
- **Live Progress & Cancellation** — Real-time progress bar overlay with current pass, resolution, bitrate, and one-click cancellation.

---

## 📥 Installation

1. Make sure you have [BetterDiscord](https://betterdiscord.app/) installed on Windows.
2. Download [`VideoFit.plugin.js`](./VideoFit.plugin.js).
3. Move `VideoFit.plugin.js` into your BetterDiscord plugins folder:
   - In Discord, go to **User Settings** → **BetterDiscord** → **Plugins** → click **Open Plugins Folder** (usually `%APPDATA%\BetterDiscord\plugins`).
4. Enable **VideoFit** in your BetterDiscord Plugins list.

---

## 🚀 Usage

1. Drag & drop, paste, or select a video file in any Discord channel or DM.
2. When Discord displays the *"Your files are too powerful"* modal, two buttons appear at the bottom:
   - **Compress** — `1 file under X MB, reduced quality`
   - **Split** — `~N parts of X MB, original quality`
3. Click your preferred option. On first run, VideoFit will ask permission to download FFmpeg (~30 MB compressed) into its temporary folder.
4. Wait for the progress bar in the bottom-right corner to complete — the processed video(s) will be attached to your message box automatically!

---

## ⚙️ Settings

Open **User Settings** → **BetterDiscord** → **Plugins** → **VideoFit settings**:

| Setting | Default | Description |
| :--- | :--- | :--- |
| **ffmpeg** | `auto` | `auto` downloads FFmpeg on first use. Set to `ffmpeg` if it's in your `PATH`, or provide a full path to `ffmpeg.exe`. |
| **Temporary folder** | `E:\VideoFit` or `%TEMP%\VideoFit` | Directory used for intermediate jobs, segments, and the auto-downloaded FFmpeg binary. |
| **Encoder** | `libx264` (CPU, 2-pass) | Choose between `libx264` (more accurate file size) or `h264_nvenc` (much faster on NVIDIA GPUs). |
| **Split with re-encoding: target video bitrate (kbps)** | `5000` | Target video bitrate used only when a video isn't H.264 (e.g., HEVC, AV1) and cannot be losslessly stream-copied. |
| **Keep generated files** | `false` | Keep output MP4 files in the temporary folder after attaching them to Discord. |

---

## 🔧 How It Works Under the Hood

BetterDiscord plugins run in a restricted context that does not expose Node's `child_process`. To run `ffmpeg.exe` cleanly on Windows without freezing Discord or flashing console windows:

1. VideoFit writes a temporary `.cmd` batch script for the FFmpeg job and launches it hidden via `electron.shell.openPath` using a tiny UTF-16LE `.vbs` wrapper (`WScript.Shell.Run ..., 0, False`), with an automatic fallback to a minimized `.cmd` window if `.vbs` execution is blocked on the system.
2. Progress is tracked asynchronously by polling FFmpeg's `-progress` output file.
3. Once completed, the resulting MP4 files are read into `File` objects and attached via Discord's internal `promptToUpload` module (with a fallback to a synthetic `ClipboardEvent("paste")`).

---

## 👤 Author

**Ayoub Touat** · [@medazero01-art](https://github.com/medazero01-art)

---

## 📄 License

Distributed under the [MIT License](./LICENSE).
