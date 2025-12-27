// YouTube Comment Monitor - Content Script

// Track which buttons we've already attached listeners to
const processedButtons = new WeakSet();

// DOM helper: Find submit button with fallbacks
function findSubmitButton() {
  return (
    document.querySelector('#submit-button button') ||
    document.querySelector('#submit-button') ||
    document.querySelector('ytd-comment-simplebox-renderer #submit-button')
  );
}

// DOM helper: Find comment input with fallbacks
function findCommentInput() {
  return (
    document.querySelector('#contenteditable-root') ||
    document.querySelector('ytd-comment-simplebox-renderer [contenteditable="true"]') ||
    document.querySelector('#placeholder-area + #contenteditable-root')
  );
}

// Extract video metadata from the current page
function extractVideoMetadata() {
  const url = new URL(window.location.href);
  const videoId = url.searchParams.get('v');

  // Try to get video title from various sources
  const titleElement =
    document.querySelector('h1.ytd-watch-metadata yt-formatted-string') ||
    document.querySelector('h1.title') ||
    document.querySelector('h1 yt-formatted-string');

  const videoTitle = titleElement?.textContent?.trim() || document.title.replace(' - YouTube', '');

  return {
    videoId,
    videoTitle,
    videoUrl: window.location.href
  };
}

// Handle comment submission
function handleCommentSubmit(event) {
  console.log('[YT Comment Monitor] Submit button clicked');

  const commentInput = findCommentInput();
  console.log('[YT Comment Monitor] Comment input element:', commentInput);

  const text = commentInput?.innerText?.trim();
  console.log('[YT Comment Monitor] Comment text:', text);

  if (!text) {
    console.warn('[YT Comment Monitor] Could not capture comment text');
    return;
  }

  const metadata = extractVideoMetadata();
  console.log('[YT Comment Monitor] Video metadata:', metadata);

  if (!metadata.videoId) {
    console.warn('[YT Comment Monitor] Could not determine video ID');
    return;
  }

  // Send to background script for storage
  chrome.runtime.sendMessage(
    {
      action: 'SAVE_COMMENT',
      payload: {
        text,
        ...metadata
      }
    },
    (response) => {
      if (chrome.runtime.lastError) {
        console.error('[YT Comment Monitor] Failed to save comment:', chrome.runtime.lastError);
        return;
      }
      if (response?.success) {
        console.log('[YT Comment Monitor] Comment captured successfully');
      }
    }
  );

  // Do NOT call event.preventDefault() - let the comment submit normally
}

// Verify if comments exist on the page
function verifyComments(commentsToCheck) {
  // Get all visible comment texts on the page
  const visibleCommentElements = document.querySelectorAll('#content-text');
  const visibleComments = Array.from(visibleCommentElements).map((el) =>
    el.textContent.trim()
  );

  // Check if comments section is loaded
  const commentsLoaded = document.querySelector('ytd-comments');
  if (!commentsLoaded) {
    // Can't determine - comments section not loaded
    return commentsToCheck.map((comment) => ({
      id: comment.id,
      found: true, // Assume found if we can't check
      reason: 'comments_not_loaded'
    }));
  }

  return commentsToCheck.map((comment) => ({
    id: comment.id,
    found: visibleComments.some(
      (visible) => visible === comment.text.trim()
    )
  }));
}

// Set up MutationObserver to detect when submit button appears
const observer = new MutationObserver(() => {
  const submitButton = findSubmitButton();

  if (submitButton && !processedButtons.has(submitButton)) {
    processedButtons.add(submitButton);
    submitButton.addEventListener('click', handleCommentSubmit, true);
    console.log('[YT Comment Monitor] Submit button listener attached to:', submitButton);
    console.log('[YT Comment Monitor] Button HTML:', submitButton.outerHTML.substring(0, 200));
  }
});

// Start observing
observer.observe(document.body, {
  childList: true,
  subtree: true
});

// Handle keyboard shortcuts (Ctrl/Cmd+Enter to submit)
function handleKeyDown(event) {
  if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
    const commentInput = findCommentInput();
    if (commentInput && document.activeElement === commentInput) {
      console.log('[YT Comment Monitor] Keyboard shortcut detected');
      handleCommentSubmit(event);
    }
  }
}

// Listen for keyboard shortcuts (capture phase)
document.addEventListener('keydown', handleKeyDown, true);

// Listen for verification requests from background script
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'VERIFY_COMMENTS') {
    const results = verifyComments(message.comments);
    sendResponse({ results });
  }
  return true; // Keep channel open
});

console.log('[YT Comment Monitor] Content script loaded');
