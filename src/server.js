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

// Get video info endpoint - based on the working src/server.js implementation
app.get('/api/video/:videoId', async (req, res) => {
    try {
        const videoId = req.params.videoId;
        
        if (!videoId || videoId.length < 5) {
            return res.status(400).json({ error: 'Invalid video ID' });
        }

        console.log(`Fetching info for video: ${videoId}`);
        const videoInfo = await yt.getBasicInfo(videoId);
        
        // Try multiple paths to get view count
        let viewCount = null;
        
        // Check view_count object first
        if (videoInfo?.view_count?.view_count?.text) {
            const match = videoInfo.view_count.view_count.text.match(/[\d,]+/);
            if (match) {
                viewCount = parseInt(match[0].replace(/,/g, ''), 10);
            }
        }
        
        // Fallback to basic_info
        if (!viewCount && videoInfo?.basic_info?.view_count) {
            viewCount = videoInfo.basic_info.view_count;
        }

        // Fallback to video_details
        if (!viewCount && videoInfo?.video_details?.view_count) {
            viewCount = videoInfo.video_details.view_count;
        }

        const response = {
            video_id: videoId,
            title: videoInfo?.basic_info?.title || videoInfo?.video_details?.title,
            views: viewCount,
            success: true
        };

        console.log('Video info:', response);
        res.json(response);

    } catch (error) {
        console.error('Video error:', error);
        res.status(500).json({ 
            error: 'Failed to fetch video info',
            message: error.message 
        });
    }
});

// Batch endpoint using the same approach
app.post('/api/videos/views/batch', async (req, res) => {
    try {
        const { videoIds } = req.body;
        console.log('Received request for videos:', videoIds);

        if (!Array.isArray(videoIds)) {
            return res.status(400).json({ error: 'videoIds must be an array' });
        }

        const results = [];
        const batchSize = 5;

        for (let i = 0; i < videoIds.length; i += batchSize) {
            const batch = videoIds.slice(i, i + batchSize);
            console.log(`Processing batch ${i/batchSize + 1}, videos:`, batch);

            const batchPromises = batch.map(async (videoId) => {
                try {
                    const videoInfo = await yt.getInfo(videoId);
                    const viewCount = videoInfo?.basic_info?.view_count;

                    return {
                        video_id: videoId,
                        views: viewCount,
                        success: true
                    };
                } catch (error) {
                    console.error(`Error fetching video ${videoId}:`, error);
                    return {
                        video_id: videoId,
                        error: error.message,
                        success: false
                    };
                }
            });

            const batchResults = await Promise.all(batchPromises);
            results.push(...batchResults);

            if (i + batchSize < videoIds.length) {
                await new Promise(resolve => setTimeout(resolve, 1000));
            }
        }

        const response = {
            total: videoIds.length,
            successful: results.filter(r => r.success).length,
            failed: results.filter(r => !r.success).length,
            results
        };
        
        res.json(response);

    } catch (error) {
        console.error('Batch update error:', error);
        res.status(500).json({ error: error.message });
    }
});

// Debug endpoint to show all video info
app.get('/api/video/:videoId/debug', async (req, res) => {
    try {
        const videoId = req.params.videoId;
        
        if (!videoId || videoId.length < 5) {
            return res.status(400).json({ error: 'Invalid video ID' });
        }

        console.log(`Fetching full debug info for video: ${videoId}`);
        
        // Get info using available methods
        const basicInfo = await yt.getBasicInfo(videoId);
        const fullInfo = await yt.getInfo(videoId);
        
        // Create debug response with all possible paths
        const debugResponse = {
            video_id: videoId,
            basic_info: {
                id: basicInfo?.basic_info?.id,
                title: basicInfo?.basic_info?.title,
                view_count: basicInfo?.basic_info?.view_count,
                view_count_text: basicInfo?.basic_info?.view_count_text,
                description: basicInfo?.basic_info?.description,
                raw_view_count: basicInfo?.view_count
            },
            video_details: {
                id: fullInfo?.video_details?.id,
                title: fullInfo?.video_details?.title,
                view_count: fullInfo?.video_details?.view_count,
                view_count_text: fullInfo?.video_details?.view_count_text,
                description: fullInfo?.video_details?.description
            },
            raw_data: process.env.NODE_ENV === 'development' ? {
                basic_info: basicInfo,
                full_info: fullInfo
            } : undefined
        };

        // Log the full response for server-side debugging
        console.log('Debug info:', JSON.stringify(debugResponse, null, 2));

        res.json(debugResponse);

    } catch (error) {
        console.error('Error fetching video debug info:', error);
        res.status(500).json({ 
            error: 'Failed to fetch video info',
            message: error.message,
            stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
        });
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
