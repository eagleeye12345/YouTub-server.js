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
function parseYouTubeDate(dateStr) {
    try {
        if (!dateStr) return new Date().toISOString();

        // If it's already an ISO date string, return it
        if (dateStr.includes('T') && dateStr.includes('Z')) {
            return dateStr;
        }

        // Handle relative dates like "X years/months/weeks/days ago"
        const matches = dateStr.match(/(\d+)\s+(year|month|week|day|hour|minute|second)s?\s+ago/i);
        
        if (matches) {
            const amount = parseInt(matches[1]);
            const unit = matches[2].toLowerCase();
            
            // Get current date
            const now = new Date();
            
            // For years ago, try to get the actual publish date from the video info
            if (unit === 'year') {
                const year = now.getFullYear() - amount;
                // Set to middle of the year if exact date unknown
                // This gives a more reasonable estimate than January 1st
                return new Date(year, 6, 1).toISOString();
            }
            
            // For all other units, calculate from current date
            const date = new Date();
            
            switch (unit) {
                case 'month':
                    date.setMonth(date.getMonth() - amount);
                    break;
                case 'week':
                    date.setDate(date.getDate() - (amount * 7));
                    break;
                case 'day':
                    date.setDate(date.getDate() - amount);
                    break;
                case 'hour':
                    date.setHours(date.getHours() - amount);
                    break;
                case 'minute':
                    date.setMinutes(date.getMinutes() - amount);
                    break;
                case 'second':
                    date.setSeconds(date.getSeconds() - amount);
                    break;
            }
            
            return date.toISOString();
        }

        // Try parsing as a regular date if not relative
        const parsedDate = new Date(dateStr);
        if (!isNaN(parsedDate.getTime())) {
            return parsedDate.toISOString();
        }

        // Return current date if parsing fails
        return new Date().toISOString();
    } catch (error) {
        console.error('Error parsing date:', dateStr, error);
        return new Date().toISOString();
    }
}

