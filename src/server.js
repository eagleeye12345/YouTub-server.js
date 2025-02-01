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

// Update extractPublishedDate function
function extractPublishedDate(short) {
    try {
        debugLogObject('Extracting date from object', {
            microformat: short.microformat,
            player_microformat: short.player_microformat,
            basic_info: short.basic_info,
            primary_info: short.primary_info,
            videoPrimaryInfo: short.videoPrimaryInfo,
            publishedTimeText: short.publishedTimeText,
            published: short.published,
            accessibility_text: short.accessibility_text
        });

        // Try primary info first (most reliable for shorts)
        if (short.primary_info?.published) {
            const publishedText = short.primary_info.published.text || 
                                short.primary_info.published.simpleText;
            if (publishedText) {
                console.log('Found date in primary_info:', publishedText);
                return parseYouTubeDate(publishedText);
            }
        }

        // Try video details
        if (short.video_details?.publishDate) {
            console.log('Found date in video_details:', short.video_details.publishDate);
            return new Date(short.video_details.publishDate).toISOString();
        }

        // Try microformat
        if (short.microformat?.playerMicroformatRenderer?.publishDate) {
            console.log('Found date in microformat:', short.microformat.playerMicroformatRenderer.publishDate);
            return new Date(short.microformat.playerMicroformatRenderer.publishDate).toISOString();
        }

        // Try basic info
        if (short.basic_info?.publishDate || short.basic_info?.publish_date) {
            const date = short.basic_info.publishDate || short.basic_info.publish_date;
            console.log('Found date in basic_info:', date);
            return new Date(date).toISOString();
        }

        // Try accessibility label
        if (short.accessibility?.accessibilityData?.label) {
            const match = short.accessibility.accessibilityData.label.match(
                /(?:uploaded|posted|published|streamed)\s+(\d+\s+(?:second|minute|hour|day|week|month|year)s?\s+ago)/i
            );
            if (match) {
                console.log('Found date in accessibility label:', match[1]);
                return parseYouTubeDate(match[1]);
            }
        }

        // Try published text
        if (short.publishedTimeText?.simpleText || short.publishedTimeText?.text) {
            const text = short.publishedTimeText.simpleText || short.publishedTimeText.text;
            console.log('Found date in publishedTimeText:', text);
            return parseYouTubeDate(text);
        }

        console.log('No valid date found in object');
        return null;
    } catch (error) {
        console.error('Error extracting published date:', error);
        return null;
    }
}

