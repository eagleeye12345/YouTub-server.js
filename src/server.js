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
                
                // Debug the shorts tab structure
                console.log('Shorts tab structure:', JSON.stringify({
                    has_videos: !!shortsTab?.videos,
                    video_count: shortsTab?.videos?.length,
                    first_video: shortsTab?.videos?.[0],
                    has_continuation: !!shortsTab?.has_continuation
                }, null, 2));

                // Get continuation if not on first page
                let currentPage = 1;
                let currentBatch = shortsTab;

                // Skip to requested page
                while (currentPage < page && currentBatch?.has_continuation) {
                    console.log(`Skipping shorts page ${currentPage}, getting next batch...`);
                    try {
                    const nextBatch = await currentBatch.getContinuation();
                        console.log(`Next batch structure:`, JSON.stringify({
                            has_videos: !!nextBatch?.videos,
                            video_count: nextBatch?.videos?.length,
                            first_video: nextBatch?.videos?.[0],
                            has_continuation: !!nextBatch?.has_continuation
                        }, null, 2));

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
                    
                    // Log the raw videos array before filtering
                    console.log('Raw videos before filtering:', JSON.stringify(currentBatch.videos.slice(startIdx, endIdx), null, 2));
                    
                    // Filter out any shorts without valid IDs before processing
                    const validShorts = currentBatch.videos
                        .slice(startIdx, endIdx)
                        .filter(short => {
                            // Check all possible ID locations based on the ShortsLockupView structure
                            const hasId = short && (
                                short.id || 
                                short.videoId || 
                                short.video_id || 
                                (short.on_tap_endpoint?.payload?.videoId) ||  // Add this path
                                (short.navigationEndpoint?.watchEndpoint?.videoId) ||
                                (short.thumbnails?.[0]?.url?.match(/\/vi\/([^/]+)\//))?.[1] ||
                                (short.thumbnail?.[0]?.url?.match(/\/vi\/([^/]+)\//))?.[1] ||  // Add this path
                                (typeof short === 'object' && Object.values(short).find(val => 
                                    typeof val === 'string' && /^[a-zA-Z0-9_-]{11}$/.test(val)
                                ))
                            );
                            if (!hasId) {
                                console.log('Invalid short object:', JSON.stringify(short, null, 2));
                            } else {
                                console.log('Valid short found:', JSON.stringify({
                                    type: short.type,
                                    id: short.id,
                                    videoId: short.videoId,
                                    video_id: short.video_id,
                                    on_tap_videoId: short.on_tap_endpoint?.payload?.videoId,
                                    watchEndpoint: short.navigationEndpoint?.watchEndpoint?.videoId,
                                    thumbnail_url: short.thumbnail?.[0]?.url || short.thumbnails?.[0]?.url,
                                    title: short.overlay_metadata?.primary_text?.text || short.title?.text,
                                    views: short.overlay_metadata?.secondary_text?.text || short.view_count?.text
                                }, null, 2));
                            }
                            return hasId;
                        })
                        .map(short => {
                            const videoId = short.id || 
                                short.videoId || 
                                short.video_id || 
                                short.on_tap_endpoint?.payload?.videoId ||  // Add this path
                                short.navigationEndpoint?.watchEndpoint?.videoId ||
                                (short.thumbnails?.[0]?.url?.match(/\/vi\/([^/]+)\//))?.[1] ||
                                (short.thumbnail?.[0]?.url?.match(/\/vi\/([^/]+)\//))?.[1] ||  // Add this path
                                Object.values(short).find(val => 
                                    typeof val === 'string' && /^[a-zA-Z0-9_-]{11}$/.test(val)
                                );

                            // Extract additional metadata from ShortsLockupView structure
                            const title = short.overlay_metadata?.primary_text?.text || 
                                         short.title?.text || 
                                         short.accessibility_text?.split(',')[0] || '';
                             
                            const views = short.overlay_metadata?.secondary_text?.text || 
                                         short.view_count?.text || 
                                         (short.accessibility_text?.match(/(\d+[KMB]?\s+views)/) || [])[1] || '0';

                            // Extract published date from multiple possible locations
                            const publishedDate = extractPublishedDate(short);

                            return {
                                ...short,
                                id: videoId,
                                title: title,
                                views: views,
                                thumbnail_url: short.thumbnail?.[0]?.url || short.thumbnails?.[0]?.url,
                                published_at: publishedDate
                            };
                        });
                    
                    console.log(`Found ${validShorts.length} valid shorts to process`);
                    
                    for (const short of validShorts) {
                        try {
                            const videoId = short.id;
                            if (!videoId) {
                                console.warn('Skipping short with missing ID');
                                continue;
                            }

                            console.log(`Processing short with ID: ${videoId}`);
                            
                            // Use getShortsVideoInfo instead of getInfo
                            const shortInfo = await yt.getShortsVideoInfo(videoId);
                            
                            // Log the raw data for debugging
                            console.log('Raw short info:', JSON.stringify(shortInfo, null, 2));

                            // Extract views from accessibility text first
                            const viewsMatch = short.accessibility_text?.match(/(\d+[KMB]?)\s+views/i);
                            const views = viewsMatch ? viewsMatch[1] : '0';

                            // Extract published date from overlay metadata
                            const publishedDate = shortInfo.overlay_metadata?.published_time?.text || 
                                                shortInfo.primary_info?.published?.text ||
                                                short.published?.text;

                            const shortData = {
                                video_id: videoId,
                                title: short.accessibility_text?.split(',')[0]?.replace(/ - play Short$/, '') || 
                                       shortInfo.basic_info?.title || '',
                                description: shortInfo.basic_info?.description || '',
                                thumbnail_url: shortInfo.basic_info?.thumbnail?.[0]?.url || 
                                             `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
                                published_at: publishedDate ? parseYouTubeDate(publishedDate) : null,
                                views: views,
                                channel_id: channel.metadata?.external_id || '',
                                channel_title: channel.metadata?.title || '',
                                duration: shortInfo.basic_info?.duration?.text || '',
                                is_short: true,
                                playability_status: shortInfo.playability_status,
                                accessibility_text: short.accessibility_text || ''
                            };

                            // Add debug logging
                            console.log('Processed short data:', JSON.stringify(shortData, null, 2));

                            shorts.push(shortData);
                            console.log(`Successfully processed short: ${shortData.video_id}`);
                        } catch (error) {
                            console.error(`Error processing short:`, error);
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

// Update the shorts processing logic in the /api/shorts/:videoId endpoint
app.get('/api/shorts/:videoId', async (req, res) => {
    try {
        let shortInfo;
        let regularInfo;
        
        try {
            shortInfo = await yt.getShortsVideoInfo(req.params.videoId);
            console.log('Got shorts info:', JSON.stringify(shortInfo?.primary_info, null, 2));
        } catch (error) {
            console.warn('Failed to get shorts info:', error);
        }

        try {
            regularInfo = await yt.getInfo(req.params.videoId);
            console.log('Got regular info:', JSON.stringify(regularInfo?.primary_info, null, 2));
        } catch (error) {
            console.warn('Failed to get regular info:', error);
        }

        if (!shortInfo && !regularInfo) {
            return res.status(404).json({ error: 'Short not found or not available' });
        }

        // Combine the info objects
        const combinedInfo = {
            ...shortInfo,
            regularInfo: regularInfo,
            raw: shortInfo || regularInfo,
            primary_info: regularInfo?.primary_info || shortInfo?.primary_info
        };

        console.log('Combined info primary_info:', JSON.stringify(combinedInfo.primary_info, null, 2));

        const simplifiedInfo = {
            video_id: combinedInfo.basic_info?.id || req.params.videoId,
            title: combinedInfo.primary_info?.title?.text || 
                   combinedInfo.basic_info?.title || '',
            description: combinedInfo.basic_info?.description || '',
            thumbnail_url: combinedInfo.basic_info?.thumbnail?.[0]?.url ||
                         `https://i.ytimg.com/vi/${req.params.videoId}/hqdefault.jpg`,
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
        
        console.log('Fetching shorts for channel:', req.params.channelId);
        
        // Get channel
        const channel = await yt.getChannel(req.params.channelId);
        
        // Debug channel data
        console.log('Channel data:', {
            id: channel.metadata?.external_id,
            has_shorts: channel.has_shorts,
            available_tabs: channel.available_tabs
        });

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

        // Get shorts tab
        const shortsTab = await channel.getShorts();
        console.log('Got shorts tab, videos count:', shortsTab?.videos?.length);

        let currentBatch = shortsTab;
        let allShorts = [];

        // Collect all shorts up to the requested page
        for (let currentPage = 1; currentPage <= page; currentPage++) {
            if (currentBatch?.videos?.length) {
                allShorts = allShorts.concat(currentBatch.videos);
            }

            if (currentPage < page && currentBatch?.has_continuation) {
                try {
                    currentBatch = await currentBatch.getContinuation();
                    console.log(`Got continuation for page ${currentPage + 1}, videos:`, currentBatch?.videos?.length);
                } catch (error) {
                    console.error('Error getting continuation:', error);
                    break;
                }
            }
        }

        // Calculate the slice for the current page
        const startIndex = (page - 1) * limit;
        const endIndex = startIndex + limit;
        const shortsForCurrentPage = allShorts.slice(startIndex, endIndex);

        console.log(`Processing ${shortsForCurrentPage.length} shorts for page ${page}`);

        // Process shorts
        const processedShorts = [];
        for (const short of shortsForCurrentPage) {
            try {
                // Get video ID from on_tap_endpoint
                const videoId = short.on_tap_endpoint?.payload?.videoId;
                if (!videoId) {
                    console.warn('Could not extract video ID from short');
                    continue;
                }

                console.log('Processing short:', videoId);

                // Fetch both shorts and regular info
                let shortInfo;
                let regularInfo;

                try {
                    shortInfo = await yt.getShortsVideoInfo(videoId);
                } catch (error) {
                    console.warn('Failed to get shorts info:', error);
                }

                try {
                    regularInfo = await yt.getInfo(videoId);
                    console.log('Got regular info for short:', videoId);
                } catch (error) {
                    console.warn('Failed to get regular info:', error);
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

                console.log('Extracted view count:', {
                    raw: regularInfo?.primary_info?.view_count,
                    extracted: viewCount
                });

                // Extract data directly from the combined info
                const shortData = {
                    video_id: videoId,
                    title: short.overlay_metadata?.primary_text?.text || 
                           short.accessibility_text?.split(',')[0]?.replace(/ - play Short$/, '') || '',
                    description: combinedInfo.basic_info?.description || '',
                    thumbnail_url: short.thumbnail?.[0]?.url || 
                                 `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
                    published_at: regularInfo?.primary_info?.published?.text ? 
                                 new Date(regularInfo.primary_info.published.text).toISOString() : null,
                    views: viewCount,
                    channel_id: channel.metadata?.external_id || '',
                    channel_title: channel.metadata?.title || '',
                    duration: combinedInfo.basic_info?.duration?.text || '',
                    is_short: true
                };

                processedShorts.push(shortData);
                console.log('Successfully processed short:', videoId, 'views:', viewCount);

            } catch (error) {
                console.error('Error processing short:', error);
                continue;
            }
        }

        const response = {
            shorts: processedShorts,
            pagination: {
                has_more: currentBatch?.has_continuation || false,
                current_page: page,
                items_per_page: limit,
                total_items: processedShorts.length
            }
        };

        console.log(`Returning ${processedShorts.length} shorts`);
        res.json(response);

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

// Initialize YouTube client before starting the server
initializeYouTube().then(() => {
    app.listen(port, () => {
        console.log(`Server running on port ${port}`);
    });
}).catch(error => {
    console.error('Failed to start server:', error);
    process.exit(1);
}); 
