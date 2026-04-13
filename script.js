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
const speedBtn = document.getElementById('speed-btn');
const playhead = document.getElementById('playhead');
const sliderStart = document.getElementById('slider-start');
const sliderEnd = document.getElementById('slider-end');
const timelineContainer = document.querySelector('.timeline-container');
const exportBtn = document.getElementById('export-btn');
const backButton = document.getElementById('back-button'); // 取得退回鍵
const appFooter = document.getElementById('app-footer'); // 👈 新增這行：取得你的版權 Footer

let currentPlaybackRate = 1;
let currentFile = null;
let ffmpeg = null;
let activeMedia = null;
let isScrubbing = false;
let isDragging = false;
let scrubWasPlaying = false;
let scrubPendingX = null;
let scrubRAF = null;
let sliderSeekPendingTime = null;
let sliderSeekRAF = null;
let isDraggingPlayhead = false;
let lastScrubX = null;
let lastScrubTime = null;
let currentSeekDelay = 50;

const GAS_URL = 'https://script.google.com/macros/s/AKfycbzUbRtaQYOr-cIDDnGPj8xcE5Ur_YkAN5iUwPPDmDSA2GQyyIesfQLaQlE9vtUyIVtG/exec';

// --- 1. 時間格式化 ---
function formatTime(seconds) {
    const s = parseFloat(seconds);
    const mins = Math.floor(s / 60);
    const secs = (s % 60).toFixed(1);
    return `${mins < 10 ? "0" + mins : mins}:${parseFloat(secs) < 10 ? "0" + secs : secs}`;
}

// --- 2. 拖放處理 ---
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

// --- 3. 退回鍵邏輯 ---
if (backButton) {
    backButton.onclick = () => {
        // 仿 Cobalt 風格：退回即重置專案
        location.reload(); 
    };
}

function handleFile(file) {
    if (!file) return;
    
    currentFile = file;
    const url = URL.createObjectURL(file);
    
    // UI 切換：隱藏上傳，顯示編輯器與退回鍵
    dropZone.classList.add('hidden');
    editor.classList.remove('hidden');
    if (backButton) backButton.classList.remove('hidden'); 
    if (appFooter) appFooter.style.display = 'none'; // 👈 新增這行：進入剪輯模式時，隱藏版權宣告
    
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

    if (activeMedia) activeMedia.playbackRate = currentPlaybackRate;

    activeMedia.onloadedmetadata = () => {
        setupSlider(activeMedia.duration);
        if (file.type.startsWith('video')) {
            generateFilmstrip(video);
        } else if (file.type.startsWith('audio')) {
            generateAudioCover(audio, file);
        }
    };

    activeMedia.ontimeupdate = () => {
        if (isDraggingPlayhead) return; // 避免拖動時 ontimeupdate 干擾
        const progress = (activeMedia.currentTime / activeMedia.duration) * 100;
        playhead.style.left = `${progress}%`;
        
        if (!isDragging && activeMedia.currentTime >= parseFloat(sliderEnd.value)) {
            activeMedia.pause();
            activeMedia.currentTime = parseFloat(sliderEnd.value);
            playPauseBtn.innerText = "▶";
        }
    };
} // 修正：原程式碼此處大括號未閉合

// --- 4. 播放控制 (含消除外框 blur) ---
function togglePlay() {
    if (!activeMedia) return;
    if (activeMedia.paused) {
        if (activeMedia.currentTime >= parseFloat(sliderEnd.value)) {
            activeMedia.currentTime = parseFloat(sliderStart.value);
        }
        activeMedia.play();
        playPauseBtn.innerText = "⏸";
    } else {
        activeMedia.pause();
        playPauseBtn.innerText = "▶";
    }
    playPauseBtn.blur(); // 關鍵：移除焦點外框
}
playPauseBtn.onclick = togglePlay;

// --- 5. 快進與速率 (含 A/D 鍵) ---
const SKIP_SECONDS = 2;
let holdTimer = null;
let isLongHold = false;
let holdPreviousRate = 1;

function setPlaybackRate(rate) {
    currentPlaybackRate = rate;
    if (activeMedia) activeMedia.playbackRate = rate;
    if (speedBtn) speedBtn.innerText = `${rate}x`;
}

