<?php
require '../config/config.php';

// Set the maximum execution time to 30 minutes
set_time_limit(1800);

// Increase memory limit if needed
ini_set('memory_limit', '512M');
ini_set('max_execution_time', 1800);

// Also add this to prevent client timeout
ini_set('default_socket_timeout', 600);

// Define the new API base URL
define('API_BASE_URL', 'https://graceful-emera-videovinkel-8402d192.koyeb.app/api');

// Add this at the top of the file after require statements
if (!file_exists('../logs')) {
    mkdir('../logs', 0777, true);
}
define('LOG_FILE', '../logs/fetch_videos.log');

function log_message($message, $type = 'INFO') {
    $date = date('Y-m-d H:i:s');
    $log_message = "[$date] [$type] $message" . PHP_EOL;
    error_log($log_message, 3, LOG_FILE);
}

// Function to make API requests
function make_api_request($endpoint, $params = [], $retries = 3) {
    $attempt = 0;
    while ($attempt < $retries) {
        try {
            $url = API_BASE_URL . $endpoint;
            if (!empty($params)) {
                $url .= '?' . http_build_query($params);
            }
            
            log_message("Attempting request to: $url (attempt " . ($attempt + 1) . ")");
            
            $ch = curl_init();
            curl_setopt($ch, CURLOPT_URL, $url);
            curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
            curl_setopt($ch, CURLOPT_SSL_VERIFYPEER, false);
            curl_setopt($ch, CURLOPT_TIMEOUT, 300);
            curl_setopt($ch, CURLOPT_CONNECTTIMEOUT, 60);
            
            // Add compression to reduce data transfer time
            curl_setopt($ch, CURLOPT_ENCODING, 'gzip,deflate');
            
            // Add keep-alive
            curl_setopt($ch, CURLOPT_TCP_KEEPALIVE, 1);
            curl_setopt($ch, CURLOPT_TCP_KEEPIDLE, 60);
            
            $response = curl_exec($ch);
            
            if (curl_errno($ch)) {
                throw new Exception(curl_error($ch));
            }
            
            $httpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);
            curl_close($ch);
            
            if ($httpCode === 524) {
                throw new Exception("Timeout error (524) - retrying...");
            }
            
            if ($httpCode !== 200) {
                throw new Exception("HTTP error $httpCode");
            }
            
            $decoded = json_decode($response, true);
            if (json_last_error() !== JSON_ERROR_NONE) {
                throw new Exception('Invalid JSON response: ' . json_last_error_msg());
            }
            
            return $decoded;
        } catch (Exception $e) {
            log_message("Request failed (attempt " . ($attempt + 1) . "): " . $e->getMessage(), 'ERROR');
            $attempt++;
            
            if ($attempt >= $retries) {
                throw new Exception("Failed after $retries attempts: " . $e->getMessage());
            }
            
            // Wait before retrying (exponential backoff)
            $waitTime = pow(2, $attempt) * 1000000; // microseconds
            usleep($waitTime);
        }
    }
}

