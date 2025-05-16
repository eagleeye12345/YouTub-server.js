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

// Basic health check endpoint
app.get('/', (req, res) => {
    res.json({ status: 'View Count Update service is running' });
});

// Get view count endpoint with optimized error handling and retries
app.get('/api/video/:videoId/views', async (req, res) => {
    try {
        const videoId = req.params.videoId;
        
        // Basic validation
        if (!videoId || videoId.length < 5) {
            return res.status(400).json({ error: 'Invalid video ID' });
        }

        // Get video info with retries
        let attempts = 0;
        const maxAttempts = 3;
        let videoInfo = null;

        while (attempts < maxAttempts) {
            try {
                videoInfo = await yt.getInfo(videoId);
                break;
            } catch (error) {
                attempts++;
                if (attempts === maxAttempts) {
                    throw error;
                }
                await new Promise(resolve => setTimeout(resolve, 1000 * attempts)); // Exponential backoff
            }
        }

        if (!videoInfo?.basic_info) {
            return res.status(404).json({ error: 'Video info not found' });
        }

        // Extract view count with fallbacks
        let viewCount = null;

        // Try basic_info view count first (most reliable)
        if (videoInfo.basic_info.view_count !== undefined) {
            viewCount = videoInfo.basic_info.view_count;
        }
        // Try engagement panels
        else if (videoInfo.engagement_panels) {
            for (const panel of videoInfo.engagement_panels) {
                if (panel.engagement_panel_content?.content?.video_description_content?.runs) {
                    for (const run of panel.engagement_panel_content.content.video_description_content.runs) {
                        if (run.text && run.text.includes('views')) {
                            const match = run.text.match(/([0-9,]+)\s+views/);
                            if (match) {
                                viewCount = parseInt(match[1].replace(/,/g, ''));
                                break;
                            }
                        }
                    }
                }
                if (viewCount) break;
            }
        }
        // Try video details
        else if (videoInfo.video_details?.view_count_text) {
            const match = videoInfo.video_details.view_count_text.match(/([0-9,]+)\s+views/);
            if (match) {
                viewCount = parseInt(match[1].replace(/,/g, ''));
            }
        }

        if (viewCount === null) {
            return res.status(404).json({ error: 'View count not found' });
        }

        res.json({
            video_id: videoId,
            views: viewCount
        });

    } catch (error) {
        console.error('Video views error:', error);
        res.status(500).json({ 
            error: 'Failed to fetch view count',
            message: error.message
        });
    }
});

// Batch view count update endpoint
app.post('/api/videos/views/batch', async (req, res) => {
    try {
        const { videoIds } = req.body;

        if (!Array.isArray(videoIds)) {
            return res.status(400).json({ error: 'videoIds must be an array' });
        }

        const results = [];
        const batchSize = 5; // Process 5 videos concurrently

        // Process videos in batches
        for (let i = 0; i < videoIds.length; i += batchSize) {
            const batch = videoIds.slice(i, i + batchSize);
            const batchPromises = batch.map(async (videoId) => {
                try {
                    const videoInfo = await yt.getInfo(videoId);
                    return {
                        video_id: videoId,
                        views: videoInfo.basic_info?.view_count || 0,
                        success: true
                    };
                } catch (error) {
                    return {
                        video_id: videoId,
                        error: error.message,
                        success: false
                    };
                }
            });

            const batchResults = await Promise.all(batchPromises);
            results.push(...batchResults);

            // Add a small delay between batches to avoid rate limiting
            if (i + batchSize < videoIds.length) {
                await new Promise(resolve => setTimeout(resolve, 1000));
            }
        }

        res.json({
            total: videoIds.length,
            successful: results.filter(r => r.success).length,
            failed: results.filter(r => !r.success).length,
            results
        });

    } catch (error) {
        console.error('Batch update error:', error);
        res.status(500).json({ error: error.message });
    }
});

// Initialize YouTube client before starting the server
initializeYouTube().then(() => {
    app.listen(port, () => {
        console.log(`View Count Update service running on port ${port}`);
    });
}).catch(error => {
    console.error('Failed to start server:', error);
    process.exit(1);
}); 