window.addEventListener('keydown', (e) => {
    if (editor.classList.contains('hidden')) return;

    if (e.code === 'Space') {
        e.preventDefault();
        togglePlay();
        return;
    }

    if (e.key.toUpperCase() === 'S') {
        e.preventDefault();
        setPlaybackRate(currentPlaybackRate === 1 ? 2 : 1);
        speedBtn.blur();
        return;
    }

    const isBackKey = e.key.toUpperCase() === 'A' || e.key === 'ArrowLeft';
    const isForwardKey = e.key.toUpperCase() === 'D' || e.key === 'ArrowRight';
    if (!isBackKey && !isForwardKey) return;

    if (e.repeat) return;
    e.preventDefault();
    holdPreviousRate = currentPlaybackRate;
    isLongHold = false;

    holdTimer = setTimeout(() => {
        if (!activeMedia) return;
        isLongHold = true;
        setPlaybackRate(4);
        if (activeMedia.paused) activeMedia.play();
    }, 1500);
});

window.addEventListener('keyup', (e) => {
    const isBackKey = e.key.toUpperCase() === 'A' || e.key === 'ArrowLeft';
    const isForwardKey = e.key.toUpperCase() === 'D' || e.key === 'ArrowRight';
    if (!isBackKey && !isForwardKey) return;

    if (holdTimer) {
        clearTimeout(holdTimer);
        holdTimer = null;
    }

    if (isLongHold) {
        setPlaybackRate(holdPreviousRate);
        isLongHold = false;
        return;
    }

    if (!activeMedia) return;

    if (isBackKey) {
        activeMedia.currentTime = Math.max(parseFloat(sliderStart.value), activeMedia.currentTime - SKIP_SECONDS);
    } else if (isForwardKey) {
        activeMedia.currentTime = Math.min(parseFloat(sliderEnd.value), activeMedia.currentTime + SKIP_SECONDS);
    }
});

if (speedBtn) {
    speedBtn.onclick = () => {
        setPlaybackRate(currentPlaybackRate === 1 ? 2 : 1);
        speedBtn.blur(); // 移除焦點
    };
}

// --- 6. 點擊進度條 (Scrubbing) ---
if (timelineContainer) {
    timelineContainer.addEventListener('pointerdown', (e) => {
        if (!activeMedia || activeMedia.duration <= 0) return;
        if (e.target.closest('.range-slider')) return; // 避免點擊滑桿時設置 isDraggingPlayhead
        isDraggingPlayhead = true;
        scrubWasPlaying = !activeMedia.paused;
        activeMedia.pause();
        lastScrubX = null;
        lastScrubTime = null;
        currentSeekDelay = 50;
        scheduleScrub(e.clientX);
    });

    window.addEventListener('pointermove', (e) => {
        if (isScrubbing) scheduleScrub(e.clientX);
        else if (isDraggingPlayhead) scheduleScrub(e.clientX);
    });

    window.addEventListener('pointerup', () => {
        if (isScrubbing) {
            isScrubbing = false;
            if (scrubRAF) {
                clearTimeout(scrubRAF);
                scrubRAF = null;
            }
            if (scrubWasPlaying && activeMedia) {
                activeMedia.play();
            }
        }
        if (isDraggingPlayhead) {
            isDraggingPlayhead = false;
            lastScrubX = null;
            lastScrubTime = null;
            currentSeekDelay = 50;
            if (scrubRAF) {
                clearTimeout(scrubRAF);
                scrubRAF = null;
            }
            if (scrubWasPlaying && activeMedia) {
                activeMedia.play();
            }
        }
    });
}

if (playhead) {
    // 移除單獨的 pointerdown 監聽器，由 timelineContainer 處理
}

function scheduleScrub(clientX) {
    scrubPendingX = clientX;
    if (scrubRAF) return;
    scrubRAF = requestAnimationFrame(() => {
        if (scrubPendingX !== null) {
            updateTimeByClick(scrubPendingX);
            scrubPendingX = null;
        }
        scrubRAF = null;
    });
}

function updateTimeByClick(clientX) {
    if (!activeMedia || !timelineContainer) return;
    const rect = timelineContainer.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    const targetTime = ratio * activeMedia.duration;
    // 限制在 start end 區間內
    const finalTime = Math.min(parseFloat(sliderEnd.value), Math.max(parseFloat(sliderStart.value), targetTime));
    
    // 計算滑動速度
    const currentTime = Date.now();
    if (lastScrubX !== null && lastScrubTime !== null) {
        const distanceMoved = Math.abs(clientX - lastScrubX);
        const timePassed = currentTime - lastScrubTime;
        const speed = distanceMoved / Math.max(timePassed, 1); // pixels per ms
        
        // 根據速度調整刷新延遲：快速 16ms，中等 50ms，緩慢 100ms
        if (speed > 2) {
            currentSeekDelay = 16; // 快速滑動
        } else if (speed > 0.5) {
            currentSeekDelay = 35; // 中等速度
        } else {
            currentSeekDelay = 100; // 慢速滑動
        }
    }
    lastScrubX = clientX;
    lastScrubTime = currentTime;
    
    // 立即更新進度條位置（視覺效果）
    if (playhead) {
        playhead.style.left = `${(finalTime / activeMedia.duration) * 100}%`;
    }
    updateTimeText();
    
    // 延迟更新影片時間（根據速度動態調整）
    scheduleSliderSeek(finalTime);
}

