/**
 * @name VideoFit - Beta
 * @author Meda
 * @authorLink https://github.com/medazero01-art
 * @description Adds a "Compress / Split" button to Discord's "file is too powerful" modal. Videos are re-encoded locally using ffmpeg (2-pass compression, or split into parts if compression is insufficient), then attached to the message. Windows only.
 * @version 0.2.1
 */

/*
 * BetterDiscord does not expose child_process to plugins. Workaround via
 * electron.shell.openPath: write a .cmd script that invokes ffmpeg, launch it
 * hidden through a small .vbs wrapper (or minimized if .vbs is blocked), and
 * track progress by polling ffmpeg's -progress output file.
 */

const fs = require("fs");
const path = require("path");

const VIDEO_EXT = ["mp4", "mov", "mkv", "webm", "avi", "m4v", "flv", "wmv", "ts", "mts", "m2ts", "3gp"];
const MB = 1000 * 1000; // Decimal MB to stay safely below Discord's limit
const SAFETY = 0.92;    // Headroom for MP4 container overhead
const MAX_FILES_PER_MESSAGE = 10;

const isWin = () => (typeof process !== "undefined" && process.platform === "win32");

function defaultTempDir() {
    try { if (fs.existsSync("E:\\")) return "E:\\VideoFit"; } catch (e) {}
    const env = (typeof process !== "undefined" && process.env) || {};
    return path.join(env.TEMP || env.TMP || "C:\\Windows\\Temp", "VideoFit");
}

// Auto-downloaded on first use (gyan.dev 6.1.1 build via ffmpeg-static), SHA-256 verified before execution.
const FFMPEG_DL = {
    url: "https://github.com/eugeneware/ffmpeg-static/releases/download/b6.1.1/ffmpeg-win32-x64.gz",
    gzSize: 29581307,
    gzSha256: "8883a3dffbd0a16cf4ef95206ea05283f78908dbfb118f73c83f4951dcc06d77",
    exeSize: 82797568
};

const DEFAULTS = {
    ffmpegPath: "auto",
    tempDir: defaultTempDir(),
    encoder: "libx264",    // "libx264" | "h264_nvenc"
    splitVideoKbps: 5000,
    keepFiles: false
};

// Encode string as UTF-16LE with BOM (required by wscript).
function utf16le(str) {
    const out = new Uint8Array(2 + str.length * 2);
    out[0] = 0xFF; out[1] = 0xFE;
    for (let i = 0; i < str.length; i++) {
        const c = str.charCodeAt(i);
        out[2 + i * 2] = c & 0xFF;
        out[3 + i * 2] = c >> 8;
    }
    return out;
}

