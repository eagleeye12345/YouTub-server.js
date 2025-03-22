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
            thumbnail_url: channel.metadata.avatar?.[0]?.url || 
                         channel.metadata.thumbnail?.[0]?.url || 
                         channel.header?.author?.thumbnail?.[0]?.url,
            banner_url: channel.header?.banner?.desktop?.[0]?.url ||
                       channel.header?.banner?.mobile?.[0]?.url ||
                       channel.header?.banner?.tv?.[0]?.url ||
                       channel.header?.content?.banner?.image?.[0]?.url
        };

        // Extract topic channel details if available
        const topicDetails = await extractTopicChannelDetails(channel);
        if (topicDetails) {
            channelInfo.topic_details = topicDetails;
        }

        // Extract related channels/artists in metadata
        if (channel.metadata?.related_channels?.length) {
            channelInfo.related_channels = channel.metadata.related_channels.map(relatedChannel => ({
                id: relatedChannel.id || relatedChannel.channel_id || '',
                title: relatedChannel.title?.text || relatedChannel.name || '',
                thumbnail_url: relatedChannel.thumbnail?.[0]?.url || 
                              relatedChannel.avatar?.[0]?.url || ''
            }));
        }

        // Log the extracted info
        console.log('Extracted channel info:', JSON.stringify(channelInfo, null, 2));

        if (!channelInfo.id || !channelInfo.title) {
            console.error('Missing required channel info:', channelInfo);
            throw new Error('Could not extract required channel information');
        }

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

