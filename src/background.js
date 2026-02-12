// YT Comment Carbon Copy - Background Service Worker

// Initialize storage on install
chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.get('comments', (data) => {
    if (!data.comments) {
      chrome.storage.local.set({ comments: {} });
    }
  });
});

// Ensure storage exists even if onInstalled did not run (e.g., reload)
chrome.runtime.onStartup?.addListener(() => {
  chrome.storage.local.get('comments', (data) => {
    if (!data.comments) {
      chrome.storage.local.set({ comments: {} });
    }
  });
});

const STATUS_ACTIVE = 'active';
const STATUS_DELETED = 'deleted';
const STATUS_ARCHIVED = 'archived';
const AUTO_ARCHIVE_AFTER_MS = 24 * 60 * 60 * 1000;

// Generate unique ID for comments
function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).substr(2, 9);
}

// Save a new comment to storage
async function saveComment(payload) {
  const { comments } = await chrome.storage.local.get('comments');
  const nextComments = comments || {};

  const id = generateId();
  const comment = {
    id,
    text: payload.text,
    videoId: payload.videoId,
    videoTitle: payload.videoTitle,
    videoUrl: payload.videoUrl,
    submittedAt: Date.now(),
    status: STATUS_ACTIVE,
    lastCheckedAt: null,
    deletedAt: null,
    archivedAt: null,
    commentId: payload.commentId || null,
    commentUrl: payload.commentUrl || null
  };

  nextComments[id] = comment;
  await chrome.storage.local.set({ comments: nextComments });

  return id;
}

// Get all comments from storage
async function getComments() {
  const { comments } = await chrome.storage.local.get('comments');
  return comments || {};
}

// Update a comment's status
async function setCommentStatus(id, { status, deletedAt, archivedAt, updateLastCheckedAt = true } = {}) {
  const { comments } = await chrome.storage.local.get('comments');

  if (!comments || !comments[id]) {
    return false;
  }

  const updated = { ...comments[id] };
  updated.status = status;

  if (updateLastCheckedAt) {
    updated.lastCheckedAt = Date.now();
  }

  if (status === STATUS_DELETED) {
    updated.deletedAt = deletedAt ?? Date.now();
  } else if (deletedAt !== undefined) {
    updated.deletedAt = deletedAt;
  } else if (status === STATUS_ACTIVE) {
    updated.deletedAt = null;
  }

  if (status === STATUS_ARCHIVED) {
    updated.archivedAt = archivedAt ?? Date.now();
  } else if (archivedAt !== undefined) {
    updated.archivedAt = archivedAt;
  } else {
    updated.archivedAt = null;
  }

  comments[id] = updated;
  await chrome.storage.local.set({ comments });
  return true;
}

async function updateCommentMeta({ id, commentId, commentUrl }) {
  const { comments } = await chrome.storage.local.get('comments');
  if (!comments || !comments[id]) {
    return false;
  }

  if (commentId) {
    comments[id].commentId = commentId;
  }

  if (commentUrl) {
    comments[id].commentUrl = commentUrl;
  }

  await chrome.storage.local.set({ comments });
  return true;
}

function shouldAutoArchive(comment, now = Date.now()) {
  if (!comment?.submittedAt) return false;
  return now - comment.submittedAt >= AUTO_ARCHIVE_AFTER_MS;
}

async function unarchiveComment(id) {
  const { comments } = await chrome.storage.local.get('comments');
  if (!comments || !comments[id]) {
    return false;
  }

  const comment = comments[id];
  const hasDeletedAt = Boolean(comment.deletedAt);
  const status = hasDeletedAt ? STATUS_DELETED : STATUS_ACTIVE;

  return setCommentStatus(id, {
    status,
    deletedAt: hasDeletedAt ? comment.deletedAt : null,
    updateLastCheckedAt: false,
    archivedAt: null
  });
}

// Handle checking comments for a specific video
async function handleCheckComments(videoId) {
  const comments = await getComments();
  const toCheck = Object.values(comments)
    .filter(c => c.videoId === videoId && c.status === STATUS_ACTIVE);

  if (toCheck.length === 0) {
    return {
      success: true,
      message: 'No comments to check for this video',
      checkedCount: 0,
      deletedCount: 0,
      archivedCount: 0
    };
  }

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

    if (!tab?.id) {
      return { success: false, message: 'Could not access current tab' };
    }

    const response = await chrome.tabs.sendMessage(tab.id, {
      action: 'VERIFY_COMMENTS',
      comments: toCheck,
      ensureLoaded: true
    });

    if (!response?.results) {
      return { success: false, message: 'Could not verify comments on page' };
    }

    // Update storage for deleted comments
    let deletedCount = 0;
    let archivedCount = 0;
    const now = Date.now();
    const byId = new Map(toCheck.map((comment) => [comment.id, comment]));
    for (const result of response.results) {
      if (result.found === null) {
        continue;
      }
      if (!result.found) {
        await setCommentStatus(result.id, {
          status: STATUS_DELETED,
          deletedAt: now
        });
        deletedCount++;
      } else {
        const comment = byId.get(result.id);
        if (comment && shouldAutoArchive(comment, now)) {
          await setCommentStatus(result.id, {
            status: STATUS_ARCHIVED,
            archivedAt: now
          });
          archivedCount++;
        } else {
          // Update lastCheckedAt for active comments
          await setCommentStatus(result.id, {
            status: STATUS_ACTIVE
          });
        }
        if (result.commentId || result.commentUrl) {
          await updateCommentMeta({
            id: result.id,
            commentId: result.commentId,
            commentUrl: result.commentUrl
          });
        }
      }
    }

    const archivedSummary = archivedCount
      ? ` ${archivedCount} archived.`
      : '';

    return {
      success: true,
      message: `Checked ${toCheck.length} comment${toCheck.length !== 1 ? 's' : ''}. ${deletedCount} deleted.${archivedSummary}`,
      checkedCount: toCheck.length,
      deletedCount,
      archivedCount
    };
  } catch (error) {
    console.error('[YT Comment Carbon Copy] Check failed:', error);
    return { success: false, message: 'Failed to check comments. Make sure you are on a YouTube video page.' };
  }
}

