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

// Add a function to extract topic channel from metadata rows
function extractTopicFromMetadataRows(metadataRows) {
    if (!metadataRows || !Array.isArray(metadataRows)) {
        return null;
    }
    
    for (const row of metadataRows) {
        if (!row.metadata_parts || !Array.isArray(row.metadata_parts)) {
            continue;
        }
        
        for (const part of row.metadata_parts) {
            if (!part.text || !part.text.runs || !Array.isArray(part.text.runs)) {
                continue;
            }
            
            // Look for text runs that might contain artist info with endpoints
            for (const run of part.text.runs) {
                if (run.endpoint?.payload?.browseId && 
                    run.text && 
                    !run.text.includes('Album') && 
                    !run.text.includes('View full playlist')) {
                    
                    console.log(`Found potential artist endpoint in metadata: ${run.text} (${run.endpoint.payload.browseId})`);
                    
                    // If the text contains "Topic", it might be the topic channel directly
                    if (run.text.includes('- Topic')) {
                        return {
                            id: run.endpoint.payload.browseId,
                            title: run.text,
                            source: 'metadata_topic_text'
                        };
                    }
                    
                    // Otherwise, store it as a potential artist channel to check later
                    return {
                        id: run.endpoint.payload.browseId,
                        title: run.text,
                        isArtistChannel: true,
                        source: 'metadata_artist_text'
                    };
                }
            }
        }
    }
    
    return null;
}

// Add a function to extract topic channel ID from playlist data
async function extractTopicFromPlaylist(playlistId) {
    try {
        console.log(`Examining playlist for topic channel info: ${playlistId}`);
        const playlist = await yt.getPlaylist(playlistId);
        
        // Check if the playlist owner is a topic channel
        if (playlist.info?.author?.name?.includes('- Topic')) {
            console.log(`Found topic channel via playlist: ${playlist.info.author.name} (${playlist.info.author.id})`);
            return {
                id: playlist.info.author.id,
                title: playlist.info.author.name,
                source: 'playlist_author'
            };
        }
        
        // Check the first video in the playlist
        if (playlist.items?.length > 0) {
            const firstVideo = playlist.items[0];
            
            // Check if the video's channel is a topic channel
            if (firstVideo.author?.name?.includes('- Topic')) {
                console.log(`Found topic channel via playlist video: ${firstVideo.author.name} (${firstVideo.author.id})`);
                return {
                    id: firstVideo.author.id,
                    title: firstVideo.author.name,
                    source: 'playlist_video_author'
                };
            }
            
            // Try to get the video info to find the topic channel
            try {
                const videoInfo = await yt.getInfo(firstVideo.id);
                if (videoInfo.basic_info?.channel?.name?.includes('- Topic')) {
                    console.log(`Found topic channel via video info: ${videoInfo.basic_info.channel.name} (${videoInfo.basic_info.channel.id})`);
                    return {
                        id: videoInfo.basic_info.channel.id,
                        title: videoInfo.basic_info.channel.name,
                        source: 'playlist_video_info'
                    };
                }
            } catch (err) {
                console.log(`Could not get video info: ${err.message}`);
            }
        }
        
        return null;
    } catch (error) {
        console.log(`Error examining playlist: ${error.message}`);
        return null;
    }
}