function scheduleSliderSeek(time) {
    sliderSeekPendingTime = time;
    if (sliderSeekRAF) return;
    sliderSeekRAF = setTimeout(() => {
        if (sliderSeekPendingTime !== null && activeMedia) {
            activeMedia.currentTime = sliderSeekPendingTime;
            sliderSeekPendingTime = null;
        }
        sliderSeekRAF = null;
    }, currentSeekDelay);
}

function updateSliderPreview(time) {
    if (!activeMedia) return;
    if (playhead) {
        playhead.style.left = `${(time / activeMedia.duration) * 100}%`;
    }
    updateTimeText();
}

// --- 7. 滑桿初始化 ---
function setupSlider(duration) {
    sliderStart.max = duration; sliderEnd.max = duration;
    sliderStart.value = 0; sliderEnd.value = duration;
    updateTimeText();

    sliderStart.oninput = () => {
        if (isDraggingPlayhead) return;
        isDragging = true;
        let value = parseFloat(sliderStart.value);
        if (value >= parseFloat(sliderEnd.value)) {
            value = parseFloat(sliderEnd.value) - 0.1;
            sliderStart.value = value;
        }
        updateSliderPreview(value);
        scheduleSliderSeek(value);
    };
    sliderStart.onchange = () => {
        isDragging = false;
        sliderStart.blur();
        scheduleSliderSeek(parseFloat(sliderStart.value));
    };

    sliderEnd.oninput = () => {
        if (isDraggingPlayhead) return;
        isDragging = true;
        let value = parseFloat(sliderEnd.value);
        if (value <= parseFloat(sliderStart.value)) {
            value = parseFloat(sliderStart.value) + 0.1;
            sliderEnd.value = value;
        }
        updateSliderPreview(value);
        scheduleSliderSeek(value);
    };
    sliderEnd.onchange = () => {
        isDragging = false;
        sliderEnd.blur();
        scheduleSliderSeek(parseFloat(sliderEnd.value));
    };
}

function updateTimeText() {
    document.getElementById('start-time').innerText = `Start: ${formatTime(sliderStart.value)}`;
    document.getElementById('end-time').innerText = `End: ${formatTime(sliderEnd.value)}`;
}

// --- 8. 膠捲與 FFmpeg (保持原樣，確保 copy 模式) ---
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
        await new Promise(r => { tempVideo.onseeked = () => { ctx.drawImage(tempVideo, i * frameWidth, 0, frameWidth, canvas.height); r(); }; });
    }
}

async function initFFmpeg() {
    if (ffmpeg) return ffmpeg; 
    ffmpeg = new FFmpeg();
    ffmpeg.on('progress', ({ progress }) => { exportBtn.innerText = `Processing... ${Math.round(progress * 100)}%`; });
    await ffmpeg.load({ coreURL: '/ffmpeg-local/core/ffmpeg-core.js', wasmURL: '/ffmpeg-local/core/ffmpeg-core.wasm' });
    return ffmpeg;
}

exportBtn.onclick = async () => {
    if (!currentFile) return;
    const start = sliderStart.value;
    const end = sliderEnd.value;
    const originalExt = currentFile.name.split('.').pop(); 
    const inputName = `input.${originalExt}`;
    const outputName = `output.${originalExt}`;
    
    try {
        exportBtn.disabled = true;
        exportBtn.innerText = "Logging...";
        await sendToGAS({ fileName: currentFile.name, duration: (end-start).toFixed(2) });

        const ff = await initFFmpeg();
        await ff.writeFile(inputName, await fetchFile(currentFile));
        await ff.exec(['-ss', `${start}`, '-to', `${end}`, '-i', inputName, '-c', 'copy', outputName]);

        const data = await ff.readFile(outputName);
        const a = document.createElement('a');
        a.href = URL.createObjectURL(new Blob([data.buffer], { type: currentFile.type }));
        a.download = `axon_cut_${currentFile.name}`;
        a.click();
        
        await ff.deleteFile(inputName);
        await ff.deleteFile(outputName);
    } catch (e) { alert("Error: " + e.message); }
    finally { exportBtn.disabled = false; exportBtn.innerText = "Export & Log"; exportBtn.blur(); }
};

async function sendToGAS(data) {
    try { await fetch(GAS_URL, { method: 'POST', mode: 'no-cors', body: JSON.stringify(data) }); } 
    catch (e) { console.error(e); }
}