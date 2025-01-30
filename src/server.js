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
        console.log('Fetching channel:', req.params.channelId);
        const channel = await yt.getChannel(req.params.channelId);
        const videos = [];
        
        // Get initial videos tab
        let videosTab = await channel.getVideos();
        console.log('Initial videos tab data:', JSON.stringify(videosTab, null, 2));
        
        let hasMore = true;
        while (hasMore && videosTab?.videos?.length) {
            console.log(`Processing batch of ${videosTab.videos.length} videos`);
            
            for (const video of videosTab.videos) {
                try {
                    const videoInfo = await yt.getInfo(video.id);
                    
                    // Try different date sources in order of accuracy
                    let publishDate;
                    
                    // Parse primary_info date if available
                    if (videoInfo.primary_info?.published?.text) {
                        const primaryInfoDate = videoInfo.primary_info.published.text;
                        // Remove "Premiered" prefix if present
                        const cleanDate = primaryInfoDate.replace(/^Premiered\s+/, '');
                        const parsedDate = new Date(cleanDate);
                        if (!isNaN(parsedDate.getTime())) {
                            publishDate = parsedDate.toISOString();
                        }
                    }

                    // Fallback to other sources if primary_info date parsing failed
                    if (!publishDate) {
                        if (videoInfo.basic_info?.publish_date && !videoInfo.basic_info.publish_date.includes('ago')) {
                            publishDate = videoInfo.basic_info.publish_date;
                        } else if (videoInfo.metadata?.publishDate) {
                            publishDate = videoInfo.metadata.publishDate;
                        } else if (videoInfo.microformat?.publishDate) {
                            publishDate = videoInfo.microformat.publishDate;
                        } else if (video.published?.text) {
                            // For relative dates, try to get a more accurate estimate
                            const relativeDate = video.published.text;
                            const yearMatch = relativeDate.match(/(\d+)\s+year/);
                            
                            if (yearMatch) {
                                const yearsAgo = parseInt(yearMatch[1]);
                                const currentDate = new Date();
                                const estimatedYear = currentDate.getFullYear() - yearsAgo;
                                
                                // If we have month info in the relative date, use it
                                const monthMatch = relativeDate.match(/(\d+)\s+month/);
                                if (monthMatch) {
                                    const monthsAgo = parseInt(monthMatch[1]);
                                    const estimatedDate = new Date();
                                    estimatedDate.setFullYear(estimatedYear);
                                    estimatedDate.setMonth(estimatedDate.getMonth() - monthsAgo);
                                    publishDate = estimatedDate.toISOString();
                                } else {
                                    // If no month info, use parseYouTubeDate as fallback
                                    publishDate = parseYouTubeDate(relativeDate);
                                }
                            } else {
                                publishDate = parseYouTubeDate(relativeDate);
                            }
                        } else {
                            console.warn(`No publish date found for video ${video.id}`);
                            publishDate = new Date().toISOString();
                        }
                    }

                    console.log(`Final parsed date for video ${video.id}: ${publishDate}`);
                    
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
                    console.log(`Added video ${videos.length}: ${videoData.video_id}`);
                } catch (videoError) {
                    console.error(`Error processing video ${video.id}:`, videoError);
                    continue;
                }
            }

            try {
                // Check for continuation using the documented method
                if (videosTab.has_continuation && typeof videosTab.getContinuation === 'function') {
                    console.log('Fetching next batch of videos...');
                    const nextBatch = await videosTab.getContinuation();
                    if (nextBatch && nextBatch.videos && nextBatch.videos.length > 0) {
                        videosTab = nextBatch;
                        console.log(`Successfully loaded next batch with ${videosTab.videos.length} videos`);
                    } else {
                        console.log('No more videos in next batch');
                        hasMore = false;
                    }
                } else {
                    console.log('No more videos to load');
                    hasMore = false;
                }
            } catch (continuationError) {
                console.error('Error getting continuation:', continuationError);
                hasMore = false;
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

// Get shorts info endpoint
app.get('/api/shorts/:videoId', async (req, res) => {
  try {
    const shortsInfo = await yt.getShortsVideoInfo(req.params.videoId);
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
      duration: shortsInfo.basic_info?.duration?.text
    };
    res.json(simplifiedInfo);
  } catch (error) {
    console.error('Shorts error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get channel shorts endpoint
app.get('/api/channel/:channelId/shorts', async (req, res) => {
  try {
    console.log('Fetching channel shorts:', req.params.channelId);
    const channel = await yt.getChannel(req.params.channelId);
    
    // Get shorts tab
    const shortsTab = await channel.getShorts();
    const shorts = [];
    
    if (shortsTab?.videos?.length) {
      for (const short of shortsTab.videos) {
        try {
          const shortInfo = await yt.getShortsVideoInfo(short.id);
          
          const shortData = {
            video_id: short.id,
            title: shortInfo.basic_info?.title || short.title?.text || '',
            description: shortInfo.basic_info?.description || short.description_snippet?.text || '',
            thumbnail_url: shortInfo.basic_info?.thumbnail?.[0]?.url || 
                         short.thumbnail?.[0]?.url ||
                         `https://i.ytimg.com/vi/${short.id}/hqdefault.jpg`,
            published_at: shortInfo.basic_info?.publish_date || short.published?.text || '',
            views: short.view_count?.text?.replace(/[^0-9]/g, '') || '0',
            channel_id: channel.metadata?.external_id || '',
            channel_title: channel.metadata?.title || '',
            duration: shortInfo.basic_info?.duration?.text || short.duration?.text || ''
          };
          
          shorts.push(shortData);
          console.log(`Added short ${shorts.length}: ${shortData.video_id}`);
        } catch (shortError) {
          console.error(`Error processing short ${short.id}:`, shortError);
          continue;
        }
      }
    }

    console.log(`Total shorts found: ${shorts.length}`);
    res.json(shorts);
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
