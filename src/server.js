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

// Single video view count endpoint
app.get('/api/video/:videoId/views', async (req, res) => {
    try {
        const videoId = req.params.videoId;
        
        if (!videoId || videoId.length < 5) {
            return res.status(400).json({ error: 'Invalid video ID' });
        }

        const videoInfo = await yt.getInfo(videoId);
        console.log('Video info response:', JSON.stringify(videoInfo, null, 2));

        // Check video availability
        if (videoInfo.playability_status?.status === 'ERROR') {
            return res.status(404).json({ 
                error: 'Video unavailable',
                reason: videoInfo.playability_status.reason 
            });
        }

        // Try multiple paths to get view count
        let viewCount = null;
        
        if (videoInfo.video_details?.view_count) {
            viewCount = videoInfo.video_details.view_count;
        } else if (videoInfo.basic_info?.view_count) {
            viewCount = videoInfo.basic_info.view_count;
        } else if (videoInfo.page_data?.view_count) {
            viewCount = videoInfo.page_data.view_count;
        }

        if (viewCount === null) {
            return res.status(404).json({ error: 'View count not found' });
        }

        res.json({
            video_id: videoId,
            views: viewCount,
            title: videoInfo.basic_info?.title || videoInfo.video_details?.title
        });

    } catch (error) {
        console.error('Error fetching video info:', error);
        res.status(500).json({ error: error.message });
    }
});

// Batch view count endpoint
app.post('/api/videos/views/batch', async (req, res) => {
    try {
        const { videoIds } = req.body;
        
        if (!Array.isArray(videoIds)) {
            return res.status(400).json({ error: 'videoIds must be an array' });
        }

        const results = [];
        const batchSize = 5; // Process 5 videos at a time

        for (let i = 0; i < videoIds.length; i += batchSize) {
            const batch = videoIds.slice(i, i + batchSize);
            console.log(`Processing batch ${Math.floor(i/batchSize) + 1}/${Math.ceil(videoIds.length/batchSize)}`);

            const batchPromises = batch.map(async (videoId) => {
                try {
                    const videoInfo = await yt.getInfo(videoId);
                    
                    // Check video availability
                    if (videoInfo.playability_status?.status === 'ERROR') {
                        return {
                            video_id: videoId,
                            error: videoInfo.playability_status.reason,
                            success: false
                        };
                    }

                    // Try multiple paths to get view count
                    let viewCount = null;
                    
                    if (videoInfo.video_details?.view_count) {
                        viewCount = videoInfo.video_details.view_count;
                    } else if (videoInfo.basic_info?.view_count) {
                        viewCount = videoInfo.basic_info.view_count;
                    } else if (videoInfo.page_data?.view_count) {
                        viewCount = videoInfo.page_data.view_count;
                    }

                    if (viewCount === null) {
                        return {
                            video_id: videoId,
                            error: 'View count not found',
                            success: false
                        };
                    }

                    return {
                        video_id: videoId,
                        views: viewCount,
                        title: videoInfo.basic_info?.title || videoInfo.video_details?.title,
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

            // Add delay between batches
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

// Start server
initializeYouTube().then(() => {
    app.listen(port, () => {
        console.log(`Server running on port ${port}`);
    });
}).catch(error => {
    console.error('Failed to start server:', error);
    process.exit(1);
}); 
