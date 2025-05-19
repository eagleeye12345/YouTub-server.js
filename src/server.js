import express from 'express';
import { Innertube } from 'youtubei.js';
import cors from 'cors';

const app = express();
const port = process.env.PORT || 3000;

// Enable CORS
app.use(cors());
app.use(express.json());

// Initialize YouTube client
let yt = null;
let ytInitialized = false;

async function initializeYouTube() {
    try {
        yt = await Innertube.create({
            cache: false,
            generate_session_locally: true
        });
        ytInitialized = true;
        console.log('YouTube client initialized successfully');
    } catch (error) {
        console.error('Failed to initialize YouTube client:', error);
        throw error;
    }
}

// Middleware to check if YouTube client is initialized
const checkYouTubeClient = async (req, res, next) => {
    if (!ytInitialized) {
        try {
            await initializeYouTube();
        } catch (error) {
            return res.status(500).json({ error: 'YouTube client not initialized' });
        }
    }
    next();
};

// Apply the middleware
app.use('/api/*', checkYouTubeClient);

// Health check endpoint
app.get('/', (req, res) => {
    res.json({ status: 'View Count Update service is running' });
});

// Function to extract view count from various formats
function extractViewCount(videoInfo) {
    // Check primary_info path (most reliable)
    if (videoInfo?.primary_info?.view_count?.text) {
        return parseInt(videoInfo.primary_info.view_count.text.replace(/[^0-9]/g, ''), 10);
    }
    
    // Check video_details path
    if (videoInfo?.video_details?.view_count?.text) {
        return parseInt(videoInfo.video_details.view_count.text.replace(/[^0-9]/g, ''), 10);
    }

    // Check basic_info path
    if (videoInfo?.basic_info?.view_count?.text) {
        return parseInt(videoInfo.basic_info.view_count.text.replace(/[^0-9]/g, ''), 10);
    }

    return null;
}

// Simple view count endpoint
app.get('/api/views/:videoId', async (req, res) => {
    try {
        const videoId = req.params.videoId;
        const videoInfo = await yt.getInfo(videoId);
        
        const viewCount = extractViewCount(videoInfo);
        
        if (!viewCount) {
            return res.status(404).json({ error: 'View count not found' });
        }

        res.json({ views: viewCount });

    } catch (error) {
        console.error('Error:', error);
        res.status(500).json({ error: 'Failed to fetch view count' });
    }
});

// Debug endpoint that only shows view count info
app.get('/api/debug/:videoId', async (req, res) => {
    try {
        const videoId = req.params.videoId;
        const videoInfo = await yt.getInfo(videoId);

        // Only extract relevant view count paths
        const viewPaths = {
            primary_info: videoInfo?.primary_info?.view_count?.text,
            video_details: videoInfo?.video_details?.view_count?.text,
            basic_info: videoInfo?.basic_info?.view_count?.text
        };

        res.json({
            video_id: videoId,
            view_count: extractViewCount(videoInfo),
            view_count_paths: viewPaths
        });

    } catch (error) {
        console.error('Debug error:', error);
        res.status(500).json({ error: 'Failed to fetch debug info' });
    }
});

// Start server
initializeYouTube().then(() => {
    app.listen(port, () => {
        console.log(`Server running on port ${port}`);
    });
}).catch(error => {
    console.error('Failed to start server:', error);
    process.exit(1);
}); 