// Update extractViews function
function extractViews(short) {
    try {
        debugLogObject('Extracting views from object', {
            basic_info: short.basic_info,
            videoPrimaryInfo: short.videoPrimaryInfo,
            view_count: short.view_count,
            short_view_count: short.short_view_count,
            overlay_stats: short.overlay_stats,
            accessibility_text: short.accessibility_text
        });

        // Try engagement panel first
        if (short.engagementPanel?.engagementPanelSectionListRenderer?.content?.viewCount) {
            const viewText = short.engagementPanel.engagementPanelSectionListRenderer.content.viewCount.videoViewCountRenderer.viewCount.simpleText;
            console.log('Found views in engagement panel:', viewText);
            return viewText.replace(/[^0-9.KMB]/gi, '');
        }

        // Try video primary info
        if (short.primary_info?.viewCount?.videoViewCountRenderer?.viewCount?.simpleText) {
            const viewText = short.primary_info.viewCount.videoViewCountRenderer.viewCount.simpleText;
            console.log('Found views in primary info:', viewText);
            return viewText.replace(/[^0-9.KMB]/gi, '');
        }

        // Try basic info
        if (short.basic_info?.view_count) {
            console.log('Found views in basic info:', short.basic_info.view_count);
            return short.basic_info.view_count.toString();
        }

        // Try accessibility text
        if (short.accessibility_text) {
            const viewMatch = short.accessibility_text.match(/(\d+(?:\.\d+)?[KMB]?)\s+views?/i);
            if (viewMatch) {
                console.log('Found views in accessibility text:', viewMatch[1]);
                return viewMatch[1];
            }
        }

        // Try overlay stats
        if (short.overlay_stats?.[0]?.text?.simpleText) {
            console.log('Found views in overlay stats:', short.overlay_stats[0].text.simpleText);
            return short.overlay_stats[0].text.simpleText.replace(/[^0-9.KMB]/gi, '');
        }

        console.log('No valid view count found in object');
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
                            const shortInfo = await yt.getShortsVideoInfo(videoId);
                            
                            if (!shortInfo || !shortInfo.basic_info) {
                                console.warn(`No basic info found for short ${videoId}, trying fallback to regular video info`);
                                // Try fallback to regular video info
                                try {
                                    const videoInfo = await yt.getInfo(videoId);
                                    if (videoInfo && videoInfo.basic_info) {
                                        const shortData = {
                                            video_id: videoId,
                                            title: videoInfo.basic_info.title || short.title || '',
                                            description: videoInfo.basic_info.description || 
                                                       short.description_snippet?.text || 
                                                       short.description?.text || '',
                                            thumbnail_url: videoInfo.basic_info.thumbnail?.[0]?.url || 
                                                         short.thumbnail_url ||
                                                         `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
                                            published_at: videoInfo.basic_info.publish_date || 
                                                        (short.published?.text ? parseYouTubeDate(short.published.text) : new Date().toISOString()),
                                            views: videoInfo.basic_info.view_count?.toString() || 
                                                   short.views?.replace(/[^0-9]/g, '') || '0',
                                            channel_id: channel.metadata?.external_id || '',
                                            channel_title: channel.metadata?.title || '',
                                            duration: videoInfo.basic_info.duration?.text || short.duration?.text || '',
                                            is_short: true,
                                            accessibility_text: short.accessibility_text || ''
                                        };
                                        shorts.push(shortData);
                                        console.log(`Successfully processed short using fallback: ${shortData.video_id}`);
                                    }
                                } catch (fallbackError) {
                                    console.error(`Fallback also failed for short ${videoId}:`, fallbackError);
                                }
                                continue;
                            }

                            const shortData = {
                                video_id: videoId,
                                title: shortInfo.basic_info.title || short.title || '',
                                description: shortInfo.basic_info.description || 
                                            short.description_snippet?.text || 
                                            short.description?.text || '',
                                thumbnail_url: shortInfo.basic_info.thumbnail?.[0]?.url || 
                                             short.thumbnail_url ||
                                             `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
                                published_at: extractPublishedDate(shortInfo) || 
                                             extractPublishedDate(short) ||
                                             null, // Don't fallback to current date
                                views: extractViews(shortInfo) || 
                                       extractViews(short) || 
                                       '0',
                                channel_id: channel.metadata?.external_id || '',
                                channel_title: channel.metadata?.title || '',
                                duration: shortInfo.basic_info.duration?.text || short.duration?.text || '',
                                is_short: true,
                                playability_status: shortInfo.playability_status,
                                accessibility_text: short.accessibility_text || ''
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
        try {
            shortInfo = await yt.getShortsVideoInfo(req.params.videoId);
        } catch (error) {
            console.warn('Failed to get shorts info, trying fallback to regular video info');
            shortInfo = await yt.getInfo(req.params.videoId);
        }

        if (!shortInfo || !shortInfo.basic_info) {
            return res.status(404).json({ error: 'Short not found or not available' });
        }

        // Extract title from multiple possible locations
        const title = shortInfo.basic_info.title ||
                     shortInfo.primary_info?.title?.text ||
                     shortInfo.overlay_metadata?.primary_text?.text ||
                     '';

        // Extract description from multiple possible locations
        const description = shortInfo.basic_info.description ||
                          shortInfo.primary_info?.description?.text ||
                          shortInfo.description_snippet?.text ||
                          '';

        const simplifiedInfo = {
            video_id: shortInfo.basic_info.id,
            title: title,
            description: description,
            thumbnail_url: shortInfo.basic_info.thumbnail?.[0]?.url ||
                         `https://i.ytimg.com/vi/${req.params.videoId}/hqdefault.jpg`,
            views: extractViews(shortInfo) || 
                  extractViews(shortInfo) || 
                  '0',
            published_at: extractPublishedDate(shortInfo) || 
                         extractPublishedDate(short) ||
                         null, // Don't fallback to current date
            channel_id: shortInfo.basic_info.channel?.id,
            channel_title: shortInfo.basic_info.channel?.name,
            channel_thumbnail: shortInfo.basic_info.channel?.thumbnails?.[0]?.url,
            duration: shortInfo.basic_info.duration?.text || '',
            is_short: true,
            playability_status: shortInfo.playability_status
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
    
    // First verify the channel exists
    let channel;
    try {
      channel = await yt.getChannel(req.params.channelId);
      if (!channel) {
        console.error('Channel not found:', req.params.channelId);
        return res.status(404).json({ error: 'Channel not found' });
      }
    } catch (error) {
      console.error('Error fetching channel:', error);
      return res.status(404).json({ error: 'Channel not found or not accessible' });
    }
    
    // Log channel metadata
    console.log('Channel metadata:', JSON.stringify({
        id: channel.metadata?.external_id,
        title: channel.metadata?.title,
        has_shorts: channel.has_shorts,
        available_tabs: channel.available_tabs
    }, null, 2));

    if (!channel.has_shorts) {
      console.log('Channel has no shorts tab');
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
    let shorts = [];
    
    // Calculate how many items to skip based on page number
    const itemsToSkip = (page - 1) * limit;
    let itemsCollected = 0;
    let currentBatch = shortsTab;

    // Keep getting continuations until we reach the desired page
    while (itemsCollected < itemsToSkip && currentBatch?.has_continuation) {
      try {
        console.log(`Skipping batch, collected ${itemsCollected}/${itemsToSkip} items`);
        currentBatch = await currentBatch.getContinuation();
        if (!currentBatch?.videos?.length) {
          break;
        }
        itemsCollected += currentBatch.videos.length;
      } catch (error) {
        console.error('Error getting continuation:', error);
        break;
      }
    }

    // Now we're at the right page, get the items for this page
    if (currentBatch?.videos) {
      // Calculate the correct slice of videos to process
      const startIdx = Math.max(0, itemsToSkip - (itemsCollected - currentBatch.videos.length));
      const endIdx = Math.min(startIdx + limit, currentBatch.videos.length);
      
      console.log(`Processing videos from index ${startIdx} to ${endIdx}`);
      
      // Process only the videos for the current page
      const videosForCurrentPage = currentBatch.videos.slice(startIdx, endIdx);
      
      // Process each video in the current page
      for (const short of videosForCurrentPage) {
        try {
          const videoId = short.id || 
            short.videoId || 
            short.video_id || 
            short.on_tap_endpoint?.payload?.videoId ||
            short.navigationEndpoint?.watchEndpoint?.videoId ||
            (short.thumbnails?.[0]?.url?.match(/\/vi\/([^/]+)\//))?.[1] ||
            (short.thumbnail?.[0]?.url?.match(/\/vi\/([^/]+)\//))?.[1] ||
            Object.values(short).find(val => 
              typeof val === 'string' && /^[a-zA-Z0-9_-]{11}$/.test(val)
            );

          if (!videoId) {
            console.warn('Skipping short with missing ID');
            continue;
          }

          console.log(`Processing short with ID: ${videoId}`);
          
          // Try to get short info with fallback
          let shortInfo;
          try {
            shortInfo = await yt.getShortsVideoInfo(videoId);
          } catch (error) {
            console.warn(`Failed to get shorts info for ${videoId}, trying fallback:`, error.message);
            try {
              shortInfo = await yt.getInfo(videoId);
            } catch (fallbackError) {
              console.error(`Both shorts and regular info failed for ${videoId}:`, fallbackError.message);
              continue;
            }
          }

          if (!shortInfo?.basic_info) {
            console.warn(`No info found for short ${videoId}, skipping`);
            continue;
          }

          const shortData = {
            video_id: videoId,
            title: shortInfo.basic_info?.title || 
                   shortInfo.primary_info?.title?.text ||
                   short.title?.text ||
                   short.overlay_metadata?.primary_text?.text || '',
            description: shortInfo.basic_info?.description || 
                        shortInfo.primary_info?.description?.text ||
                        short.description_snippet?.text || 
                        short.description?.text || '',
            thumbnail_url: shortInfo.basic_info?.thumbnail?.[0]?.url || 
                          short.thumbnail_url ||
                          `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
            published_at: extractPublishedDate(shortInfo) || 
                         extractPublishedDate(short) ||
                         null,
            views: extractViews(shortInfo) || 
                   extractViews(short) || 
                   '0',
            channel_id: channel.metadata?.external_id || '',
            channel_title: channel.metadata?.title || '',
            duration: shortInfo.basic_info?.duration?.text || 
                      short.duration?.text || '',
            is_short: true,
            playability_status: shortInfo.playability_status,
            accessibility_text: short.accessibility_text || ''
          };

          shorts.push(shortData);
          console.log(`Successfully processed short: ${shortData.video_id}`);
        } catch (error) {
          console.error(`Error processing short:`, error);
          continue;
        }
      }

      // If we didn't get enough items and there are more available, get the next batch
      if (shorts.length < limit && currentBatch.has_continuation) {
        try {
          const nextBatch = await currentBatch.getContinuation();
          if (nextBatch?.videos) {
            const remainingNeeded = limit - shorts.length;
            const additionalVideos = nextBatch.videos.slice(0, remainingNeeded);
            
            // Process the remaining needed videos
            for (const short of additionalVideos) {
              try {
                const videoId = short.id || 
                  short.videoId || 
                  short.video_id || 
                  short.on_tap_endpoint?.payload?.videoId ||
                  short.navigationEndpoint?.watchEndpoint?.videoId ||
                  (short.thumbnails?.[0]?.url?.match(/\/vi\/([^/]+)\//))?.[1] ||
                  (short.thumbnail?.[0]?.url?.match(/\/vi\/([^/]+)\//))?.[1] ||
                  Object.values(short).find(val => 
                    typeof val === 'string' && /^[a-zA-Z0-9_-]{11}$/.test(val)
                  );

                if (!videoId) {
                  console.warn('Skipping short with missing ID');
                  continue;
                }

                console.log(`Processing short with ID: ${videoId}`);
                
                // Try to get short info with fallback
                let shortInfo;
                try {
                  shortInfo = await yt.getShortsVideoInfo(videoId);
                } catch (error) {
                  console.warn(`Failed to get shorts info for ${videoId}, trying fallback:`, error.message);
                  try {
                    shortInfo = await yt.getInfo(videoId);
                  } catch (fallbackError) {
                    console.error(`Both shorts and regular info failed for ${videoId}:`, fallbackError.message);
                    continue;
                  }
                }

                if (!shortInfo?.basic_info) {
                  console.warn(`No info found for short ${videoId}, skipping`);
                  continue;
                }

                const shortData = {
                  video_id: videoId,
                  title: shortInfo.basic_info?.title || 
                         shortInfo.primary_info?.title?.text ||
                         short.title?.text ||
                         short.overlay_metadata?.primary_text?.text || '',
                  description: shortInfo.basic_info?.description || 
                              shortInfo.primary_info?.description?.text ||
                              short.description_snippet?.text || 
                              short.description?.text || '',
                  thumbnail_url: shortInfo.basic_info?.thumbnail?.[0]?.url || 
                                short.thumbnail_url ||
                                `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
                  published_at: extractPublishedDate(shortInfo) || 
                               extractPublishedDate(short) ||
                               null,
                  views: extractViews(shortInfo) || 
                         extractViews(short) || 
                         '0',
                  channel_id: channel.metadata?.external_id || '',
                  channel_title: channel.metadata?.title || '',
                  duration: shortInfo.basic_info?.duration?.text || 
                            short.duration?.text || '',
                  is_short: true,
                  playability_status: shortInfo.playability_status,
                  accessibility_text: short.accessibility_text || ''
                };

                shorts.push(shortData);
                console.log(`Successfully processed short: ${shortData.video_id}`);
              } catch (error) {
                console.error(`Error processing additional short:`, error);
                continue;
              }
            }
          }
        } catch (error) {
          console.error('Error getting additional shorts:', error);
        }
      }
    }

    // Check if more shorts are available
    const hasMore = currentBatch?.has_continuation || false;

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
}); 
