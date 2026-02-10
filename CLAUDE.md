# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

YT Comment Carbon Copy is a Chrome Manifest V3 extension that captures comments you submit on YouTube and detects when they get deleted.

## Architecture

### Content Script ([content.js](src/content.js))
- Injected into all YouTube pages (`*://*.youtube.com/*`)
- Uses MutationObserver to detect when comment submit button appears
- Captures comment text on submit (both click and Ctrl/Cmd+Enter) and sends to background script
- Supports both regular videos and YouTube Shorts
- Deduplicates captures to avoid saving the same comment twice
- Responds to VERIFY_COMMENTS requests to check if comments still exist on page

### Background Service Worker ([background.js](src/background.js))
- Central message hub and storage manager
- Handles SAVE_COMMENT, GET_COMMENTS, CHECK_COMMENTS, CHECK_ALL_COMMENTS actions
- Stores comments in `chrome.storage.local` with structure:
  ```javascript
  { comments: { [id]: { text, videoId, videoTitle, status, submittedAt, ... } } }
  ```
- Coordinates deletion detection between popup and content script
- Opens background tabs for batch comment verification across multiple videos

### Popup UI ([popup.html](src/popup.html), [popup.js](src/popup.js))
- Displays all captured comments sorted by date
- "Check Current Video" button triggers deletion detection for current video
- "Check All Comments" button triggers batch verification across all videos
- Dark theme support via `prefers-color-scheme` media query
- Progress indicator for batch operations
- Visual distinction for deleted comments (red styling)
- Copy button for each comment

### Message Flow

**Comment Submission:**
```
Submit comment → content.js → SAVE_COMMENT → background.js → storage
```

**Check Current Video:**
```
Check button → popup.js → CHECK_COMMENTS → background.js → VERIFY_COMMENTS → content.js
                                                        ↓
                                                 Update storage
                                                        ↓
                                              Refresh popup display
```

**Check All Comments (Batch):**
```
Check All button → popup.js → CHECK_ALL_COMMENTS → background.js
                                                        ↓
                                          For each video with active comments:
                                            1. Open video in background tab
                                            2. Wait for page load
                                            3. VERIFY_COMMENTS → content.js
                                            4. Update storage
                                            5. Close tab
                                                        ↓
                                              Refresh popup display
```

## Development Commands

### Loading the Extension
1. Open Chrome → `chrome://extensions/`
2. Enable "Developer mode" (top right toggle)
3. Click "Load unpacked" → Select the `src/` directory

### Testing Changes
- After changes: Click refresh icon on extension card in `chrome://extensions/`
- Content script changes: Also reload the YouTube page
- Popup changes: Close and reopen the popup

### Debugging
- **Content script**: F12 on YouTube page → Console tab
- **Background script**: `chrome://extensions/` → Click "service worker" link
- **Popup**: Right-click extension icon → "Inspect popup"

## Icons

### Regenerating Icon Assets
Icon assets live in `src/icons/` and are generated with ImageMagick (`magick`).
Small sizes (`16/32/48`) use a pixel-art style; large sizes (`128/512`) use smooth
vector-style drawing. If you change the design, regenerate all sizes to keep
consistency with `manifest.json`.

#### Pixel-art icons (16/32/48)
```bash
magick -size 16x16 xc:'#d32f2f' \
  -stroke '#a31515' -strokewidth 1 -fill none -draw "roundrectangle 0,0 15,15 4,4" \
  -stroke '#b11a1a' -strokewidth 1 -fill '#f0dfdf' -draw "roundrectangle 2,3 10,8 2,2" \
  -stroke '#b11a1a' -strokewidth 1 -fill '#ffffff' -draw "roundrectangle 4,5 12,10 2,2" \
  -stroke '#b11a1a' -strokewidth 1 -fill '#ffffff' -draw "polygon 6,10 8,10 5,12" \
  -stroke none -fill '#f3b3b3' -draw "roundrectangle 5,6 11,6 1,1" \
  -stroke none -fill '#f3b3b3' -draw "roundrectangle 5,8 9,8 1,1" \
  src/icons/icon-16.png

magick src/icons/icon-16.png -filter point -resize 32x32 src/icons/icon-32.png
magick src/icons/icon-16.png -filter point -resize 48x48 src/icons/icon-48.png
```

#### Smooth icons (128/512)
```bash
magick -size 512x512 xc:none \
  -fill '#d32f2f' -stroke '#a31515' -strokewidth 12 -draw "roundrectangle 8,8 504,504 72,72" \
  -stroke '#b11a1a' -strokewidth 12 -fill '#f0dfdf' -draw "roundrectangle 72,88 344,288 40,40" \
  -stroke '#b11a1a' -strokewidth 16 -fill '#ffffff' -draw "roundrectangle 136,152 424,360 48,48" \
  -stroke '#b11a1a' -strokewidth 16 -fill '#ffffff' -draw "polygon 224,360 280,360 208,432" \
  -stroke none -fill '#f3b3b3' -draw "roundrectangle 176,208 384,232 16,16" \
  -stroke none -fill '#f3b3b3' -draw "roundrectangle 176,264 320,288 16,16" \
  src/icons/icon-512.png

magick src/icons/icon-512.png -alpha set \
  \( -size 512x512 xc:none -fill white -draw "roundrectangle 0,0 511,511 80,80" \) \
  -compose DstIn -composite src/icons/icon-512.png

magick src/icons/icon-512.png -filter Lanczos -resize 128x128 src/icons/icon-128.png
```

## Code Patterns

### DOM Selectors (may break if YouTube changes HTML)
- `#submit-button` / `#submit-button button` - Comment submit button
- `#contenteditable-root` - Comment input field
- `#content-text` - Existing comment elements on page
- `ytd-comments` - Comments section container

### Chrome Extension APIs Used
- `chrome.storage.local` - Persistent comment storage
- `chrome.runtime.sendMessage` - Content ↔ Background communication
- `chrome.tabs.sendMessage` - Background → Content communication
- `chrome.tabs.query` - Get active tab info

### WeakSet Pattern
Content script uses `WeakSet` to track processed buttons and prevent duplicate event listeners when MutationObserver fires multiple times.

## Permissions
- `activeTab` - Access to currently active tab
- `storage` - Chrome storage API for persisting data
- `tabs` - Required for sending messages to content scripts
