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
        yt = await Innertube.create();
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

// Apply the middleware to all routes except health check
app.use('/api/*', checkYouTubeClient);

// Basic health check endpoint
app.get('/', (req, res) => {
    res.json({ status: 'YouTube API service is running' });
});

// Get channel info endpoint
app.get('/api/channel/:channelId', async (req, res) => {
    try {
        console.log('Fetching channel:', req.params.channelId);
        const channel = await yt.getChannel(req.params.channelId);
        
        // Extract channel info from metadata and header
        const channelInfo = {
            id: channel.metadata.external_id,
            title: channel.metadata.title,
            description: channel.metadata.description,
            thumbnail_url: channel.metadata.avatar?.[0]?.url || channel.metadata.thumbnail?.[0]?.url,
            banner_url: channel.header?.content?.banner?.image?.[0]?.url || 
                       channel.header?.content?.banner?.desktop?.[0]?.url
        };

        res.json(channelInfo);
    } catch (error) {
        console.error('Channel error:', error);
        res.status(500).json({ error: error.message });
    }
});

// Get video info endpoint
app.get('/api/video/:videoId', async (req, res) => {
  try {
    const videoInfo = await yt.getInfo(req.params.videoId);
    const simplifiedInfo = {
      video_id: videoInfo.basic_info.id,
      title: videoInfo.basic_info.title,
      description: videoInfo.basic_info.description,
      thumbnail_url: videoInfo.basic_info.thumbnail[0].url,
      views: videoInfo.basic_info.view_count,
      published_at: videoInfo.basic_info.publish_date,
      channel_id: videoInfo.basic_info.channel?.id,
      channel_title: videoInfo.basic_info.channel?.name,
      channel_thumbnail: videoInfo.basic_info.channel?.thumbnails?.[0]?.url
    };
    res.json(simplifiedInfo);
  } catch (error) {
    console.error('Video error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get channel videos endpoint
app.get('/api/channel/:channelId/videos', async (req, res) => {
    try {
        const channel = await yt.getChannel(req.params.channelId);
        const videos = [];
        
        // Get videos from channel's content tab
        const contents = channel.current_tab?.content?.contents || [];
        console.log('Channel contents:', JSON.stringify(contents, null, 2));
        
        for (const item of contents) {
            if (item.type === 'Video' || item.type === 'GridVideo' || item.type === 'ReelItem') {
                try {
                    // Fetch detailed video info
                    const videoInfo = await yt.getInfo(item.id);
                    console.log('Video info:', JSON.stringify(videoInfo.basic_info, null, 2));
                    
                    // Add null checks for all properties
                    const videoData = {
                        video_id: item.id,
                        title: videoInfo.basic_info?.title || '',
                        description: videoInfo.basic_info?.description || '',
                        thumbnail_url: videoInfo.basic_info?.thumbnail?.[0]?.url || '',
                        published_at: videoInfo.basic_info?.published?.text || new Date().toISOString(),
                        views: String(videoInfo.basic_info?.view_count || 0),
                        channel_id: channel.metadata?.external_id || '',
                        channel_title: channel.metadata?.title || '',
                        duration: videoInfo.basic_info?.duration?.text || ''
                    };
                    
                    videos.push(videoData);
                    console.log('Added video:', videoData);
                } catch (videoError) {
                    console.error(`Error fetching video ${item.id}:`, videoError);
                    continue;
                }
            }
        }

        // If we got no videos from the first method, try the videos tab
        if (videos.length === 0) {
            console.log('No videos found in contents, trying videos tab...');
            const videosTab = await channel.getVideos();
            console.log('Videos tab:', JSON.stringify(videosTab, null, 2));
            
            if (videosTab?.videos) {
                for (const video of videosTab.videos) {
                    try {
                        const videoData = {
                            video_id: video.id,
                            title: video.title?.text || '',
                            description: video.description?.text || '',
                            thumbnail_url: video.thumbnail?.[0]?.url || '',
                            published_at: video.published?.text || new Date().toISOString(),
                            views: String(video.view_count?.text || 0),
                            channel_id: channel.metadata?.external_id || '',
                            channel_title: channel.metadata?.title || '',
                            duration: video.duration?.text || ''
                        };
                        videos.push(videoData);
                        console.log('Added video from tab:', videoData);
                    } catch (error) {
                        console.error('Error processing video:', error);
                    }
                }
            }
        }

        console.log(`Total videos found: ${videos.length}`);
        res.json(videos);
    } catch (error) {
        console.error('Channel videos error:', error);
        res.status(500).json({ error: error.message });
    }
});

// Search endpoint
app.get('/api/search', async (req, res) => {
  try {
    const query = req.query.q;
    if (!query) {
      return res.status(400).json({ error: 'Search query is required' });
    }
    const results = await yt.search(query);
    const simplifiedResults = results.videos.map(video => ({
      video_id: video.id,
      title: video.title?.text || '',
      description: video.description?.text || '',
      thumbnail_url: video.thumbnails?.[0]?.url || '',
      published_at: video.published?.text || '',
      views: video.view_count?.text || '0',
      channel_id: video.channel?.id,
      channel_title: video.channel?.name,
      channel_thumbnail: video.channel?.thumbnails?.[0]?.url
    }));
    res.json(simplifiedResults);
  } catch (error) {
    console.error('Search error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get playlist endpoint
app.get('/api/playlist/:playlistId', async (req, res) => {
  try {
    const playlist = await yt.getPlaylist(req.params.playlistId);
    res.json(playlist);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Initialize YouTube client before starting the server
initializeYouTube().then(() => {
    app.listen(port, () => {
        console.log(`Server running on port ${port}`);
    });
}).catch(error => {
    console.error('Failed to start server:', error);
    process.exit(1);
}); 
