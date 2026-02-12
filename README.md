# YT Comment Carbon Copy

A Chrome extension that captures your YouTube comments and alerts you when they get deleted.

## Features

- **Automatic Comment Capture**: Saves every comment you post on YouTube
- **Deletion Detection**: Check if your comments have been shadow-deleted or removed
- **Scheduled Checks**: Run automatic checks every 6/12/24 hours
- **Configurable Auto-Archive**: Keep active feed clean on your own retention window
- **Comment History**: View all your captured comments with timestamps and video titles
- **Search & Filters**: Filter by text, video title, status, and recency
- **Paged History View**: Navigate large comment histories without UI slowdown
- **Easy Copying**: One-click copy of any saved comment
- **Export / Import**: Backup comments to JSON/CSV and restore from JSON
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

### Enabling Scheduled Checks

1. Open the extension popup
2. Turn on "Enable scheduled checks"
3. Pick an interval (6/12/24 hours)
4. Optionally enable notifications for deleted/unknown results
5. Choose auto-archive retention (Never / 24h / 3d / 7d)

### Viewing Your Comment History

Click the extension icon at any time to see all your captured comments, sorted by date. Each entry shows:
- The comment text
- Video title
- Submission timestamp
- Current status (active or deleted)

### Backup and Restore

- Use **Export JSON** for a full-fidelity backup you can re-import later
- Use **Export CSV** for spreadsheet analysis
- Use **Import JSON** to merge comments from a previous backup

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
- **alarms**: Run scheduled checks
- **notifications**: Optional alerts for scheduled check findings

## Development

See [CLAUDE.md](CLAUDE.md) for detailed architecture documentation and development instructions.

### Quick Start

After making changes:
1. Go to `chrome://extensions/`
2. Click the refresh icon on the extension card
3. If you modified the content script, also reload any YouTube pages
4. If you modified the popup, close and reopen it

Run regression tests:
```bash
npm test
```

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
