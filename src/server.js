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

// Helper function to parse YouTube relative time
function parseYouTubeDate(publishedText) {
    if (!publishedText) return new Date().toISOString();
    
    console.log('Parsing date from:', publishedText);
    
    // Extract number and unit from strings like "9 years ago"
    const match = publishedText.match(/(\d+)\s+(second|minute|hour|day|week|month|year)s?\s+ago/i);
    if (!match) return new Date().toISOString();
    
    const amount = parseInt(match[1]);
    const unit = match[2].toLowerCase();
    
    const now = new Date();
    switch (unit) {
        case 'year':
            now.setFullYear(now.getFullYear() - amount);
            break;
        case 'month':
            now.setMonth(now.getMonth() - amount);
            break;
        case 'week':
            now.setDate(now.getDate() - (amount * 7));
            break;
        case 'day':
            now.setDate(now.getDate() - amount);
            break;
        case 'hour':
            now.setHours(now.getHours() - amount);
            break;
        case 'minute':
            now.setMinutes(now.getMinutes() - amount);
            break;
        case 'second':
            now.setSeconds(now.getSeconds() - amount);
            break;
    }
    
    return now.toISOString();
}

// Get channel videos endpoint
app.get('/api/channel/:channelId/videos', async (req, res) => {
    try {
        console.log('Fetching channel:', req.params.channelId);
        const channel = await yt.getChannel(req.params.channelId);
        const videos = [];
        
        let videosTab = await channel.getVideos();
        console.log('Initial videos tab data:', JSON.stringify(videosTab, null, 2));
        
        // Keep fetching videos while there are more available
        while (videosTab?.videos) {
            for (const video of videosTab.videos) {
                try {
                    const videoInfo = await yt.getInfo(video.id);
                    console.log('Video info for', video.id, ':', JSON.stringify(videoInfo.basic_info, null, 2));
                    
                    // Get description from multiple possible locations
                    let description = '';
                    if (videoInfo.primary_info?.description?.text) {
                        description = videoInfo.primary_info.description.text;
                    } else if (videoInfo.secondary_info?.description?.text) {
                        description = videoInfo.secondary_info.description.text;
                    } else if (videoInfo.basic_info?.description) {
                        description = videoInfo.basic_info.description;
                    } else if (video.description_snippet?.text) {
                        description = video.description_snippet.text;
                    }
                    
                    // Get published date from video metadata
                    let publishDate;
                    if (video.published?.text) {
                        publishDate = parseYouTubeDate(video.published.text);
                        console.log(`Video ${video.id} published ${video.published.text} -> ${publishDate}`);
                    } else if (videoInfo.basic_info?.published) {
                        publishDate = parseYouTubeDate(videoInfo.basic_info.published);
                        console.log(`Video ${video.id} published (from info) ${videoInfo.basic_info.published} -> ${publishDate}`);
                    } else {
                        publishDate = new Date().toISOString();
                        console.log(`Video ${video.id} no publish date found, using current time`);
                    }
                    
                    // Parse view count
                    let viewCount = '0';
                    if (video.view_count?.text) {
                        viewCount = video.view_count.text.replace(/[^0-9]/g, '');
                    }
                    
                    const videoData = {
                        video_id: video.id,
                        title: videoInfo.basic_info?.title || video.title?.text || '',
                        description: description,
                        thumbnail_url: videoInfo.basic_info?.thumbnail?.[0]?.url || 
                                     video.thumbnail?.[0]?.url ||
                                     `https://i.ytimg.com/vi/${video.id}/hqdefault.jpg`,
                        published_at: publishDate,
                        views: viewCount,
                        channel_id: channel.metadata?.external_id || '',
                        channel_title: channel.metadata?.title || '',
                        duration: videoInfo.basic_info?.duration?.text || video.duration?.text || ''
                    };
                    
                    videos.push(videoData);
                    console.log(`Added video data (${videos.length}):`, videoData);
                } catch (videoError) {
                    console.error(`Error processing video ${video.id}:`, videoError);
                    continue;
                }
            }

            // Check if there are more videos to load
            if (videosTab.continuation) {
                console.log('Loading more videos...');
                videosTab = await videosTab.getContinuation();
            } else {
                console.log('No more videos to load');
                break;
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
