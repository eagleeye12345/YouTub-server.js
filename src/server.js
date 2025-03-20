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

// Helper function to parse YouTube relative time
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

        // Try parsing as a regular date
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

// Modify the channel videos endpoint to include topic info
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

        // Process current page videos in parallel
        if (currentBatch?.videos) {
            const videos = currentBatch.videos.slice(0, limit);
            const processedVideos = [];
            let videoCount = 0;

            for (const video of videos) {
                try {
                    videoCount++;
                    console.log(`Processing video ${videoCount}/${videos.length}: ${video.id}`);

                    // Extract basic info without additional API calls when possible
                    const videoData = {
                        video_id: video.id || video.videoId,
                        title: video.title?.text || '',
                        description: video.description_snippet?.text || '',
                        thumbnail_url: video.thumbnail?.[0]?.url || 
                                     `https://i.ytimg.com/vi/${video.id}/hqdefault.jpg`,
                        published_at: video.published?.text ? 
                                     parseYouTubeDate(video.published.text) : null,
                        views: video.view_count?.text?.replace(/[^0-9]/g, '') || '0',
                        channel_id: channel.metadata?.external_id || '',
                        channel_title: channel.metadata?.title || '',
                        duration: video.duration?.text || '',
                        is_short: type === 'shorts'
                    };

                    // Only fetch additional info if basic data is missing
                    if (!videoData.title || !videoData.published_at) {
                        const additionalInfo = type === 'shorts' ?
                            await yt.getShortsVideoInfo(video.id) :
                            await yt.getInfo(video.id);
                        
                        videoData.title = videoData.title || additionalInfo.basic_info?.title;
                        videoData.description = videoData.description || additionalInfo.basic_info?.description;
                        videoData.published_at = videoData.published_at || 
                            parseYouTubeDate(additionalInfo.basic_info?.publish_date);
                    }

                    processedVideos.push(videoData);
                } catch (error) {
                    console.error(`Error processing video: ${error.message}`);
                    continue;
                }
            }

            console.log(`Successfully processed ${processedVideos.length} videos`);
            return res.json({
                videos: processedVideos,
                topic_details: topicDetails,
                pagination: {
                    has_more: currentBatch.has_continuation,
                    current_page: page,
                    items_per_page: limit,
                    total_items: processedVideos.length
                }
            });
        }

        res.json({
            videos: [],
            topic_details: topicDetails,
            pagination: { has_more: false }
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

// Update the shorts processing logic in the /api/shorts/:videoId endpoint
app.get('/api/shorts/:videoId', async (req, res) => {
    try {
        console.log(`Fetching shorts info for: ${req.params.videoId}`);
        
        // Get both shorts-specific and regular info
        let shortInfo = await yt.getShortsVideoInfo(req.params.videoId).catch(() => null);
        let regularInfo = await yt.getInfo(req.params.videoId).catch(() => null);
        
        // Combine the info objects
        const combinedInfo = {
            ...shortInfo,
            regularInfo: regularInfo,
            basic_info: shortInfo?.basic_info || regularInfo?.basic_info || {},
            primary_info: regularInfo?.primary_info || shortInfo?.primary_info
        };

        // Extract simplified info
        const simplifiedInfo = {
            video_id: req.params.videoId,
            title: combinedInfo.basic_info?.title || '',
            description: combinedInfo.basic_info?.description || '',
            // Always use the clean thumbnail URL format
            thumbnail_url: getCleanThumbnailUrl(req.params.videoId),
            views: extractViews(combinedInfo) || '0',
            published_at: extractPublishedDate(combinedInfo),
            channel_id: combinedInfo.basic_info?.channel?.id,
            channel_title: combinedInfo.basic_info?.channel?.name,
            channel_thumbnail: combinedInfo.basic_info?.channel?.thumbnails?.[0]?.url,
            duration: combinedInfo.basic_info?.duration?.text || '',
            is_short: true,
            playability_status: combinedInfo.playability_status
        };

        console.log('Final simplified info:', JSON.stringify(simplifiedInfo, null, 2));
        res.json(simplifiedInfo);
    } catch (error) {
        console.error('Shorts error:', error);
        res.status(500).json({ error: error.message });
    }
});

// Update the channel shorts endpoint
app.get('/api/channel/:channelId/shorts', async (req, res) => {
    try {
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 30;
        
        console.log(`Fetching shorts for channel: ${req.params.channelId} (page ${page})`);
        
        // Get channel
        const channel = await yt.getChannel(req.params.channelId);

        if (!channel.has_shorts) {
            console.log('No shorts found for channel');
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

        // Get shorts tab
        const shortsTab = await channel.getShorts();
        console.log(`Found ${shortsTab?.videos?.length} shorts`);

        let currentBatch = shortsTab;
        let allShorts = [];

        // Collect all shorts up to the requested page
        for (let currentPage = 1; currentPage <= page; currentPage++) {
            if (currentBatch?.videos?.length) {
                allShorts = allShorts.concat(currentBatch.videos);
            }

            if (currentPage < page && currentBatch?.has_continuation) {
                currentBatch = await currentBatch.getContinuation();
            }
        }

        // Calculate the slice for the current page
        const startIndex = (page - 1) * limit;
        const endIndex = startIndex + limit;
        const shortsForCurrentPage = allShorts.slice(startIndex, endIndex);

        // Process shorts
        const processedShorts = [];
        let shortCount = 0;
        for (const short of shortsForCurrentPage) {
            try {
                const videoId = short.on_tap_endpoint?.payload?.videoId;
                if (!videoId) continue;

                shortCount++;
                console.log(`Processing short ${shortCount}/${shortsForCurrentPage.length}: ${videoId}`);

                // Try to get shorts info, but handle parsing errors gracefully
                let shortInfo = null;
                try {
                    shortInfo = await yt.getShortsVideoInfo(videoId);
                } catch (error) {
                    console.log(`Error getting shorts info for ${videoId}: ${error.message}`);
                    // Continue with shortInfo as null
                }

                // Try to get regular info as fallback, but handle parsing errors gracefully
                let regularInfo = null;
                try {
                    regularInfo = await yt.getInfo(videoId);
                } catch (error) {
                    console.log(`Error getting regular info for ${videoId}: ${error.message}`);
                    // Continue with regularInfo as null
                }

                // If both API calls failed, extract basic info from the short object
                if (!shortInfo && !regularInfo) {
                    console.log(`Using fallback data extraction for ${videoId}`);
                    
                    const shortData = {
                        video_id: videoId,
                        title: short.overlay_metadata?.primary_text?.text || 
                               short.accessibility_text?.split(',')[0]?.replace(/ - play Short$/, '') || '',
                        description: '',
                        thumbnail_url: getCleanThumbnailUrl(videoId),
                        published_at: null,
                        views: short.overlay_metadata?.secondary_text?.text?.replace(/[^0-9.KMB]/gi, '') || '0',
                        channel_id: channel.metadata?.external_id || '',
                        channel_title: channel.metadata?.title || '',
                        duration: '',
                        is_short: true
                    };
                    
                    processedShorts.push(shortData);
                    continue;
                }

                // Combine the info objects
                const combinedInfo = {
                    ...shortInfo,
                    regularInfo: regularInfo,
                    raw: shortInfo || regularInfo,
                    primary_info: regularInfo?.primary_info || shortInfo?.primary_info
                };

                // Get exact view count
                let viewCount = '';
                if (regularInfo?.primary_info?.view_count?.view_count?.text) {
                    // Use exact view count from view_count.text (e.g., "245,906 views")
                    viewCount = regularInfo.primary_info.view_count.view_count.text.replace(/[^0-9]/g, '');
                } else if (regularInfo?.primary_info?.view_count?.original_view_count) {
                    // Try original_view_count as backup
                    viewCount = regularInfo.primary_info.view_count.original_view_count;
                } else if (regularInfo?.basic_info?.view_count) {
                    // Fallback to basic_info view count
                    viewCount = regularInfo.basic_info.view_count.toString();
                } else if (short.overlay_metadata?.secondary_text?.text) {
                    // Fallback to overlay metadata
                    viewCount = short.overlay_metadata.secondary_text.text.replace(/[^0-9.KMB]/gi, '');
                } else if (short.accessibility_text) {
                    // Last resort: try to extract from accessibility text
                    const viewMatch = short.accessibility_text.match(/(\d+(?:\.\d+)?[KMB]?)\s+views/i);
                    viewCount = viewMatch ? viewMatch[1] : '0';
                }

                // Extract data directly from the combined info
                const shortData = {
                    video_id: videoId,
                    title: short.overlay_metadata?.primary_text?.text || 
                           combinedInfo.basic_info?.title ||
                           short.accessibility_text?.split(',')[0]?.replace(/ - play Short$/, '') || '',
                    description: combinedInfo.basic_info?.description || '',
                    // Always use the clean thumbnail URL format
                    thumbnail_url: getCleanThumbnailUrl(videoId),
                    published_at: regularInfo?.primary_info?.published?.text ? 
                                 new Date(regularInfo.primary_info.published.text).toISOString() : null,
                    views: viewCount,
                    channel_id: channel.metadata?.external_id || '',
                    channel_title: channel.metadata?.title || '',
                    duration: combinedInfo.basic_info?.duration?.text || '',
                    is_short: true
                };

                processedShorts.push(shortData);

            } catch (error) {
                console.error(`Error processing short: ${error.message}`);
                continue;
            }
        }

        console.log(`Successfully processed ${processedShorts.length} shorts`);
        res.json({
            shorts: processedShorts,
            pagination: {
                has_more: currentBatch?.has_continuation || false,
                current_page: page,
                items_per_page: limit,
                total_items: processedShorts.length
            }
        });

    } catch (error) {
        console.error('Channel shorts error:', error);
        res.status(500).json({ error: error.message });
    }
});

// Add a new debug endpoint for shorts
app.get('/api/debug/shorts/:videoId', async (req, res) => {
    try {
        const results = {
            shortsInfo: null,
            regularInfo: null,
            error: null
        };

        // Try getting shorts-specific info
        try {
            const shortsInfo = await yt.getShortsVideoInfo(req.params.videoId);
            results.shortsInfo = {
                basic_info: shortsInfo.basic_info,
                primary_info: shortsInfo.primary_info,
                secondary_info: shortsInfo.secondary_info,
                microformat: shortsInfo.microformat,
                video_details: shortsInfo.video_details,
                overlay_metadata: shortsInfo.overlay_metadata,
                published: shortsInfo.published,
                publishedTimeText: shortsInfo.publishedTimeText,
                dateText: shortsInfo.dateText,
                // Include raw data for inspection
                raw: shortsInfo
            };
        } catch (error) {
            results.error = `Shorts info error: ${error.message}`;
        }

        // Also try getting regular video info as fallback
        try {
            const videoInfo = await yt.getInfo(req.params.videoId);
            results.regularInfo = {
                basic_info: videoInfo.basic_info,
                primary_info: videoInfo.primary_info,
                secondary_info: videoInfo.secondary_info,
                microformat: videoInfo.microformat,
                video_details: videoInfo.video_details,
                // Include raw data for inspection
                raw: videoInfo
            };
        } catch (error) {
            if (!results.error) {
                results.error = `Regular info error: ${error.message}`;
            }
        }

        // Send the full response
        res.header('Content-Type', 'application/json');
        res.send(JSON.stringify(results, null, 2));

    } catch (error) {
        res.status(500).json({
            error: error.message,
            stack: error.stack
        });
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

// Update the debug endpoint to explore the Releases tab with pagination
app.get('/api/debug/channel/:channelId/releases', async (req, res) => {
    try {
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 30;
        
        console.log(`Exploring Releases tab for channel: ${req.params.channelId} (page ${page})`);
        const channel = await yt.getChannel(req.params.channelId);
        
        // Basic channel info
        const channelInfo = {
            id: channel.metadata?.external_id || '',
            title: channel.metadata?.title || ''
        };
        
        // Try to access the Releases tab
        let releasesInfo = null;
        try {
            let releasesTab = await channel.getTabByName('Releases');
            if (releasesTab) {
                console.log('Found Releases tab');
                
                // Skip to requested page if needed
                let currentPage = 1;
                while (currentPage < page && releasesTab?.has_continuation) {
                    console.log(`Loading page ${currentPage + 1}...`);
                    releasesTab = await releasesTab.getContinuation();
                    currentPage++;
                }
                
                // Extract basic tab info
                releasesInfo = {
                    found: true,
                    has_content: !!releasesTab.page_contents,
                    content_type: releasesTab.page_contents?.type || null,
                    has_shelves: Array.isArray(releasesTab.shelves) && releasesTab.shelves.length > 0,
                    shelves_count: Array.isArray(releasesTab.shelves) ? releasesTab.shelves.length : 0,
                    has_playlists: Array.isArray(releasesTab.playlists) && releasesTab.playlists.length > 0,
                    playlists_count: Array.isArray(releasesTab.playlists) ? releasesTab.playlists.length : 0,
                    has_continuation: releasesTab.has_continuation,
                    pagination: {
                        current_page: page,
                        items_per_page: limit,
                        has_more: releasesTab.has_continuation
                    }
                };
                
                // Extract detailed playlist info
                if (releasesTab.playlists && releasesTab.playlists.length) {
                    releasesInfo.playlists = [];
                    
                    // Apply limit to the number of playlists processed
                    const playlistsToProcess = releasesTab.playlists.slice(0, limit);
                    
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
                            channel_name: playlist.author?.name || '',
                            first_video_id: playlist.first_video_id || ''
                        };
                        
                        // If this playlist has a first video, try to get more info about it
                        if (playlist.first_video_id) {
                            try {
                                const videoInfo = await yt.getInfo(playlist.first_video_id);
                                playlistInfo.video_info = {
                                    title: videoInfo.basic_info?.title || '',
                                    channel_id: videoInfo.basic_info?.channel_id || '',
                                    channel_name: videoInfo.basic_info?.author || '',
                                    is_different_channel: videoInfo.basic_info?.channel_id !== channel.metadata.external_id
                                };
                            } catch (error) {
                                playlistInfo.video_info_error = error.message;
                            }
                        }
                        
                        releasesInfo.playlists.push(playlistInfo);
                    }
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
            releases: releasesInfo
        };
        
        res.json(response);
    } catch (error) {
        console.error('Releases tab exploration error:', error);
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
