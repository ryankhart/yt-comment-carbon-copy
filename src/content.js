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

function findCommentInputFromEvent(event) {
  if (!event) return findCommentInput();

  const path = typeof event.composedPath === 'function' ? event.composedPath() : [];
  for (const node of path) {
    if (node?.isContentEditable) {
      return node;
    }
  }

  const targetElement = event.target;
  if (targetElement?.isContentEditable) {
    return targetElement;
  }

  if (targetElement?.closest) {
    const scopedInput = targetElement.closest(
      '#contenteditable-root, [contenteditable="true"]'
    );
    if (scopedInput) return scopedInput;
  }

  return findCommentInputForElement(targetElement || document.activeElement);
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

function getCommentIdFromUrl(urlString) {
  if (!urlString) return null;
  try {
    const url = new URL(urlString, window.location.origin);
    return url.searchParams.get('lc');
  } catch {
    return null;
  }
}

function extractCommentMetaFromElement(element, metadata) {
  if (!element) return { commentId: null, commentUrl: null };

  const candidate =
    element.closest('ytd-comment-renderer, ytd-comment-thread-renderer') || element;

  let commentId = null;
  let commentUrl = null;

  const directAttributes = [
    'comment-id',
    'data-comment-id',
    'data-commentid',
    'data-cid',
    'data-id',
    'cid'
  ];

  for (const attr of directAttributes) {
    const value = candidate.getAttribute?.(attr);
    if (value) {
      commentId = value;
      break;
    }
  }

  if (!commentId) {
    if (candidate.dataset?.commentId) commentId = candidate.dataset.commentId;
    if (!commentId && candidate.dataset?.commentid) commentId = candidate.dataset.commentid;
    if (!commentId && candidate.dataset?.cid) commentId = candidate.dataset.cid;
    if (!commentId && candidate.dataset?.id) commentId = candidate.dataset.id;
  }

  if (!commentId) {
    const candidateId = candidate.getAttribute?.('id');
    if (candidateId?.startsWith('comment-')) {
      commentId = candidateId.slice('comment-'.length);
    }
  }

  if (!commentId && candidate.getAttributeNames) {
    const attributeNames = candidate.getAttributeNames();
    const dynamicAttribute = attributeNames.find((name) =>
      name.includes('comment-id')
    );
    if (dynamicAttribute) {
      commentId = candidate.getAttribute(dynamicAttribute);
    }
  }

  const anchor = candidate.querySelector?.('a[href*="lc="]');
  if (anchor) {
    const anchorUrl = new URL(anchor.getAttribute('href'), window.location.origin);
    const anchorCommentId = getCommentIdFromUrl(anchorUrl.toString());
    if (anchorCommentId) {
      commentId = commentId || anchorCommentId;
      commentUrl = anchorUrl.toString();
    }
  }

  if (commentId && !commentUrl) {
    commentUrl = buildCommentUrl(metadata.videoId, commentId, metadata.videoUrl);
  }

  return { commentId, commentUrl };
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
function buildVisibleCommentIndex(metadata) {
  const visibleCommentElements = document.querySelectorAll('#content-text');
  const index = new Map();

  visibleCommentElements.forEach((el) => {
    const normalized = normalizeText(el.textContent);
    if (!normalized) return;
    const meta = extractCommentMetaFromElement(el, metadata);

    if (!index.has(normalized)) {
      index.set(normalized, []);
    }
    index.get(normalized).push(meta);
  });

  return index;
}

// Verify if comments exist on the page
function verifyComments(commentsToCheck) {
  // Get all visible comment texts on the page
  const metadata = extractVideoMetadata();
  const visibleIndex = buildVisibleCommentIndex(metadata);

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

  return commentsToCheck.map((comment) => {
    const normalized = normalizeText(comment.text);
    const matches = visibleIndex.get(normalized) || [];
    const preferredMeta = matches.find((match) => match.commentId) || matches[0];
    return {
      id: comment.id,
      found: matches.length > 0,
      commentId: preferredMeta?.commentId || null,
      commentUrl: preferredMeta?.commentUrl || null
    };
  });
}

function scheduleCommentLinkResolve({ localId, normalizedText, metadata }) {
  const start = Date.now();
  const timeoutMs = 15000;
  const intervalMs = 800;

  const attempt = () => {
    const matches = findMatchingCommentElements(normalizedText);
    for (const match of matches) {
      const meta = extractCommentMetaFromElement(match, metadata);
      if (meta.commentId) {
        chrome.runtime.sendMessage({
          action: 'UPDATE_COMMENT_META',
          payload: {
            id: localId,
            commentId: meta.commentId,
            commentUrl: meta.commentUrl
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
    const commentInput = findCommentInputFromEvent(event);
    if (!commentInput) return;

    console.log('[YT Comment Monitor] Keyboard shortcut detected');
    captureComment(commentInput);
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
