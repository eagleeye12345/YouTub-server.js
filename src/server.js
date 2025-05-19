import express from 'express';
import { Innertube } from 'youtubei.js';
import cors from 'cors';

const app = express();
const port = process.env.PORT || 3000;

// Enable CORS and JSON parsing
app.use(cors());
app.use(express.json());

// Initialize YouTube client
let yt = null;
let ytInitialized = false;
let initializationAttempts = 0;
const MAX_INIT_ATTEMPTS = 3;

async function initializeYouTube() {
    try {
        console.log('Initializing YouTube client...');
        yt = await Innertube.create({
            cache: false,
            generate_session_locally: true,
            fetch: async (input, init) => {
                // Handle both URL string and Request object
                const url = input instanceof Request ? input.url : input;
                
                const timeout = new Promise((_, reject) => {
                    setTimeout(() => reject(new Error('Request timed out')), 10000);
                });
                
                const request = fetch(url, {
                    ...init,
                    headers: {
                        ...(init?.headers || {}),
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
                    }
                });
                
                return Promise.race([request, timeout]);
            }
        });
        ytInitialized = true;
        console.log('YouTube client initialized successfully');
    } catch (error) {
        console.error('Failed to initialize YouTube client:', error);
        if (++initializationAttempts < MAX_INIT_ATTEMPTS) {
            console.log(`Retrying initialization (attempt ${initializationAttempts + 1}/${MAX_INIT_ATTEMPTS})...`);
            await new Promise(resolve => setTimeout(resolve, 1000));
            return initializeYouTube();
        }
        throw error;
    }
}

// Middleware to check YouTube client
const checkYouTubeClient = async (req, res, next) => {
    if (!ytInitialized) {
        try {
            await initializeYouTube();
        } catch (error) {
            return res.status(503).json({ error: 'YouTube client unavailable', details: error.message });
        }
    }
    next();
};

app.use('/api/*', checkYouTubeClient);

// Health check endpoint
app.get('/', (req, res) => {
    res.json({ 
        status: 'View Count Update service is running',
        youtube_client: ytInitialized ? 'initialized' : 'not initialized'
    });
});

// Function to extract view count from various formats
function extractViewCount(videoInfo) {
    try {
        // Check primary_info path (most reliable)
        if (videoInfo?.primary_info?.view_count?.view_count?.text) {
            return parseInt(videoInfo.primary_info.view_count.view_count.text.replace(/[^0-9]/g, ''), 10);
        }

        // Check primary_info original count
        if (videoInfo?.primary_info?.view_count?.original_view_count) {
            return parseInt(videoInfo.primary_info.view_count.original_view_count, 10);
        }

        // Check basic_info path
        if (videoInfo?.basic_info?.view_count) {
            return parseInt(videoInfo.basic_info.view_count.toString().replace(/[^0-9]/g, ''), 10);
        }

        // Check video_details path
        if (videoInfo?.video_details?.view_count_text) {
            const match = videoInfo.video_details.view_count_text.match(/([0-9,]+)\s+views/);
            if (match) {
                return parseInt(match[1].replace(/,/g, ''), 10);
            }
        }

        // Check engagement panels
        if (videoInfo?.engagement_panels) {
            for (const panel of videoInfo.engagement_panels) {
                if (panel.engagement_panel_content?.content?.video_description_content?.runs) {
                    for (const run of panel.engagement_panel_content.content.video_description_content.runs) {
                        if (run.text && run.text.includes('views')) {
                            const match = run.text.match(/([0-9,]+)\s+views/);
                            if (match) {
                                return parseInt(match[1].replace(/,/g, ''), 10);
                            }
                        }
                    }
                }
            }
        }

        // Check overlay metadata
        if (videoInfo?.overlay_metadata?.secondary_text?.text) {
            const viewText = videoInfo.overlay_metadata.secondary_text.text;
            const match = viewText.match(/(\d+(?:\.\d+)?[KMB]?)\s+views/i);
            if (match) {
                const viewCount = match[1];
                if (viewCount.endsWith('B')) {
                    return Math.floor(parseFloat(viewCount.replace('B', '')) * 1000000000);
                }
                if (viewCount.endsWith('M')) {
                    return Math.floor(parseFloat(viewCount.replace('M', '')) * 1000000);
                }
                if (viewCount.endsWith('K')) {
                    return Math.floor(parseFloat(viewCount.replace('K', '')) * 1000);
                }
                return parseInt(viewCount, 10);
            }
        }

        return null;
    } catch (error) {
        console.error('Error extracting view count:', error);
        return null;
    }
}

// View count endpoint
app.get('/api/views/:videoId', async (req, res) => {
    try {
        const videoId = req.params.videoId;
        console.log(`Fetching view count for video ${videoId}`);
        
        const videoInfo = await yt.getInfo(videoId);
        const viewCount = extractViewCount(videoInfo);
        
        if (!viewCount) {
            console.log(`No view count found for video ${videoId}`);
            return res.status(404).json({ error: 'View count not found' });
        }

        console.log(`Successfully got view count for ${videoId}: ${viewCount}`);
        res.json({ views: viewCount });

    } catch (error) {
        console.error(`Error fetching view count for ${req.params.videoId}:`, error);
        res.status(500).json({ error: 'Failed to fetch view count', details: error.message });
    }
});

// Debug endpoint that shows all possible view count paths
app.get('/api/debug/:videoId', async (req, res) => {
    try {
        const videoId = req.params.videoId;
        console.log(`Debug request for video ${videoId}`);
        
        const videoInfo = await yt.getInfo(videoId);
        const viewCount = extractViewCount(videoInfo);
        
        // Show all possible paths where view count might be found
        const viewPaths = {
            primary_info: {
                formatted: videoInfo?.primary_info?.view_count?.view_count?.text,
                original: videoInfo?.primary_info?.view_count?.original_view_count
            },
            basic_info: videoInfo?.basic_info?.view_count,
            video_details: videoInfo?.video_details?.view_count_text,
            engagement_panels: videoInfo?.engagement_panels?.map(panel => 
                panel.engagement_panel_content?.content?.video_description_content?.runs
                ?.find(run => run.text?.includes('views'))?.text
            ).filter(Boolean),
            overlay_metadata: videoInfo?.overlay_metadata?.secondary_text?.text,
            final_view_count: viewCount
        };

        res.json({
            video_id: videoId,
            view_count: viewCount,
            view_count_paths: viewPaths
        });

    } catch (error) {
        console.error(`Debug error for ${req.params.videoId}:`, error);
        res.status(500).json({ error: 'Debug failed', details: error.message });
    }
});

// Error handling
process.on('uncaughtException', (error) => {
    console.error('Uncaught Exception:', error);
});

process.on('unhandledRejection', (error) => {
    console.error('Unhandled Rejection:', error);
});

// Start server with retries
function startServer(retries = 3) {
    try {
        const server = app.listen(port, () => {
            console.log(`Server running on port ${port}`);
        });

        server.on('error', (error) => {
            console.error('Server error:', error);
            if (retries > 0) {
                console.log(`Retrying server start (${retries} attempts left)...`);
                setTimeout(() => startServer(retries - 1), 1000);
            }
        });
    } catch (error) {
        console.error('Failed to start server:', error);
        if (retries > 0) {
            console.log(`Retrying server start (${retries} attempts left)...`);
            setTimeout(() => startServer(retries - 1), 1000);
        }
    }
}

// Initialize and start
initializeYouTube()
    .then(() => startServer())
    .catch(error => {
        console.error('Fatal error:', error);
        process.exit(1);
    }); 
