// 1. 指向我們剛剛抽出來的本地檔案
import { FFmpeg } from './ffmpeg-local/ffmpeg/index.js';
import { fetchFile } from './ffmpeg-local/util/index.js';

// --- 0. 環境初始化檢查 (Critical) ---
if (!window.crossOriginIsolated) {
    alert("⚠️ 系統警告：環境未正確配置 (crossOriginIsolated 為 false)！\nFFmpeg 需要 SharedArrayBuffer。\n請確保伺服器有設定 COOP/COEP 標頭，否則轉檔將無法執行。");
}

const dropZone = document.getElementById('drop-zone');
const fileInput = document.getElementById('file-input');
const editor = document.getElementById('editor');
const video = document.getElementById('main-video');
const audio = document.getElementById('main-audio');
const sliderStart = document.getElementById('slider-start');
const sliderEnd = document.getElementById('slider-end');
const exportBtn = document.getElementById('export-btn');

let currentFile = null;
let ffmpeg = null; // 預留 ffmpeg 實例
const GAS_URL = 'https://script.google.com/macros/s/AKfycbzUbRtaQYOr-cIDDnGPj8xcE5Ur_YkAN5iUwPPDmDSA2GQyyIesfQLaQlE9vtUyIVtG/exec';

// --- 1. 時間格式化函式 ---
function formatTime(seconds) {
    const s = parseFloat(seconds);
    const hrs = Math.floor(s / 3600);
    const mins = Math.floor((s % 3600) / 60);
    const secs = (s % 60).toFixed(1);

    const hDisplay = hrs > 0 ? (hrs < 10 ? "0" + hrs : hrs) + ":" : "";
    const mDisplay = (mins < 10 ? "0" + mins : mins) + ":";
    const sDisplay = parseFloat(secs) < 10 ? "0" + secs : secs;
    
    return hDisplay + mDisplay + sDisplay;
}

// --- 2. 檔案處理邏輯 ---
dropZone.onclick = () => fileInput.click();
fileInput.onchange = (e) => handleFile(e.target.files[0]);

function handleFile(file) {
    if (!file) return;
    currentFile = file;
    const url = URL.createObjectURL(file);
    
    dropZone.classList.add('hidden');
    editor.classList.remove('hidden');

    if (file.type.startsWith('video')) {
        video.src = url;
        video.classList.remove('hidden');
        video.onloadedmetadata = () => setupSlider(video.duration);
        video.onclick = () => video.paused ? video.play() : video.pause();
    } else {
        audio.src = url;
        audio.classList.remove('hidden');
        audio.onloadedmetadata = () => setupSlider(audio.duration);
    }
}

// --- 3. 滑桿與膠捲初始化 ---
function setupSlider(duration) {
    sliderStart.max = duration;
    sliderEnd.max = duration;
    sliderStart.value = 0;
    sliderEnd.value = duration;
    updateTimeText();

    if (currentFile.type.startsWith('video')) generateFilmstrip(video);

    sliderStart.oninput = () => {
        if (parseFloat(sliderStart.value) >= parseFloat(sliderEnd.value)) {
            sliderStart.value = parseFloat(sliderEnd.value) - 0.1;
        }
        video.currentTime = sliderStart.value;
        updateTimeText();
    };

    sliderEnd.oninput = () => {
        if (parseFloat(sliderEnd.value) <= parseFloat(sliderStart.value)) {
            sliderEnd.value = parseFloat(sliderStart.value) + 0.1;
        }
        video.currentTime = sliderEnd.value;
        updateTimeText();
    };
}

function updateTimeText() {
    document.getElementById('start-time').innerText = `Start: ${formatTime(sliderStart.value)}`;
    document.getElementById('end-time').innerText = `End: ${formatTime(sliderEnd.value)}`;
}

// --- 4. 膠捲縮圖生成 (Canvas) ---
async function generateFilmstrip(videoElement) {
    const canvas = document.getElementById('filmstrip-canvas');
    const ctx = canvas.getContext('2d');
    const duration = videoElement.duration;
    canvas.width = 1000; canvas.height = 100;
    const frameCount = 10; 
    const frameWidth = canvas.width / frameCount;

    const tempVideo = document.createElement('video');
    tempVideo.src = videoElement.src;
    tempVideo.muted = true;
    tempVideo.load();
    await new Promise(r => tempVideo.onloadeddata = r);

    for (let i = 0; i < frameCount; i++) {
        tempVideo.currentTime = (duration / frameCount) * i;
        await new Promise(resolve => {
            tempVideo.onseeked = () => {
                ctx.drawImage(tempVideo, i * frameWidth, 0, frameWidth, canvas.height);
                resolve();
            };
        });
    }
}

