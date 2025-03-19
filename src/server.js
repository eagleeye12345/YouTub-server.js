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

// Comprehensive implementation for topic channel detection
async function extractTopicChannelDetails(channel) {
    console.log(`Attempting to extract topic channel details for: ${channel.metadata?.title || 'unknown channel'}`);
    
    // Method 1: Direct topic_channel_details access
    let topicDetails = null;
    
    if (channel.header?.topic_channel_details) {
        console.log('Found topic_channel_details in header');
        topicDetails = channel.header.topic_channel_details;
    } 
    else if (channel.metadata?.topic_channel_details) {
        console.log('Found topic_channel_details in metadata');
        topicDetails = channel.metadata.topic_channel_details;
    }
    else if (channel.header?.content?.topic_channel_details) {
        console.log('Found topic_channel_details in header.content');
        topicDetails = channel.header.content.topic_channel_details;
    }
    
    // If we found explicit topic details, return them
    if (topicDetails) {
        return {
            title: topicDetails.title?.text || '',
            subtitle: topicDetails.subtitle?.text || '',
            avatar: topicDetails.avatar?.[0]?.url || '',
            endpoint: topicDetails.endpoint?.browse_endpoint?.browse_id || 
                     topicDetails.endpoint?.navigation_endpoint?.browse_id || '',
            source: 'explicit_topic_details'
        };
    }
    
    // Method 2: Check if this is a music artist
    if (channel.metadata?.music_artist_name) {
        console.log(`Channel is a music artist: ${channel.metadata.music_artist_name}`);
        
        // For music artists, try to find the topic channel through music-specific tabs
        
        // Method 2.1: Try the Releases tab
        try {
            console.log('Checking Releases tab...');
            let releasesTab;
            
            // Try different methods to access the Releases tab
            try {
                // Try direct method if available
                if (typeof channel.getReleases === 'function') {
                    releasesTab = await channel.getReleases();
                    console.log('Got Releases tab via getReleases()');
                } else {
                    // Fall back to getTabByName
                    releasesTab = await channel.getTabByName('Releases');
                    console.log('Got Releases tab via getTabByName()');
                }
            } catch (error) {
                // Try URL-based approach
                try {
                    const channelId = channel.metadata.external_id;
                    releasesTab = await channel.getTabByURL(`/channel/${channelId}/releases`);
                    console.log('Got Releases tab via getTabByURL()');
                } catch (innerError) {
                    console.log(`Could not access Releases tab: ${innerError.message}`);
                }
            }
            
            if (releasesTab) {
                // Look for album shelves in the releases tab
                if (releasesTab.shelves && releasesTab.shelves.length) {
                    console.log(`Found ${releasesTab.shelves.length} shelves in Releases tab`);
                    
                    for (const shelf of releasesTab.shelves) {
                        const shelfTitle = shelf.title?.text || '';
                        console.log(`Examining shelf: ${shelfTitle}`);
                        
                        // Look for album or music-related shelves
                        if (shelfTitle.toLowerCase().includes('album') || 
                            shelfTitle.toLowerCase().includes('single') ||
                            shelfTitle.toLowerCase().includes('music')) {
                            
                            console.log(`Found music-related shelf: ${shelfTitle}`);
                            
                            // Check if the shelf itself has a topic channel endpoint
                            if (shelf.endpoint?.browse_endpoint?.browse_id) {
                                const browseId = shelf.endpoint.browse_endpoint.browse_id;
                                if (browseId.startsWith('UC') || browseId.includes('music_channel')) {
                                    console.log(`Found topic channel ID in shelf endpoint: ${browseId}`);
                                    return {
                                        title: `${channel.metadata?.title || ''} - Topic`,
                                        subtitle: 'Music Artist',
                                        endpoint: browseId,
                                        source: 'releases_shelf_endpoint'
                                    };
                                }
                            }
                            
                            // Check items in the shelf for topic channel links
                            if (shelf.items && shelf.items.length) {
                                console.log(`Examining ${shelf.items.length} items in shelf`);
                                
                                for (const item of shelf.items) {
                                    // Check for album/playlist endpoints
                                    if (item.endpoint?.browse_endpoint?.browse_id) {
                                        const browseId = item.endpoint.browse_endpoint.browse_id;
                                        console.log(`Found browse ID: ${browseId}`);
                                        
                                        // If this looks like a topic channel ID
                                        if (browseId.startsWith('UC') || browseId.includes('music_channel')) {
                                            console.log(`Found potential topic channel ID: ${browseId}`);
                                            return {
                                                title: `${channel.metadata?.title || ''} - Topic`,
                                                subtitle: 'Music Artist',
                                                endpoint: browseId,
                                                source: 'releases_item_endpoint'
                                            };
                                        }
                                        
                                        // If this is an album/playlist, try to extract artist info from it
                                        if (browseId.startsWith('OLAK5uy_') || 
                                            browseId.startsWith('VL') || 
                                            browseId.startsWith('PL')) {
                                            
                                            console.log(`Found album/playlist ID: ${browseId}`);
                                            
                                            // For albums/playlists, check if they have artist info
                                            if (item.subtitle && item.subtitle.runs) {
                                                for (const run of item.subtitle.runs) {
                                                    if (run.navigation_endpoint?.browse_endpoint?.browse_id) {
                                                        const artistId = run.navigation_endpoint.browse_endpoint.browse_id;
                                                        if (artistId.startsWith('UC') && artistId !== channel.metadata.external_id) {
                                                            console.log(`Found potential topic channel ID in subtitle: ${artistId}`);
                                                            return {
                                                                title: `${channel.metadata?.title || ''} - Topic`,
                                                                subtitle: 'Music Artist',
                                                                endpoint: artistId,
                                                                source: 'album_subtitle_artist'
                                                            };
                                                        }
                                                    }
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        } catch (error) {
            console.log(`Error exploring Releases tab: ${error.message}`);
        }
        
        // Method 2.2: Try the Music tab
        try {
            console.log('Checking Music tab...');
            let musicTab;
            
            try {
                // Try direct method if available
                if (typeof channel.getMusic === 'function') {
                    musicTab = await channel.getMusic();
                    console.log('Got Music tab via getMusic()');
                } else {
                    // Fall back to getTabByName
                    musicTab = await channel.getTabByName('Music');
                    console.log('Got Music tab via getTabByName()');
                }
            } catch (error) {
                // Try URL-based approach
                try {
                    const channelId = channel.metadata.external_id;
                    musicTab = await channel.getTabByURL(`/channel/${channelId}/music`);
                    console.log('Got Music tab via getTabByURL()');
                } catch (innerError) {
                    console.log(`Could not access Music tab: ${innerError.message}`);
                }
            }
            
            if (musicTab) {
                // Process similar to Releases tab
                if (musicTab.shelves && musicTab.shelves.length) {
                    console.log(`Found ${musicTab.shelves.length} shelves in Music tab`);
                    
                    for (const shelf of musicTab.shelves) {
                        const shelfTitle = shelf.title?.text || '';
                        console.log(`Examining shelf: ${shelfTitle}`);
                        
                        // Check shelf endpoint
                        if (shelf.endpoint?.browse_endpoint?.browse_id) {
                            const browseId = shelf.endpoint.browse_endpoint.browse_id;
                            if (browseId.startsWith('UC') || browseId.includes('music_channel')) {
                                console.log(`Found topic channel ID in Music tab shelf: ${browseId}`);
                                return {
                                    title: `${channel.metadata?.title || ''} - Topic`,
                                    subtitle: 'Music Artist',
                                    endpoint: browseId,
                                    source: 'music_shelf_endpoint'
                                };
                            }
                        }
                        
                        // Check items in shelf
                        if (shelf.items && shelf.items.length) {
                            for (const item of shelf.items) {
                                if (item.endpoint?.browse_endpoint?.browse_id) {
                                    const browseId = item.endpoint.browse_endpoint.browse_id;
                                    if (browseId.startsWith('UC') || browseId.includes('music_channel')) {
                                        console.log(`Found topic channel ID in Music tab item: ${browseId}`);
                                        return {
                                            title: `${channel.metadata?.title || ''} - Topic`,
                                            subtitle: 'Music Artist',
                                            endpoint: browseId,
                                            source: 'music_item_endpoint'
                                        };
                                    }
                                }
                            }
                        }
                    }
                }
            }
        } catch (error) {
            console.log(`Error exploring Music tab: ${error.message}`);
        }
        
        // Method 2.3: Check main page shelves for music videos
        try {
            console.log('Checking main page shelves...');
            
            if (channel.shelves && channel.shelves.length) {
                console.log(`Found ${channel.shelves.length} shelves on main page`);
                
                // Try to find music-related shelves
                for (const shelf of channel.shelves) {
                    const shelfTitle = shelf.title?.text || '';
                    console.log(`Examining shelf: ${shelfTitle}`);
                    
                    if (shelfTitle.toLowerCase().includes('music') || 
                        shelfTitle.toLowerCase().includes('album') || 
                        shelfTitle.toLowerCase().includes('song')) {
                        
                        console.log(`Found music-related shelf: ${shelfTitle}`);
                        
                        // Check shelf endpoint
                        if (shelf.endpoint?.browse_endpoint?.browse_id) {
                            const browseId = shelf.endpoint.browse_endpoint.browse_id;
                            if (browseId.startsWith('UC') || browseId.includes('music_channel')) {
                                console.log(`Found topic channel ID in shelf endpoint: ${browseId}`);
                                return {
                                    title: `${channel.metadata?.title || ''} - Topic`,
                                    subtitle: 'Music Artist',
                                    endpoint: browseId,
                                    source: 'main_shelf_endpoint'
                                };
                            }
                        }
                        
                        // Check items in shelf
                        if (shelf.items && shelf.items.length) {
                            console.log(`Examining ${shelf.items.length} items in shelf`);
                            
                            for (const item of shelf.items) {
                                if (item.endpoint?.browse_endpoint?.browse_id) {
                                    const browseId = item.endpoint.browse_endpoint.browse_id;
                                    if (browseId.startsWith('UC') || browseId.includes('music_channel')) {
                                        console.log(`Found topic channel ID in shelf item: ${browseId}`);
                                        return {
                                            title: `${channel.metadata?.title || ''} - Topic`,
                                            subtitle: 'Music Artist',
                                            endpoint: browseId,
                                            source: 'main_item_endpoint'
                                        };
                                    }
                                }
                            }
                        }
                    }
                }
            }
        } catch (error) {
            console.log(`Error exploring main page shelves: ${error.message}`);
        }
        
        // Method 2.4: Try to derive a topic channel ID based on patterns
        console.log('Attempting to derive topic channel ID from patterns...');
        
        // For music artists, YouTube often creates a topic channel with a similar ID
        const channelId = channel.metadata.external_id;
        
        // If this is already a topic channel, return it
        if (channel.metadata.title.toLowerCase().includes('- topic')) {
            console.log('This appears to be a topic channel already');
            return {
                title: channel.metadata.title,
                subtitle: 'Music Artist',
                endpoint: channelId,
                source: 'is_topic_channel'
            };
        }
        
        // For music artists, try a common pattern - the channel ID itself might be the topic channel
        if (channelId && channelId.startsWith('UC')) {
            console.log(`Using channel ID as potential topic channel ID: ${channelId}`);
            return {
                title: `${channel.metadata.title} - Topic`,
                subtitle: 'Music Artist',
                endpoint: channelId,
                is_derived: true,
                source: 'derived_from_channel_id'
            };
        }
    }
    
    // Method 3: Check for music-related metadata
    if (channel.metadata?.keywords) {
        const keywords = Array.isArray(channel.metadata.keywords) ? 
            channel.metadata.keywords : 
            [channel.metadata.keywords];
        
        const musicKeywords = keywords.filter(keyword => 
            keyword.toLowerCase().includes('music') || 
            keyword.toLowerCase().includes('artist') ||
            keyword.toLowerCase().includes('band') ||
            keyword.toLowerCase().includes('singer')
        );
        
        if (musicKeywords.length > 0) {
            console.log(`Found music-related keywords: ${musicKeywords.join(', ')}`);
            
            // This is likely a music channel, use the channel ID as a fallback
            const channelId = channel.metadata.external_id;
            if (channelId && channelId.startsWith('UC')) {
                console.log(`Using channel ID as fallback topic channel ID: ${channelId}`);
                return {
                    title: `${channel.metadata.title} - Topic`,
                    subtitle: 'Music Artist',
                    endpoint: channelId,
                    is_derived: true,
                    source: 'derived_from_keywords'
                };
            }
        }
    }
    
    console.log('No topic channel details found');
    return null;
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

// Improved debug endpoint to explore all channel tabs
app.get('/api/debug/channel/:channelId/tabs', async (req, res) => {
    try {
        console.log('Exploring tabs for channel:', req.params.channelId);
        const channel = await yt.getChannel(req.params.channelId);
        
        // Get basic channel info
        const channelInfo = {
            id: channel.metadata?.external_id || '',
            title: channel.metadata?.title || '',
            is_music_artist: !!channel.metadata?.music_artist_name
        };
        
        // Extract available tab names
        let availableTabs = [];
        
        // Try to get tab names from the channel object
        if (channel.tabs) {
            console.log('Channel has tabs property');
            if (typeof channel.tabs === 'function') {
                console.log('tabs is a function');
                try {
                    const tabsResult = channel.tabs();
                    availableTabs = Array.isArray(tabsResult) ? tabsResult : [];
                } catch (error) {
                    console.log(`Error calling tabs function: ${error.message}`);
                }
            } else if (Array.isArray(channel.tabs)) {
                console.log(`Found ${channel.tabs.length} tabs as array`);
                // Extract tab names or IDs
                availableTabs = channel.tabs.map(tab => {
                    return {
                        title: tab.title?.text || tab.title || '',
                        type: tab.type || '',
                        endpoint: tab.endpoint?.browse_endpoint?.browse_id || '',
                        url: tab.endpoint?.browse_endpoint?.canonical_base_url || ''
                    };
                });
            } else {
                console.log(`tabs property is type: ${typeof channel.tabs}`);
            }
        }
        
        // Try to access tab data directly from the page data
        const rawTabs = [];
        try {
            // Look for tab data in various possible locations
            const possibleTabLocations = [
                channel.page?.header?.tabs,
                channel.page?.header?.tabbed_header?.tabs,
                channel.page?.contents?.tabs,
                channel.page?.contents?.two_column_browse_results_renderer?.tabs
            ];
            
            for (const location of possibleTabLocations) {
                if (Array.isArray(location)) {
                    console.log(`Found ${location.length} tabs in raw page data`);
                    for (const tab of location) {
                        rawTabs.push({
                            title: tab.title || tab.tab_renderer?.title || '',
                            endpoint: tab.endpoint?.browse_endpoint?.browse_id || 
                                     tab.tab_renderer?.endpoint?.browse_endpoint?.browse_id || '',
                            content_type: tab.content_type || tab.tab_renderer?.content_type || '',
                            selected: !!tab.selected || !!tab.tab_renderer?.selected
                        });
                    }
                    break;
                }
            }
        } catch (error) {
            console.log(`Error accessing raw tab data: ${error.message}`);
        }
        
        // Try to explore each tab using getTabByURL
        const exploredTabs = [];
        for (const tabInfo of [...availableTabs, ...rawTabs]) {
            if (tabInfo.endpoint || tabInfo.url) {
                try {
                    console.log(`Trying to access tab: ${tabInfo.title || 'unnamed'}`);
                    const tabData = tabInfo.url ? 
                        await channel.getTabByURL(tabInfo.url) : 
                        await channel.getTabByName(tabInfo.title);
                    
                    if (tabData) {
                        const tabDetails = {
                            title: tabInfo.title,
                            found: true,
                            has_shelves: !!tabData.shelves && tabData.shelves.length > 0,
                            shelves_count: tabData.shelves?.length || 0,
                            has_videos: !!tabData.videos && tabData.videos.length > 0,
                            videos_count: tabData.videos?.length || 0,
                            has_playlists: !!tabData.playlists && tabData.playlists.length > 0,
                            playlists_count: tabData.playlists?.length || 0
                        };
                        
                        // If this tab has shelves, explore them
                        if (tabData.shelves && tabData.shelves.length) {
                            tabDetails.shelves = tabData.shelves.map(shelf => ({
                                title: shelf.title?.text || '',
                                type: shelf.type || '',
                                items_count: shelf.items?.length || 0,
                                endpoint: shelf.endpoint?.browse_endpoint?.browse_id || '',
                                has_topic_details: !!shelf.topic_channel_details
                            }));
                        }
                        
                        exploredTabs.push(tabDetails);
                    }
                } catch (error) {
                    console.log(`Error exploring tab ${tabInfo.title}: ${error.message}`);
                }
            }
        }
        
        // Try a different approach - use common tab paths
        const commonTabPaths = [
            '/featured',
            '/videos',
            '/shorts',
            '/streams',
            '/playlists',
            '/community',
            '/channels',
            '/about',
            '/store',
            '/releases',
            '/music'
        ];
        
        const pathTabs = [];
        for (const path of commonTabPaths) {
            try {
                const tabUrl = `/channel/${channel.metadata.external_id}${path}`;
                console.log(`Trying tab path: ${tabUrl}`);
                const tab = await channel.getTabByURL(tabUrl);
                
                if (tab) {
                    const tabInfo = {
                        path: path,
                        found: true,
                        has_shelves: !!tab.shelves && tab.shelves.length > 0,
                        shelves_count: tab.shelves?.length || 0
                    };
                    
                    // If this tab has shelves, check them for topic details
                    if (tab.shelves && tab.shelves.length) {
                        tabInfo.shelves = tab.shelves.map(shelf => ({
                            title: shelf.title?.text || '',
                            type: shelf.type || '',
                            items_count: shelf.items?.length || 0
                        }));
                        
                        // Look for music-related shelves
                        const musicShelves = tab.shelves.filter(shelf => {
                            const title = shelf.title?.text || '';
                            return title.toLowerCase().includes('music') || 
                                   title.toLowerCase().includes('album') || 
                                   title.toLowerCase().includes('song') ||
                                   title.toLowerCase().includes('single');
                        });
                        
                        if (musicShelves.length > 0) {
                            tabInfo.has_music_content = true;
                            tabInfo.music_shelves_count = musicShelves.length;
                        }
                    }
                    
                    pathTabs.push(tabInfo);
                }
            } catch (error) {
                // Just skip tabs that don't exist
                console.log(`Tab path ${path} not available: ${error.message}`);
            }
        }
        
        // Construct the response
        const response = {
            channel: channelInfo,
            available_tabs: availableTabs,
            raw_tabs: rawTabs,
            explored_tabs: exploredTabs,
            path_tabs: pathTabs,
            has_music_artist_name: !!channel.metadata?.music_artist_name,
            music_artist_name: channel.metadata?.music_artist_name || null
        };
        
        res.json(response);
    } catch (error) {
        console.error('Tab exploration error:', error);
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
