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
    const channel = await yt.getChannel(req.params.channelId);
    const channelInfo = {
      id: channel.info.channel_id,
      title: channel.info.title,
      thumbnail_url: channel.info.thumbnail?.[0]?.url,
      banner_url: channel.info.banner?.[0]?.url,
      uploads: channel.info.playlist_id // This is the uploads playlist ID
    };
    res.json(channelInfo);
  } catch (error) {
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
      channel_id: videoInfo.basic_info.channel_id,
      channel_title: videoInfo.basic_info.channel.name,
      channel_thumbnail: videoInfo.basic_info.channel.thumbnails[0].url
    };
    res.json(simplifiedInfo);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get channel videos endpoint
app.get('/api/channel/:channelId/videos', async (req, res) => {
  try {
    const channel = await yt.getChannel(req.params.channelId);
    const videos = await channel.getVideos();
    const simplifiedVideos = videos.map(video => ({
      video_id: video.id,
      title: video.title,
      description: video.description,
      thumbnail_url: video.thumbnails[0].url,
      published_at: video.published.text,
      views: video.view_count,
      channel_id: req.params.channelId
    }));
    res.json(simplifiedVideos);
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
      video_id: video.id,
      title: video.title,
      description: video.description,
      thumbnail_url: video.thumbnails[0].url,
      published_at: video.published,
      views: video.view_count,
      channel_id: video.channel?.id,
      channel_title: video.channel?.name,
      channel_thumbnail: video.channel?.thumbnails[0]?.url
    }));
    res.json(simplifiedResults);
  } catch (error) {
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

app.listen(port, () => {
  console.log(`Server running on port ${port}`);
}); 