// Function to save video to database
function save_video($conn, $video_id, $title, $description, $published_at, $thumbnail_url, $channel_id, $views, $is_short) {
    try {
        // Convert view count from format like "245K" to numeric
        if (is_string($views)) {
            // Remove any commas and spaces first
            $views = str_replace([',', ' '], '', $views);
            
            // Extract the numeric part and the suffix
            if (preg_match('/^(\d+\.?\d*)([KMB])?$/i', $views, $matches)) {
                $number = floatval($matches[1]);
                $suffix = strtoupper($matches[2] ?? '');
                
                switch ($suffix) {
                    case 'K':
                        $number *= 1000;
                        break;
                    case 'M':
                        $number *= 1000000;
                        break;
                    case 'B':
                        $number *= 1000000000;
                        break;
                }
                
                $views = floor($number); // Convert to integer
            } else {
                // If no suffix found, just convert to integer
                $views = (int)preg_replace('/[^0-9]/', '', $views);
            }
            
            log_message("Converted view count from '{$_views}' to {$views}");
        }

        // Convert published_at to MySQL datetime format if it's an ISO date
        if ($published_at && strpos($published_at, 'T') !== false) {
            $date = new DateTime($published_at);
            $published_at = $date->format('Y-m-d H:i:s');
        }

        // Ensure title isn't empty
        $title = trim($title) ?: 'Untitled';

        // Log the processed data
        log_message("Processing video data: " . json_encode([
            'video_id' => $video_id,
            'title' => $title,
            'published_at' => $published_at,
            'views' => $views,
            'is_short' => $is_short,
            'original_views' => $_views // Log the original value
        ]));

        // If published_at is NULL, set a default value
        if ($published_at === null || $published_at === '') {
            $published_at = date('Y-m-d H:i:s'); // Use current date as fallback
            log_message("Setting default published_at date for video $video_id: $published_at");
        }

        // Prepare the SQL statement
        $stmt = $conn->prepare("INSERT INTO videos 
            (video_id, title, description, published_at, thumbnail_url, channel_id, views, is_short) 
            VALUES (?, ?, ?, ?, ?, ?, ?, ?) 
            ON DUPLICATE KEY UPDATE 
            title = VALUES(title), 
            description = COALESCE(NULLIF(VALUES(description), ''), description),
            published_at = COALESCE(NULLIF(VALUES(published_at), ''), published_at),
            thumbnail_url = COALESCE(NULLIF(VALUES(thumbnail_url), ''), thumbnail_url),
            views = VALUES(views),
            is_short = VALUES(is_short)");
        
        if (!$stmt) {
            throw new Exception("Failed to prepare statement: " . $conn->error);
        }
        
        $stmt->bind_param("ssssssis", 
            $video_id, 
            $title, 
            $description, 
            $published_at, 
            $thumbnail_url, 
            $channel_id, 
            $views,
            $is_short
        );
        
        // Execute and check result
        $result = $stmt->execute();
        if (!$result) {
            throw new Exception("Failed to execute statement: " . $stmt->error);
        }
        
        log_message("Successfully saved/updated video: $video_id");
        $stmt->close();
        
    } catch (Exception $e) {
        log_message("Database error saving video $video_id: " . $e->getMessage(), 'ERROR');
        throw $e;
    }
}

// Function to save channel to database
function save_channel($conn, $channel_id, $title, $thumbnail_url, $banner_url, $topic_details = null) {
    // First save the main channel
    $stmt = $conn->prepare("INSERT INTO channels (channel_id, title, thumbnail_url, banner_url) 
                           VALUES (?, ?, ?, ?) 
                           ON DUPLICATE KEY UPDATE 
                           title=VALUES(title), 
                           thumbnail_url=VALUES(thumbnail_url), 
                           banner_url=VALUES(banner_url)");
    
    if ($stmt) {
        $stmt->bind_param("ssss", $channel_id, $title, $thumbnail_url, $banner_url);
        $stmt->execute();
        $stmt->close();
        
        // If we have topic details, save them too
        if ($topic_details && isset($topic_details['title']) && isset($topic_details['endpoint'])) {
            $topic_id = $topic_details['endpoint'];
            $topic_title = $topic_details['title'];
            $topic_subtitle = $topic_details['subtitle'] ?? '';
            $topic_avatar = $topic_details['avatar'] ?? '';
            
            $stmt = $conn->prepare("INSERT INTO topic_channels 
                                   (channel_id, topic_id, title, subtitle, avatar_url) 
                                   VALUES (?, ?, ?, ?, ?) 
                                   ON DUPLICATE KEY UPDATE 
                                   title=VALUES(title), 
                                   subtitle=VALUES(subtitle), 
                                   avatar_url=VALUES(avatar_url)");
            
            if ($stmt) {
                $stmt->bind_param("sssss", $channel_id, $topic_id, $topic_title, $topic_subtitle, $topic_avatar);
                $stmt->execute();
                $stmt->close();
                log_message("Saved topic channel info for: $topic_title (ID: $topic_id)");
            }
        }
    } else {
        throw new Exception("Database error: " . $conn->error);
    }
}

// Update fetch_progress table structure
$sql = "CREATE TABLE IF NOT EXISTS fetch_progress (
    id INT AUTO_INCREMENT PRIMARY KEY,
    channel_id VARCHAR(30) NOT NULL,
    type VARCHAR(10) NOT NULL DEFAULT 'videos',
    page INT NOT NULL DEFAULT 1,
    status VARCHAR(20) NOT NULL DEFAULT 'pending',
    items_fetched INT NOT NULL DEFAULT 0,
    last_error TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY unique_channel_type (channel_id, type)
)";

try {
    $conn->query($sql);
    log_message("Ensured fetch_progress table structure");
} catch (Exception $e) {
    log_message("Error creating fetch_progress table: " . $e->getMessage(), 'ERROR');
}

// Function to get fetch progress
function get_fetch_progress($conn, $channel_id, $type = 'videos') {
    try {
        $stmt = $conn->prepare("SELECT * FROM fetch_progress WHERE channel_id = ? AND type = ?");
        $stmt->bind_param("ss", $channel_id, $type);
        $stmt->execute();
        $result = $stmt->get_result();
        $progress = $result->fetch_assoc();
        $stmt->close();
        return $progress ?: [
            'channel_id' => $channel_id,
            'type' => $type,
            'page' => 1,
            'status' => 'pending',
            'items_fetched' => 0
        ];
    } catch (Exception $e) {
        log_message("Error getting fetch progress: " . $e->getMessage(), 'ERROR');
        throw $e;
    }
}

// Function to update fetch progress
function update_fetch_progress($conn, $channel_id, $page, $status, $items_fetched, $type = 'videos', $error = null) {
    try {
        $stmt = $conn->prepare("INSERT INTO fetch_progress 
            (channel_id, type, page, status, items_fetched, last_error) 
            VALUES (?, ?, ?, ?, ?, ?)
            ON DUPLICATE KEY UPDATE 
            page = VALUES(page),
            status = VALUES(status),
            items_fetched = VALUES(items_fetched),
            last_error = VALUES(last_error),
            updated_at = CURRENT_TIMESTAMP");
        
        $stmt->bind_param("ssisss", 
            $channel_id, 
            $type, 
            $page, 
            $status, 
            $items_fetched, 
            $error
        );
        
        $stmt->execute();
        $stmt->close();
        
        log_message("Updated fetch progress for $channel_id ($type): page $page, status $status, items $items_fetched");
    } catch (Exception $e) {
        log_message("Error updating fetch progress: " . $e->getMessage(), 'ERROR');
        throw $e;
    }
}

// Modify the fetch_channel_videos function to process in larger batches
function fetch_channel_videos($channel_id, $resume = true, $type = 'videos') {
    global $conn;
    $fetchedCount = 0;
    $page = 1;
    $batchSize = 50; // Increased batch size
    
    try {
        // Get existing progress if resuming
        if ($resume) {
            $progress = get_fetch_progress($conn, $channel_id, $type);
            if ($progress['status'] === 'completed') {
                return $progress['items_fetched'];
            }
            $page = $progress['status'] === 'failed' ? 1 : $progress['page'];
            $fetchedCount = $progress['items_fetched'];
        }
        
        update_fetch_progress($conn, $channel_id, $page, 'in_progress', $fetchedCount, $type);
        
        $hasMore = true;
        while ($hasMore) {
            $response = make_api_request("/channel/$channel_id/$type", [
                'page' => $page,
                'limit' => $batchSize
            ]);
            
            if (isset($response[$type]) && is_array($response[$type])) {
                // Prepare batch insert
                $values = [];
                $types = '';
                $params = [];
                
                foreach ($response[$type] as $item) {
                    $values[] = "(?, ?, ?, ?, ?, ?, ?, ?)";
                    $types .= "ssssssis";
                    array_push($params,
                        $item['video_id'],
                        $item['title'],
                        $item['description'] ?? '',
                        $item['published_at'],
                        $item['thumbnail_url'],
                        $channel_id,
                        $item['views'],
                        $type === 'shorts' ? 1 : 0
                    );
                }
                
                if (!empty($values)) {
                    // Batch insert/update
                    $sql = "INSERT INTO videos 
                            (video_id, title, description, published_at, thumbnail_url, channel_id, views, is_short)
                            VALUES " . implode(',', $values) . "
                            ON DUPLICATE KEY UPDATE
                            title = VALUES(title),
                            description = COALESCE(NULLIF(VALUES(description), ''), description),
                            published_at = COALESCE(NULLIF(VALUES(published_at), ''), published_at),
                            thumbnail_url = COALESCE(NULLIF(VALUES(thumbnail_url), ''), thumbnail_url),
                            views = VALUES(views),
                            is_short = VALUES(is_short)";
                    
                    $stmt = $conn->prepare($sql);
                    $stmt->bind_param($types, ...$params);
                    $stmt->execute();
                    $stmt->close();
                    
                    $fetchedCount += count($response[$type]);
                }
            }
            
            update_fetch_progress($conn, $channel_id, $page, 'in_progress', $fetchedCount, $type);
            
            $hasMore = $response['pagination']['has_more'] ?? false;
            if ($hasMore) {
                $page++;
                usleep(100000); // Reduced delay between batches
            }
        }
        
        update_fetch_progress($conn, $channel_id, $page, 'completed', $fetchedCount, $type);
        return $fetchedCount;
        
    } catch (Exception $e) {
        update_fetch_progress($conn, $channel_id, $page, 'failed', $fetchedCount, $type, $e->getMessage());
        throw $e;
    }
}

// Add this SQL to create a topic_channels table
$sql = "CREATE TABLE IF NOT EXISTS topic_channels (
    id INT AUTO_INCREMENT PRIMARY KEY,
    channel_id VARCHAR(30) NOT NULL,
    topic_id VARCHAR(30) NOT NULL,
    title VARCHAR(255) NOT NULL,
    subtitle VARCHAR(255),
    avatar_url VARCHAR(255),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY unique_channel_topic (channel_id, topic_id)
)";

try {
    $conn->query($sql);
    log_message("Ensured topic_channels table structure");
} catch (Exception $e) {
    log_message("Error creating topic_channels table: " . $e->getMessage(), 'ERROR');
}

// Add a function to fetch topic channel data
function fetch_topic_channel($topic_id) {
    try {
        log_message("Fetching topic channel: $topic_id");
        $response = make_api_request("/topic/$topic_id");
        
        if (isset($response['id'])) {
            log_message("Successfully fetched topic channel: " . $response['title']);
            return $response;
        } else {
            log_message("Warning: Topic channel info not found in response", 'WARN');
            return null;
        }
    } catch (Exception $e) {
        log_message("Error fetching topic channel: " . $e->getMessage(), 'ERROR');
        return null;
    }
}

// Add this SQL to create playlists table
$sql = "CREATE TABLE IF NOT EXISTS playlists (
    id INT AUTO_INCREMENT PRIMARY KEY,
    playlist_id VARCHAR(30) NOT NULL,
    title VARCHAR(255) NOT NULL,
    thumbnail_url VARCHAR(255),
    channel_id VARCHAR(30) NOT NULL,
    type VARCHAR(50) DEFAULT 'Album',
    release_date DATETIME NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY unique_playlist (playlist_id)
)";

try {
    $conn->query($sql);
    log_message("Ensured playlists table structure");
} catch (Exception $e) {
    log_message("Error creating playlists table: " . $e->getMessage(), 'ERROR');
}

// Add this SQL to create video_playlists table
$sql = "CREATE TABLE IF NOT EXISTS video_playlists (
    id INT AUTO_INCREMENT PRIMARY KEY,
    video_id VARCHAR(30) NOT NULL,
    playlist_id VARCHAR(30) NOT NULL,
    position INT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY unique_video_playlist (video_id, playlist_id)
)";

