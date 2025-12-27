# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

YouTube Comment Monitor is a Chrome Manifest V3 extension that captures comments you submit on YouTube and detects when they get deleted.

## Architecture

### Content Script ([content.js](src/content.js))
- Injected into all YouTube pages (`*://*.youtube.com/*`)
- Uses MutationObserver to detect when comment submit button appears
- Captures comment text on submit and sends to background script
- Responds to VERIFY_COMMENTS requests to check if comments still exist on page

### Background Service Worker ([background.js](src/background.js))
- Central message hub and storage manager
- Handles SAVE_COMMENT, GET_COMMENTS, CHECK_COMMENTS actions
- Stores comments in `chrome.storage.local` with structure:
  ```javascript
  { comments: { [id]: { text, videoId, videoTitle, status, submittedAt, ... } } }
  ```
- Coordinates deletion detection between popup and content script

### Popup UI ([popup.html](src/popup.html), [popup.js](src/popup.js))
- Displays all captured comments sorted by date
- "Check Current Video" button triggers deletion detection
- Visual distinction for deleted comments (red styling)
- Copy button for each comment

### Message Flow
```
Submit comment → content.js → SAVE_COMMENT → background.js → storage
Check button → popup.js → CHECK_COMMENTS → background.js → VERIFY_COMMENTS → content.js
                                                        ↓
                                                 Update storage
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