// Add a function to directly check for the topic channel by ID pattern
async function checkDirectTopicChannelId(artistName, channelId) {
    try {
        console.log('Trying direct topic channel ID check...');
        
        // First, try a direct check for the topic channel using the URL
        // The URL format is typically: youtube.com/channel/UC...-Topic
        
        // 1. Try the exact artist name + "- Topic"
        const topicName = `${artistName} - Topic`;
        console.log(`Checking for topic channel with name: ${topicName}`);
        
        // 2. Try to construct the topic channel ID from the releases tab
        // This is the most reliable approach for finding topic channels
        try {
            console.log('Checking releases tab for topic channel ID...');
            const channel = await yt.getChannel(channelId);
            
            // Find the releases tab endpoint
            const releasesTab = channel.shelves?.find(shelf => 
                shelf.type?.includes('Release') || 
                (shelf.title?.text && shelf.title.text.includes('Release'))
            );
            
            if (releasesTab?.title?.endpoint?.payload?.params) {
                // The params field often contains information about the topic channel
                console.log(`Found releases tab with params: ${releasesTab.title.endpoint.payload.params}`);
                
                // Try to navigate to the releases tab to get more information
                try {
                    const browseId = releasesTab.title.endpoint.payload.browseId;
                    const params = releasesTab.title.endpoint.payload.params;
                    
                    console.log(`Navigating to releases tab: browseId=${browseId}, params=${params}`);
                    
                    // Use the browse endpoint to get the releases page
                    const releasesPage = await yt.browse({
                        browseId: browseId,
                        params: params
                    });
                    
                    // Look for topic channel references in the releases page
                    if (releasesPage.header?.author?.name?.includes('- Topic')) {
                        console.log(`Found topic channel in releases page header: ${releasesPage.header.author.name} (${releasesPage.header.author.id})`);
                        return {
                            id: releasesPage.header.author.id,
                            title: releasesPage.header.author.name,
                            source: 'releases_page_header'
                        };
                    }
                    
                    // Check for topic channel in the first few releases
                    if (releasesPage.contents?.length > 0) {
                        for (const content of releasesPage.contents.slice(0, 5)) {
                            if (content.author?.name?.includes('- Topic')) {
                                console.log(`Found topic channel in release content: ${content.author.name} (${content.author.id})`);
                                return {
                                    id: content.author.id,
                                    title: content.author.name,
                                    source: 'releases_content'
                                };
                            }
                        }
                    }
                } catch (err) {
                    console.log(`Error navigating to releases tab: ${err.message}`);
                }
            }
        } catch (err) {
            console.log(`Error checking releases tab: ${err.message}`);
        }
        
        // 3. Try to find the topic channel by searching for the artist name + "- Topic"
        try {
            console.log(`Searching for "${topicName}"...`);
            const searchResults = await yt.search(topicName);
            
            // Look for an exact match in the search results
            const exactMatch = searchResults.channels?.find(channel => 
                channel.name?.toLowerCase() === topicName.toLowerCase()
            );
            
            if (exactMatch) {
                console.log(`Found exact match for topic channel in search: ${exactMatch.name} (${exactMatch.id})`);
                return {
                    id: exactMatch.id,
                    title: exactMatch.name,
                    source: 'search_exact_match'
                };
            }
            
            // Look for a close match in the search results
            const closeMatch = searchResults.channels?.find(channel => 
                channel.name?.toLowerCase().includes(artistName.toLowerCase()) && 
                channel.name?.toLowerCase().includes('topic')
            );
            
            if (closeMatch) {
                console.log(`Found close match for topic channel in search: ${closeMatch.name} (${closeMatch.id})`);
                return {
                    id: closeMatch.id,
                    title: closeMatch.name,
                    source: 'search_close_match'
                };
            }
        } catch (err) {
            console.log(`Error searching for topic channel: ${err.message}`);
        }
        
        return null;
    } catch (error) {
        console.log(`Error in direct topic channel check: ${error.message}`);
        return null;
    }
}

// Add a function to extract topic channel from releases tab params
async function extractTopicFromReleasesParams(channelId, params) {
    try {
        console.log(`Extracting topic channel from releases params: ${params}`);
        
        // Use the browse endpoint with the channel ID and params to get the releases page
        const releasesPage = await yt.browse({
            browseId: channelId,
            params: params
        });
        
        console.log('Successfully loaded releases page');
        
        // Check if the releases page has a different header author than the original channel
        if (releasesPage.header?.author?.id && releasesPage.header.author.id !== channelId) {
            // If the author ID is different and contains "Topic", it's likely the topic channel
            if (releasesPage.header.author.name?.includes('- Topic')) {
                console.log(`Found topic channel in releases page header: ${releasesPage.header.author.name} (${releasesPage.header.author.id})`);
                return {
                    id: releasesPage.header.author.id,
                    title: releasesPage.header.author.name,
                    source: 'releases_params_header'
                };
            }
        }
        
        // Check the contents of the releases page for topic channel references
        if (releasesPage.contents) {
            // Look for playlists or sections that might contain topic channel info
            for (const content of releasesPage.contents) {
                // Check if the content has an author that's a topic channel
                if (content.author?.name?.includes('- Topic')) {
                    console.log(`Found topic channel in releases content: ${content.author.name} (${content.author.id})`);
                    return {
                        id: content.author.id,
                        title: content.author.name,
                        source: 'releases_params_content'
                    };
                }
                
                // Check if the content has items with topic channel info
                if (content.contents?.items) {
                    for (const item of content.contents.items) {
                        if (item.author?.name?.includes('- Topic')) {
                            console.log(`Found topic channel in releases item: ${item.author.name} (${item.author.id})`);
                            return {
                                id: item.author.id,
                                title: item.author.name,
                                source: 'releases_params_item'
                            };
                        }
                    }
                }
            }
        }
        
        // If we couldn't find a direct reference, try to extract from the first playlist
        if (releasesPage.contents?.[0]?.contents?.items?.[0]?.id) {
            const firstPlaylistId = releasesPage.contents[0].contents.items[0].id;
            console.log(`Checking first playlist in releases: ${firstPlaylistId}`);
            
            const topicFromPlaylist = await extractTopicFromPlaylist(firstPlaylistId);
            if (topicFromPlaylist) {
                return topicFromPlaylist;
            }
        }
        
        return null;
    } catch (error) {
        console.log(`Error extracting topic from releases params: ${error.message}`);
        return null;
    }
}

