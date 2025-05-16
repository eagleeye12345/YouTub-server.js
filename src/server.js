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

// Function to extract view count from various formats
function extractViewCount(videoInfo) {
    // Try to get view count from VideoViewCount type
    if (videoInfo?.video_details?.view_count?.original_view_count) {
        return parseInt(videoInfo.video_details.view_count.original_view_count, 10);
    }
    
    if (videoInfo?.basic_info?.view_count?.original_view_count) {
        return parseInt(videoInfo.basic_info.view_count.original_view_count, 10);
    }

    // Try to get from view_count object
    if (videoInfo?.video_details?.view_count?.view_count?.text) {
        return parseInt(videoInfo.video_details.view_count.view_count.text.replace(/[^0-9]/g, ''), 10);
    }

    // Try other paths
    const viewCount = videoInfo?.video_details?.view_count || 
                     videoInfo?.basic_info?.view_count ||
                     videoInfo?.page_data?.view_count;

    if (typeof viewCount === 'number') {
        return viewCount;
    }

    if (typeof viewCount === 'string') {
        return parseInt(viewCount.replace(/[^0-9]/g, ''), 10);
    }

    return null;
}

// Update the batch endpoint to use the new function
app.post('/api/videos/views/batch', async (req, res) => {
    try {
        const { videoIds } = req.body;
        
        if (!Array.isArray(videoIds)) {
            return res.status(400).json({ error: 'videoIds must be an array' });
        }

        const results = [];
        const batchSize = 5;

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

                    const viewCount = extractViewCount(videoInfo);

                    if (viewCount === null) {
                        console.log('View count not found for video:', videoId, 'Full response:', JSON.stringify(videoInfo, null, 2));
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

// Debug endpoint to show full video info and view count extraction process
app.get('/api/debug/:videoId', async (req, res) => {
    try {
        const videoId = req.params.videoId;
        
        if (!videoId || videoId.length < 5) {
            return res.status(400).json({ error: 'Invalid video ID' });
        }

        console.log(`Debug request for video ${videoId}`);

        // Try both methods to get video info
        const basicInfo = await yt.getBasicInfo(videoId);
        const fullInfo = await yt.getInfo(videoId);
        
        // Collect all possible view count locations
        const viewCountPaths = {
            video_details: {
                original: fullInfo?.video_details?.view_count?.original_view_count,
                formatted: fullInfo?.video_details?.view_count?.view_count?.text,
                short: fullInfo?.video_details?.view_count?.short_view_count?.text,
                extra_short: fullInfo?.video_details?.view_count?.extra_short_view_count?.text
            },
            basic_info: {
                original: basicInfo?.basic_info?.view_count?.original_view_count,
                formatted: basicInfo?.basic_info?.view_count?.view_count?.text,
                short: basicInfo?.basic_info?.view_count?.short_view_count?.text,
                extra_short: basicInfo?.basic_info?.view_count?.extra_short_view_count?.text
            },
            page_data: {
                view_count: fullInfo?.page_data?.view_count,
                videoDetails: fullInfo?.page_data?.videoDetails?.viewCount
            },
            engagement_panels: fullInfo?.engagement_panels?.map(panel => ({
                title: panel.title,
                view_count: panel.view_count
            }))
        };

        // Check video availability
        const availability = {
            basic_info: {
                status: basicInfo?.playability_status?.status,
                reason: basicInfo?.playability_status?.reason
            },
            full_info: {
                status: fullInfo?.playability_status?.status,
                reason: fullInfo?.playability_status?.reason
            }
        };

        // Get final view count using our normal logic
        let finalViewCount = null;
        if (fullInfo?.video_details?.view_count) {
            finalViewCount = fullInfo.video_details.view_count;
        } else if (fullInfo?.basic_info?.view_count) {
            finalViewCount = fullInfo.basic_info.view_count;
        } else if (fullInfo?.page_data?.view_count) {
            finalViewCount = fullInfo.page_data.view_count;
        }

        const response = {
            video_id: videoId,
            title: fullInfo?.basic_info?.title || fullInfo?.video_details?.title,
            availability,
            view_count_paths: viewCountPaths,
            final_view_count: finalViewCount,
            thumbnails: {
                basic: basicInfo?.thumbnails,
                full: fullInfo?.thumbnails
            },
            raw_response: {
                basic_info: basicInfo,
                full_info: fullInfo
            }
        };

        console.log('Debug response:', JSON.stringify(response, null, 2));
        res.json(response);

    } catch (error) {
        console.error('Debug endpoint error:', error);
        res.status(500).json({
            error: error.message,
            stack: error.stack,
            name: error.name
        });
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
