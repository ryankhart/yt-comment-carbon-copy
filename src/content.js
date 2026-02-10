// YouTube Comment Monitor - Content Script

// Track which buttons we've already attached listeners to
const processedButtons = new WeakSet();

const LAST_CAPTURE_WINDOW_MS = 2000;
let lastCapture = null;

function normalizeText(value) {
  if (!value) return '';
  return value.replace(/\s+/g, ' ').trim();
}

// DOM helper: Find submit button with fallbacks
function findSubmitButtons() {
  const selectors = [
    '#submit-button button',
    'ytd-comment-simplebox-renderer #submit-button button'
  ];

  const buttons = new Set();
  for (const selector of selectors) {
    document.querySelectorAll(selector).forEach((el) => buttons.add(el));
  }

  if (buttons.size === 0) {
    document.querySelectorAll('#submit-button').forEach((el) => buttons.add(el));
  }

  return Array.from(buttons);
}

// DOM helper: Find comment input with fallbacks
function findCommentInput() {
  return (
    document.querySelector('#contenteditable-root') ||
    document.querySelector('ytd-comment-simplebox-renderer [contenteditable="true"]') ||
    document.querySelector('#placeholder-area + #contenteditable-root')
  );
}

function findCommentInputForElement(element) {
  if (!element) return findCommentInput();

  if (element.isContentEditable) {
    return element;
  }

  const container = element.closest(
    'ytd-commentbox, ytd-comment-simplebox-renderer, ytd-comment-reply-dialog-renderer, ytd-comment-reply-renderer, ytd-comment-thread-renderer'
  );
  const scopedInput = container?.querySelector('#contenteditable-root, [contenteditable="true"]');
  return scopedInput || findCommentInput();
}

function getVideoIdFromUrl(urlString) {
  const url = new URL(urlString);
  const queryId = url.searchParams.get('v');
  if (queryId) return queryId;

  const parts = url.pathname.split('/').filter(Boolean);
  const shortsIndex = parts.indexOf('shorts');
  if (shortsIndex !== -1 && parts[shortsIndex + 1]) {
    return parts[shortsIndex + 1];
  }

  const liveIndex = parts.indexOf('live');
  if (liveIndex !== -1 && parts[liveIndex + 1]) {
    return parts[liveIndex + 1];
  }

  return null;
}

function buildCommentUrl(videoId, commentId, videoUrl) {
  if (!commentId) return null;

  try {
    const url = videoUrl
      ? new URL(videoUrl)
      : new URL(`https://www.youtube.com/watch?v=${videoId}`);
    url.searchParams.set('lc', commentId);
    return url.toString();
  } catch {
    if (!videoId) return null;
    return `https://www.youtube.com/watch?v=${videoId}&lc=${commentId}`;
  }
}

function extractCommentIdFromElement(element) {
  if (!element) return null;

  const candidates = [
    element.closest('ytd-comment-renderer'),
    element.closest('ytd-comment-thread-renderer')
  ];

  for (const candidate of candidates) {
    if (!candidate) continue;

    const directAttributes = ['comment-id', 'data-comment-id', 'data-id'];
    for (const attr of directAttributes) {
      const value = candidate.getAttribute(attr);
      if (value) return value;
    }

    if (candidate.dataset?.commentId) return candidate.dataset.commentId;
    if (candidate.dataset?.id) return candidate.dataset.id;

    const attributeNames = candidate.getAttributeNames?.() || [];
    const dynamicAttribute = attributeNames.find((name) => name.includes('comment-id'));
    if (dynamicAttribute) {
      const value = candidate.getAttribute(dynamicAttribute);
      if (value) return value;
    }
  }

  return null;
}

function findMatchingCommentElements(text) {
  const normalized = normalizeText(text);
  if (!normalized) return [];

  const elements = Array.from(document.querySelectorAll('#content-text'));
  return elements.filter((el) => normalizeText(el.textContent) === normalized);
}