// Update the findTopicChannelId function to use the releases params
async function findTopicChannelId(artistName, channelId) {
    try {
        // Try direct topic channel ID check first
        const directTopicChannel = await checkDirectTopicChannelId(artistName, channelId);
        if (directTopicChannel) {
            return directTopicChannel;
        }
        
        // Check for releases tab params
        try {
            console.log('Checking for releases tab params...');
            const channel = await yt.getChannel(channelId);
            
            // Find the releases tab
            const releasesTab = channel.shelves?.find(shelf => 
                shelf.type?.includes('Release') || 
                (shelf.title?.text && shelf.title.text.includes('Release'))
            );
            
            if (releasesTab?.title?.endpoint?.payload?.params) {
                const params = releasesTab.title.endpoint.payload.params;
                console.log(`Found params in releases shelf endpoint: ${params}`);
                
                const topicFromParams = await extractTopicFromReleasesParams(channelId, params);
                if (topicFromParams) {
                    return topicFromParams;
                }
            }
        } catch (err) {
            console.log(`Error checking releases tab params: ${err.message}`);
        }
        
        // Continue with existing approaches...
        // First try: Direct search for "Artist Name - Topic"
        const searchQuery = `${artistName} - Topic`;
        const searchResults = await yt.search(searchQuery);
        
        // Look for channels in search results
        const topicChannel = searchResults.channels?.find(channel => 
            channel.name?.toLowerCase().includes('topic') && 
            channel.name?.toLowerCase().includes(artistName.toLowerCase())
        );
        
        if (topicChannel) {
            console.log(`Found topic channel via search: ${topicChannel.name} (${topicChannel.id})`);
            return {
                id: topicChannel.id,
                title: topicChannel.name,
                source: 'search_results'
            };
        }
        
        // Second try: Check if this is an artist topic channel itself
        // Artist topic channels have a specific naming pattern: "Artist Name - Topic"
        if (artistName.endsWith('- Topic')) {
            console.log('This is already a topic channel');
            return {
                id: channelId,
                title: artistName,
                source: 'self_topic'
            };
        }
        
        // Third try: Try to get the auto-generated uploads playlist
        // This is a special playlist that exists for all channels
        // For artist channels, this often links to the topic channel
        try {
            console.log('Trying to find topic channel via uploads playlist...');
            const uploadsPlaylistId = `UU${channelId.substring(2)}`;
            const uploadsPlaylist = await yt.getPlaylist(uploadsPlaylistId);
            
            // Check if the playlist owner is a topic channel
            if (uploadsPlaylist.info?.author?.name?.includes('- Topic')) {
                console.log(`Found topic channel via uploads playlist: ${uploadsPlaylist.info.author.name} (${uploadsPlaylist.info.author.id})`);
                return {
                    id: uploadsPlaylist.info.author.id,
                    title: uploadsPlaylist.info.author.name,
                    source: 'uploads_playlist'
                };
            }
        } catch (err) {
            console.log('Could not find topic channel via uploads playlist:', err.message);
        }
        
        // Fourth try: Check for releases tab and try to extract from there
        // This is similar to what FreeTube does
        try {
            console.log('Trying to find topic channel via releases tab...');
            const channel = await yt.getChannel(channelId);
            
            // Check if this is an artist channel with releases
            const hasReleasesShelf = channel.shelves?.some(shelf => 
                shelf.type?.includes('Release') || 
                (shelf.title?.text && shelf.title.text.includes('Release'))
            );
            
            if (hasReleasesShelf) {
                // Get the first release and check its metadata
                const releasesShelf = channel.shelves.find(shelf => 
                    shelf.type?.includes('Release') || 
                    (shelf.title?.text && shelf.title.text.includes('Release'))
                );
                
                if (releasesShelf?.content?.items?.length > 0) {
                    const firstRelease = releasesShelf.content.items[0];
                    
                    // Try to extract from the first release's endpoint
                    if (firstRelease.endpoint?.payload?.browseId) {
                        const browseId = firstRelease.endpoint.payload.browseId;
                        if (browseId !== channelId) {
                            console.log(`Found potential topic channel ID in release: ${browseId}`);
                            return {
                                id: browseId,
                                title: `${artistName} - Topic`,
                                source: 'release_browse_id'
                            };
                        }
                    }
                    
                    // Try to extract from the first release's video ID
                    if (firstRelease.endpoint?.payload?.videoId) {
                        const videoId = firstRelease.endpoint.payload.videoId;
                        const videoInfo = await yt.getInfo(videoId);
                        
                        // Check if the video's channel is a topic channel
                        if (videoInfo.basic_info?.channel?.name?.includes('- Topic')) {
                            console.log(`Found topic channel via video: ${videoInfo.basic_info.channel.name} (${videoInfo.basic_info.channel.id})`);
                            return {
                                id: videoInfo.basic_info.channel.id,
                                title: videoInfo.basic_info.channel.name,
                                source: 'release_video'
                            };
                        }
                    }
                }
            }
        } catch (err) {
            console.log('Could not find topic channel via releases tab:', err.message);
        }
        
        // Fifth try: Check for playlists in releases tab
        try {
            console.log('Trying to find topic channel via release playlists...');
            const channel = await yt.getChannel(channelId);
            
            // Find releases shelf
            const releasesShelf = channel.shelves?.find(shelf => 
                shelf.type?.includes('Release') || 
                (shelf.title?.text && shelf.title.text.includes('Release'))
            );
            
            if (releasesShelf?.content?.items) {
                // First, check each item's metadata for topic channel references
                for (const item of releasesShelf.content.items) {
                    if (item.metadata?.metadata?.metadata_rows) {
                        const topicFromMetadata = extractTopicFromMetadataRows(item.metadata.metadata.metadata_rows);
                        
                        if (topicFromMetadata) {
                            // If we found a direct topic channel, return it
                            if (!topicFromMetadata.isArtistChannel) {
                                return topicFromMetadata;
                            }
                            
                            // If we found an artist channel, try to find its associated topic channel
                            if (topicFromMetadata.isArtistChannel && topicFromMetadata.id !== channelId) {
                                console.log(`Found artist channel, checking for its topic channel: ${topicFromMetadata.title} (${topicFromMetadata.id})`);
                                const artistTopicChannel = await findTopicChannelId(topicFromMetadata.title, topicFromMetadata.id);
                                if (artistTopicChannel) {
                                    return artistTopicChannel;
                                }
                            }
                        }
                    }
                    
                    // Then check for playlist IDs as before
                    let playlistId = null;
                    
                    // Extract playlist ID from various possible locations
                    if (item.content_id) {
                        playlistId = item.content_id;
                    } else if (item.endpoint?.payload?.playlistId) {
                        playlistId = item.endpoint.payload.playlistId;
                    } else if (item.endpoint?.payload?.browseId?.startsWith('VL')) {
                        playlistId = item.endpoint.payload.browseId.substring(2);
                    } else if (item.renderer_context?.command_context?.on_tap?.payload?.playlistId) {
                        playlistId = item.renderer_context.command_context.on_tap.payload.playlistId;
                    }
                    
                    if (playlistId) {
                        console.log(`Found playlist ID in releases: ${playlistId}`);
                        const topicInfo = await extractTopicFromPlaylist(playlistId);
                        if (topicInfo) {
                            return topicInfo;
                        }
                    }
                }
            }
        } catch (err) {
            console.log('Could not find topic channel via release playlists:', err.message);
        }
        
        // Sixth try: Directly check playlist IDs from the releases tab
        try {
            console.log('Trying to find topic channel by directly checking playlist IDs...');
            const channel = await yt.getChannel(channelId);
            
            // Find releases shelf
            const releasesShelf = channel.shelves?.find(shelf => 
                shelf.type?.includes('Release') || 
                (shelf.title?.text && shelf.title.text.includes('Release'))
            );
            
            if (releasesShelf?.content?.items) {
                // Extract all playlist IDs from the releases shelf
                const playlistIds = [];
                
                for (const item of releasesShelf.content.items) {
                    // Check for playlist ID in various locations
                    if (item.content_id) {
                        playlistIds.push(item.content_id);
                    }
                    
                    // Check in renderer_context
                    if (item.renderer_context?.command_context?.on_tap?.payload?.playlistId) {
                        playlistIds.push(item.renderer_context.command_context.on_tap.payload.playlistId);
                    }
                    
                    // Check in metadata
                    if (item.metadata?.metadata?.metadata_rows) {
                        for (const row of item.metadata.metadata.metadata_rows) {
                            if (row.metadata_parts) {
                                for (const part of row.metadata_parts) {
                                    if (part.text?.runs) {
                                        for (const run of part.text.runs) {
                                            if (run.endpoint?.metadata?.url?.includes('playlist?list=')) {
                                                const url = new URL(`https://youtube.com${run.endpoint.metadata.url}`);
                                                const playlistId = url.searchParams.get('list');
                                                if (playlistId) {
                                                    playlistIds.push(playlistId);
                                                }
                                            } else if (run.endpoint?.payload?.browseId?.startsWith('VL')) {
                                                playlistIds.push(run.endpoint.payload.browseId.substring(2));
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
                
                // Remove duplicates
                const uniquePlaylistIds = [...new Set(playlistIds)];
                console.log(`Found ${uniquePlaylistIds.length} unique playlist IDs to check`);
                
                // Check each playlist for topic channel info
                for (const playlistId of uniquePlaylistIds) {
                    const topicInfo = await extractTopicFromPlaylist(playlistId);
                    if (topicInfo) {
                        return topicInfo;
                    }
                }
            }
        } catch (err) {
            console.log('Could not find topic channel via direct playlist checks:', err.message);
        }
        
        return null;
    } catch (error) {
        console.error('Error finding topic channel:', error);
        return null;
    }
}

// Update the channel endpoint to always search for the topic channel for music artists
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
                       channel.header?.content?.banner?.image?.[0]?.url,
            subscriber_count: channel.header?.subscriber_count?.text || 
                             channel.metadata?.subscriber_count || '',
            topic: extractChannelTopic(channel)
        };

        // Check if this is likely a music artist channel by looking for releases shelf
        const hasReleasesShelf = channel.shelves?.some(shelf => 
            shelf.type?.includes('Release') || 
            (shelf.title?.text && shelf.title.text.includes('Release'))
        );

        // If we found a topic in the channel data OR it's a music artist channel,
        // try to find the actual topic channel by searching
        if (channelInfo.topic || hasReleasesShelf) {
            console.log('This appears to be a music artist channel, searching for topic channel...');
            const topicChannel = await findTopicChannelId(channelInfo.title, channelInfo.id);
            
            if (topicChannel) {
                // If we already had topic info, merge it; otherwise create new topic info
                if (channelInfo.topic) {
                    channelInfo.topic = {
                        ...channelInfo.topic,
                        ...topicChannel
                    };
                } else {
                    channelInfo.topic = {
                        title: `${channelInfo.title} - Topic`,
                        ...topicChannel
                    };
                }
            }
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

// Add a new debug endpoint for channel data
app.get('/api/debug/channel/:channelId', async (req, res) => {
    try {
        console.log('Debugging channel:', req.params.channelId);
        const channel = await yt.getChannel(req.params.channelId);
        
        // Create a simplified version of the channel data for debugging
        const debugData = {
            metadata: channel.metadata,
            header: channel.header,
            shelves_summary: channel.shelves?.map(shelf => ({
                type: shelf.type,
                title: shelf.title?.text || null,
                content_type: shelf.content?.type || null,
                items_count: Array.isArray(shelf.content?.items) ? shelf.content.items.length : 0
            })),
            // Look for releases tab specifically
            releases_tab: channel.shelves?.find(shelf => 
                shelf.type?.includes('Release') || 
                (shelf.title?.text && shelf.title.text.includes('Release'))
            ),
            // Look for music tab
            music_tab: channel.shelves?.find(shelf => 
                shelf.type?.includes('Music') || 
                (shelf.title?.text && shelf.title.text.includes('Music'))
            ),
            // Look for artist info
            artist_info: channel.header?.artist_info || null,
            // Look for topic info
            topic_info: channel.metadata?.topic || null
        };
        
        res.header('Content-Type', 'application/json');
        res.send(JSON.stringify(debugData, null, 2));
    } catch (error) {
        console.error('Channel debug error:', error);
        res.status(500).json({ error: error.message });
    }
});

// Update the extractChannelTopic function to search for topic channel connections
function extractChannelTopic(channel) {
    try {
        // First, check if there's a TopicChannelDetails node anywhere in the channel data
        // This is the most direct way to get topic information
        
        // Check in header components
        if (channel.header?.contents) {
            for (const content of channel.header.contents) {
                if (content.type === 'TopicChannelDetails') {
                    console.log('Found TopicChannelDetails in header:', content);
                    return {
                        title: content.title?.text || '',
                        id: content.endpoint?.payload?.browseId || null,
                        url: content.endpoint?.metadata?.url || null,
                        type: 'topic_channel',
                        source: 'topic_channel_details'
                    };
                }
            }
        }
        
        // Look for topic channel in video endpoints
        // Often, videos in a channel have links to the topic channel in their metadata
        if (channel.videos?.length > 0) {
            console.log('Checking videos for topic channel references...');
            
            for (const video of channel.videos.slice(0, 5)) { // Check first 5 videos
                // Check if video has a music-related endpoint
                if (video.endpoint?.payload?.watchEndpoint?.musicVideoType) {
                    console.log('Found music video endpoint:', video.endpoint.payload.watchEndpoint);
                    
                    // Music videos often link to topic channels
                    return {
                        title: channel.metadata?.title ? `${channel.metadata.title} - Topic` : 'Music Artist',
                        id: video.endpoint.payload.watchEndpoint.musicVideoType,
                        type: 'topic_channel',
                        source: 'music_video_endpoint'
                    };
                }
            }
        }
        
        // Check for releases shelf - this is often where the topic connection is found
        let releasesShelf = channel.shelves?.find(shelf => 
            shelf.type?.includes('Release') || 
            (shelf.title?.text && shelf.title.text.includes('Release'))
        );
        
        if (releasesShelf) {
            console.log('Examining releases shelf for topic channel connection...');
            
            // Check if the shelf has a special browse endpoint
            if (releasesShelf.endpoint?.payload?.browseId) {
                const browseId = releasesShelf.endpoint.payload.browseId;
                
                // If the browseId is different from the current channel ID, it might be the topic channel
                if (browseId !== channel.metadata?.external_id) {
                    console.log('Found potential topic channel ID in releases shelf:', browseId);
                    return {
                        title: `${channel.metadata?.title || 'Artist'} - Topic`,
                        id: browseId,
                        url: releasesShelf.endpoint.metadata?.url || null,
                        type: 'topic_channel',
                        source: 'releases_shelf_endpoint'
                    };
                }
            }
            
            // Check for playlist IDs in the releases shelf
            if (releasesShelf.endpoint?.payload?.params) {
                console.log('Found params in releases shelf endpoint:', releasesShelf.endpoint.payload.params);
                
                // The params often contain encoded information about the topic channel
                return {
                    title: `${channel.metadata?.title || 'Artist'} - Topic`,
                    id: channel.metadata?.external_id || null,
                    params: releasesShelf.endpoint.payload.params,
                    url: releasesShelf.endpoint.metadata?.url || null,
                    type: 'topic_channel',
                    source: 'releases_shelf_params'
                };
            }
            
            // Check the first release item for topic channel info
            if (releasesShelf.content?.items?.length > 0) {
                const firstRelease = releasesShelf.content.items[0];
                
                // Debug the first release structure
                console.log('Examining first release item for topic channel connection:', 
                    JSON.stringify({
                        title: firstRelease.title?.text,
                        endpoint_type: firstRelease.endpoint?.type,
                        payload: firstRelease.endpoint?.payload,
                        navigation_type: firstRelease.endpoint?.payload?.watchEndpoint?.watchEndpointMusicSupportedConfigs?.watchEndpointMusicConfig?.musicVideoType
                    }, null, 2)
                );
                
                // Check for music video type in the endpoint
                if (firstRelease.endpoint?.payload?.watchEndpoint?.watchEndpointMusicSupportedConfigs?.watchEndpointMusicConfig?.musicVideoType) {
                    const musicVideoType = firstRelease.endpoint.payload.watchEndpoint.watchEndpointMusicSupportedConfigs.watchEndpointMusicConfig.musicVideoType;
                    console.log('Found music video type:', musicVideoType);
                    
                    return {
                        title: `${channel.metadata?.title || 'Artist'} - Topic`,
                        id: channel.metadata?.external_id || null,
                        music_video_type: musicVideoType,
                        type: 'topic_channel',
                        source: 'music_video_type'
                    };
                }
                
                // Check for playlist ID in the endpoint
                if (firstRelease.endpoint?.payload?.watchEndpoint?.playlistId) {
                    const playlistId = firstRelease.endpoint.payload.watchEndpoint.playlistId;
                    console.log('Found playlist ID in release:', playlistId);
                    
                    // Playlists often link to topic channels
                    return {
                        title: `${channel.metadata?.title || 'Artist'} - Topic`,
                        id: channel.metadata?.external_id || null,
                        playlist_id: playlistId,
                        type: 'topic_channel',
                        source: 'release_playlist'
                    };
                }
            }
        }
        
        // Continue with existing checks...
        
        // Check for topic in metadata
        if (channel.metadata?.topic) {
            return {
                title: channel.metadata.topic.title || channel.metadata.topic,
                id: channel.metadata.topic.id || null,
                url: channel.metadata.topic.url || null,
                source: 'metadata'
            };
        }
        
        // Check for artist info in header
        if (channel.header?.artist_info) {
            return {
                title: channel.header.artist_info.name || channel.header.artist_info.title,
                id: channel.header.artist_info.id || null,
                url: channel.header.artist_info.url || null,
                type: 'artist',
                source: 'header'
            };
        }
        
        // Check for releases tab - enhanced to look deeper
        if (releasesShelf) {
            console.log('Found releases shelf:', JSON.stringify({
                title: releasesShelf.title?.text,
                endpoint: releasesShelf.endpoint?.payload,
                content_type: releasesShelf.content?.type,
                items_count: releasesShelf.content?.items?.length || 0
            }, null, 2));
            
            // Try to extract from the shelf endpoint payload
            if (releasesShelf.endpoint?.payload?.browseId) {
                return {
                    title: releasesShelf.title?.text || 'Music Artist',
                    id: releasesShelf.endpoint.payload.browseId,
                    url: releasesShelf.endpoint.metadata?.url || null,
                    type: 'artist',
                    source: 'releases_shelf_endpoint'
                };
            }
            
            // Try to extract from the first release item
            if (releasesShelf.content?.items?.length > 0) {
                const firstRelease = releasesShelf.content.items[0];
                
                // Debug the first release structure
                console.log('First release item:', JSON.stringify({
                    title: firstRelease.title?.text,
                    subtitle: firstRelease.subtitle?.text,
                    endpoint: firstRelease.endpoint?.payload,
                    thumbnail: firstRelease.thumbnail?.[0]?.url
                }, null, 2));
                
                // Try to get from subtitle (often contains artist name)
                if (firstRelease.subtitle?.text) {
                    // For music releases, the subtitle often has format "Song · Artist"
                    const parts = firstRelease.subtitle.text.split('·').map(p => p.trim());
                    const artistName = parts.length > 1 ? parts[1] : firstRelease.subtitle.text;
                    
                    return {
                        title: artistName,
                        type: 'artist',
                        source: 'releases_shelf_item_subtitle'
                    };
                }
                
                // Try to get from endpoint
                if (firstRelease.endpoint?.payload?.videoId) {
                    return {
                        title: firstRelease.title?.text || 'Music Artist',
                        id: firstRelease.endpoint.payload.videoId,
                        url: firstRelease.endpoint.metadata?.url || null,
                        type: 'artist',
                        source: 'releases_shelf_item_endpoint'
                    };
                }
            }
        }
        
        // Check for music tab
        const musicShelf = channel.shelves?.find(shelf => 
            shelf.type?.includes('Music') || 
            (shelf.title?.text && shelf.title.text.includes('Music'))
        );
        
        if (musicShelf?.content?.items?.length > 0) {
            // Try to extract artist info from the first music item
            const firstMusic = musicShelf.content.items[0];
            
            // Debug the first music item
            console.log('First music item:', JSON.stringify({
                title: firstMusic.title?.text,
                subtitle: firstMusic.subtitle?.text,
                endpoint: firstMusic.endpoint?.payload
            }, null, 2));
            
            if (firstMusic.subtitle?.text) {
                // For music videos, the subtitle often has format "Artist · Album"
                const parts = firstMusic.subtitle.text.split('·').map(p => p.trim());
                const artistName = parts[0];
                
                return {
                    title: artistName,
                    type: 'artist',
                    source: 'music_shelf_item_subtitle'
                };
            }
        }
        
        // Check for topic in channel tagline
        const taglineShelf = channel.shelves?.find(shelf => 
            shelf.type === 'ChannelTagline' || 
            shelf.title?.text?.toLowerCase()?.includes('topic')
        );
        
        if (taglineShelf?.content?.text) {
            return {
                title: taglineShelf.content.text,
                type: 'tagline',
                source: 'tagline_shelf'
            };
        }
        
        // Check for topic in channel links
        const linksShelf = channel.shelves?.find(shelf => 
            shelf.type === 'ChannelHeaderLinks' || 
            shelf.title?.text?.toLowerCase()?.includes('link')
        );
        
        if (linksShelf?.content?.links) {
            const topicLink = linksShelf.content.links.find(link => 
                link.title?.toLowerCase()?.includes('topic') || 
                link.title?.toLowerCase()?.includes('artist')
            );
            
            if (topicLink) {
                return {
                    title: topicLink.title,
                    url: topicLink.url,
                    type: 'link',
                    source: 'links_shelf'
                };
            }
        }
        
        // If no topic found, return null
        return null;
    } catch (error) {
        console.error('Error extracting channel topic:', error);
        return null;
    }
}

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

// Modify the channel videos endpoint to batch process videos
app.get('/api/channel/:channelId/videos', async (req, res) => {
    try {
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 30;
        const type = req.query.type || 'videos';
        
        console.log(`Fetching ${type} for channel: ${req.params.channelId} (page ${page})`);
        const channel = await yt.getChannel(req.params.channelId);
        
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

// Add a more comprehensive debug endpoint for channel data
app.get('/api/debug/channel/full/:channelId', async (req, res) => {
    try {
        console.log('Full debugging for channel:', req.params.channelId);
        const channel = await yt.getChannel(req.params.channelId);
        
        // Extract all video endpoints to look for topic connections
        const videoEndpoints = [];
        if (channel.videos?.length > 0) {
            channel.videos.slice(0, 5).forEach(video => {
                if (video.endpoint) {
                    videoEndpoints.push({
                        title: video.title?.text || '',
                        endpoint: video.endpoint
                    });
                }
            });
        }
        
        // Look for all playlists that might contain topic information
        const playlists = [];
        if (channel.playlists?.length > 0) {
            channel.playlists.forEach(playlist => {
                playlists.push({
                    title: playlist.title?.text || '',
                    id: playlist.id,
                    endpoint: playlist.endpoint
                });
            });
        }
        
        // Create a comprehensive debug object
        const debugData = {
            channel_id: channel.metadata?.external_id,
            title: channel.metadata?.title,
            metadata: channel.metadata,
            header: channel.header,
            has_releases: channel.has_releases,
            releases_tab: channel.shelves?.find(shelf => 
                shelf.type?.includes('Release') || 
                (shelf.title?.text && shelf.title.text.includes('Release'))
            ),
            video_endpoints: videoEndpoints,
            playlists: playlists,
            topic_extraction_result: extractChannelTopic(channel)
        };
        
        res.header('Content-Type', 'application/json');
        res.send(JSON.stringify(debugData, null, 2));
    } catch (error) {
        console.error('Channel full debug error:', error);
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