// --- 5. FFmpeg 初始化 (v0.12+ 語法) ---
async function initFFmpeg() {
    if (ffmpeg) return ffmpeg; 

    ffmpeg = new FFmpeg();
    
    // 監聽轉檔進度，即時更新按鈕文字，避免 UI 凍結的錯覺
    ffmpeg.on('progress', ({ progress, time }) => {
        exportBtn.innerText = `Processing... ${Math.round(progress * 100)}%`;
    });

    // 載入本地核心 (這裡的路徑已經幫你修正為剛剛提取出來的 ffmpeg-local 資料夾)
    const baseURL = '/ffmpeg-local/core'; 
    await ffmpeg.load({
        coreURL: `${baseURL}/ffmpeg-core.js`,
        wasmURL: `${baseURL}/ffmpeg-core.wasm`
    });

    return ffmpeg;
}

// --- 6. 輸出按鈕行為 (GAS 紀錄 + FFmpeg 剪輯) ---
exportBtn.onclick = async () => {
    if (!currentFile) return;
    if (!window.crossOriginIsolated) {
        alert("無法轉檔：瀏覽器環境缺乏 COOP/COEP 標頭配置。請使用 Node.js Server 啟動。");
        return;
    }

    const start = sliderStart.value;
    const end = sliderEnd.value;
    const duration = (parseFloat(end) - parseFloat(start)).toFixed(2);
    const inputName = 'input_video' + currentFile.name.substring(currentFile.name.lastIndexOf('.'));
    const outputName = 'output.mp4';

    const logData = {
        fileName: currentFile.name,
        startTime: formatTime(start),
        endTime: formatTime(end),
        duration: duration,
        timestamp: new Date().toLocaleString()
    };

    try {
        exportBtn.disabled = true;
        
        // A. 先傳送資料到 GAS
        exportBtn.innerText = "Logging...";
        await sendToGAS(logData);

        // B. 執行影片剪輯
        exportBtn.innerText = "Loading Engine...";
        const ffmpegInstance = await initFFmpeg();

        // 寫入檔案系統 (v0.12 API)
        exportBtn.innerText = "Reading File...";
        await ffmpegInstance.writeFile(inputName, await fetchFile(currentFile));

        // 執行指令 (需求書要求：-ss [start] -to [end] -c:v libx264 -c:a copy)
        exportBtn.innerText = "Processing Video...";
        await ffmpegInstance.exec([
            '-ss', `${start}`,
            '-to', `${end}`,
            '-i', inputName,
            '-c:v', 'libx264',
            '-c:a', 'copy',
            outputName
        ]);

        // 讀取產出檔案 (v0.12 API)
        exportBtn.innerText = "Exporting...";
        const data = await ffmpegInstance.readFile(outputName);

        // 觸發下載
        const downloadUrl = URL.createObjectURL(new Blob([data.buffer], { type: 'video/mp4' }));
        const a = document.createElement('a');
        a.href = downloadUrl;
        a.download = `axon_cut_${currentFile.name}`;
        a.click();

        alert(`成功！\n資料已紀錄至試算表，剪裁影片已開始下載。`);

        // 清理記憶體 (非常重要，避免多次剪輯後瀏覽器崩潰)
        await ffmpegInstance.deleteFile(inputName);
        await ffmpegInstance.deleteFile(outputName);

    } catch (e) {
        console.error("發生錯誤:", e);
        alert("操作失敗: " + e.message);
    } finally {
        exportBtn.disabled = false;
        exportBtn.innerText = "Export & Log";
    }
};

// 封裝 GAS 傳送
async function sendToGAS(data) {
    try {
        await fetch(GAS_URL, {
            method: 'POST',
            mode: 'no-cors',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data)
        });
    } catch (e) {
        console.error("GAS Log failed", e);
    }
}