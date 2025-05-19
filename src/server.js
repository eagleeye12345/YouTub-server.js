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

// Get view count endpoint - optimized for just view count
app.get('/api/video/:videoId/views', async (req, res) => {
    try {
        const videoId = req.params.videoId;
        
        if (!videoId || videoId.length < 5) {
            return res.status(400).json({ error: 'Invalid video ID' });
        }

        // Get basic video info with retries
        let attempts = 0;
        const maxAttempts = 3;
        let videoInfo = null;

        while (attempts < maxAttempts) {
            try {
                // Using getBasicInfo() instead of getInfo() for faster response
                videoInfo = await yt.getBasicInfo(videoId);
                break;
            } catch (error) {
                attempts++;
                if (attempts === maxAttempts) throw error;
                await new Promise(resolve => setTimeout(resolve, 1000 * attempts));
            }
        }

        // Extract view count using VideoViewCount class properties
        const viewCount = videoInfo?.basic_info?.view_count;
        
        if (typeof viewCount === 'undefined') {
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
        console.log('Received request for videos:', videoIds);

        if (!Array.isArray(videoIds)) {
            return res.status(400).json({ error: 'videoIds must be an array' });
        }

        const results = [];
        const batchSize = 5; // Process 5 videos concurrently

        for (let i = 0; i < videoIds.length; i += batchSize) {
            const batch = videoIds.slice(i, i + batchSize);
            console.log(`Processing batch ${i/batchSize + 1}, videos:`, batch);

            const batchPromises = batch.map(async (videoId) => {
                try {
                    console.log(`Fetching info for video ${videoId}`);
                    const videoInfo = await yt.getBasicInfo(videoId);
                    
                    // Check if video is unavailable
                    if (videoInfo?.playability_status?.status === 'ERROR' || 
                        videoInfo?.playability_status?.reason?.includes('unavailable') ||
                        (videoInfo?.thumbnails?.[0]?.url || '').includes('meh7-vflGevej7.png')) {
                        console.log(`Video ${videoId} is unavailable`);
                        return {
                            video_id: videoId,
                            error: 'Video unavailable',
                            success: false
                        };
                    }

                    // Try different paths to get view count
                    let viewCount = null;
                    
                    if (videoInfo?.basic_info?.view_count) {
                        viewCount = videoInfo.basic_info.view_count;
                    } else if (videoInfo?.video_details?.view_count) {
                        viewCount = videoInfo.video_details.view_count;
                    } else if (videoInfo?.page_data?.view_count) {
                        viewCount = videoInfo.page_data.view_count;
                    }

                    console.log(`Video ${videoId} view count paths:`, {
                        basic_info: videoInfo?.basic_info?.view_count,
                        video_details: videoInfo?.video_details?.view_count,
                        page_data: videoInfo?.page_data?.view_count,
                        final_view_count: viewCount,
                        playability_status: videoInfo?.playability_status
                    });

                    // If no view count found, mark as failed
                    if (viewCount === null || viewCount === undefined) {
                        return {
                            video_id: videoId,
                            error: 'View count not found',
                            success: false
                        };
                    }

                    // If view count is a string (like "1.5M"), convert it
                    if (typeof viewCount === 'string') {
                        viewCount = parseViewCount(viewCount);
                    }

                    return {
                        video_id: videoId,
                        views: viewCount,
                        success: true,
                        raw_response: process.env.NODE_ENV === 'development' ? videoInfo : undefined
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
            console.log('Batch results:', batchResults);
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
        
        console.log('Sending response:', response);
        res.json(response);

    } catch (error) {
        console.error('Batch update error:', error);
        res.status(500).json({ error: error.message });
    }
});

// Helper function to parse view count strings
function parseViewCount(viewCount) {
    if (typeof viewCount === 'number') return viewCount;
    if (!viewCount) return 0;

    // Remove any commas and spaces
    viewCount = viewCount.replace(/,|\s/g, '');

    // Handle K, M, B suffixes
    const multipliers = {
        'K': 1000,
        'M': 1000000,
        'B': 1000000000
    };

    for (const [suffix, multiplier] of Object.entries(multipliers)) {
        if (viewCount.toUpperCase().endsWith(suffix)) {
            const number = parseFloat(viewCount.slice(0, -1));
            return Math.round(number * multiplier);
        }
    }

    // Try parsing as a regular number
    return parseInt(viewCount, 10) || 0;
}

// Debug endpoint to show all video info
app.get('/api/video/:videoId/debug', async (req, res) => {
    try {
        const videoId = req.params.videoId;
        
        if (!videoId || videoId.length < 5) {
            return res.status(400).json({ error: 'Invalid video ID' });
        }

        console.log(`Fetching full debug info for video: ${videoId}`);
        
        // Get both basic and full info
        const basicInfo = await yt.getBasicInfo(videoId);
        const fullInfo = await yt.getInfo(videoId);
        
        // Create debug response with all possible paths
        const debugResponse = {
            video_id: videoId,
            basic_info_paths: {
                basic_info_view_count: basicInfo?.basic_info?.view_count,
                video_details_view_count: basicInfo?.video_details?.view_count,
                page_data_view_count: basicInfo?.page_data?.view_count
            },
            full_info_paths: {
                basic_info_view_count: fullInfo?.basic_info?.view_count,
                video_details_view_count: fullInfo?.video_details?.view_count,
                page_data_view_count: fullInfo?.page_data?.view_count,
                engagement_panels: fullInfo?.engagement_panels?.map(panel => ({
                    type: panel.panel_type,
                    content: panel.engagement_panel_content
                }))
            },
            playability_status: {
                basic: basicInfo?.playability_status,
                full: fullInfo?.playability_status
            },
            raw_basic_info: process.env.NODE_ENV === 'development' ? basicInfo : undefined,
            raw_full_info: process.env.NODE_ENV === 'development' ? fullInfo : undefined
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

// Also update your existing view count endpoint to use both methods
app.get('/api/video/:videoId', async (req, res) => {
    try {
        const videoId = req.params.videoId;
        
        if (!videoId || videoId.length < 5) {
            return res.status(400).json({ error: 'Invalid video ID' });
        }

        console.log(`Fetching view count for video: ${videoId}`);
        
        // Try both methods to get view count
        const basicInfo = await yt.getBasicInfo(videoId);
        const fullInfo = await yt.getInfo(videoId);
        
        let viewCount = null;
        
        // Try all possible paths to find view count
        const possiblePaths = [
            basicInfo?.basic_info?.view_count,
            basicInfo?.video_details?.view_count,
            basicInfo?.page_data?.view_count,
            fullInfo?.basic_info?.view_count,
            fullInfo?.video_details?.view_count,
            fullInfo?.page_data?.view_count
        ];

        // Log all possible paths for debugging
        console.log('Possible view count paths:', {
            basic_info: {
                basic_info: basicInfo?.basic_info?.view_count,
                video_details: basicInfo?.video_details?.view_count,
                page_data: basicInfo?.page_data?.view_count
            },
            full_info: {
                basic_info: fullInfo?.basic_info?.view_count,
                video_details: fullInfo?.video_details?.view_count,
                page_data: fullInfo?.page_data?.view_count
            }
        });

        // Find first valid view count
        viewCount = possiblePaths.find(count => count !== undefined && count !== null);

        if (viewCount !== undefined && viewCount !== null) {
            if (typeof viewCount === 'string') {
                viewCount = parseViewCount(viewCount);
            }
            
            res.json({
                video_id: videoId,
                views: viewCount,
                success: true
            });
        } else {
            console.log('No view count found for video:', videoId);
            res.status(404).json({ 
                error: 'View count not found',
                success: false
            });
        }

    } catch (error) {
        console.error('Error fetching video views:', error);
        res.status(500).json({ 
            error: 'Failed to fetch view count',
            message: error.message,
            success: false
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