// Extract video metadata from the current page
function extractVideoMetadata() {
  const videoId = getVideoIdFromUrl(window.location.href);

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
function captureComment(sourceElement) {
  console.log('[YT Comment Monitor] Submit button clicked');

  const commentInput = findCommentInputForElement(sourceElement);
  console.log('[YT Comment Monitor] Comment input element:', commentInput);

  const rawText = commentInput?.innerText?.trim() || '';
  const normalizedText = normalizeText(rawText);
  console.log('[YT Comment Monitor] Comment text:', rawText);

  if (!normalizedText) {
    console.warn('[YT Comment Monitor] Could not capture comment text');
    return;
  }

  const metadata = extractVideoMetadata();
  console.log('[YT Comment Monitor] Video metadata:', metadata);

  if (!metadata.videoId) {
    console.warn('[YT Comment Monitor] Could not determine video ID');
    return;
  }

  const now = Date.now();
  if (
    lastCapture &&
    lastCapture.videoId === metadata.videoId &&
    lastCapture.text === normalizedText &&
    now - lastCapture.at < LAST_CAPTURE_WINDOW_MS
  ) {
    console.log('[YT Comment Monitor] Skipping duplicate capture');
    return;
  }

  lastCapture = { videoId: metadata.videoId, text: normalizedText, at: now };

  // Send to background script for storage
  chrome.runtime.sendMessage(
    {
      action: 'SAVE_COMMENT',
      payload: {
        text: rawText,
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
        if (response.id) {
          scheduleCommentLinkResolve({
            localId: response.id,
            normalizedText,
            metadata
          });
        }
      }
    }
  );

  // Do NOT call event.preventDefault() - let the comment submit normally
}

function handleCommentSubmit(event) {
  captureComment(event?.target || document.activeElement);
}

// Verify if comments exist on the page
function verifyComments(commentsToCheck) {
  // Get all visible comment texts on the page
  const visibleCommentElements = document.querySelectorAll('#content-text');
  const visibleComments = new Set(
    Array.from(visibleCommentElements).map((el) => normalizeText(el.textContent))
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
    found: visibleComments.has(normalizeText(comment.text))
  }));
}

function scheduleCommentLinkResolve({ localId, normalizedText, metadata }) {
  const start = Date.now();
  const timeoutMs = 15000;
  const intervalMs = 800;

  const attempt = () => {
    const matches = findMatchingCommentElements(normalizedText);
    for (const match of matches) {
      const commentId = extractCommentIdFromElement(match);
      if (commentId) {
        const commentUrl = buildCommentUrl(metadata.videoId, commentId, metadata.videoUrl);
        chrome.runtime.sendMessage({
          action: 'UPDATE_COMMENT_META',
          payload: {
            id: localId,
            commentId,
            commentUrl
          }
        });
        return;
      }
    }

    if (Date.now() - start < timeoutMs) {
      setTimeout(attempt, intervalMs);
    }
  };

  setTimeout(attempt, intervalMs);
}

// Set up MutationObserver to detect when submit button appears
const observer = new MutationObserver(() => {
  const submitButtons = findSubmitButtons();

  submitButtons.forEach((submitButton) => {
    if (!processedButtons.has(submitButton)) {
      processedButtons.add(submitButton);
      submitButton.addEventListener('click', handleCommentSubmit, true);
      console.log('[YT Comment Monitor] Submit button listener attached to:', submitButton);
      console.log('[YT Comment Monitor] Button HTML:', submitButton.outerHTML.substring(0, 200));
    }
  });
});

// Start observing
observer.observe(document.body, {
  childList: true,
  subtree: true
});

// Handle keyboard shortcuts (Ctrl/Cmd+Enter to submit)
function handleKeyDown(event) {
  if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
    const commentInput = findCommentInputForElement(document.activeElement);
    if (commentInput && document.activeElement === commentInput) {
      console.log('[YT Comment Monitor] Keyboard shortcut detected');
      captureComment(commentInput);
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
