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
                try {
                    // Handle Request object properly
                    let url = input;
                    let options = init || {};

                    if (input instanceof Request) {
                        url = input.url;
                        options = {
                            method: input.method,
                            headers: Object.fromEntries(input.headers.entries()),
                            body: input.body,
                            mode: input.mode,
                            credentials: input.credentials,
                            ...init
                        };
                    }

                    // Add timeout using AbortController
                    const controller = new AbortController();
                    const timeoutId = setTimeout(() => controller.abort(), 10000);

                    try {
                        // Make the request with proper headers
                        const response = await globalThis.fetch(url, {
                            ...options,
                            signal: controller.signal,
                            headers: {
                                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
                                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
                                'Accept-Language': 'en-US,en;q=0.5',
                                ...(options.headers || {})
                            }
                        });

                        clearTimeout(timeoutId);
                        return response;
                    } catch (error) {
                        clearTimeout(timeoutId);
                        if (error.name === 'AbortError') {
                            throw new Error('Request timed out');
                        }
                        throw error;
                    }
                } catch (error) {
                    console.error('Fetch error:', error);
                    throw error;
                }
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

// Function to extract view count
function extractViewCount(videoInfo) {
    try {
        // Check basic_info path (most reliable)
        if (videoInfo?.basic_info?.view_count !== undefined) {
            return parseInt(videoInfo.basic_info.view_count.toString().replace(/[^0-9]/g, ''), 10);
        }

        // Log available paths for debugging
        console.log('Available paths:', Object.keys(videoInfo || {}));
        if (videoInfo?.basic_info) {
            console.log('Basic info keys:', Object.keys(videoInfo.basic_info));
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
        console.log(`Fetching view count for video: ${videoId}`);
        
        // Add validation for video ID
        if (!videoId || videoId.length < 5) {
            return res.status(400).json({ error: 'Invalid video ID' });
        }
        
        const videoInfo = await yt.getInfo(videoId);
        console.log(`Video info retrieved, checking for view count...`);
        
        // More detailed logging to debug the issue
        if (!videoInfo) {
            console.log('Video info is null or undefined');
            return res.status(404).json({ error: 'Video not found' });
        }
        
        if (!videoInfo.basic_info) {
            console.log('basic_info is missing from response');
            console.log('Available keys:', Object.keys(videoInfo));
            return res.status(404).json({ error: 'Video basic info not found' });
        }
        
        // Check if view count exists and log it
        console.log('View count from API:', videoInfo.basic_info.view_count);
        
        // Return the view count if available
        if (videoInfo.basic_info.view_count !== undefined) {
            res.json({
                video_id: videoInfo.basic_info.id,
                views: videoInfo.basic_info.view_count
            });
        } else {
            console.log('View count not found in response');
            res.status(404).json({ error: 'View count not found' });
        }

    } catch (error) {
        console.error(`Error fetching view count for ${req.params.videoId}:`, error);
        res.status(500).json({ error: 'Failed to fetch view count', details: error.message });
    }
});

// Debug endpoint
app.get('/api/debug/:videoId', async (req, res) => {
    try {
        const videoId = req.params.videoId;
        console.log(`Debug request for video ${videoId}`);
        
        const videoInfo = await yt.getInfo(videoId);
        
        res.json({
            video_id: videoId,
            basic_info: {
                id: videoInfo?.basic_info?.id,
                title: videoInfo?.basic_info?.title,
                views: videoInfo?.basic_info?.view_count
            },
            available_keys: Object.keys(videoInfo || {})
        });

    } catch (error) {
        console.error(`
