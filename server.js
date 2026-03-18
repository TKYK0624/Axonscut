const http = require('http');
const fs = require('fs');
const path = require('path');

const server = http.createServer((req, res) => {
    // 維持 same-origin 不變
    res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
    // 💡 修正這裡：將 require-corp 改為 credentialless
    res.setHeader("Cross-Origin-Embedder-Policy", "credentialless");
    
    let filePath = '.' + req.url;
    if (filePath == './') filePath = './index.html';
    
    const extname = String(path.extname(filePath)).toLowerCase();
    const mimeTypes = {
        '.html': 'text/html',
        '.js': 'text/javascript',
        '.css': 'text/css',
        '.wasm': 'application/wasm',
        '.mp4': 'video/mp4'
    };
    const contentType = mimeTypes[extname] || 'application/octet-stream';

    fs.readFile(filePath, (error, content) => {
        if (error) {
            res.writeHead(500);
            res.end('Sorry, error: ' + error.code + ' ..\n');
        } else {
            res.writeHead(200, { 'Content-Type': contentType });
            res.end(content, 'utf-8');
        }
    });
});

const PORT = 8080;
server.listen(PORT, () => {
    console.log(`✅ Server is running at http://localhost:${PORT}`);
    console.log(`請打開瀏覽器並輸入上面的網址來測試您的專案！`);
});