// Get channel videos endpoint
app.get('/api/channel/:channelId/videos', async (req, res) => {
    try {
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 30;
        const type = req.query.type || 'videos';
        
        console.log(`Fetching ${type} for channel:`, req.params.channelId, `(page ${page})`);
        const channel = await yt.getChannel(req.params.channelId);
        
        let videos = [];
        let hasMore = false;
        
        if (type === 'shorts') {
            try {
                // First check if channel has shorts
                if (!channel.has_shorts) {
                    console.log('Channel has no shorts tab');
                    return res.json({ 
                        videos: [],
                        pagination: { has_more: false }
                    });
                }

                // Get shorts tab
                let shortsTab = await channel.getShorts();
                console.log('Initial shorts tab loaded');

                // Get continuation if not on first page
                let currentPage = 1;
                let currentBatch = shortsTab;

                // Skip to requested page
                while (currentPage < page && currentBatch?.has_continuation) {
                    console.log(`Skipping shorts page ${currentPage}, getting next batch...`);
                    try {
                        const nextBatch = await currentBatch.getContinuation();
                        if (!nextBatch || !nextBatch.videos || nextBatch.videos.length === 0) {
                            break;
                        }
                        currentBatch = nextBatch;
                        currentPage++;
                    } catch (error) {
                        console.error('Error getting continuation:', error);
                        break;
                    }
                }

                // Process current page
                if (currentBatch?.videos) {
                    const startIdx = 0;
                    const endIdx = Math.min(limit, currentBatch.videos.length);
                    
                    // Filter out any shorts without valid IDs before processing
                    const validShorts = currentBatch.videos
                        .slice(startIdx, endIdx)
                        .filter(short => short && short.id);
                    
                    console.log(`Found ${validShorts.length} valid shorts to process`);
                    
                    for (const short of validShorts) {
                        try {
                            if (!short.id) {
                                console.warn('Skipping short with missing ID');
                                continue;
                            }

                            console.log(`Processing short with ID: ${short.id}`);
                            const shortInfo = await yt.getShortsVideoInfo(short.id);
                            
                            if (!shortInfo || !shortInfo.basic_info) {
                                console.warn(`No basic info found for short ${short.id}`);
                                continue;
                            }

                            const shortData = {
                                video_id: shortInfo.basic_info.id,
                                title: shortInfo.basic_info.title || short.title?.text || '',
                                description: shortInfo.basic_info.description || short.description_snippet?.text || '',
                                thumbnail_url: shortInfo.basic_info.thumbnail?.[0]?.url || 
                                             short.thumbnail?.[0]?.url ||
                                             `https://i.ytimg.com/vi/${short.id}/hqdefault.jpg`,
                                published_at: shortInfo.basic_info.publish_date || 
                                            (short.published?.text ? parseYouTubeDate(short.published.text) : new Date().toISOString()),
                                views: shortInfo.basic_info.view_count?.toString() || 
                                       short.view_count?.text?.replace(/[^0-9]/g, '') || '0',
                                channel_id: channel.metadata?.external_id || '',
                                channel_title: channel.metadata?.title || '',
                                duration: shortInfo.basic_info.duration?.text || short.duration?.text || '',
                                is_short: true,
                                playability_status: shortInfo.playability_status
                            };
                            
                            videos.push(shortData);
                            console.log(`Successfully processed short: ${shortData.video_id}`);
                        } catch (error) {
                            if (error.message.includes('video_id is missing')) {
                                console.warn(`Skipping short with invalid ID: ${short?.id}`);
                            } else {
                                console.error(`Error processing short ${short?.id}:`, error);
                            }
                            continue;
                        }
                    }

                    // Check if more shorts available
                    hasMore = currentBatch.has_continuation && 
                             typeof currentBatch.getContinuation === 'function';
                }
            } catch (shortsError) {
                console.error('Error fetching shorts:', shortsError);
                throw shortsError;
            }
        } else {
            // Existing video fetching logic...
            const videosTab = await channel.getVideos();
            console.log('Initial videos tab data received');
            
            let currentPage = 1;
            let currentBatch = videosTab;
            let continuationAttempts = 0;
            const MAX_CONTINUATION_ATTEMPTS = 3;
            
            // Skip to the requested page
            while (currentPage < page && currentBatch?.has_continuation) {
                console.log(`Skipping page ${currentPage}, getting next batch...`);
                try {
                    const nextBatch = await currentBatch.getContinuation();
                    if (!nextBatch || !nextBatch.videos || nextBatch.videos.length === 0) {
                        console.log('No more videos in continuation');
                        break;
                    }
                    currentBatch = nextBatch;
                    currentPage++;
                    continuationAttempts = 0; // Reset attempts on successful continuation
                } catch (continuationError) {
                    console.error(`Continuation error on page ${currentPage}:`, continuationError);
                    continuationAttempts++;
                    
                    if (continuationAttempts >= MAX_CONTINUATION_ATTEMPTS) {
                        console.error(`Failed to get continuation after ${MAX_CONTINUATION_ATTEMPTS} attempts`);
                        break;
                    }
                    
                    // Wait before retrying
                    await new Promise(resolve => setTimeout(resolve, 2000));
                    continue;
                }
            }
            
            // Process the current page
            if (currentBatch?.videos?.length) {
                console.log(`Processing ${currentBatch.videos.length} videos for page ${page}`);
                
                for (const video of currentBatch.videos) {
                    try {
                        console.log(`Fetching info for video: ${video.id}`);
                        const videoInfo = await yt.getInfo(video.id);
                        
                        // Try to get the most accurate date
                        let publishDate = videoInfo.basic_info?.publish_date;
                        if (!publishDate) {
                            if (videoInfo.primary_info?.published?.text) {
                                const cleanDate = videoInfo.primary_info.published.text.replace(/^Premiered\s+/, '');
                                const parsedDate = new Date(cleanDate);
                                if (!isNaN(parsedDate.getTime())) {
                                    publishDate = parsedDate.toISOString();
                                }
                            } else if (video.published?.text) {
                                publishDate = parseYouTubeDate(video.published.text);
                            } else {
                                publishDate = new Date().toISOString();
                            }
                        }

                        const videoData = {
                            video_id: video.id,
                            title: videoInfo.basic_info?.title || video.title?.text || '',
                            description: videoInfo.primary_info?.description?.text || 
                                       videoInfo.basic_info?.description || 
                                       video.description_snippet?.text || '',
                            thumbnail_url: videoInfo.basic_info?.thumbnail?.[0]?.url || 
                                         video.thumbnail?.[0]?.url ||
                                         `https://i.ytimg.com/vi/${video.id}/hqdefault.jpg`,
                            published_at: publishDate,
                            views: video.view_count?.text?.replace(/[^0-9]/g, '') || '0',
                            channel_id: channel.metadata?.external_id || '',
                            channel_title: channel.metadata?.title || '',
                            duration: videoInfo.basic_info?.duration?.text || video.duration?.text || '',
                            is_short: false,
                            playability_status: videoInfo.playability_status
                        };
                        
                        videos.push(videoData);
                        console.log(`Added video ${videos.length}: ${videoData.video_id}`);
                        
                        if (videos.length >= limit) {
                            break;
                        }

                        // Add a small delay between video info requests
                        await new Promise(resolve => setTimeout(resolve, 100));
                    } catch (videoError) {
                        console.error(`Error processing video ${video.id}:`, videoError);
                        continue;
                    }
                }
            }

            // Check if there are actually more videos
            try {
                if (currentBatch?.has_continuation) {
                    const nextBatch = await currentBatch.getContinuation();
                    hasMore = !!(nextBatch?.videos?.length);
                }
            } catch (error) {
                console.error('Error checking for more videos:', error);
                hasMore = currentBatch?.has_continuation || false;
            }
        }

        res.json({
            videos,
            pagination: {
                has_more: hasMore,
                current_page: page,
                items_per_page: limit,
                total_items: videos.length
            }
        });

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

// Get shorts info endpoint
app.get('/api/shorts/:videoId', async (req, res) => {
  try {
    const shortsInfo = await yt.getShortsVideoInfo(req.params.videoId);
    if (!shortsInfo || !shortsInfo.basic_info) {
      return res.status(404).json({ error: 'Short not found or not available' });
    }

    const simplifiedInfo = {
      video_id: shortsInfo.basic_info?.id,
      title: shortsInfo.basic_info?.title,
      description: shortsInfo.basic_info?.description,
      thumbnail_url: shortsInfo.basic_info?.thumbnail?.[0]?.url,
      views: shortsInfo.basic_info?.view_count,
      published_at: shortsInfo.basic_info?.publish_date,
      channel_id: shortsInfo.basic_info?.channel?.id,
      channel_title: shortsInfo.basic_info?.channel?.name,
      channel_thumbnail: shortsInfo.basic_info?.channel?.thumbnails?.[0]?.url,
      duration: shortsInfo.basic_info?.duration?.text,
      is_short: true,
      playability_status: shortsInfo.playability_status
    };
    res.json(simplifiedInfo);
  } catch (error) {
    console.error('Shorts error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get channel shorts endpoint with pagination
app.get('/api/channel/:channelId/shorts', async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 30;
    
    console.log('Fetching channel shorts:', req.params.channelId, `(page ${page}, limit ${limit})`);
    const channel = await yt.getChannel(req.params.channelId);
    
    if (!channel.has_shorts) {
      return res.json({
        shorts: [],
        pagination: {
          has_more: false,
          current_page: page,
          items_per_page: limit,
          total_items: 0
        }
      });
    }

    // Get initial shorts tab
    let shortsTab = await channel.getShorts();
    console.log('Initial shorts tab loaded');

    // Skip to requested page if needed
    let currentPage = 1;
    let currentBatch = shortsTab;
    let shorts = [];
    let hasMore = false;

    // Skip to the requested page
    while (currentPage < page && currentBatch?.has_continuation) {
      console.log(`Skipping to page ${currentPage}...`);
      try {
        const nextBatch = await currentBatch.getContinuation();
        if (!nextBatch || !nextBatch.videos || nextBatch.videos.length === 0) {
          break;
        }
        currentBatch = nextBatch;
        currentPage++;
      } catch (error) {
        console.error('Error getting continuation:', error);
        break;
      }
    }

    // Process current page
    if (currentBatch?.videos) {
      const startIdx = 0;
      const endIdx = Math.min(limit, currentBatch.videos.length);
      
      // Filter out any shorts without valid IDs before processing
      const validShorts = currentBatch.videos
          .slice(startIdx, endIdx)
          .filter(short => short && short.id);
      
      console.log(`Found ${validShorts.length} valid shorts to process`);
      
      for (const short of validShorts) {
        try {
          if (!short.id) {
            console.warn('Skipping short with missing ID');
            continue;
          }

          console.log(`Processing short with ID: ${short.id}`);
          const shortInfo = await yt.getShortsVideoInfo(short.id);
          
          if (!shortInfo || !shortInfo.basic_info) {
            console.warn(`No basic info found for short ${short.id}`);
            continue;
          }

          const shortData = {
            video_id: shortInfo.basic_info.id,
            title: shortInfo.basic_info.title || short.title?.text || '',
            description: shortInfo.basic_info.description || short.description_snippet?.text || '',
            thumbnail_url: shortInfo.basic_info.thumbnail?.[0]?.url || 
                         short.thumbnail?.[0]?.url ||
                         `https://i.ytimg.com/vi/${short.id}/hqdefault.jpg`,
            published_at: shortInfo.basic_info.publish_date || 
                        (short.published?.text ? parseYouTubeDate(short.published.text) : new Date().toISOString()),
            views: shortInfo.basic_info.view_count?.toString() || 
                   short.view_count?.text?.replace(/[^0-9]/g, '') || '0',
            channel_id: channel.metadata?.external_id || '',
            channel_title: channel.metadata?.title || '',
            duration: shortInfo.basic_info.duration?.text || short.duration?.text || '',
            is_short: true,
            playability_status: shortInfo.playability_status
          };
          
          shorts.push(shortData);
          console.log(`Successfully processed short: ${shortData.video_id}`);
        } catch (error) {
          if (error.message.includes('video_id is missing')) {
            console.warn(`Skipping short with invalid ID: ${short?.id}`);
          } else {
            console.error(`Error processing short ${short?.id}:`, error);
          }
          continue;
        }
      }

      // Check if more shorts available
      hasMore = currentBatch.has_continuation && 
                typeof currentBatch.getContinuation === 'function';
    }

    res.json({
      shorts,
      pagination: {
        has_more: hasMore,
        current_page: page,
        items_per_page: limit,
        total_items: shorts.length
      }
    });

  } catch (error) {
    console.error('Channel shorts error:', error);
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