try {
    $conn->query($sql);
    log_message("Ensured video_playlists table structure");
} catch (Exception $e) {
    log_message("Error creating video_playlists table: " . $e->getMessage(), 'ERROR');
}

// Function to save playlist to database
function save_playlist($conn, $playlist_id, $title, $thumbnail_url, $channel_id, $type = 'Album', $release_date = null) {
    try {
        // Prepare the SQL statement
        $stmt = $conn->prepare("INSERT INTO playlists 
            (playlist_id, title, thumbnail_url, channel_id, type, release_date) 
            VALUES (?, ?, ?, ?, ?, ?) 
            ON DUPLICATE KEY UPDATE 
            title = VALUES(title), 
            thumbnail_url = COALESCE(NULLIF(VALUES(thumbnail_url), ''), thumbnail_url),
            type = VALUES(type),
            release_date = COALESCE(NULLIF(VALUES(release_date), ''), release_date)");
        
        if (!$stmt) {
            throw new Exception("Failed to prepare statement: " . $conn->error);
        }
        
        $stmt->bind_param("ssssss", 
            $playlist_id, 
            $title, 
            $thumbnail_url, 
            $channel_id,
            $type,
            $release_date
        );
        
        // Execute and check result
        $result = $stmt->execute();
        if (!$result) {
            throw new Exception("Failed to execute statement: " . $stmt->error);
        }
        
        log_message("Successfully saved/updated playlist: $playlist_id" . ($release_date ? " with release date: $release_date" : ""));
        $stmt->close();
        
    } catch (Exception $e) {
        log_message("Database error saving playlist $playlist_id: " . $e->getMessage(), 'ERROR');
        throw $e;
    }
}

// Function to save playlist video (without adding to main videos table)
function save_playlist_video($conn, $video_id, $playlist_id, $position = null) {
    try {
        // Prepare the SQL statement - only insert into video_playlists table
        $stmt = $conn->prepare("INSERT INTO video_playlists 
            (video_id, playlist_id, position) 
            VALUES (?, ?, ?) 
            ON DUPLICATE KEY UPDATE 
            position = VALUES(position)");
        
        if (!$stmt) {
            throw new Exception("Failed to prepare statement: " . $conn->error);
        }
        
        $stmt->bind_param("ssi", 
            $video_id, 
            $playlist_id, 
            $position
        );
        
        // Execute and check result
        $result = $stmt->execute();
        if (!$result) {
            throw new Exception("Failed to execute statement: " . $stmt->error);
        }
        
        log_message("Successfully saved playlist video: $video_id in playlist $playlist_id at position $position");
        $stmt->close();
        
    } catch (Exception $e) {
        log_message("Database error saving playlist video $video_id: " . $e->getMessage(), 'ERROR');
        throw $e;
    }
}

// Enhanced approach to extract release date from videos
function extract_release_date_from_playlist($playlist_id, $videos) {
    if (empty($videos) || !is_array($videos)) {
        return null;
    }
    
    $publish_dates = [];
    
    // Collect publish dates from up to 3 videos
    $videos_to_check = array_slice($videos, 0, 3);
    foreach ($videos_to_check as $video) {
        if (!empty($video['published_at'])) {
            $date = parse_release_date($video['published_at']);
            if ($date) {
                $publish_dates[] = $date;
                log_message("Found publish date for video {$video['video_id']}: $date");
            }
        }
    }
    
    if (!empty($publish_dates)) {
        // Sort dates to find the earliest one
        sort($publish_dates);
        $release_date = $publish_dates[0];
        log_message("Using earliest video publish date as release date for playlist $playlist_id: $release_date");
        return $release_date;
    }
    
    return null;
}

// Function to fetch channel releases (playlists)
function fetch_channel_releases($channel_id, $resume = true) {
    global $conn;
    $fetchedCount = 0;
    $page = 1;
    
    try {
        // Get existing progress if resuming
        if ($resume) {
            $progress = get_fetch_progress($conn, $channel_id, 'releases');
            if ($progress['status'] === 'completed') {
                return $progress['items_fetched'];
            }
            $page = $progress['status'] === 'failed' ? 1 : $progress['page'];
            $fetchedCount = $progress['items_fetched'];
        }
        
        update_fetch_progress($conn, $channel_id, $page, 'in_progress', $fetchedCount, 'releases');
        
        $hasMore = true;
        while ($hasMore) {
            $response = make_api_request("/channel/$channel_id/releases/videos", [
                'page' => $page
            ]);
            
            if (isset($response['releases']) && is_array($response['releases'])) {
                foreach ($response['releases'] as $release) {
                    // Skip if missing required fields
                    if (empty($release['playlist_id']) || empty($release['title'])) {
                        log_message("Skipping release with missing required fields", 'WARN');
                        continue;
                    }
                    
                    // First try to extract release date from videos (most reliable)
                    $release_date = null;
                    if (!empty($release['videos']) && is_array($release['videos'])) {
                        $release_date = extract_release_date_from_playlist($release['playlist_id'], $release['videos']);
                    }
                    
                    // If no date from videos, try other methods
                    if (!$release_date) {
                        // Try to extract from raw metadata
                        if (!empty($release['raw_metadata'])) {
                            log_message("Examining raw metadata for release date: " . json_encode($release['raw_metadata']));
                            
                            // Try different paths where release date might be found
                            if (!empty($release['raw_metadata']['publish_date'])) {
                                $release_date = parse_release_date($release['raw_metadata']['publish_date']);
                            } elseif (!empty($release['raw_metadata']['date'])) {
                                $release_date = parse_release_date($release['raw_metadata']['date']);
                            } elseif (!empty($release['raw_metadata']['year'])) {
                                // If only year is available, use January 1st of that year
                                $release_date = $release['raw_metadata']['year'] . '-01-01';
                            } elseif (!empty($release['raw_metadata']['description_snippet']['text'])) {
                                $desc = $release['raw_metadata']['description_snippet']['text'];
                                
                                // Try various date patterns
                                if (preg_match('/Released on:?\s*(\d{4}-\d{2}-\d{2})/i', $desc, $matches)) {
                                    $release_date = $matches[1];
                                } elseif (preg_match('/Release date:?\s*(\d{4}-\d{2}-\d{2})/i', $desc, $matches)) {
                                    $release_date = $matches[1];
                                } elseif (preg_match('/Released:?\s*(\d{4}-\d{2}-\d{2})/i', $desc, $matches)) {
                                    $release_date = $matches[1];
                                } elseif (preg_match('/(\d{1,2})[\/\-\.](\d{1,2})[\/\-\.](\d{4})/', $desc, $matches)) {
                                    // Assume MM/DD/YYYY format
                                    $release_date = sprintf('%04d-%02d-%02d', $matches[3], $matches[1], $matches[2]);
                                } elseif (preg_match('/(\d{4})[\/\-\.](\d{1,2})[\/\-\.](\d{1,2})/', $desc, $matches)) {
                                    // YYYY/MM/DD format
                                    $release_date = sprintf('%04d-%02d-%02d', $matches[1], $matches[2], $matches[3]);
                                }
                            }
                            
                            if ($release_date) {
                                log_message("Extracted release date from metadata: $release_date");
                            }
                        }
                    }
                    
                    // If still no release date, try to extract year from title
                    if (!$release_date) {
                        if (preg_match('/\b(19\d{2}|20\d{2})\b/', $release['title'], $matches)) {
                            $release_date = $matches[1] . '-01-01';
                            log_message("Extracted year from title: $release_date");
                        }
                    }
                    
                    // If still no release date, use the first video's date if available
                    if (!$release_date && !empty($release['videos']) && !empty($release['videos'][0]['published_at'])) {
                        $release_date = parse_release_date($release['videos'][0]['published_at']);
                        log_message("Using first video's publish date: $release_date");
                    }
                    
                    // Save the playlist with release date
                    save_playlist(
                        $conn,
                        $release['playlist_id'],
                        $release['title'],
                        $release['thumbnail_url'] ?? '',
                        $channel_id,
                        $release['type'] ?? 'Album',
                        $release_date
                    );
                    
                    // Process videos in the playlist
                    if (isset($release['videos']) && is_array($release['videos'])) {
                        $position = 0;
                        foreach ($release['videos'] as $video) {
                            // Skip if missing video_id
                            if (empty($video['video_id'])) {
                                log_message("Skipping video with missing video_id", 'WARN');
                                continue;
                            }
                            
                            try {
                                // Only save to video_playlists table, not to videos table
                                save_playlist_video(
                                    $conn,
                                    $video['video_id'],
                                    $release['playlist_id'],
                                    $position++
                                );
                                
                                // If we have the playlist_videos table, save video details there
                                if ($conn->query("SHOW TABLES LIKE 'playlist_videos'")->num_rows > 0) {
                                    $stmt = $conn->prepare("INSERT INTO playlist_videos 
                                        (video_id, title, thumbnail_url, duration, playlist_id, position) 
                                        VALUES (?, ?, ?, ?, ?, ?) 
                                        ON DUPLICATE KEY UPDATE 
                                        title = VALUES(title),
                                        thumbnail_url = VALUES(thumbnail_url),
                                        duration = VALUES(duration),
                                        position = VALUES(position)");
                                    
                                    if ($stmt) {
                                        $stmt->bind_param("sssssi", 
                                            $video['video_id'], 
                                            $video['title'] ?? 'Untitled', 
                                            $video['thumbnail_url'] ?? '', 
                                            $video['duration'] ?? '', 
                                            $release['playlist_id'], 
                                            $position - 1
                                        );
                                        
                                        $stmt->execute();
                                        $stmt->close();
                                        
                                        log_message("Saved video details to playlist_videos: {$video['video_id']}");
                                    }
                                }
                            } catch (Exception $e) {
                                log_message("Error saving video {$video['video_id']} from playlist: " . $e->getMessage(), 'ERROR');
                                // Continue with next video instead of failing the entire process
                                continue;
                            }
                        }
                    }
                    
                    $fetchedCount++;
                }
            }
            
            update_fetch_progress($conn, $channel_id, $page, 'in_progress', $fetchedCount, 'releases');
            
            $hasMore = $response['pagination']['has_more'] ?? false;
            if ($hasMore) {
                $page++;
                usleep(500000); // 0.5 second delay between batches
            }
        }
        
        update_fetch_progress($conn, $channel_id, $page, 'completed', $fetchedCount, 'releases');
        return $fetchedCount;
        
    } catch (Exception $e) {
        update_fetch_progress($conn, $channel_id, $page, 'failed', $fetchedCount, 'releases', $e->getMessage());
        throw $e;
    }
}

// Helper function to parse various date formats into MySQL format
function parse_release_date($date_string) {
    if (empty($date_string)) {
        return null;
    }
    
    // If it's already in YYYY-MM-DD format, return it
    if (preg_match('/^\d{4}-\d{2}-\d{2}$/', $date_string)) {
        return $date_string;
    }
    
    // Try to parse with DateTime
    try {
        $date = new DateTime($date_string);
        return $date->format('Y-m-d');
    } catch (Exception $e) {
        // If DateTime parsing fails, try manual parsing
    }
    
    // Try various date formats
    // MM/DD/YYYY or DD/MM/YYYY
    if (preg_match('/(\d{1,2})[\/\-\.](\d{1,2})[\/\-\.](\d{4})/', $date_string, $matches)) {
        // Assume MM/DD/YYYY format for simplicity
        return sprintf('%04d-%02d-%02d', $matches[3], $matches[1], $matches[2]);
    }
    
    // YYYY/MM/DD
    if (preg_match('/(\d{4})[\/\-\.](\d{1,2})[\/\-\.](\d{1,2})/', $date_string, $matches)) {
        return sprintf('%04d-%02d-%02d', $matches[1], $matches[2], $matches[3]);
    }
    
    // Just a year
    if (preg_match('/^(19\d{2}|20\d{2})$/', $date_string)) {
        return $date_string . '-01-01';
    }
    
    // Month Year (e.g., "January 2020")
    if (preg_match('/([a-zA-Z]+)\s+(\d{4})/', $date_string, $matches)) {
        $month_names = [
            'january' => 1, 'february' => 2, 'march' => 3, 'april' => 4,
            'may' => 5, 'june' => 6, 'july' => 7, 'august' => 8,
            'september' => 9, 'october' => 10, 'november' => 11, 'december' => 12
        ];
        
        $month = strtolower($matches[1]);
        if (isset($month_names[$month])) {
            return sprintf('%04d-%02d-01', $matches[2], $month_names[$month]);
        }
    }
    
    // If all parsing attempts fail, return null
    return null;
}

// Update the fetch_all_channel_content function to include releases
function fetch_all_channel_content($channel_id, $resume = true) {
    global $conn;
    $total_fetched = 0;
    
    try {
        log_message("Starting to fetch all content for channel $channel_id");
        
        // First fetch and save channel info
        log_message("Fetching channel info...");
        $channel_response = make_api_request("/channel/$channel_id");
        
        if (isset($channel_response['id'])) {
            // Check if there's topic channel info
            $topic_details = $channel_response['topic_details'] ?? null;
            
            // Save the channel with topic details if available
            save_channel(
                $conn,
                $channel_response['id'],
                $channel_response['title'],
                $channel_response['thumbnail_url'],
                $channel_response['banner_url'],
                $topic_details
            );
            
            log_message("Saved channel info for: " . $channel_response['title']);
            
            // If we have topic details with an endpoint, fetch that too
            if ($topic_details && isset($topic_details['endpoint'])) {
                $topic_id = $topic_details['endpoint'];
                $topic_channel = fetch_topic_channel($topic_id);
                
                if ($topic_channel) {
                    log_message("Successfully fetched related topic channel: " . $topic_channel['title']);
                }
            }
        } else {
            log_message("Warning: Channel info not found in response", 'WARN');
        }
        
        // Then fetch regular videos
        log_message("Fetching regular videos...");
        $videos_count = fetch_channel_videos($channel_id, $resume, 'videos');
        $total_fetched += $videos_count;
        log_message("Completed fetching regular videos. Count: $videos_count");
        
        // Then fetch shorts
        log_message("Fetching shorts...");
        $shorts_count = fetch_channel_videos($channel_id, $resume, 'shorts');
        $total_fetched += $shorts_count;
        log_message("Completed fetching shorts. Count: $shorts_count");
        
        // Then fetch releases (playlists)
        log_message("Fetching releases (playlists)...");
        $releases_count = fetch_channel_releases($channel_id, $resume);
        $total_fetched += $releases_count;
        log_message("Completed fetching releases. Count: $releases_count");
        
        return [
            'total' => $total_fetched,
            'videos' => $videos_count,
            'shorts' => $shorts_count,
            'releases' => $releases_count,
            'channel' => [
                'id' => $channel_response['id'] ?? null,
                'title' => $channel_response['title'] ?? null,
                'thumbnail' => $channel_response['thumbnail_url'] ?? null,
                'banner' => $channel_response['banner_url'] ?? null,
                'has_topic' => isset($channel_response['topic_details'])
            ]
        ];
    } catch (Exception $e) {
        log_message("Error in fetch_all_channel_content: " . $e->getMessage(), 'ERROR');
        throw $e;
    }
}

// Modify the POST handler to include releases in the response
if ($_SERVER['REQUEST_METHOD'] === 'POST') {
    try {
        $channelUrl = $_POST['channelUrl'] ?? '';
        $resume = isset($_POST['resume']) ? filter_var($_POST['resume'], FILTER_VALIDATE_BOOLEAN) : true;
        
        if (empty($channelUrl)) {
            throw new Exception('Channel URL is required');
        }

        if (!preg_match('/(channel|user|c)\/([^\/]+)/', $channelUrl, $matches)) {
            throw new Exception('Invalid YouTube channel URL format');
        }

        $channelId = $matches[2];
        $results = fetch_all_channel_content($channelId, $resume);
        
        // Get progress for all types
        $videos_progress = get_fetch_progress($conn, $channelId, 'videos');
        $shorts_progress = get_fetch_progress($conn, $channelId, 'shorts');
        $releases_progress = get_fetch_progress($conn, $channelId, 'releases');
        
        echo json_encode([
            'success' => "Channel content fetched successfully!",
            'total_fetched' => $results['total'],
            'regular_videos' => $results['videos'],
            'shorts' => $results['shorts'],
            'releases' => $results['releases'],
            'videos_status' => $videos_progress['status'],
            'shorts_status' => $shorts_progress['status'],
            'releases_status' => $releases_progress['status']
        ]);

    } catch (Exception $e) {
        error_log("Error in fetch_videos.php: " . $e->getMessage());
        http_response_code(400);
        echo json_encode(['error' => $e->getMessage()]);
    }
}

// Add this near the top of the file with other table creation code
$sql = "ALTER TABLE videos ADD COLUMN IF NOT EXISTS is_short TINYINT(1) NOT NULL DEFAULT 0";

try {
    $conn->query($sql);
    log_message("Added is_short column to videos table");
} catch (Exception $e) {
    log_message("Error adding is_short column: " . $e->getMessage(), 'ERROR');
}

$conn->close();
?>
