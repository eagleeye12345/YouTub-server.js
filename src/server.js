import express from 'express';
import { Innertube } from 'youtubei.js';
import cors from 'cors';

const app = express();
const port = process.env.PORT || 3000;

// Enable CORS
app.use(cors());
app.use(express.json());

// Initialize YouTube client
let yt;
(async () => {
  yt = await Innertube.create();
})();

// Basic health check endpoint
app.get('/', (req, res) => {
  res.json({ status: 'YouTube API service is running' });
});

// Get channel info endpoint
app.get('/api/channel/:channelId', async (req, res) => {
  try {
    console.log('Fetching channel:', req.params.channelId);
    const channel = await yt.getChannel(req.params.channelId);
    console.log('Channel response:', channel);
    const channelInfo = {
      id: channel.info.channel_id,
      title: channel.info.title,
      thumbnail: channel.info.thumbnail[0].url,
      banner: channel.info.banner?.desktop[0]?.url,
      uploadPlaylistId: channel.info.content?.upload_playlist_id
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
      videoId: videoInfo.basic_info.id,
      title: videoInfo.basic_info.title,
      description: videoInfo.basic_info.description,
      thumbnail: videoInfo.basic_info.thumbnail[0].url,
      views: videoInfo.basic_info.view_count,
      publishDate: videoInfo.basic_info.publish_date,
      channelId: videoInfo.basic_info.channel_id,
      channelTitle: videoInfo.basic_info.channel.name
    };
    res.json(simplifiedInfo);
  } catch (error) {
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
      videoId: video.id,
      title: video.title,
      thumbnail: video.thumbnails[0].url
    }));
    res.json(simplifiedResults);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get playlist videos endpoint
app.get('/api/playlist/:playlistId', async (req, res) => {
  try {
    const playlist = await yt.getPlaylist(req.params.playlistId);
    const videos = playlist.videos.map(video => ({
      videoId: video.id,
      title: video.title,
      thumbnail: video.thumbnails[0].url,
      publishDate: video.published,
      description: video.description,
      views: video.view_count
    }));
    res.json(videos);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.listen(port, () => {
  console.log(`Server running on port ${port}`);
}); 
