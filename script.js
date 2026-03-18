import { FFmpeg } from './ffmpeg-local/ffmpeg/index.js';
import { fetchFile } from './ffmpeg-local/util/index.js';

if (!window.crossOriginIsolated) {
    alert("⚠️ 系統警告：環境未正確配置，FFmpeg 無法執行。");
}

const dropZone = document.getElementById('drop-zone');
const fileInput = document.getElementById('file-input');
const editor = document.getElementById('editor');
const video = document.getElementById('main-video');
const audio = document.getElementById('main-audio');
const playPauseBtn = document.getElementById('play-pause-btn');
const playhead = document.getElementById('playhead');
const sliderStart = document.getElementById('slider-start');
const sliderEnd = document.getElementById('slider-end');
const exportBtn = document.getElementById('export-btn');

let currentFile = null;
let ffmpeg = null;
let activeMedia = null; // 儲存目前正在播放的對象 (video 或 audio)
const GAS_URL = 'https://script.google.com/macros/s/AKfycbzUbRtaQYOr-cIDDnGPj8xcE5Ur_YkAN5iUwPPDmDSA2GQyyIesfQLaQlE9vtUyIVtG/exec';

// --- 1. 時間格式化 ---
function formatTime(seconds) {
    const s = parseFloat(seconds);
    const mins = Math.floor(s / 60);
    const secs = (s % 60).toFixed(1);
    return `${mins < 10 ? "0" + mins : mins}:${parseFloat(secs) < 10 ? "0" + secs : secs}`;
}

// --- 修正 1: 修復拖放檔案 Bug ---
['dragover', 'dragenter'].forEach(eventName => {
    dropZone.addEventListener(eventName, (e) => {
        e.preventDefault();
        dropZone.classList.add('dragover');
    });
});

['dragleave', 'drop'].forEach(eventName => {
    dropZone.addEventListener(eventName, (e) => {
        e.preventDefault();
        dropZone.classList.remove('dragover');
    });
});

dropZone.addEventListener('drop', (e) => {
    const files = e.dataTransfer.files;
    if (files.length > 0) handleFile(files[0]);
});

dropZone.onclick = () => fileInput.click();
fileInput.onchange = (e) => handleFile(e.target.files[0]);

function handleFile(file) {
    if (!file) return;
    currentFile = file;
    const url = URL.createObjectURL(file);
    
    dropZone.classList.add('hidden');
    editor.classList.remove('hidden');

    if (file.type.startsWith('video')) {
        activeMedia = video;
        video.src = url;
        video.classList.remove('hidden');
        audio.classList.add('hidden');
    } else {
        activeMedia = audio;
        audio.src = url;
        audio.classList.remove('hidden');
        video.classList.add('hidden');
    }

    activeMedia.onloadedmetadata = () => {
        setupSlider(activeMedia.duration);
        if (file.type.startsWith('video')) generateFilmstrip(video);
    };

    // 修正 3: 播放時更新進度線 (Playhead)
    activeMedia.ontimeupdate = () => {
        const progress = (activeMedia.currentTime / activeMedia.duration) * 100;
        playhead.style.left = `${progress}%`;
        
        // 如果播到 End 滑桿位置，自動暫停或循環
        if (activeMedia.currentTime >= parseFloat(sliderEnd.value)) {
            activeMedia.pause();
            activeMedia.currentTime = parseFloat(sliderStart.value);
        }
    };
}

// --- 修正 2: 播放按鈕邏輯 ---
function togglePlay() {
    if (!activeMedia) return;
    if (activeMedia.paused) {
        activeMedia.play();
        playPauseBtn.innerText = "Pause";
    } else {
        activeMedia.pause();
        playPauseBtn.innerText = "Play";
    }
}
playPauseBtn.onclick = togglePlay;

// 鍵盤空白鍵控制
window.addEventListener('keydown', (e) => {
    if (e.code === 'Space' && !editor.classList.contains('hidden')) {
        e.preventDefault();
        togglePlay();
    }
});