// Handle checking all comments for a video by opening it in a background tab
async function handleCheckAllComments(videoId, comments) {
  if (!comments || comments.length === 0) {
    return { success: true, videoId, deletedCount: 0, checkedCount: 0 };
  }

  try {
    // Open the video in a new tab (in background)
    const tab = await chrome.tabs.create({
      url: `https://www.youtube.com/watch?v=${videoId}`,
      active: false
    });

    let response = null;
    try {
      response = await waitForContentScript(tab.id, comments, 10000);
    } catch (error) {
      response = null;
    }

    // Update storage for deleted comments
    let deletedCount = 0;
    let archivedCount = 0;
    const now = Date.now();
    const byId = new Map(comments.map((comment) => [comment.id, comment]));
    if (response?.results) {
      for (const result of response.results) {
        if (result.found === null) {
          continue;
        }
        if (!result.found) {
          await setCommentStatus(result.id, {
            status: STATUS_DELETED,
            deletedAt: now
          });
          deletedCount++;
        } else {
          const comment = byId.get(result.id);
          if (comment && shouldAutoArchive(comment, now)) {
            await setCommentStatus(result.id, {
              status: STATUS_ARCHIVED,
              archivedAt: now
            });
            archivedCount++;
          } else {
            await setCommentStatus(result.id, {
              status: STATUS_ACTIVE
            });
          }
          if (result.commentId || result.commentUrl) {
            await updateCommentMeta({
              id: result.id,
              commentId: result.commentId,
              commentUrl: result.commentUrl
            });
          }
        }
      }
    }

    // Close the tab
    await chrome.tabs.remove(tab.id);

    return {
      success: true,
      videoId,
      deletedCount,
      archivedCount,
      checkedCount: comments.length
    };
  } catch (error) {
    console.error('[YT Comment Carbon Copy] Batch check failed for video:', videoId, error);
    return {
      success: false,
      videoId,
      error: error.message,
      deletedCount: 0,
      archivedCount: 0
    };
  }
}

function waitForContentScript(tabId, comments, timeoutMs = 10000) {
  const intervalMs = 800;
  const start = Date.now();

  return new Promise((resolve, reject) => {
    const attempt = async () => {
      try {
        const response = await chrome.tabs.sendMessage(tabId, {
          action: 'VERIFY_COMMENTS',
          comments,
          ensureLoaded: true
        });

        if (response?.results) {
          resolve(response);
          return;
        }
      } catch (error) {
        // Swallow errors while content script loads
      }

      if (Date.now() - start >= timeoutMs) {
        reject(new Error('Timed out waiting for content script'));
        return;
      }

      setTimeout(attempt, intervalMs);
    };

    attempt();
  });
}

// Message handler
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  switch (message.action) {
    case 'SAVE_COMMENT':
      saveComment(message.payload)
        .then(id => sendResponse({ success: true, id }))
        .catch(error => {
          console.error('[YT Comment Carbon Copy] Save failed:', error);
          sendResponse({ success: false, error: error.message });
        });
      return true; // Keep channel open for async response

    case 'GET_COMMENTS':
      getComments()
        .then(comments => sendResponse({ success: true, comments }))
        .catch(error => {
          console.error('[YT Comment Carbon Copy] Get failed:', error);
          sendResponse({ success: false, error: error.message });
        });
      return true;

    case 'CHECK_COMMENTS':
      handleCheckComments(message.videoId)
        .then(sendResponse)
        .catch(error => {
          console.error('[YT Comment Carbon Copy] Check failed:', error);
          sendResponse({ success: false, message: error.message });
        });
      return true;

    case 'CHECK_ALL_COMMENTS':
      handleCheckAllComments(message.videoId, message.comments)
        .then(sendResponse)
        .catch(error => {
          console.error('[YT Comment Carbon Copy] Batch check failed:', error);
          sendResponse({ success: false, error: error.message });
        });
      return true;

    case 'UPDATE_COMMENT_META':
      updateCommentMeta(message.payload)
        .then((updated) => sendResponse({ success: updated }))
        .catch((error) => {
          console.error('[YT Comment Carbon Copy] Update meta failed:', error);
          sendResponse({ success: false, error: error.message });
        });
      return true;

    case 'ARCHIVE_COMMENT':
      setCommentStatus(message.id, {
        status: STATUS_ARCHIVED,
        updateLastCheckedAt: false
      })
        .then((updated) => sendResponse({ success: updated }))
        .catch((error) => {
          console.error('[YT Comment Carbon Copy] Archive failed:', error);
          sendResponse({ success: false, error: error.message });
        });
      return true;

    case 'UNARCHIVE_COMMENT':
      unarchiveComment(message.id)
        .then((updated) => sendResponse({ success: updated }))
        .catch((error) => {
          console.error('[YT Comment Carbon Copy] Unarchive failed:', error);
          sendResponse({ success: false, error: error.message });
        });
      return true;

    default:
      sendResponse({ success: false, error: 'Unknown action' });
      return false;
  }
});