// Quote an argument for a .cmd file (% must be escaped as %%).
const q = (a) => `"${String(a).replace(/%/g, "%%")}"`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = class VideoFit {
    constructor(meta) {
        this.meta = meta;
        this.pending = null;
        this.busy = false;
        this.job = null;
        this.cancelled = false;
        this.launcher = null; // "vbs" or "cmd", cached after the first successful launch
    }

    start() {
        this.settings = Object.assign({}, DEFAULTS, BdApi.Data.load("VideoFit", "settings") || {});
        // Migrate pre-v4 default (1500 kbps) to high-quality split bitrate
        if (!this.settings.v4) { this.settings.splitVideoKbps = DEFAULTS.splitVideoKbps; this.settings.v4 = true; this.save(); }
        delete this.settings.mode; delete this.settings.minVideoKbps; delete this.settings.ffprobePath;
        this.onDrop = (e) => this.remember(e.dataTransfer && e.dataTransfer.files);
        this.onPaste = (e) => { if (!this.ignoreSynthetic) this.remember(e.clipboardData && e.clipboardData.files); };
        this.onChange = (e) => { if (e.target && e.target.type === "file") this.remember(e.target.files); };
        document.addEventListener("drop", this.onDrop, true);
        document.addEventListener("paste", this.onPaste, true);
        document.addEventListener("change", this.onChange, true);

        this.observer = new MutationObserver(() => this.scanForModal());
        this.observer.observe(document.body, { childList: true, subtree: true });

        BdApi.DOM.addStyle("VideoFit", `
            .vf-choices { display: flex; gap: 8px; width: 100%; flex: none; height: auto; align-self: stretch;
                          box-sizing: border-box; margin-top: 8px; }
            .vf-choice { flex: 1; display: flex; flex-direction: column; align-items: center; gap: 2px; padding: 8px 10px;
                         border-radius: 8px; border: none; cursor: pointer; color: #fff; transition: filter .15s; }
            .vf-choice:hover { filter: brightness(1.12); }
            .vf-choice strong { font-size: 14px; font-weight: 600; }
            .vf-choice span { font-size: 11px; opacity: .85; text-align: center; }
            .vf-compress { background: #4e5058; }
            .vf-split { background: #248046; }
            .vf-row { display: flex; gap: 12px; align-items: center; margin-top: 8px; }
            .vf-next { background: #248046; color: #fff; border: none; border-radius: 6px; padding: 6px 10px; cursor: pointer; font-weight: 600; }
            .vf-overlay { position: fixed; right: 20px; bottom: 90px; z-index: 10000; width: 300px; padding: 12px 14px;
                          border-radius: 10px; background: #1e1f22; color: #dbdee1; box-shadow: 0 8px 24px rgba(0,0,0,.45);
                          font-size: 13px; }
            .vf-bar { height: 6px; border-radius: 3px; background: #3f4147; margin: 8px 0; overflow: hidden; }
            .vf-bar > div { height: 100%; width: 0; background: #23a55a; transition: width .2s; }
            .vf-cancel { background: none; border: none; color: #f23f43; cursor: pointer; padding: 0; font-size: 12px; }
            .vf-panel label { display: block; margin: 10px 0 4px; color: var(--header-primary, #f2f3f5); font-weight: 600; }
            .vf-panel input, .vf-panel select { width: 100%; padding: 6px 8px; border-radius: 4px; border: 1px solid #3f4147;
                                                 background: #1e1f22; color: #dbdee1; box-sizing: border-box; }
            .vf-panel small { color: #949ba4; }
        `);
    }

    stop() {
        document.removeEventListener("drop", this.onDrop, true);
        document.removeEventListener("paste", this.onPaste, true);
        document.removeEventListener("change", this.onChange, true);
        if (this.observer) this.observer.disconnect();
        if (this.busy) this.cancel();
        this.removeOverlay();
        this.removeQueue();
        document.querySelectorAll(".vf-btn").forEach((b) => b.remove());
        BdApi.DOM.removeStyle("VideoFit");
    }

    isVideo(file) {
        if (file.type && file.type.startsWith("video/")) return true;
        const ext = (file.name.split(".").pop() || "").toLowerCase();
        return VIDEO_EXT.includes(ext);
    }

    remember(fileList) {
        if (!fileList || !fileList.length) return;
        const store = BdApi.Webpack.getStore("SelectedChannelStore");
        this.pending = {
            files: Array.from(fileList),
            time: Date.now(),
            channelId: store ? store.getChannelId() : null
        };
    }

    scanForModal() {
        if (!this.pending || Date.now() - this.pending.time > 10000 || this.busy) return;
        for (const dialog of document.querySelectorAll('[role="dialog"]')) {
            if (dialog.querySelector(".vf-btn")) continue;
            const m = (dialog.textContent || "").match(/(\d+(?:[.,]\d+)?)\s*(Mo|MB)\b/i);
            if (!m) continue;
            const limitMo = parseFloat(m[1].replace(",", "."));
            if (!this.pending.files.some((f) => this.isVideo(f) && f.size > limitMo * MB)) continue;
            this.injectButton(dialog, limitMo);
        }
    }

    injectButton(dialog, limitMo) {
        const buttons = dialog.querySelectorAll("button");
        if (!buttons.length) return;
        const parts = this.pending.files
            .filter((f) => this.isVideo(f) && f.size > limitMo * MB)
            .reduce((n, f) => n + Math.ceil(f.size / (limitMo * MB * 0.93)), 0);

        const wrap = document.createElement("div");
        wrap.className = "vf-btn vf-choices";
        const make = (title, sub, choice, cls) => {
            const b = document.createElement("button");
            b.type = "button";
            b.className = "vf-choice " + cls;
            b.innerHTML = `<strong></strong><span></span>`;
            b.querySelector("strong").textContent = title;
            b.querySelector("span").textContent = sub;
            b.addEventListener("click", (e) => {
                e.preventDefault();
                e.stopPropagation();
                const job = this.pending;
                this.pending = null;
                this.closeModal(dialog);
                this.process(job, limitMo, choice);
            });
            return b;
        };
        wrap.appendChild(make("Compress", `1 file under ${limitMo} MB, reduced quality`, "compress", "vf-compress"));
        wrap.appendChild(make("Split", `~${parts} part${parts > 1 ? "s" : ""} of ${limitMo} MB, original quality`, "split", "vf-split"));
        this.placeBelowLastButton(dialog, buttons, wrap);
    }

    // Locate the bottom-most wide button (e.g. "Get Nitro") and walk up through tight
    // glow wrappers or row flex containers so the choices render below it, not beside it.
    placeBelowLastButton(dialog, buttons, wrap) {
        const rect = (el) => el.getBoundingClientRect();
        const wide = Array.from(buttons).filter((b) => {
            const r = rect(b);
            return r.width > 80 && r.height > 20;
        });
        const last = wide.length
            ? wide.reduce((a, b) => (rect(b).bottom >= rect(a).bottom ? b : a))
            : buttons[buttons.length - 1];

        const isRow = (el) => {
            const cs = getComputedStyle(el);
            return /flex/.test(cs.display) && !/column/.test(cs.flexDirection);
        };
        const r0 = rect(last);
        let anchor = last;
        while (anchor.parentElement && anchor.parentElement !== dialog) {
            const p = anchor.parentElement;
            const pr = rect(p);
            const tight = Math.abs(pr.width - r0.width) <= 32 && Math.abs(pr.height - r0.height) <= 32;
            if (tight || isRow(p)) { anchor = p; continue; }
            break;
        }
        const parent = anchor.parentElement;
        if (parent && isRow(parent)) {
            (anchor === last ? last.parentElement || anchor : anchor).appendChild(wrap);
        } else {
            anchor.insertAdjacentElement("afterend", wrap);
        }
    }

    closeModal(dialog) {
        try {
            const mod = BdApi.Webpack.getByKeys("closeAllModals");
            if (mod) { mod.closeAllModals(); return; }
        } catch (e) {}
        const close = dialog.querySelector("button[aria-label]");
        if (close) { close.click(); return; }
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", keyCode: 27, bubbles: true }));
    }

    async process(job, limitMo, choice) {
        if (!isWin()) {
            BdApi.UI.showToast("VideoFit: this version only works on Windows.", { type: "error" });
            return;
        }
        this.busy = true;
        this.cancelled = false;
        const s = this.settings;
        const tmp = s.tempDir;
        const toDelete = [];
        try {
            fs.mkdirSync(path.join(tmp, "jobs"), { recursive: true });
            this.cleanOld(tmp);
            this.bin = await this.ensureFfmpeg();
            const outputs = [];
            const passthrough = [];

            for (const file of job.files) {
                if (!this.isVideo(file) || file.size <= limitMo * MB) { passthrough.push(file); continue; }
                this.showOverlay(`Preparing ${file.name}…`, 0);
                const input = await this.fileToPath(file, tmp);
                if (input.temp) toDelete.push(input.path);
                const info = await this.probe(input.path);
                const base = file.name.replace(/\.[^.]+$/, "").replace(/[^\w\-]+/g, "_").slice(0, 60) || "video";
                const outs = choice === "split"
                    ? await this.split(input.path, base, info, limitMo, tmp)
                    : await this.compress(input.path, base, info, limitMo, tmp);
                outputs.push(...outs);
            }
            if (this.cancelled) throw new Error("cancelled");

            const items = passthrough.map((file) => ({ file })).concat(outputs.map((p) => ({ path: p })));
            this.removeOverlay();
            this.deliver(items, job.channelId);
        } catch (err) {
            if (this.cancelled) {
                BdApi.UI.showToast("VideoFit: cancelled.", { type: "info" });
            } else {
                console.error("[VideoFit]", err);
                BdApi.UI.showToast("VideoFit: " + (err && err.message ? err.message : err), { type: "error", timeout: 12000 });
            }
        } finally {
            toDelete.forEach((p) => this.rm(p));
            this.removeOverlay();
            this.busy = false;
            this.job = null;
        }
    }

    async compress(input, base, info, limitMo, tmp) {
        const targetBytes = limitMo * MB * SAFETY;
        const budgetKbps = (targetBytes * 8) / info.duration / 1000;
        const aK = info.hasAudio ? (budgetKbps < 300 ? 32 : budgetKbps < 600 ? 64 : 96) : 0;
        const vK = Math.floor(budgetKbps - aK);
        if (vK < 60) {
            throw new Error(`video is too long to fit into a single ${limitMo} MB file, even at maximum compression. Use "Split" instead.`);
        }
        if (vK < 250) BdApi.UI.showToast("VideoFit: long video, quality will be very low.", { type: "warning" });
        const out = path.join(tmp, `${base}_compressed.mp4`);
        await this.encodeChecked(input, out, { vK, aK, info, start: null, dur: null, label: "Compressing", limitMo });
        return [out];
    }

    // Stream-copy H.264 when possible; fall back to high-bitrate re-encoding for other codecs or sparse keyframes.
    async split(input, base, info, limitMo, tmp) {
        if (info.vcodec === "h264") {
            const parts = await this.splitCopy(input, base, info, limitMo, tmp);
            if (parts) return parts;
        }
        return this.splitReencode(input, base, info, limitMo, tmp);
    }

    async splitCopy(input, base, info, limitMo, tmp) {
        const limitBytes = limitMo * MB * 0.98;
        const fileSize = fs.statSync(input).size;
        // Estimate segment duration from average bitrate with margin for keyframe alignment
        let segTime = info.duration * (limitMo * MB * 0.9) / fileSize * 0.85;
        // Copy audio if MP4/Discord-compatible, otherwise transcode to AAC
        const audio = !info.hasAudio ? [] :
            ["aac", "mp3"].includes(info.acodec) ? ["-c:a", "copy"] : ["-c:a", "aac", "-b:a", "160k"];

        for (let attempt = 0; attempt < 5 && segTime >= 2; attempt++) {
            if (this.cancelled) throw new Error("cancelled");
            const dir = path.join(tmp, `${base}_parts_${Date.now().toString(36)}`);
            fs.mkdirSync(dir, { recursive: true });
            await this.exec(this.bin, ["-y", "-i", input, "-map", "0:v:0", "-map", "0:a:0?",
                "-c:v", "copy", ...audio, "-f", "segment", "-segment_time", segTime.toFixed(2),
                "-reset_timestamps", "1", "-segment_format", "mp4",
                "-segment_format_options", "movflags=+faststart",
                path.join(dir, `${base}_part%03d.mp4`)],
                { onTime: (t) => this.showOverlay(`Lossless split – ~${Math.round(segTime)} s parts`, t / info.duration) });

            const files = fs.readdirSync(dir).filter((n) => n.endsWith(".mp4")).sort().map((n) => path.join(dir, n));
            const sizes = files.map((p) => fs.statSync(p).size);
            const biggest = Math.max(...sizes);
            if (files.length && biggest <= limitBytes) {
                const n = files.length;
                const out = files.map((p, i) => {
                    const dest = path.join(tmp, `${base}_part${String(i + 1).padStart(2, "0")}of${n}.mp4`);
                    this.rm(dest);
                    fs.renameSync(p, dest);
                    return dest;
                });
                this.rmDir(dir);
                return out;
            }
            this.rmDir(dir);
            // A segment exceeded the size limit; shrink segment duration proportionally and retry
            segTime *= Math.min(0.8, (limitBytes / biggest) * 0.9);
        }
        return null; // Keyframes too sparse to fit within the limit without re-encoding
    }

    async splitReencode(input, base, info, limitMo, tmp) {
        const s = this.settings;
        const targetBytes = limitMo * MB * SAFETY;
        const partA = info.hasAudio ? 128 : 0;
        const perPartSeconds = (targetBytes * 8) / 1000 / (s.splitVideoKbps + partA);
        const n = Math.max(2, Math.ceil(info.duration / perPartSeconds));
        const segDur = info.duration / n;
        const partV = Math.floor((targetBytes * 8) / segDur / 1000 - partA);
        const outs = [];
        for (let i = 0; i < n; i++) {
            if (this.cancelled) throw new Error("cancelled");
            const out = path.join(tmp, `${base}_part${String(i + 1).padStart(2, "0")}of${n}.mp4`);
            await this.encodeChecked(input, out, {
                vK: partV, aK: partA, info, start: i * segDur, dur: segDur,
                label: `Part ${i + 1}/${n}`, limitMo
            });
            outs.push(out);
        }
        return outs;
    }

    deliver(items, channelId) {
        const batch = items.slice(0, MAX_FILES_PER_MESSAGE);
        const rest = items.slice(MAX_FILES_PER_MESSAGE);
        const files = batch.map((it) => {
            if (it.file) return it.file;
            const f = new File([fs.readFileSync(it.path, null)], path.basename(it.path), { type: "video/mp4" });
            if (!this.settings.keepFiles) this.rm(it.path);
            return f;
        });
        this.attach(files, channelId);
        this.removeQueue();
        if (!rest.length) {
            BdApi.UI.showToast(`VideoFit: ${files.length} file(s) attached, review and send.`, { type: "success" });
            return;
        }
        // Discord caps attachments at 10 per message; queue remaining parts for subsequent messages
        const box = document.createElement("div");
        box.className = "vf-overlay vf-queue";
        box.innerHTML = `<div class="vf-text"></div><div class="vf-row"><button class="vf-next"></button><button class="vf-cancel">Discard</button></div>`;
        box.querySelector(".vf-text").textContent =
            `${rest.length} part(s) remaining. Send this message, then attach the rest.`;
        const next = box.querySelector(".vf-next");
        next.textContent = `Attach next ${Math.min(rest.length, MAX_FILES_PER_MESSAGE)}`;
        next.addEventListener("click", () => {
            try { this.deliver(rest, channelId); }
            catch (e) { BdApi.UI.showToast("VideoFit: " + e.message, { type: "error" }); }
        });
        box.querySelector(".vf-cancel").addEventListener("click", () => {
            this.removeQueue();
            if (!this.settings.keepFiles) rest.forEach((it) => it.path && this.rm(it.path));
        });
        document.body.appendChild(box);
        this.queueBox = box;
    }

    removeQueue() {
        if (this.queueBox) { this.queueBox.remove(); this.queueBox = null; }
    }

    async encodeChecked(input, out, opts) {
        let vK = opts.vK;
        for (let attempt = 0; attempt < 3; attempt++) {
            await this.encode(input, out, Object.assign({}, opts, { vK }));
            if (fs.statSync(out).size <= opts.limitMo * MB * 0.98) return;
            vK = Math.floor(vK * 0.85);
        }
        throw new Error(`unable to get under ${opts.limitMo} MB for ${path.basename(out)}`);
    }

    pickHeight(vK, srcH) {
        const h = vK >= 3000 ? 1080 : vK >= 1500 ? 720 : vK >= 700 ? 480 : 360;
        const r = srcH ? Math.min(h, srcH) : h;
        return r - (r % 2);
    }

    async encode(input, out, { vK, aK, info, start, dur, label }) {
        const s = this.settings;
        const h = this.pickHeight(vK, info.height);
        const seek = start != null ? ["-ss", start.toFixed(3)] : [];
        const len = dur != null ? ["-t", dur.toFixed(3)] : [];
        // Constrain the shorter side to h so portrait videos scale properly
        const vf = ["-vf", `scale='if(gt(iw,ih),-2,${h})':'if(gt(iw,ih),${h},-2)'`, "-pix_fmt", "yuv420p"];
        const audio = aK > 0 ? ["-c:a", "aac", "-b:a", `${aK}k`, "-ac", "2"] : ["-an"];
        const total = dur != null ? dur : info.duration;
        const progress = (pass, passes) => (t) =>
            this.showOverlay(`${label} – ${h}p, ${vK} kbps${passes > 1 ? ` (pass ${pass}/${passes})` : ""}`,
                ((pass - 1) + Math.min(1, t / total)) / passes);

        if (s.encoder === "h264_nvenc") {
            await this.exec(this.bin,["-y", ...seek, "-i", input, ...len, ...vf,
                "-c:v", "h264_nvenc", "-preset", "p5", "-rc", "vbr", "-multipass", "fullres",
                "-b:v", `${vK}k`, "-maxrate", `${Math.floor(vK * 1.2)}k`, "-bufsize", `${vK * 2}k`,
                ...audio, "-movflags", "+faststart", out], { onTime: progress(1, 1) });
            return;
        }

        const passlog = path.join(s.tempDir, "vf_pass");
        const common = ["-y", ...seek, "-i", input, ...len, ...vf,
            "-c:v", "libx264", "-preset", "medium", "-b:v", `${vK}k`, "-passlogfile", passlog];
        await this.exec(this.bin,[...common, "-pass", "1", "-an", "-f", "mp4", "NUL"], { onTime: progress(1, 2) });
        await this.exec(this.bin,[...common, "-pass", "2", ...audio, "-movflags", "+faststart", out], { onTime: progress(2, 2) });
        ["-0.log", "-0.log.mbtree"].forEach((sfx) => this.rm(passlog + sfx));
    }

    // Parse stream metadata from `ffmpeg -i` stderr (exits with code 1 when no output file is given).
    async probe(file) {
        const r = await this.exec(this.bin, ["-hide_banner", "-i", file], { allowFail: true });
        return VideoFit.parseInfo(r.stderr);
    }

    static parseInfo(text) {
        const d = text.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
        const v = text.match(/Stream #[^\n]*Video:[^\n]*?,\s*(\d{2,5})x(\d{2,5})[\s,\[]/);
        if (!d || !v) throw new Error("unreadable video or unknown duration");
        const duration = +d[1] * 3600 + +d[2] * 60 + +d[3];
        if (!duration) throw new Error("unknown video duration");
        const vc = text.match(/Stream #[^\n]*Video:\s*(\w+)/);
        const ac = text.match(/Stream #[^\n]*Audio:\s*(\w+)/);
        return {
            duration,
            height: Math.min(+v[1], +v[2]), // Shorter dimension to handle portrait videos
            hasAudio: !!ac,
            vcodec: vc ? vc[1].toLowerCase() : null,
            acodec: ac ? ac[1].toLowerCase() : null
        };
    }

    async ensureFfmpeg() {
        const s = this.settings;
        if (s.ffmpegPath && s.ffmpegPath !== "auto") return s.ffmpegPath;
        const bin = path.join(s.tempDir, "bin", "ffmpeg.exe");
        try { if (fs.existsSync(bin) && fs.statSync(bin).size === FFMPEG_DL.exeSize) return bin; } catch (e) {}

        const ok = await new Promise((resolve) => {
            let done = false;
            const finish = (v) => { if (!done) { done = true; resolve(v); } };
            BdApi.UI.showConfirmationModal("VideoFit: download ffmpeg?",
                `VideoFit needs ffmpeg to encode videos. It will be downloaded once (~30 MB, 83 MB uncompressed) from GitHub, verified, and stored in ${path.dirname(bin)}.`,
                { confirmText: "Download", cancelText: "Cancel", onConfirm: () => finish(true), onCancel: () => finish(false) });
        });
        if (!ok) throw new Error("ffmpeg is required to compress videos. You can also specify your own ffmpeg.exe path in the settings.");

        fs.mkdirSync(path.dirname(bin), { recursive: true });
        this.showOverlay("Downloading ffmpeg…", 0);
        const doFetch = (BdApi.Net && BdApi.Net.fetch) ? BdApi.Net.fetch.bind(BdApi.Net) : window.fetch.bind(window);
        const res = await doFetch(FFMPEG_DL.url);
        if (!res.ok || !res.body) throw new Error(`failed to download ffmpeg (HTTP ${res.status})`);

        const reader = res.body.getReader();
        const chunks = [];
        let got = 0;
        for (;;) {
            if (this.cancelled) { try { reader.cancel(); } catch (e) {} throw new Error("cancelled"); }
            const { done, value } = await reader.read();
            if (done) break;
            chunks.push(value);
            got += value.length;
            this.showOverlay(`Downloading ffmpeg… ${(got / 1e6).toFixed(1)} / ${(FFMPEG_DL.gzSize / 1e6).toFixed(1)} MB`, got / FFMPEG_DL.gzSize);
        }
        const gz = new Uint8Array(got);
        let off = 0;
        for (const c of chunks) { gz.set(c, off); off += c.length; }

        // Verify SHA-256 checksum before writing the executable to disk
        const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", gz));
        const hex = Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
        if (hex !== FFMPEG_DL.gzSha256) throw new Error("downloaded ffmpeg file does not match expected SHA-256 checksum and was discarded");

        this.showOverlay("Installing ffmpeg…", 1);
        const part = bin + ".part";
        const stream = new Blob([gz]).stream().pipeThrough(new DecompressionStream("gzip"));
        const r2 = stream.getReader();
        let buf = [], bufLen = 0, first = true, total = 0;
        const flush = () => {
            if (!bufLen) return;
            const block = new Uint8Array(bufLen);
            let o = 0;
            for (const c of buf) { block.set(c, o); o += c.length; }
            fs.writeFileSync(part, block, { flag: first ? "w" : "a" });
            first = false; total += bufLen; buf = []; bufLen = 0;
        };
        for (;;) {
            const { done, value } = await r2.read();
            if (done) break;
            buf.push(value); bufLen += value.length;
            if (bufLen >= 8 * 1024 * 1024) flush();
        }
        flush();
        if (total !== FFMPEG_DL.exeSize) { this.rm(part); throw new Error("ffmpeg decompression incomplete"); }
        this.rm(bin);
        fs.renameSync(part, bin);
        return bin;
    }

    async exec(bin, args, { onTime = null, stdout = false, label = "ffmpeg", allowFail = false } = {}) {
        if (this.cancelled) throw new Error("cancelled");
        const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
        const dir = path.join(this.settings.tempDir, "jobs", id);
        fs.mkdirSync(dir, { recursive: true });
        const f = (n) => path.join(dir, n);

        const progressArgs = onTime ? ["-progress", f("prog.txt"), "-nostats"] : [];
        const redirect = (stdout ? ` 1> ${q(f("out.txt"))}` : "") + ` 2> ${q(f("err.txt"))}`;
        const cmd = [
            "@echo off",
            // When launched directly as a fallback (without "hidden"), re-spawn minimized
            'if not "%~1"=="hidden" (start "" /min "%~f0" hidden & exit /b)',
            // Prevent duplicate execution if the .vbs launcher succeeded right before the fallback
            `if exist ${q(f("started.txt"))} exit /b`,
            `> ${q(f("started.txt"))} echo 1`,
            "chcp 65001 >nul",
            [q(bin), ...progressArgs.map(q), ...args.map(q)].join(" ") + redirect,
            `> ${q(f("code.tmp"))} echo %ERRORLEVEL%`,
            `move /y ${q(f("code.tmp"))} ${q(f("code.txt"))} >nul`,
            ""
        ].join("\r\n");
        fs.writeFileSync(f("job.cmd"), cmd);
        fs.writeFileSync(f("job.vbs"), utf16le(`CreateObject("WScript.Shell").Run """${f("job.cmd")}"" hidden", 0, False\r\n`));

        this.job = { dir };
        try {
            await this.launch(f("job.cmd"), f("job.vbs"), f("started.txt"));
            while (!fs.existsSync(f("code.txt"))) {
                await sleep(400);
                if (onTime) {
                    try {
                        const t = fs.readFileSync(f("prog.txt"), "utf-8");
                        const all = t.match(/out_time_(?:us|ms)=(\d+)/g);
                        if (all) onTime(parseInt(all[all.length - 1].split("=")[1], 10) / 1e6);
                    } catch (e) {}
                }
            }
            await sleep(100);
            const code = parseInt(fs.readFileSync(f("code.txt"), "utf-8").trim(), 10);
            let err = "";
            try { err = fs.readFileSync(f("err.txt"), "utf-8"); } catch (e) {}
            if (this.cancelled) throw new Error("cancelled");
            if (code === 9009 || /n'est pas reconnu|is not recognized|cannot find the path/i.test(err)) {
                throw new Error(`${label} not found. Set it back to "auto" in the plugin settings to download it automatically, or provide the full path to ffmpeg.exe.`);
            }
            if (code !== 0 && !allowFail) {
                const tail = err.trim().split(/\r?\n/).slice(-3).join(" ");
                throw new Error(`${label} failed (code ${code}): ${tail}`);
            }
            let out = "";
            if (stdout) { try { out = fs.readFileSync(f("out.txt"), "utf-8"); } catch (e) {} }
            return { stdout: out, stderr: err };
        } finally {
            this.job = null;
            this.rmDir(dir);
        }
    }

    async launch(cmdPath, vbsPath, startedPath) {
        const { shell } = require("electron");
        if (!shell || !shell.openPath) throw new Error("electron.shell is not available in this version of BetterDiscord");
        const waitStarted = async (ms) => {
            const end = Date.now() + ms;
            while (Date.now() < end) {
                if (fs.existsSync(startedPath)) return true;
                await sleep(150);
            }
            return false;
        };
        if (this.launcher !== "cmd") {
            const err = await shell.openPath(vbsPath);
            if (!err && await waitStarted(5000)) { this.launcher = "vbs"; return; }
        }
        // Fallback: open the .cmd directly (runs minimized in the taskbar)
        const err2 = await shell.openPath(cmdPath);
        if (!err2 && await waitStarted(8000)) { this.launcher = "cmd"; return; }
        throw new Error(`unable to launch ffmpeg (${err2 || "script did not start"}). An antivirus might be blocking scripts in ${this.settings.tempDir}.`);
    }

    cancel() {
        this.cancelled = true;
        if (!this.job || !isWin()) return;
        // Kill any ffmpeg/ffprobe processes whose command line references the active job directory
        try {
            const dir = this.job.dir;
            const kdir = path.join(this.settings.tempDir, "jobs", "kill_" + Date.now().toString(36));
            fs.mkdirSync(kdir, { recursive: true });
            const ps1 = path.join(kdir, "kill.ps1");
            const kcmd = path.join(kdir, "kill.cmd");
            const kvbs = path.join(kdir, "kill.vbs");
            fs.writeFileSync(ps1, "\uFEFF" + [
                `$d = '${dir.replace(/'/g, "''")}'`,
                "Get-CimInstance Win32_Process -Filter \"Name='ffmpeg.exe' OR Name='ffprobe.exe'\" |",
                "  Where-Object { $_.CommandLine -and $_.CommandLine.Contains($d) } |",
                "  ForEach-Object { Stop-Process -Id $_.ProcessId -Force }",
                ""
            ].join("\r\n"));
            fs.writeFileSync(kcmd, `@echo off\r\npowershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File ${q(ps1)}\r\n`);
            fs.writeFileSync(kvbs, utf16le(`CreateObject("WScript.Shell").Run """${kcmd}""", 0, False\r\n`));
            const { shell } = require("electron");
            shell.openPath(this.launcher === "cmd" ? kcmd : kvbs);
            setTimeout(() => this.rmDir(kdir), 15000);
        } catch (e) {
            console.error("[VideoFit] cancel", e);
        }
    }

    async fileToPath(file, dir) {
        let p = file.path;
        if (!p) {
            try {
                const { webUtils } = require("electron");
                if (webUtils) p = webUtils.getPathForFile(file);
            } catch (e) {}
        }
        if (p && fs.existsSync(p)) return { path: p, temp: false };
        // In-memory File (e.g. clipboard paste): stream to a temporary file in chunks
        const out = path.join(dir, `in_${Date.now()}_${file.name.replace(/[^\w.\-]+/g, "_")}`);
        const CHUNK = 32 * 1024 * 1024;
        for (let off = 0; off < file.size; off += CHUNK) {
            if (this.cancelled) throw new Error("cancelled");
            const buf = new Uint8Array(await file.slice(off, off + CHUNK).arrayBuffer());
            fs.writeFileSync(out, buf, { flag: off === 0 ? "w" : "a" });
            this.showOverlay(`Copying ${file.name}…`, off / file.size);
        }
        return { path: out, temp: true };
    }

    attach(files, channelId) {
        const ChannelStore = BdApi.Webpack.getStore("ChannelStore");
        const channel = ChannelStore && channelId ? ChannelStore.getChannel(channelId) : null;
        let promptToUpload = null;
        try {
            const mod = BdApi.Webpack.getByKeys("promptToUpload");
            if (mod) promptToUpload = mod.promptToUpload.bind(mod);
        } catch (e) {}
        if (!promptToUpload) {
            try {
                promptToUpload = BdApi.Webpack.getModule(
                    (m) => typeof m === "function" && String(m).includes("UPLOAD_FILE_LIMIT_ERROR"),
                    { searchExports: true });
            } catch (e) {}
        }
        if (promptToUpload && channel) {
            promptToUpload(files, channel, 0);
            return;
        }
        // Fallback: dispatch a synthetic paste event on the chat input
        const dt = new DataTransfer();
        files.forEach((file) => dt.items.add(file));
        const box = document.querySelector('[class*="channelTextArea"] [role="textbox"]') || document.querySelector('[role="textbox"]');
        if (!box) throw new Error("chat input not found to attach files");
        this.ignoreSynthetic = true;
        try {
            box.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
        } finally {
            this.ignoreSynthetic = false;
        }
    }

    rm(p) { try { fs.unlinkSync(p); } catch (e) {} }
    rmDir(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch (e) {} }

    cleanOld(dir) {
        const dayAgo = Date.now() - 24 * 3600 * 1000;
        try {
            const jobs = path.join(dir, "jobs");
            for (const name of fs.readdirSync(jobs)) {
                const p = path.join(jobs, name);
                if (fs.statSync(p).mtimeMs < dayAgo) this.rmDir(p);
            }
        } catch (e) {}
        if (this.settings.keepFiles) return;
        try {
            for (const name of fs.readdirSync(dir)) {
                const p = path.join(dir, name);
                const st = fs.statSync(p);
                if (st.isFile() && st.mtimeMs < dayAgo) this.rm(p);
            }
        } catch (e) {}
    }

    showOverlay(text, ratio) {
        if (!this.overlay) {
            this.overlay = document.createElement("div");
            this.overlay.className = "vf-overlay";
            this.overlay.innerHTML = `<div class="vf-text"></div><div class="vf-bar"><div></div></div><button class="vf-cancel">Cancel</button>`;
            this.overlay.querySelector(".vf-cancel").addEventListener("click", () => this.cancel());
            document.body.appendChild(this.overlay);
        }
        this.overlay.querySelector(".vf-text").textContent = text;
        this.overlay.querySelector(".vf-bar > div").style.width = `${Math.round(Math.max(0, Math.min(1, ratio)) * 100)}%`;
    }

    removeOverlay() {
        if (this.overlay) { this.overlay.remove(); this.overlay = null; }
    }

    save() { BdApi.Data.save("VideoFit", "settings", this.settings); }

    getSettingsPanel() {
        const s = this.settings || Object.assign({}, DEFAULTS, BdApi.Data.load("VideoFit", "settings") || {});
        this.settings = s;
        const panel = document.createElement("div");
        panel.className = "vf-panel";
        const field = (label, key, type = "text", help = "", options = null) => {
            const l = document.createElement("label");
            l.textContent = label;
            panel.appendChild(l);
            let input;
            if (options) {
                input = document.createElement("select");
                for (const [value, text] of options) {
                    const o = document.createElement("option");
                    o.value = value; o.textContent = text;
                    if (s[key] === value) o.selected = true;
                    input.appendChild(o);
                }
            } else {
                input = document.createElement("input");
                input.type = type;
                if (type === "checkbox") { input.checked = !!s[key]; input.style.width = "auto"; }
                else input.value = s[key];
            }
            input.addEventListener("change", () => {
                s[key] = type === "checkbox" ? input.checked : type === "number" ? Number(input.value) : input.value;
                this.save();
            });
            panel.appendChild(input);
            if (help) { const h = document.createElement("small"); h.textContent = help; panel.appendChild(h); }
        };
        field("ffmpeg", "ffmpegPath", "text", "\"auto\": downloaded automatically on first use. Otherwise \"ffmpeg\" if in PATH, or full path to ffmpeg.exe");
        field("Temporary folder", "tempDir", "text", "Intermediate files can be large");
        field("Encoder", "encoder", "text", "NVENC is much faster on an NVIDIA GPU, x264 gives a more accurate file size", [["libx264", "x264 (CPU, 2-pass)"], ["h264_nvenc", "NVENC (NVIDIA GPU)"]]);
        field("Split with re-encoding: target video bitrate (kbps)", "splitVideoKbps", "number", "Only used when the video is not H.264 (HEVC, AV1…) and cannot be split losslessly. 5000 ≈ good quality 1080p");
        field("Keep generated files", "keepFiles", "checkbox");
        return panel;
    }
};