// --- 3. 滑桿與時間連動 ---
function setupSlider(duration) {
    sliderStart.max = duration;
    sliderEnd.max = duration;
    sliderStart.value = 0;
    sliderEnd.value = duration;
    updateTimeText();

    sliderStart.oninput = () => {
        if (parseFloat(sliderStart.value) >= parseFloat(sliderEnd.value)) {
            sliderStart.value = parseFloat(sliderEnd.value) - 0.1;
        }
        activeMedia.currentTime = sliderStart.value; // 跳轉預覽
        updateTimeText();
    };

    sliderEnd.oninput = () => {
        if (parseFloat(sliderEnd.value) <= parseFloat(sliderStart.value)) {
            sliderEnd.value = parseFloat(sliderStart.value) + 0.1;
        }
        activeMedia.currentTime = sliderEnd.value; // 跳轉預覽
        updateTimeText();
    };
}

function updateTimeText() {
    document.getElementById('start-time').innerText = `Start: ${formatTime(sliderStart.value)}`;
    document.getElementById('end-time').innerText = `End: ${formatTime(sliderEnd.value)}`;
}

// --- 4. 膠捲生成 ---
async function generateFilmstrip(videoElement) {
    const canvas = document.getElementById('filmstrip-canvas');
    const ctx = canvas.getContext('2d');
    const duration = videoElement.duration;
    canvas.width = 1000; canvas.height = 80;
    const frameCount = 10; 
    const frameWidth = canvas.width / frameCount;

    const tempVideo = document.createElement('video');
    tempVideo.src = videoElement.src;
    tempVideo.muted = true;
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

// --- 5. FFmpeg 初始化 ---
async function initFFmpeg() {
    if (ffmpeg) return ffmpeg; 
    ffmpeg = new FFmpeg();
    ffmpeg.on('progress', ({ progress }) => {
        exportBtn.innerText = `Processing... ${Math.round(progress * 100)}%`;
    });
    const baseURL = '/ffmpeg-local/core'; 
    await ffmpeg.load({
        coreURL: `${baseURL}/ffmpeg-core.js`,
        wasmURL: `${baseURL}/ffmpeg-core.wasm`
    });
    return ffmpeg;
}

// --- 6. 輸出行為 (修正 4 & 5) ---
exportBtn.onclick = async () => {
    if (!currentFile) return;

    const start = sliderStart.value;
    const end = sliderEnd.value;
    const duration = (parseFloat(end) - parseFloat(start)).toFixed(2);
    
    // 修正 4: 獲取原始副檔名
    const originalExt = currentFile.name.split('.').pop(); 
    const inputName = `input.${originalExt}`;
    const outputName = `output.${originalExt}`;
    const mimeType = currentFile.type;

    const logData = {
        fileName: currentFile.name,
        startTime: formatTime(start),
        endTime: formatTime(end),
        duration: duration,
        timestamp: new Date().toLocaleString()
    };

    try {
        exportBtn.disabled = true;
        exportBtn.innerText = "Logging...";
        await sendToGAS(logData);

        const ffmpegInstance = await initFFmpeg();
        await ffmpegInstance.writeFile(inputName, await fetchFile(currentFile));

        // 修正 5: 秒切模式 (不重新編碼)
        exportBtn.innerText = "Cutting (Fast)...";
        await ffmpegInstance.exec([
            '-ss', `${start}`,        // 快尋起點
            '-to', `${end}`,          // 終點
            '-i', inputName,          // 輸入放在 -ss 後面有時更精確，但 -c copy 模式下通常 OK
            '-c', 'copy',             // 核心修改：直接流拷貝，不重新計算編碼
            outputName
        ]);

        const data = await ffmpegInstance.readFile(outputName);
        const downloadUrl = URL.createObjectURL(new Blob([data.buffer], { type: mimeType }));
        const a = document.createElement('a');
        a.href = downloadUrl;
        a.download = `axon_cut_${currentFile.name}`;
        a.click();

        alert(`成功！\n檔案已利用秒切技術完成處理。`);
        await ffmpegInstance.deleteFile(inputName);
        await ffmpegInstance.deleteFile(outputName);

    } catch (e) {
        console.error(e);
        alert("失敗: " + e.message);
    } finally {
        exportBtn.disabled = false;
        exportBtn.innerText = "Export & Log";
    }
};

async function sendToGAS(data) {
    try {
        await fetch(GAS_URL, { method: 'POST', mode: 'no-cors', body: JSON.stringify(data) });
    } catch (e) { console.error("GAS failed", e); }
}