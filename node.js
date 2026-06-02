const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const cors = require('cors');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

const ytDlpBinary = process.platform === 'win32' 
    ? path.join(__dirname, 'yt-dlp.exe') 
    : 'yt-dlp'; 

const tmpDir = path.join(__dirname, 'tmp');
if (!fs.existsSync(tmpDir)) {
    fs.mkdirSync(tmpDir, { recursive: true });
}

// Security Configuration
app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            ...helmet.contentSecurityPolicy.getDefaultDirectives(),
            "img-src": ["'self'", "https://i.ytimg.com", "data:"],
            "script-src": ["'self'", "'unsafe-inline'", "https://cdn.tailwindcss.com"]
        }
    }
}));
app.use(cors({ origin: '*' }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const apiLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 45,
    message: { error: 'Too many requests. Please try again later.' }
});

const validateYoutubeUrl = (urlStr) => {
    try {
        if (!urlStr) return null;
        const url = new URL(urlStr);
        if (url.hostname === 'youtu.be') {
            return url.pathname.substring(1).split(/[?#]/)[0];
        }
        if (url.hostname.includes('youtube.com')) {
            if (url.pathname.includes('/shorts/')) {
                return url.pathname.split('/shorts/')[1].split(/[?#]/)[0];
            }
            return url.searchParams.get('v');
        }
        return null;
    } catch (e) {
        const regex = /(?:youtube\.com\/(?:[^\/]+\/.+\/|(?:v|e(?:mbed)?)\/|.*[?&]v=)|youtu\.be\/)([a-zA-Z0-9_-]{11})/;
        const match = urlStr.match(regex);
        return match ? match[1] : null;
    }
};

const sanitizeFilename = (title) => {
    if (!title) return 'media';
    return title.replace(/[/\\?%*:|"<>]/g, '-').replace(/\s+/g, '_');
};

// Metadata extraction endpoint
app.post('/api/info', apiLimiter, (req, res) => {
    const { url } = req.body;
    const videoId = validateYoutubeUrl(url);

    if (!videoId) {
        return res.status(400).json({ error: 'Invalid or unsupported YouTube URL.' });
    }

    const cleanUrl = `https://www.youtube.com/watch?v=${videoId}`;
    
    // Pass User-Agent to match your browser session structure
    const infoArgs = [
        '--dump-json', 
        '--user-agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
        cleanUrl
    ];
    
    // Check and add cookie integration
    const cookiePath = path.join(__dirname, 'cookies.txt');
    if (fs.existsSync(cookiePath)) {
        infoArgs.unshift('--cookies', cookiePath);
        console.log('🍪 cookies.txt detected! Passing session tokens to yt-dlp.');
    } else {
        console.log('⚠️ Warning: cookies.txt not found in directory root.');
    }

    const ytDlp = spawn(ytDlpBinary, infoArgs);
    
    let stdoutData = '';
    let stderrData = '';

    ytDlp.stdout.on('data', (data) => { stdoutData += data; });
    ytDlp.stderr.on('data', (data) => { stderrData += data; });

    ytDlp.on('error', (err) => {
        console.error('Spawning failure:', err);
        return res.status(500).json({ error: 'Missing system dependencies (yt-dlp/ffmpeg).' });
    });

    ytDlp.on('close', (code) => {
        if (code !== 0) {
            console.error(`yt-dlp process failed with code ${code}`);
            console.error(`Detailed stderr logs: ${stderrData}`);
            const cleanError = stderrData.trim().split('\n').pop() || 'Unknown error.';
            return res.status(500).json({ error: `Extraction Failed: ${cleanError}` });
        }
        try {
            const json = JSON.parse(stdoutData);
            const formats = json.formats
                .filter(f => f.vcodec !== 'none' || f.acodec !== 'none')
                .map(f => ({
                    formatId: f.format_id,
                    ext: f.ext,
                    resolution: f.resolution || `${f.height}p` || 'Audio Only',
                    note: f.format_note || '',
                    hasVideo: f.vcodec !== 'none',
                    hasAudio: f.acodec !== 'none',
                    size: f.filesize || f.filesize_approx || null
                }));

            res.json({
                title: json.title,
                thumbnail: json.thumbnail,
                duration: json.duration_string,
                formats: formats
            });
        } catch (e) {
            res.status(500).json({ error: 'Data serialization runtime error.' });
        }
    });
});

// File build processing download endpoint
app.get('/api/download', (req, res) => {
    const { url, formatId, type, title } = req.query;
    const videoId = validateYoutubeUrl(url);

    if (!videoId || !formatId || !type) {
        return res.status(400).send('Invalid file parsing payload parameters.');
    }

    const cleanUrl = `https://www.youtube.com/watch?v=${videoId}`;
    const fileId = crypto.randomBytes(8).toString('hex');
    const tempOutPath = path.join(tmpDir, `download_${fileId}`);
    
    let args = [
        '--user-agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
    ];

    if (type === 'mp3') {
        args.push(
            '-q', '--no-warnings', 
            '-f', 'ba', 
            '-x', '--audio-format', 'mp3', 
            '--embed-thumbnail', '--convert-thumbnails', 'jpg',
            '-o', `${tempOutPath}.%(ext)s`, 
            cleanUrl
        );
    } else {
        args.push(
            '-q', '--no-warnings', 
            '-f', `${formatId}+ba/best`, 
            '--merge-output-format', 'mp4', 
            '-o', `${tempOutPath}.%(ext)s`, 
            cleanUrl
        );
    }

    const cookiePath = path.join(__dirname, 'cookies.txt');
    if (fs.existsSync(cookiePath)) {
        args.unshift('--cookies', cookiePath);
    }

    const downloader = spawn(ytDlpBinary, args);

    downloader.on('close', (code) => {
        const expectedFile = `${tempOutPath}.${type}`;

        if (code !== 0 || !fs.existsSync(expectedFile)) {
            console.error('Download processing failed or file not found.');
            if (!res.headersSent) {
                res.status(500).send('Error compiling media files.');
            }
            return;
        }

        const secureTitleName = sanitizeFilename(title);
        const finalClientFilename = `VIDE_${secureTitleName}.${type}`;

        res.download(expectedFile, finalClientFilename, (err) => {
            fs.unlink(expectedFile, (unlinkErr) => {
                if (unlinkErr) console.error('Error removing temporary cached item:', unlinkErr);
            });
        });
    });

    req.on('close', () => {
        downloader.kill();
    });
});

app.listen(PORT, () => console.log(`🔒 Secure Core serving on http://localhost:${PORT}`));