// Helper function to parse YouTube relative time - FIXED to preserve the original date
function parseYouTubeDate(dateStr) {
    try {
        if (!dateStr) return null;

        // If it's already an ISO date string, return it
        if (dateStr.includes('T') && dateStr.includes('Z')) {
            return dateStr;
        }

        // Handle "Streamed X time ago" format
        dateStr = dateStr.replace(/^Streamed\s+/, '');
        
        // Handle "Premiered X time ago" format
        dateStr = dateStr.replace(/^Premiered\s+/, '');

        // Handle relative dates like "X years/months/weeks/days ago"
        const matches = dateStr.match(/(\d+)\s+(year|month|week|day|hour|minute|second)s?\s+ago/i);
        
        if (matches) {
            const amount = parseInt(matches[1]);
            const unit = matches[2].toLowerCase();
            
            const now = new Date();
            const date = new Date();
            
            switch (unit) {
                case 'year':
                    date.setFullYear(date.getFullYear() - amount);
                    break;
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

        // Try parsing as a regular date (like "Oct 15, 2020")
        const parsedDate = new Date(dateStr);
        if (!isNaN(parsedDate.getTime())) {
            return parsedDate.toISOString();
        }

        return null;
    } catch (error) {
        console.error('Error parsing date:', dateStr, error);
        return null;
    }
}

// Add debug logging helper
function debugLogObject(prefix, obj) {
    console.log(`${prefix}:`, JSON.stringify(obj, null, 2));
}

// Update the extractPublishedDate function with more paths and debugging
function extractPublishedDate(short) {
    try {
        console.log('Extracting date from:', JSON.stringify({
            regularInfo_path: short?.regularInfo?.primary_info?.published?.text,
            primary_info_path: short?.primary_info?.published?.text,
            raw_path: short?.raw?.primary_info?.published?.text,
            relative_date: short?.primary_info?.relative_date?.text
        }, null, 2));

        // Check regularInfo path first
        if (short?.regularInfo?.primary_info?.published?.text) {
            const dateStr = short.regularInfo.primary_info.published.text;
            console.log('Found date in regularInfo:', dateStr);
            const parsedDate = new Date(dateStr);
            if (!isNaN(parsedDate.getTime())) {
                return parsedDate.toISOString();
            }
        }

        // Check primary_info path
        if (short?.primary_info?.published?.text) {
            const dateStr = short.primary_info.published.text;
            console.log('Found date in primary_info:', dateStr);
            const parsedDate = new Date(dateStr);
            if (!isNaN(parsedDate.getTime())) {
                return parsedDate.toISOString();
            }
        }

        // Check raw data path
        if (short?.raw?.primary_info?.published?.text) {
            const dateStr = short.raw.primary_info.published.text;
            console.log('Found date in raw data:', dateStr);
            const parsedDate = new Date(dateStr);
            if (!isNaN(parsedDate.getTime())) {
                return parsedDate.toISOString();
            }
        }

        return null;
    } catch (error) {
        console.error('Error extracting published date:', error);
        return null;
    }
}

// Update extractViews function
function extractViews(short) {
    try {
        // First try accessibility text as it's most reliable for shorts
        if (short.accessibility_text) {
            const viewMatch = short.accessibility_text.match(/([0-9,.]+[KMB]?)\s*views?/i);
            if (viewMatch) {
                console.log('Found views in accessibility text:', viewMatch[1]);
                return viewMatch[1].replace(/,/g, '');
            }
        }

        // Try overlay stats
        if (short.overlay_stats?.[0]?.text?.simpleText) {
            const viewText = short.overlay_stats[0].text.simpleText;
            console.log('Found views in overlay stats:', viewText);
            return viewText.replace(/[^0-9.KMB]/gi, '');
        }

        // Try engagement panels
        if (short.engagement_panels?.[0]?.engagementPanelSectionListRenderer?.content?.viewCount?.videoViewCountRenderer?.viewCount?.simpleText) {
            const viewText = short.engagement_panels[0].engagementPanelSectionListRenderer.content.viewCount.videoViewCountRenderer.viewCount.simpleText;
            console.log('Found views in engagement panel:', viewText);
            return viewText.replace(/[^0-9.KMB]/gi, '');
        }

        // Try video primary info
        if (short.primary_info?.viewCount?.videoViewCountRenderer?.viewCount?.simpleText) {
            const viewText = short.primary_info.viewCount.videoViewCountRenderer.viewCount.simpleText;
            console.log('Found views in primary info:', viewText);
            return viewText.replace(/[^0-9.KMB]/gi, '');
        }

        return '0';
    } catch (error) {
        console.error('Error extracting views:', error);
        return '0';
    }
}

// Helper function to get a clean thumbnail URL
function getCleanThumbnailUrl(videoId) {
    return `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;
}

// Enhanced video endpoint to extract dates from all possible locations
app.get('/api/channel/:channelId/videos', async (req, res) => {
    try {
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 30;
        const type = req.query.type || 'videos';
        
        console.log(`Fetching ${type} for channel: ${req.params.channelId} (page ${page})`);
        const channel = await yt.getChannel(req.params.channelId);
        
        // Extract topic channel details if available
        const topicDetails = await extractTopicChannelDetails(channel);
        
        // Get videos/shorts tab
        const videosTab = type === 'shorts' ? 
            await channel.getShorts() : 
            await channel.getVideos();

        console.log(`Found ${videosTab?.videos?.length} videos`);

        let currentBatch = videosTab;
        let currentPage = 1;

        // Skip to requested page
        while (currentPage < page && currentBatch?.has_continuation) {
            currentBatch = await currentBatch.getContinuation();
            currentPage++;
        }

        // Process current page videos
        if (currentBatch?.videos) {
            const videos = currentBatch.videos.slice(0, limit);
            const processedVideos = [];
            let videoCount = 0;

            // For debugging: Get the first video's full info to examine structure
            if (videos.length > 0) {
                try {
                    const sampleVideoInfo = await yt.getInfo(videos[0].id);
                    console.log('SAMPLE VIDEO INFO STRUCTURE:');
                    console.log('Available top-level keys:', Object.keys(sampleVideoInfo));
                    
                    // Log primary_info structure if it exists
                    if (sampleVideoInfo.primary_info) {
                        console.log('PRIMARY INFO KEYS:', Object.keys(sampleVideoInfo.primary_info));
                        
                        // Check for date fields in primary_info
                        if (sampleVideoInfo.primary_info.date_text) {
                            console.log('DATE TEXT:', sampleVideoInfo.primary_info.date_text);
                        }
                        if (sampleVideoInfo.primary_info.published) {
                            console.log('PUBLISHED:', sampleVideoInfo.primary_info.published);
                        }
                    }
                    
                    // Log microformat structure if it exists
                    if (sampleVideoInfo.microformat?.playerMicroformatRenderer) {
                        console.log('MICROFORMAT DATE FIELDS:');
                        console.log('publishDate:', sampleVideoInfo.microformat.playerMicroformatRenderer.publishDate);
                        console.log('uploadDate:', sampleVideoInfo.microformat.playerMicroformatRenderer.uploadDate);
                    }
                } catch (error) {
                    console.error('Error examining sample video:', error);
                }
            }

            for (const video of videos) {
                try {
                    videoCount++;
                    console.log(`Processing video ${videoCount}/${videos.length}: ${video.id}`);

                    // Get detailed video info
                    const videoInfo = await yt.getInfo(video.id);
                    
                    // Extract basic info
                    const videoData = {
                        video_id: video.id || video.videoId,
                        title: videoInfo.basic_info?.title || video.title?.text || '',
                        description: videoInfo.basic_info?.description || video.description_snippet?.text || '',
                        thumbnail_url: videoInfo.basic_info?.thumbnail?.[0]?.url || 
                                     video.thumbnail?.[0]?.url || 
                                     `https://i.ytimg.com/vi/${video.id}/hqdefault.jpg`,
                        published_at: null, // Will be set below
                        views: videoInfo.basic_info?.view_count || 
                               video.view_count?.text?.replace(/[^0-9]/g, '') || '0',
                        channel_id: videoInfo.basic_info?.channel?.id || 
                                   channel.metadata?.external_id || '',
                        channel_title: videoInfo.basic_info?.channel?.name || 
                                      channel.metadata?.title || '',
                        duration: videoInfo.basic_info?.duration || 
                                video.duration?.text || '',
                        is_short: type === 'shorts'
                    };

                    // Try all possible date fields in order of reliability
                    
                    // 1. Check microformat which often has exact dates
                    if (videoInfo.microformat?.playerMicroformatRenderer?.publishDate) {
                        videoData.published_at = videoInfo.microformat.playerMicroformatRenderer.publishDate;
                        console.log(`Using microformat publishDate for ${video.id}: ${videoData.published_at}`);
                    }
                    else if (videoInfo.microformat?.playerMicroformatRenderer?.uploadDate) {
                        videoData.published_at = videoInfo.microformat.playerMicroformatRenderer.uploadDate;
                        console.log(`Using microformat uploadDate for ${video.id}: ${videoData.published_at}`);
                    }
                    // 2. Check basic_info
                    else if (videoInfo.basic_info?.publish_date) {
                        videoData.published_at = videoInfo.basic_info.publish_date;
                        console.log(`Using basic_info publish_date for ${video.id}: ${videoData.published_at}`);
                    }
                    // 3. Check primary_info
                    else if (videoInfo.primary_info?.published?.text) {
                        const publishedText = videoInfo.primary_info.published.text;
                        console.log(`Found primary_info published text for ${video.id}: ${publishedText}`);
                        
                        // Try to parse as exact date
                        try {
                            const date = new Date(publishedText);
                            if (!isNaN(date.getTime())) {
                                videoData.published_at = date.toISOString();
                                console.log(`Parsed primary_info date for ${video.id}: ${videoData.published_at}`);
                            }
                        } catch (e) {
                            console.log(`Could not parse primary_info date as exact date: ${e.message}`);
                        }
                    }
                    // 4. Check date_text in primary_info
                    else if (videoInfo.primary_info?.date_text?.simpleText) {
                        const dateText = videoInfo.primary_info.date_text.simpleText;
                        console.log(`Found primary_info date_text for ${video.id}: ${dateText}`);
                        
                        // Try to parse as exact date
                        try {
                            const date = new Date(dateText);
                            if (!isNaN(date.getTime())) {
                                videoData.published_at = date.toISOString();
                                console.log(`Parsed date_text for ${video.id}: ${videoData.published_at}`);
                            }
                        } catch (e) {
                            console.log(`Could not parse date_text as exact date: ${e.message}`);
                        }
                    }
                    // 5. Last resort: try to parse from the video's published text
                    else if (video.published?.text) {
                        console.log(`No exact date found, falling back to relative date for ${video.id}`);
                        const publishedText = video.published.text;
                        console.log(`Raw published date for ${video.id}: ${publishedText}`);
                        
                        // Parse the date properly
                        const parsedDate = parseYouTubeDate(publishedText);
                        if (parsedDate) {
                            videoData.published_at = parsedDate;
                            console.log(`Parsed published date for ${video.id}: ${parsedDate}`);
                        }
                    }

                    processedVideos.push(videoData);
                } catch (error) {
                    console.error(`Error processing video ${video.id}:`, error);
                    // Still add the video with basic info even if there was an error
                    processedVideos.push({
                        video_id: video.id || video.videoId,
                        title: video.title?.text || 'Unknown title',
                        thumbnail_url: `https://i.ytimg.com/vi/${video.id}/hqdefault.jpg`,
                        channel_id: channel.metadata?.external_id || '',
                        channel_title: channel.metadata?.title || '',
                        error: error.message
                    });
                }
            }

            // Construct the response
            const response = {
                videos: processedVideos,
                topic_details: topicDetails,
                pagination: {
                    has_more: currentBatch.has_continuation,
                    current_page: page,
                    items_per_page: limit,
                    total_items: processedVideos.length
                }
            };
            
            res.json(response);
        } else {
            res.json({
                videos: [],
                pagination: {
                    has_more: false,
                    current_page: page,
                    items_per_page: limit,
                    total_items: 0
                }
            });
        }
    } catch (error) {
        console.error('Error fetching videos:', error);
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

// Update the shorts endpoint to use primary_info.published for dates
app.get('/api/channel/:channelId/shorts', async (req, res) => {
    try {
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 30;
        
        console.log(`Fetching shorts for channel: ${req.params.channelId} (page ${page})`);
        const channel = await yt.getChannel(req.params.channelId);
        
        // Get shorts tab
        const shortsTab = await channel.getShorts();
        console.log(`Found ${shortsTab?.videos?.length} shorts`);

        let currentBatch = shortsTab;
        let currentPage = 1;

        // Skip to requested page
        while (currentPage < page && currentBatch?.has_continuation) {
            currentBatch = await currentBatch.getContinuation();
            currentPage++;
        }

        // Process current page shorts
        if (currentBatch?.videos) {
            const shorts = currentBatch.videos.slice(0, limit);
            const processedShorts = [];
            let shortCount = 0;

            for (const short of shorts) {
                try {
                    shortCount++;
                    console.log(`Processing short ${shortCount}/${shorts.length}: ${short.id}`);

                    // Get detailed short info
                    const shortInfo = await yt.getInfo(short.id);
                    
                    // Extract basic info
                    const shortData = {
                        video_id: short.id || short.videoId,
                        title: shortInfo.basic_info?.title || short.title?.text || '',
                        description: shortInfo.basic_info?.description || short.description_snippet?.text || '',
                        thumbnail_url: shortInfo.basic_info?.thumbnail?.[0]?.url || 
                                     short.thumbnail?.[0]?.url || 
                                     `https://i.ytimg.com/vi/${short.id}/hqdefault.jpg`,
                        published_at: null, // Will be set below
                        views: shortInfo.basic_info?.view_count || 
                               short.view_count?.text?.replace(/[^0-9]/g, '') || '0',
                        channel_id: shortInfo.basic_info?.channel?.id || 
                                   channel.metadata?.external_id || '',
                        channel_title: shortInfo.basic_info?.channel?.name || 
                                      channel.metadata?.title || '',
                        duration: shortInfo.basic_info?.duration || 
                                short.duration?.text || '',
                        is_short: true
                    };

                    // Try all possible date fields in order of reliability
                    
                    // 1. Check primary_info.published which we found works best
                    if (shortInfo.primary_info?.published?.text) {
                        const publishedText = shortInfo.primary_info.published.text;
                        console.log(`Found primary_info published text for ${short.id}: ${publishedText}`);
                        
                        // Try to parse as exact date
                        try {
                            const date = new Date(publishedText);
                            if (!isNaN(date.getTime())) {
                                shortData.published_at = date.toISOString();
                                console.log(`Parsed primary_info date for ${short.id}: ${shortData.published_at}`);
                            }
                        } catch (e) {
                            console.log(`Could not parse primary_info date as exact date: ${e.message}`);
                        }
                    }
                    // 2. Check microformat which often has exact dates
                    else if (shortInfo.microformat?.playerMicroformatRenderer?.publishDate) {
                        shortData.published_at = shortInfo.microformat.playerMicroformatRenderer.publishDate;
                        console.log(`Using microformat publishDate for ${short.id}: ${shortData.published_at}`);
                    }
                    else if (shortInfo.microformat?.playerMicroformatRenderer?.uploadDate) {
                        shortData.published_at = shortInfo.microformat.playerMicroformatRenderer.uploadDate;
                        console.log(`Using microformat uploadDate for ${short.id}: ${shortData.published_at}`);
                    }
                    // 3. Check basic_info
                    else if (shortInfo.basic_info?.publish_date) {
                        shortData.published_at = shortInfo.basic_info.publish_date;
                        console.log(`Using basic_info publish_date for ${short.id}: ${shortData.published_at}`);
                    }
                    // 4. Last resort: try to parse from the short's published text
                    else if (short.published?.text) {
                        console.log(`No exact date found, falling back to relative date for ${short.id}`);
                        const publishedText = short.published.text;
                        console.log(`Raw published date for ${short.id}: ${publishedText}`);
                        
                        // Parse the date properly
                        const parsedDate = parseYouTubeDate(publishedText);
                        if (parsedDate) {
                            shortData.published_at = parsedDate;
                            console.log(`Parsed published date for ${short.id}: ${parsedDate}`);
                        }
                    }

                    processedShorts.push(shortData);
                } catch (error) {
                    console.error(`Error processing short ${short.id}:`, error);
                    // Still add the short with basic info even if there was an error
                    processedShorts.push({
                        video_id: short.id || short.videoId,
                        title: short.title?.text || 'Unknown title',
                        thumbnail_url: `https://i.ytimg.com/vi/${short.id}/hqdefault.jpg`,
                        channel_id: channel.metadata?.external_id || '',
                        channel_title: channel.metadata?.title || '',
                        error: error.message,
                        is_short: true
                    });
                }
            }

            // Construct the response
            const response = {
                shorts: processedShorts,
                pagination: {
                    has_more: currentBatch.has_continuation,
                    current_page: page,
                    items_per_page: limit,
                    total_items: processedShorts.length
                }
            };
            
            res.json(response);
        } else {
            res.json({
                shorts: [],
                pagination: {
                    has_more: false,
                    current_page: page,
                    items_per_page: limit,
                    total_items: 0
                }
            });
        }
    } catch (error) {
        console.error('Error fetching shorts:', error);
        res.status(500).json({ error: error.message });
    }
});

// Get topic channel info endpoint
app.get('/api/topic/:topicId', async (req, res) => {
    try {
        console.log('Fetching topic channel:', req.params.topicId);
        
        // Topic IDs are usually in the format "UC..." or "FEmusic_channel..."
        const topicChannel = await yt.getChannel(req.params.topicId);
        
        // Extract basic topic channel info
        const topicInfo = {
            id: topicChannel.metadata.external_id,
            title: topicChannel.metadata.title,
            description: topicChannel.metadata.description,
            thumbnail_url: topicChannel.metadata.avatar?.[0]?.url || 
                          topicChannel.metadata.thumbnail?.[0]?.url,
            banner_url: topicChannel.header?.banner?.desktop?.[0]?.url,
            is_artist_channel: topicChannel.metadata?.is_artist || false
        };
        
        // Extract related channels/artists if available
        if (topicChannel.metadata?.related_channels?.length) {
            topicInfo.related_channels = topicChannel.metadata.related_channels.map(relatedChannel => ({
                id: relatedChannel.id || relatedChannel.channel_id || '',
                title: relatedChannel.title?.text || relatedChannel.name || '',
                thumbnail_url: relatedChannel.thumbnail?.[0]?.url || 
                              relatedChannel.avatar?.[0]?.url || ''
            }));
        }
        
        // Extract featured content if available
        if (topicChannel.sections?.length) {
            topicInfo.sections = [];
            
            for (const section of topicChannel.sections) {
                if (section.title?.text) {
                    const sectionData = {
                        title: section.title.text,
                        items: []
                    };
                    
                    // Extract items from the section (videos, playlists, etc.)
                    if (section.contents?.length) {
                        for (const content of section.contents) {
                            // Handle different content types
                            if (content.video_renderer || content.grid_video_renderer) {
                                const videoRenderer = content.video_renderer || content.grid_video_renderer;
                                sectionData.items.push({
                                    type: 'video',
                                    id: videoRenderer.video_id,
                                    title: videoRenderer.title?.text || '',
                                    thumbnail_url: videoRenderer.thumbnail?.[0]?.url || ''
                                });
                            } else if (content.playlist_renderer) {
                                sectionData.items.push({
                                    type: 'playlist',
                                    id: content.playlist_renderer.playlist_id,
                                    title: content.playlist_renderer.title?.text || '',
                                    thumbnail_url: content.playlist_renderer.thumbnail?.[0]?.url || ''
                                });
                            }
                        }
                    }
                    
                    topicInfo.sections.push(sectionData);
                }
            }
        }
        
        console.log('Extracted topic info:', JSON.stringify(topicInfo, null, 2));
        res.json(topicInfo);
    } catch (error) {
        console.error('Topic channel error:', error);
        res.status(500).json({ error: error.message });
    }
});

// Update the extractTopicChannelDetails function to include the new approach
async function extractTopicChannelDetails(channel) {
    // First try the existing methods
    let topicDetails = null;
    
    // Check in header
    if (channel.header?.topic_channel_details) {
        topicDetails = channel.header.topic_channel_details;
    }
    // Check in metadata
    else if (channel.metadata?.topic_channel_details) {
        topicDetails = channel.metadata.topic_channel_details;
    }
    // Check in header content
    else if (channel.header?.content?.topic_channel_details) {
        topicDetails = channel.header.content.topic_channel_details;
    }
    // Check in tabs
    else if (channel.tabs && Array.isArray(channel.tabs)) {
        // Look through tabs for topic information
        for (const tab of channel.tabs) {
            if (tab.topic_channel_details) {
                topicDetails = tab.topic_channel_details;
                break;
            }
        }
    }
    
    // If we still don't have topic details, try the new approach with playlists
    if (!topicDetails) {
        const playlistTopicDetails = await extractTopicChannelFromPlaylists(channel);
        if (playlistTopicDetails) {
            return playlistTopicDetails;
        }
    }
    
    // If we still don't have topic details, try to access the Releases tab
    if (!topicDetails) {
        try {
            // Try to access the Releases tab
            const releasesTab = await channel.getTabByName('Releases');
            if (releasesTab) {
                console.log('Found Releases tab, checking for topic channel details');
                
                // Check if the tab itself has topic_channel_details
                if (releasesTab.topic_channel_details) {
                    topicDetails = releasesTab.topic_channel_details;
                }
                // Check in the shelves of the Releases tab
                else if (releasesTab.shelves && releasesTab.shelves.length) {
                    for (const shelf of releasesTab.shelves) {
                        // Look for shelves with albums or music
                        const shelfTitle = shelf.title?.text || '';
                        if (shelfTitle.toLowerCase().includes('album') || 
                            shelfTitle.toLowerCase().includes('music') ||
                            shelfTitle.toLowerCase().includes('single')) {
                            
                            // If we find a music-related shelf, check its endpoint
                            if (shelf.endpoint?.browse_endpoint?.browse_id) {
                                // This might be a topic channel ID
                                const potentialTopicId = shelf.endpoint.browse_endpoint.browse_id;
                                if (potentialTopicId.startsWith('UC') || 
                                    potentialTopicId.includes('music_channel')) {
                                    
                                    return {
                                        title: `${channel.metadata?.title || ''} - Topic`,
                                        subtitle: 'Music Artist',
                                        endpoint: potentialTopicId
                                    };
                                }
                            }
                            
                            // Also check the items in the shelf
                            if (shelf.items && shelf.items.length) {
                                for (const item of shelf.items) {
                                    // Albums often have navigation endpoints to the topic channel
                                    if (item.endpoint?.browse_endpoint?.browse_id) {
                                        const browseId = item.endpoint.browse_endpoint.browse_id;
                                        if (browseId.startsWith('UC') || 
                                            browseId.includes('music_channel')) {
                                            
                                            return {
                                                title: `${channel.metadata?.title || ''} - Topic`,
                                                subtitle: 'Music Artist',
                                                endpoint: browseId
                                            };
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        } catch (error) {
            console.log(`Error accessing Releases tab: ${error.message}`);
        }
    }
    
    // If we still don't have topic details, check for music shelves in the main channel
    if (!topicDetails && channel.shelves && channel.shelves.length) {
        for (const shelf of channel.shelves) {
            const shelfTitle = shelf.title?.text || '';
            if (shelfTitle.toLowerCase().includes('music videos')) {
                console.log('Found music videos shelf, checking for topic channel details');
                
                // This shelf might contain links to the topic channel
                if (shelf.endpoint?.browse_endpoint?.browse_id) {
                    const browseId = shelf.endpoint.browse_endpoint.browse_id;
                    if (browseId.startsWith('UC') || browseId.includes('music_channel')) {
                        return {
                            title: `${channel.metadata?.title || ''} - Topic`,
                            subtitle: 'Music Artist',
                            endpoint: browseId
                        };
                    }
                }
                
                // Check items in the shelf
                if (shelf.items && shelf.items.length) {
                    for (const item of shelf.items) {
                        if (item.endpoint?.browse_endpoint?.browse_id) {
                            const browseId = item.endpoint.browse_endpoint.browse_id;
                            if (browseId.startsWith('UC') || browseId.includes('music_channel')) {
                                return {
                                    title: `${channel.metadata?.title || ''} - Topic`,
                                    subtitle: 'Music Artist',
                                    endpoint: browseId
                                };
                            }
                        }
                    }
                }
            }
        }
    }
    
    // If we still don't have topic details but the channel has music_artist_name,
    // we can try to construct a topic channel ID based on the channel ID
    if (!topicDetails && channel.metadata?.music_artist_name) {
        // Many topic channels are derived from the original channel ID
        const channelId = channel.metadata.external_id;
        if (channelId && channelId.startsWith('UC')) {
            // Try a common pattern for topic channels
            return {
                title: `${channel.metadata.title} - Topic`,
                subtitle: 'Music Artist',
                endpoint: channelId,
                is_derived: true  // Flag to indicate this is a derived ID
            };
        }
    }
    
    if (!topicDetails) return null;
    
    // Extract the details from the found topic_channel_details
    return {
        title: topicDetails.title?.text || '',
        subtitle: topicDetails.subtitle?.text || '',
        avatar: topicDetails.avatar?.[0]?.url || '',
        endpoint: topicDetails.endpoint?.browse_endpoint?.browse_id || 
                 topicDetails.endpoint?.navigation_endpoint?.browse_id || ''
    };
}

// Add a new debug endpoint to help identify topic channels
app.get('/api/debug/channel/:channelId/topic', async (req, res) => {
    try {
        console.log('Debugging topic channel for:', req.params.channelId);
        const channel = await yt.getChannel(req.params.channelId);
        
        // Extract all possible locations where topic details might be
        const debug = {
            channel_id: req.params.channelId,
            channel_title: channel.metadata?.title || '',
            has_header_topic: !!channel.header?.topic_channel_details,
            has_metadata_topic: !!channel.metadata?.topic_channel_details,
            has_content_topic: !!channel.header?.content?.topic_channel_details,
            has_tabs: !!channel.tabs,
            tabs_count: channel.tabs?.length || 0,
            has_sections: !!channel.sections,
            sections_count: channel.sections?.length || 0,
            topic_details: extractTopicChannelDetails(channel),
            // Include raw data for inspection
            header_keys: Object.keys(channel.header || {}),
            metadata_keys: Object.keys(channel.metadata || {})
        };
        
        // If we found topic details, try to fetch that channel too
        if (debug.topic_details?.endpoint) {
            try {
                const topicChannel = await yt.getChannel(debug.topic_details.endpoint);
                debug.topic_channel = {
                    id: topicChannel.metadata?.external_id || '',
                    title: topicChannel.metadata?.title || '',
                    is_artist: topicChannel.metadata?.is_artist || false,
                    is_verified: topicChannel.metadata?.is_verified || false
                };
            } catch (error) {
                debug.topic_channel_error = error.message;
            }
        }
        
        res.json(debug);
    } catch (error) {
        console.error('Topic debug error:', error);
        res.status(500).json({ error: error.message });
    }
});

// Update the debug endpoint to explore all channel tabs
app.get('/api/debug/channel/:channelId/tabs', async (req, res) => {
    try {
        console.log('Exploring tabs for channel:', req.params.channelId);
        const channel = await yt.getChannel(req.params.channelId);
        
        // Get basic channel info
        const channelInfo = {
            id: channel.metadata?.external_id || '',
            title: channel.metadata?.title || '',
            is_music_artist: !!channel.metadata?.music_artist_name,
            music_artist_name: channel.metadata?.music_artist_name || null
        };
        
        // Get available tab names from the channel object
        const availableTabs = [];
        
        // Check if the channel has the tabs getter
        if (typeof channel.tabs === 'function' || Array.isArray(channel.tabs)) {
            const tabNames = Array.isArray(channel.tabs) ? 
                channel.tabs : 
                (typeof channel.tabs === 'function' ? channel.tabs() : []);
            
            console.log('Available tabs from getter:', tabNames);
            availableTabs.push(...tabNames);
        }
        
        // Check for tab availability using the has_* properties
        const tabAvailability = {
            has_videos: channel.has_videos || false,
            has_shorts: channel.has_shorts || false,
            has_releases: channel.has_releases || false,
            has_podcasts: channel.has_podcasts || false,
            has_playlists: channel.has_playlists || false,
            has_search: channel.has_search || false
        };
        
        // Explore all possible tabs
        const tabsInfo = [];
        const possibleTabs = [
            'Home', 'Videos', 'Shorts', 'Live', 'Releases', 
            'Podcasts', 'Playlists', 'Community', 'Store', 
            'Channels', 'About', 'Music'
        ];
        
        // Add any tabs we found from the tabs getter
        possibleTabs.push(...availableTabs.filter(tab => !possibleTabs.includes(tab)));
        
        // Explore each possible tab
        for (const tabName of possibleTabs) {
            try {
                console.log(`Trying to access tab: ${tabName}`);
                const tab = await channel.getTabByName(tabName);
                
                if (tab) {
                    console.log(`Successfully accessed tab: ${tabName}`);
                    
                    const tabInfo = {
                        name: tabName,
                        found: true,
                        has_content: !!tab.page_contents,
                        content_type: tab.page_contents ? tab.page_contents.type : null,
                        has_shelves: Array.isArray(tab.shelves) && tab.shelves.length > 0,
                        shelves_count: Array.isArray(tab.shelves) ? tab.shelves.length : 0,
                        has_videos: Array.isArray(tab.videos) && tab.videos.length > 0,
                        videos_count: Array.isArray(tab.videos) ? tab.videos.length : 0,
                        has_playlists: Array.isArray(tab.playlists) && tab.playlists.length > 0,
                        playlists_count: Array.isArray(tab.playlists) ? tab.playlists.length : 0
                    };
                    
                    // If this is the Releases tab, explore it in more detail
                    if (tabName === 'Releases' && tab.shelves && tab.shelves.length) {
                        tabInfo.shelves = tab.shelves.map(shelf => ({
                            title: shelf.title?.text || '',
                            type: shelf.type || '',
                            items_count: shelf.items?.length || 0,
                            has_endpoint: !!shelf.endpoint,
                            endpoint: shelf.endpoint?.browse_endpoint?.browse_id || '',
                            items_sample: (shelf.items || []).slice(0, 2).map(item => ({
                                title: item.title?.text || '',
                                type: item.type || '',
                                has_endpoint: !!item.endpoint,
                                endpoint: item.endpoint?.browse_endpoint?.browse_id || ''
                            }))
                        }));
                    }
                    
                    tabsInfo.push(tabInfo);
                }
            } catch (error) {
                console.log(`Error accessing tab ${tabName}: ${error.message}`);
                // Still add the tab to the list, but mark it as not found
                tabsInfo.push({
                    name: tabName,
                    found: false,
                    error: error.message
                });
            }
        }
        
        // Check for music-related content in shelves on the main page
        const musicShelves = [];
        if (channel.shelves && channel.shelves.length) {
            for (const shelf of channel.shelves) {
                const shelfTitle = shelf.title?.text || '';
                if (shelfTitle.toLowerCase().includes('music') || 
                    shelfTitle.toLowerCase().includes('album') || 
                    shelfTitle.toLowerCase().includes('song')) {
                    
                    musicShelves.push({
                        title: shelfTitle,
                        type: shelf.type,
                        items_count: shelf.items?.length || 0,
                        endpoint: shelf.endpoint?.browse_endpoint?.browse_id || '',
                        items_sample: (shelf.items || []).slice(0, 2).map(item => ({
                            title: item.title?.text || '',
                            type: item.type || '',
                            has_endpoint: !!item.endpoint,
                            endpoint: item.endpoint?.browse_endpoint?.browse_id || ''
                        }))
                    });
                }
            }
        }
        
        // Construct the response
        const response = {
            channel: channelInfo,
            tab_availability: tabAvailability,
            available_tabs: availableTabs,
            tabs_explored: tabsInfo.length,
            tabs: tabsInfo,
            music_shelves: musicShelves
        };
        
        res.json(response);
    } catch (error) {
        console.error('Tab exploration error:', error);
        res.status(500).json({ error: error.message });
    }
});

// Add this function to extract topic channel ID from playlists
async function extractTopicChannelFromPlaylists(channel) {
    try {
        console.log('Attempting to extract topic channel from playlists...');
        
        // Try to access the Releases tab
        const releasesTab = await channel.getTabByName('Releases');
        if (releasesTab && releasesTab.playlists && releasesTab.playlists.length > 0) {
            console.log(`Found ${releasesTab.playlists.length} playlists in Releases tab`);
            
            // Examine each playlist for topic channel references
            for (const playlist of releasesTab.playlists) {
                console.log(`Examining playlist: ${playlist.title?.text || 'Untitled'}`);
                
                // Check if the playlist has an endpoint that might be a topic channel
                if (playlist.endpoint?.browse_endpoint?.browse_id) {
                    const browseId = playlist.endpoint.browse_endpoint.browse_id;
                    
                    // If this looks like a topic channel ID, return it
                    if (browseId.startsWith('UC') || browseId.includes('music_channel')) {
                        return {
                            title: `${channel.metadata?.title || ''} - Topic`,
                            subtitle: 'Music Artist',
                            endpoint: browseId,
                            source: 'releases_playlist'
                        };
                    }
                }
                
                // Check if the playlist has a channel_id property
                if (playlist.channel_id || playlist.author?.id || playlist.author?.channel_id) {
                    const channelId = playlist.channel_id || playlist.author?.id || playlist.author?.channel_id;
                    
                    // If this looks like a topic channel ID, return it
                    if (channelId.startsWith('UC') || channelId.includes('music_channel')) {
                        return {
                            title: `${channel.metadata?.title || ''} - Topic`,
                            subtitle: 'Music Artist',
                            endpoint: channelId,
                            source: 'releases_playlist_channel'
                        };
                    }
                }
                
                // If the playlist has a thumbnail, try to fetch the first video
                if (playlist.first_video_id) {
                    try {
                        console.log(`Fetching video info for ${playlist.first_video_id}`);
                        const videoInfo = await yt.getInfo(playlist.first_video_id);
                        
                        // Check if the video has a music topic channel
                        if (videoInfo.basic_info?.channel_id && 
                            videoInfo.basic_info?.channel_id !== channel.metadata.external_id) {
                            
                            const videoChannelId = videoInfo.basic_info.channel_id;
                            if (videoChannelId.startsWith('UC') || videoChannelId.includes('music_channel')) {
                                return {
                                    title: videoInfo.basic_info?.author || `${channel.metadata?.title || ''} - Topic`,
                                    subtitle: 'Music Artist',
                                    endpoint: videoChannelId,
                                    source: 'video_in_playlist'
                                };
                            }
                        }
                    } catch (error) {
                        console.log(`Error fetching video info: ${error.message}`);
                    }
                }
            }
        }
        
        return null;
    } catch (error) {
        console.log(`Error in extractTopicChannelFromPlaylists: ${error.message}`);
        return null;
    }
}

// Update the releases debug endpoint to handle pagination more reliably
app.get('/api/debug/channel/:channelId/releases', async (req, res) => {
    try {
        console.log('Exploring Releases tab for channel:', req.params.channelId);
        const channel = await yt.getChannel(req.params.channelId);
        
        // Get pagination parameters
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 30;
        const fetchAll = req.query.all === 'true';
        
        // Basic channel info
        const channelInfo = {
            id: channel.metadata?.external_id || '',
            title: channel.metadata?.title || ''
        };
        
        // Try to access the Releases tab
        let releasesInfo = null;
        try {
            // Always start with page 1
            let releasesTab = await channel.getTabByName('Releases');
            if (releasesTab) {
                console.log('Found Releases tab');
                
                // Collect all playlists
                const allPlaylists = [];
                
                // Add first page playlists
                if (releasesTab.playlists && releasesTab.playlists.length) {
                    allPlaylists.push(...releasesTab.playlists);
                    console.log(`Added ${releasesTab.playlists.length} playlists from first page`);
                }
                
                // If we need more pages (either for fetchAll or to reach the requested page)
                let currentPage = 1;
                let continuationTab = releasesTab;
                
                while (continuationTab.has_continuation && 
                      (fetchAll || currentPage < page)) {
                    try {
                        currentPage++;
                        console.log(`Fetching continuation for page ${currentPage}...`);
                        
                        continuationTab = await continuationTab.getContinuation();
                        
                        if (continuationTab.playlists && continuationTab.playlists.length) {
                            allPlaylists.push(...continuationTab.playlists);
                            console.log(`Added ${continuationTab.playlists.length} more playlists, total: ${allPlaylists.length}`);
                        } else {
                            console.log('No more playlists found in continuation');
                            break;
                        }
                    } catch (error) {
                        console.error(`Error fetching continuation for page ${currentPage}: ${error.message}`);
                        break;
                    }
                }
                
                // Extract basic tab info
                releasesInfo = {
                    found: true,
                    has_content: !!releasesTab.page_contents,
                    content_type: releasesTab.page_contents?.type || null,
                    has_shelves: Array.isArray(releasesTab.shelves) && releasesTab.shelves.length > 0,
                    shelves_count: Array.isArray(releasesTab.shelves) ? releasesTab.shelves.length : 0,
                    has_playlists: allPlaylists.length > 0,
                    playlists_count: allPlaylists.length,
                    has_continuation: continuationTab.has_continuation,
                    total_pages_fetched: currentPage
                };
                
                // Calculate which playlists to include in the response
                let playlistsToProcess = [];
                
                if (fetchAll) {
                    // Include all playlists
                    playlistsToProcess = allPlaylists;
                } else {
                    // Calculate the start and end indices for the requested page
                    const startIndex = (page - 1) * limit;
                    const endIndex = startIndex + limit;
                    
                    // Check if we have enough playlists
                    if (startIndex >= allPlaylists.length) {
                        // Requested page is beyond available data
                        playlistsToProcess = [];
                    } else {
                        // Get the playlists for the requested page
                        playlistsToProcess = allPlaylists.slice(startIndex, endIndex);
                    }
                }
                
                // Update the count to reflect the total number of playlists found
                releasesInfo.total_playlists_found = allPlaylists.length;
                releasesInfo.playlists_in_response = playlistsToProcess.length;
                
                // Process the selected playlists
                releasesInfo.playlists = [];
                
                for (const playlist of playlistsToProcess) {
                    const playlistInfo = {
                        title: playlist.title?.text || 'Untitled',
                        type: playlist.type || '',
                        playlist_id: playlist.id || playlist.playlist_id || '',
                        video_count: playlist.video_count || 0,
                        thumbnail_url: playlist.thumbnail?.[0]?.url || '',
                        has_endpoint: !!playlist.endpoint,
                        endpoint: playlist.endpoint?.browse_endpoint?.browse_id || '',
                        channel_id: playlist.channel_id || playlist.author?.id || playlist.author?.channel_id || '',
                        channel_name: playlist.author?.name || channelInfo.title,
                        first_video_id: playlist.first_video_id || ''
                    };
                    
                    // If this playlist has a first video, try to get more info about it
                    if (playlist.first_video_id && (fetchAll || page === 1)) {
                        // Only fetch video info for the first page or when fetching all
                        // to avoid too many API calls
                        try {
                            const videoInfo = await yt.getInfo(playlist.first_video_id);
                            playlistInfo.video_info = {
                                title: videoInfo.basic_info?.title || '',
                                channel_id: videoInfo.basic_info?.channel_id || '',
                                channel_name: videoInfo.basic_info?.author || '',
                                is_different_channel: videoInfo.basic_info?.channel_id !== channel.metadata.external_id
                            };
                            
                            // If this video has a different channel ID, it might be the topic channel
                            if (playlistInfo.video_info.is_different_channel) {
                                console.log(`Found potential topic channel: ${playlistInfo.video_info.channel_id}`);
                            }
                        } catch (error) {
                            playlistInfo.video_info_error = error.message;
                        }
                    }
                    
                    releasesInfo.playlists.push(playlistInfo);
                }
                
                // Extract detailed shelf info
                if (releasesTab.shelves && releasesTab.shelves.length) {
                    releasesInfo.shelves = [];
                    
                    for (const shelf of releasesTab.shelves) {
                        const shelfInfo = {
                            title: shelf.title?.text || '',
                            type: shelf.type || '',
                            items_count: shelf.items?.length || 0,
                            has_endpoint: !!shelf.endpoint,
                            endpoint: shelf.endpoint?.browse_endpoint?.browse_id || ''
                        };
                        
                        // Extract items from the shelf
                        if (shelf.items && shelf.items.length) {
                            shelfInfo.items = shelf.items.map(item => ({
                                title: item.title?.text || '',
                                type: item.type || '',
                                has_endpoint: !!item.endpoint,
                                endpoint: item.endpoint?.browse_endpoint?.browse_id || '',
                                channel_id: item.channel_id || item.author?.id || item.author?.channel_id || '',
                                channel_name: item.author?.name || ''
                            }));
                        }
                        
                        releasesInfo.shelves.push(shelfInfo);
                    }
                }
            }
        } catch (error) {
            console.log(`Error accessing Releases tab: ${error.message}`);
            releasesInfo = {
                found: false,
                error: error.message
            };
        }
        
        // Construct the response
        const response = {
            channel: channelInfo,
            releases: releasesInfo,
            pagination: {
                current_page: page,
                items_per_page: limit,
                fetch_all: fetchAll,
                total_items: releasesInfo?.total_playlists_found || 0,
                total_pages: Math.ceil((releasesInfo?.total_playlists_found || 0) / limit)
            }
        };
        
        res.json(response);
    } catch (error) {
        console.error('Releases tab exploration error:', error);
        res.status(500).json({ error: error.message });
    }
});

// Update the channel releases endpoint to extract release dates from primary_info
app.get('/api/channel/:channelId/releases/videos', async (req, res) => {
    try {
        console.log('Fetching releases with videos for channel:', req.params.channelId);
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 30;
        
        const channel = await yt.getChannel(req.params.channelId);
        
        // Basic channel info
        const channelInfo = {
            id: channel.metadata?.external_id || '',
            title: channel.metadata?.title || ''
        };
        
        // Try to access the Releases tab
        let releasesWithVideos = [];
        let hasMore = false;
        
        try {
            // Get all playlists from releases tab
            let releasesTab = await channel.getTabByName('Releases');
            if (!releasesTab) {
                return res.json({
                    channel: channelInfo,
                    releases: [],
                    pagination: {
                        has_more: false,
                        current_page: page,
                        items_per_page: limit,
                        total_items: 0
                    }
                });
            }
            
            console.log('Found Releases tab');
            
            // Collect all playlists for the current page
            const allPlaylists = [];
            
            // Add first page playlists
            if (releasesTab.playlists && releasesTab.playlists.length) {
                allPlaylists.push(...releasesTab.playlists);
                console.log(`Added ${releasesTab.playlists.length} playlists from first page`);
            }
            
            // Fetch continuations until we reach the requested page
            let currentPage = 1;
            let continuationTab = releasesTab;
            
            while (currentPage < page && continuationTab.has_continuation) {
                try {
                    currentPage++;
                    console.log(`Fetching continuation for page ${currentPage}...`);
                    
                    continuationTab = await continuationTab.getContinuation();
                    
                    if (continuationTab.playlists && continuationTab.playlists.length) {
                        if (currentPage === page) {
                            // This is the page we want
                            allPlaylists.length = 0; // Clear previous pages
                            allPlaylists.push(...continuationTab.playlists);
                            console.log(`Added ${continuationTab.playlists.length} playlists from page ${currentPage}`);
                        }
                    } else {
                        console.log('No more playlists found in continuation');
                        break;
                    }
                } catch (error) {
                    console.error(`Error fetching continuation for page ${currentPage}: ${error.message}`);
                    break;
                }
            }
            
            // Check if there are more pages
            hasMore = continuationTab.has_continuation;
            
            // Take only the requested number of playlists
            const playlistsForPage = allPlaylists.slice(0, limit);
            console.log(`Processing ${playlistsForPage.length} playlists for page ${page}`);
            
            // Process each playlist to get its videos
            for (const playlist of playlistsForPage) {
                try {
                    const playlistId = playlist.id || playlist.playlist_id || '';
                    if (!playlistId) {
                        console.log('Skipping playlist with no ID');
                        continue;
                    }
                    
                    console.log(`Fetching videos for playlist: ${playlistId} (${playlist.title?.text || 'Untitled'})`);
                    
                    // Get playlist details
                    const playlistDetails = await yt.getPlaylist(playlistId);
                    
                    // Extract release date from playlist details
                    let releaseDate = null;
                    
                    // First check if the playlist itself has a published date in primary_info
                    if (playlistDetails.primary_info?.published?.text) {
                        const publishedText = playlistDetails.primary_info.published.text;
                        console.log(`Found published date in primary_info: ${publishedText}`);
                        
                        // Convert date formats like "Oct 15, 2020" to YYYY-MM-DD
                        try {
                            const date = new Date(publishedText);
                            if (!isNaN(date.getTime())) {
                                releaseDate = date.toISOString().split('T')[0]; // Get YYYY-MM-DD part
                                console.log(`Converted to ISO date: ${releaseDate}`);
                            }
                        } catch (dateError) {
                            console.error(`Error parsing date from primary_info: ${dateError.message}`);
                        }
                    }
                    
                    // If no release date found in primary_info, try other methods
                    if (!releaseDate) {
                        // ... existing fallback methods ...
                    }
                    
                    const releaseInfo = {
                        playlist_id: playlistId,
                        title: playlist.title?.text || 'Untitled',
                        type: playlist.type || 'Album',
                        thumbnail_url: playlist.thumbnail?.[0]?.url || '',
                        channel_id: playlist.channel_id || playlist.author?.id || playlist.author?.channel_id || channelInfo.id,
                        channel_name: playlist.author?.name || channelInfo.title,
                        videos_count: playlistDetails.videos?.length || 0,
                        release_date: releaseDate,
                        raw_metadata: playlistDetails.metadata || {},  // Include raw metadata for debugging
                        videos: []
                    };
                    
                    // Process videos in the playlist
                    if (playlistDetails.videos && playlistDetails.videos.length) {
                        for (const video of playlistDetails.videos) {
                            try {
                                const videoData = {
                                    video_id: video.id,
                                    title: video.title?.text || '',
                                    thumbnail_url: video.thumbnail?.[0]?.url || getCleanThumbnailUrl(video.id),
                                    duration: video.duration?.text || '',
                                    channel_id: video.author?.id || releaseInfo.channel_id,
                                    channel_name: video.author?.name || releaseInfo.channel_name,
                                    playlist_id: playlistId,
                                    album_title: releaseInfo.title,
                                    album_type: releaseInfo.type
                                };
                                
                                releaseInfo.videos.push(videoData);
                            } catch (error) {
                                console.error(`Error processing video in playlist: ${error.message}`);
                            }
                        }
                    }
                    
                    releasesWithVideos.push(releaseInfo);
                } catch (error) {
                    console.error(`Error processing playlist: ${error.message}`);
                }
            }
            
        } catch (error) {
            console.error(`Error accessing Releases tab: ${error.message}`);
        }
        
        // Construct the response
        const response = {
            channel: channelInfo,
            releases: releasesWithVideos,
            pagination: {
                has_more: hasMore,
                current_page: page,
                items_per_page: limit,
                total_items: releasesWithVideos.length
            }
        };
        
        res.json(response);
    } catch (error) {
        console.error('Error fetching releases with videos:', error);
        res.status(500).json({ error: error.message });
    }
});

// Enhance the debug endpoint for playlists to extract more date information
app.get('/api/debug/playlist/:playlistId', async (req, res) => {
    try {
        const playlistId = req.params.playlistId;
        console.log(`Debug request for playlist: ${playlistId}`);
        
        // Get full playlist details
        const playlistDetails = await yt.getPlaylist(playlistId);
        
        // Create a response object with all available data
        const response = {
            playlist_id: playlistId,
            basic_info: {
                title: playlistDetails.title || '',
                description: playlistDetails.description?.text || '',
                channel_id: playlistDetails.channel_id || playlistDetails.author?.id || '',
                channel_name: playlistDetails.author?.name || '',
                video_count: playlistDetails.videos?.length || 0
            },
            metadata: playlistDetails.metadata || {},
            header: playlistDetails.header || {},
            info: playlistDetails.info || {},
            date_candidates: [],
            primary_info_published: null
        };
        
        // Extract all potential date fields
        const dateCandidates = [];
        
        // Function to recursively search for date fields
        function findDateFields(obj, path = '') {
            if (!obj || typeof obj !== 'object') return;
            
            for (const [key, value] of Object.entries(obj)) {
                const currentPath = path ? `${path}.${key}` : key;
                
                // Check if the key or value might contain date information
                if (
                    (typeof value === 'string' && (
                        key.includes('date') || 
                        key.includes('time') || 
                        key.includes('publish') || 
                        key.includes('created') || 
                        key.includes('updated') ||
                        /\d{4}-\d{2}-\d{2}/.test(value) ||
                        /\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2},?\s+\d{4}\b/i.test(value)
                    )) ||
                    key.includes('date') || 
                    key.includes('time') || 
                    key.includes('publish') || 
                    key.includes('created') || 
                    key.includes('updated')
                ) {
                    dateCandidates.push({
                        path: currentPath,
                        key: key,
                        value: value,
                        type: typeof value
                    });
                }
                
                // Recursively search nested objects
                if (typeof value === 'object' && value !== null) {
                    findDateFields(value, currentPath);
                }
            }
        }
        
        // Search for date fields in the entire response
        findDateFields(playlistDetails);
        response.date_candidates = dateCandidates;
        
        // Get detailed video information including publish dates
        if (playlistDetails.videos && playlistDetails.videos.length > 0) {
            response.video_details = [];
            
            // Check first 5 videos (increased from 3)
            const videosToCheck = playlistDetails.videos.slice(0, 5);
            
            for (const video of videosToCheck) {
                try {
                    console.log(`Fetching detailed info for video: ${video.id}`);
                    const videoInfo = await yt.getInfo(video.id);
                    
                    const videoDetail = {
                        video_id: video.id,
                        title: video.title?.text || '',
                        publish_date: null,
                        date_fields: [],
                        full_info: {
                            basic_info: videoInfo.basic_info || {},
                            primary_info: videoInfo.primary_info || {},
                            secondary_info: videoInfo.secondary_info || {},
                            microformat: videoInfo.microformat || {}
                        }
                    };
                    
                    // Extract publish date from various locations
                    if (videoInfo.basic_info?.publish_date) {
                        videoDetail.publish_date = videoInfo.basic_info.publish_date;
                        videoDetail.date_fields.push({
                            path: 'basic_info.publish_date',
                            value: videoInfo.basic_info.publish_date
                        });
                    }
                    
                    // Check primary info for dates
                    if (videoInfo.primary_info?.date_text?.simpleText) {
                        videoDetail.date_fields.push({
                            path: 'primary_info.date_text.simpleText',
                            value: videoInfo.primary_info.date_text.simpleText
                        });
                    }
                    
                    // Check microformat for dates
                    if (videoInfo.microformat?.playerMicroformatRenderer?.publishDate) {
                        videoDetail.date_fields.push({
                            path: 'microformat.playerMicroformatRenderer.publishDate',
                            value: videoInfo.microformat.playerMicroformatRenderer.publishDate
                        });
                    }
                    
                    if (videoInfo.microformat?.playerMicroformatRenderer?.uploadDate) {
                        videoDetail.date_fields.push({
                            path: 'microformat.playerMicroformatRenderer.uploadDate',
                            value: videoInfo.microformat.playerMicroformatRenderer.uploadDate
                        });
                    }
                    
                    // Find all date fields in video info
                    const videoDateFields = [];
                    findDateFields(videoInfo, '', videoDateFields);
                    
                    videoDetail.date_fields = videoDetail.date_fields.concat(
                        videoDateFields.filter(item => 
                            !videoDetail.date_fields.some(existing => existing.path === item.path)
                        )
                    );
                    
                    response.video_details.push(videoDetail);
                    
                } catch (error) {
                    console.error(`Error getting video info for ${video.id}:`, error.message);
                    response.video_details.push({
                        video_id: video.id,
                        title: video.title?.text || '',
                        error: error.message
                    });
                }
            }
            
            // Try to determine the earliest publish date as the likely release date
            const publishDates = response.video_details
                .filter(v => v.publish_date)
                .map(v => v.publish_date);
                
            if (publishDates.length > 0) {
                // Sort dates to find the earliest one
                publishDates.sort();
                response.earliest_video_publish_date = publishDates[0];
                console.log('Earliest video publish date:', response.earliest_video_publish_date);
            }
        }
        
        // Extract text dates from description
        if (response.basic_info.description) {
            const description = response.basic_info.description;
            response.description_date_matches = [];
            
            // Check for date patterns in description
            const datePatterns = [
                { pattern: /Released on:?\s*(\d{4}-\d{2}-\d{2})/i, type: 'Released on YYYY-MM-DD' },
                { pattern: /Release date:?\s*(\d{4}-\d{2}-\d{2})/i, type: 'Release date YYYY-MM-DD' },
                { pattern: /Released:?\s*(\d{4}-\d{2}-\d{2})/i, type: 'Released YYYY-MM-DD' },
                { pattern: /Published:?\s*(\d{4}-\d{2}-\d{2})/i, type: 'Published YYYY-MM-DD' },
                { pattern: /Date:?\s*(\d{4}-\d{2}-\d{2})/i, type: 'Date YYYY-MM-DD' },
                { pattern: /(\d{1,2})[\/\-\.](\d{1,2})[\/\-\.](\d{4})/, type: 'MM/DD/YYYY or DD/MM/YYYY' },
                { pattern: /(\d{4})[\/\-\.](\d{1,2})[\/\-\.](\d{1,2})/, type: 'YYYY/MM/DD' },
                { pattern: /\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{1,2}),?\s+(\d{4})\b/i, type: 'Month DD, YYYY' }
            ];
            
            for (const { pattern, type } of datePatterns) {
                const matches = description.match(pattern);
                if (matches) {
                    response.description_date_matches.push({
                        type: type,
                        match: matches[0],
                        groups: matches.slice(1)
                    });
                }
            }
        }
        
        // Check for year in title
        if (response.basic_info.title) {
            const yearMatch = response.basic_info.title.match(/\b(19\d{2}|20\d{2})\b/);
            if (yearMatch) {
                response.year_in_title = yearMatch[1];
            }
        }
        
        // Try to access the playlist's microformat data which often contains dates
        if (playlistDetails.microformat) {
            response.microformat = playlistDetails.microformat;
        }
        
        // Try to access the playlist's page header which might contain dates
        if (playlistDetails.page_header) {
            response.page_header = playlistDetails.page_header;
        }
        
        // Try to access the playlist's sidebar info which might contain dates
        if (playlistDetails.sidebar_info) {
            response.sidebar_info = playlistDetails.sidebar_info;
        }
        
        // Add raw data for complete inspection if requested
        if (req.query.raw === 'true') {
            response.raw_data = playlistDetails;
        }
        
        // Specifically check for primary_info.published
        if (playlistDetails.primary_info?.published?.text) {
            const publishedText = playlistDetails.primary_info.published.text;
            response.primary_info_published = {
                raw_text: publishedText,
                parsed_date: null
            };
            
            // Try to parse the date
            try {
                const date = new Date(publishedText);
                if (!isNaN(date.getTime())) {
                    response.primary_info_published.parsed_date = date.toISOString().split('T')[0];
                }
            } catch (dateError) {
                console.error(`Error parsing date from primary_info: ${dateError.message}`);
            }
        }
        
        // Update the release date summary to include primary_info
        response.release_date_summary = {
            from_primary_info: response.primary_info_published?.parsed_date || null,
            from_metadata: response.date_candidates.length > 0 ? 
                response.date_candidates[0].value : null,
            from_earliest_video: response.earliest_video_publish_date || null,
            from_description: response.description_date_matches?.length > 0 ? 
                response.description_date_matches[0].match : null,
            from_title_year: response.year_in_title ? 
                `${response.year_in_title}-01-01` : null
        };
        
        res.json(response);
    } catch (error) {
        console.error('Error in playlist debug endpoint:', error);
        res.status(500).json({ 
            error: error.message,
            stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
        });
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
