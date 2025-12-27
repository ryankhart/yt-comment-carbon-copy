# YT Comment Carbon Copy

A Chrome extension that captures your YouTube comments and alerts you when they get deleted.

## Features

- **Automatic Comment Capture**: Saves every comment you post on YouTube
- **Deletion Detection**: Check if your comments have been shadow-deleted or removed
- **Comment History**: View all your captured comments with timestamps and video titles
- **Easy Copying**: One-click copy of any saved comment
- **Privacy First**: All data stored locally on your device

## Installation

### From Source

1. Clone this repository:
   ```bash
   git clone https://github.com/ryankhart/yt-comment-carbon-copy.git
   cd yt-comment-carbon-copy
   ```

2. Open Chrome and navigate to `chrome://extensions/`

3. Enable "Developer mode" using the toggle in the top right

4. Click "Load unpacked" and select the `src/` directory from this repository

5. The extension icon should appear in your Chrome toolbar

## Usage

### Capturing Comments

Simply post comments on YouTube as you normally would. The extension automatically captures and saves them in the background.

### Checking for Deleted Comments

1. Navigate to a YouTube video where you've previously commented
2. Click the extension icon to open the popup
3. Click "Check Current Video" to verify which comments still exist
4. Deleted comments will be highlighted in red

### Viewing Your Comment History

Click the extension icon at any time to see all your captured comments, sorted by date. Each entry shows:
- The comment text
- Video title
- Submission timestamp
- Current status (active or deleted)

## How It Works

The extension uses three main components:

1. **Content Script**: Monitors YouTube pages for comment submissions and verifies comment existence
2. **Background Service Worker**: Manages storage and coordinates between components
3. **Popup UI**: Provides the interface for viewing and checking comments

All data is stored locally using Chrome's storage API. No external servers or third-party services are involved.

## Permissions

The extension requires the following permissions:

- **activeTab**: Access to the currently active YouTube tab
- **storage**: Store comment data locally
- **tabs**: Send messages to content scripts for verification

## Development

See [CLAUDE.md](CLAUDE.md) for detailed architecture documentation and development instructions.

### Quick Start

After making changes:
1. Go to `chrome://extensions/`
2. Click the refresh icon on the extension card
3. If you modified the content script, also reload any YouTube pages
4. If you modified the popup, close and reopen it

### Debugging

- **Content script logs**: Open DevTools (F12) on any YouTube page
- **Background script logs**: Click "service worker" link in `chrome://extensions/`
- **Popup logs**: Right-click the extension icon → "Inspect popup"

## Limitations

- Only works on YouTube (www.youtube.com)
- Relies on YouTube's DOM structure, which may change over time
- Cannot detect deletions until you run a manual check
- Does not capture comments made before the extension was installed

## License

MIT License - see [LICENSE](LICENSE) for details

## Contributing

Contributions are welcome! Please feel free to submit issues or pull requests.

## Disclaimer

This extension is not affiliated with or endorsed by YouTube or Google. Use at your own discretion.
