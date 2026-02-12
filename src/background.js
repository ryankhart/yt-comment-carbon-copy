// YT Comment Carbon Copy - Background Service Worker

const STATUS_ACTIVE = 'active';
const STATUS_DELETED = 'deleted';
const STATUS_ARCHIVED = 'archived';
const STATUS_UNKNOWN = 'unknown';
const SETTINGS_KEY = 'settings';
const LAST_AUTO_CHECK_KEY = 'lastAutoCheck';
const AUTO_CHECK_ALARM = 'autoCheckComments';
const SUPPORTED_AUTO_CHECK_INTERVALS = [6, 12, 24];
const DEFAULT_SETTINGS = {
  autoCheckEnabled: false,
  autoCheckIntervalHours: 12,
  autoCheckNotifications: false
};
const AUTO_ARCHIVE_AFTER_MS = 24 * 60 * 60 * 1000;

let autoCheckInProgress = false;

// Generate unique ID for comments
function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).substr(2, 9);
}

function normalizeSettings(settings) {
  const source = settings || {};
  const autoCheckIntervalHours = SUPPORTED_AUTO_CHECK_INTERVALS.includes(Number(source.autoCheckIntervalHours))
    ? Number(source.autoCheckIntervalHours)
    : DEFAULT_SETTINGS.autoCheckIntervalHours;

  return {
    autoCheckEnabled: Boolean(source.autoCheckEnabled),
    autoCheckIntervalHours,
    autoCheckNotifications: Boolean(source.autoCheckNotifications)
  };
}

function buildAutoCheckSummaryMessage(summary) {
  const deletedPart = `${summary.deletedCount} deleted`;
  const unknownPart = `${summary.unknownCount} unknown`;
  return `Checked ${summary.checkedCount} comments across ${summary.videoCount} videos: ${deletedPart}, ${unknownPart}.`;
}

async function ensureStorageDefaults() {
  const data = await chrome.storage.local.get(['comments', SETTINGS_KEY]);
  const updates = {};

  if (!data.comments) {
    updates.comments = {};
  }

  const normalizedSettings = normalizeSettings(data[SETTINGS_KEY]);
  if (!data[SETTINGS_KEY] || JSON.stringify(data[SETTINGS_KEY]) !== JSON.stringify(normalizedSettings)) {
    updates[SETTINGS_KEY] = normalizedSettings;
  }

  if (Object.keys(updates).length > 0) {
    await chrome.storage.local.set(updates);
  }

  return normalizedSettings;
}

async function getSettings() {
  const data = await chrome.storage.local.get(SETTINGS_KEY);
  return normalizeSettings(data[SETTINGS_KEY]);
}

async function syncAutoCheckAlarm(settingsInput = null) {
  const settings = settingsInput || await getSettings();

  await chrome.alarms.clear(AUTO_CHECK_ALARM);

  if (!settings.autoCheckEnabled) {
    return;
  }

  await chrome.alarms.create(AUTO_CHECK_ALARM, {
    delayInMinutes: 1,
    periodInMinutes: settings.autoCheckIntervalHours * 60
  });
}

async function updateSettings(patch) {
  const current = await getSettings();
  const next = normalizeSettings({ ...current, ...(patch || {}) });
  await chrome.storage.local.set({ [SETTINGS_KEY]: next });
  await syncAutoCheckAlarm(next);
  return next;
}

async function maybeNotifyAutoCheck(summary, settings) {
  if (!settings.autoCheckNotifications) {
    return;
  }

  if (summary.deletedCount === 0 && summary.unknownCount === 0) {
    return;
  }

  try {
    await chrome.notifications.create({
      type: 'basic',
      iconUrl: 'icons/icon-128.png',
      title: 'YT Comment Carbon Copy',
      message: buildAutoCheckSummaryMessage(summary)
    });
  } catch (error) {
    console.error('[YT Comment Carbon Copy] Notification failed:', error);
  }
}

async function runAutoCheckCycle(trigger = 'alarm') {
  if (autoCheckInProgress) {
    return {
      success: false,
      skipped: true,
      reason: 'already_running'
    };
  }

  autoCheckInProgress = true;
  try {
    const settings = await getSettings();
    if (!settings.autoCheckEnabled && trigger === 'alarm') {
      return { success: true, skipped: true, reason: 'disabled' };
    }

    const comments = await getComments();
    const activeComments = Object.values(comments).filter((comment) => {
      const status = comment.status || STATUS_ACTIVE;
      return (status === STATUS_ACTIVE || status === STATUS_UNKNOWN) && Boolean(comment.videoId);
    });

    if (activeComments.length === 0) {
      const summary = {
        trigger,
        checkedAt: Date.now(),
        checkedCount: 0,
        deletedCount: 0,
        archivedCount: 0,
        unknownCount: 0,
        videoCount: 0
      };
      await chrome.storage.local.set({ [LAST_AUTO_CHECK_KEY]: summary });
      return { success: true, summary };
    }

    const commentsByVideo = {};
    activeComments.forEach((comment) => {
      if (!commentsByVideo[comment.videoId]) {
        commentsByVideo[comment.videoId] = [];
      }
      commentsByVideo[comment.videoId].push(comment);
    });

    const videoIds = Object.keys(commentsByVideo);
    let deletedCount = 0;
    let archivedCount = 0;
    let unknownCount = 0;

    for (const videoId of videoIds) {
      const result = await handleCheckAllComments(videoId, commentsByVideo[videoId]);
      if (!result?.success) {
        continue;
      }
      deletedCount += result.deletedCount || 0;
      archivedCount += result.archivedCount || 0;
      unknownCount += result.unknownCount || 0;
    }

    const summary = {
      trigger,
      checkedAt: Date.now(),
      checkedCount: activeComments.length,
      deletedCount,
      archivedCount,
      unknownCount,
      videoCount: videoIds.length
    };

    await chrome.storage.local.set({ [LAST_AUTO_CHECK_KEY]: summary });
    await maybeNotifyAutoCheck(summary, settings);

    return { success: true, summary };
  } finally {
    autoCheckInProgress = false;
  }
}

chrome.runtime.onInstalled.addListener(() => {
  ensureStorageDefaults()
    .then((settings) => syncAutoCheckAlarm(settings))
    .catch((error) => console.error('[YT Comment Carbon Copy] Install init failed:', error));
});

chrome.runtime.onStartup?.addListener(() => {
  ensureStorageDefaults()
    .then((settings) => syncAutoCheckAlarm(settings))
    .catch((error) => console.error('[YT Comment Carbon Copy] Startup init failed:', error));
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== AUTO_CHECK_ALARM) {
    return;
  }

  runAutoCheckCycle('alarm').catch((error) => {
    console.error('[YT Comment Carbon Copy] Scheduled check failed:', error);
  });
});

ensureStorageDefaults()
  .then((settings) => syncAutoCheckAlarm(settings))
  .catch((error) => console.error('[YT Comment Carbon Copy] Init failed:', error));

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
    unknownAt: null,
    unknownReason: null,
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
async function setCommentStatus(
  id,
  { status, deletedAt, archivedAt, unknownAt, unknownReason, updateLastCheckedAt = true } = {}
) {
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

  if (status === STATUS_UNKNOWN) {
    updated.unknownAt = unknownAt ?? Date.now();
    updated.unknownReason = unknownReason || null;
  } else {
    updated.unknownAt = unknownAt !== undefined ? unknownAt : null;
    updated.unknownReason = unknownReason !== undefined ? unknownReason : null;
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
    .filter((c) => c.videoId === videoId && (c.status === STATUS_ACTIVE || c.status === STATUS_UNKNOWN));

  if (toCheck.length === 0) {
    return {
      success: true,
      message: 'No comments to check for this video',
      checkedCount: 0,
      deletedCount: 0,
      archivedCount: 0,
      unknownCount: 0
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
    let unknownCount = 0;
    const now = Date.now();
    const byId = new Map(toCheck.map((comment) => [comment.id, comment]));
    for (const result of response.results) {
      if (result.found === null) {
        await setCommentStatus(result.id, {
          status: STATUS_UNKNOWN,
          unknownAt: now,
          unknownReason: result.reason || 'verification_incomplete'
        });
        unknownCount++;
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

    const archivedSummary = archivedCount ? ` ${archivedCount} archived.` : '';
    const unknownSummary = unknownCount ? ` ${unknownCount} unknown.` : '';

    return {
      success: true,
      message: `Checked ${toCheck.length} comment${toCheck.length !== 1 ? 's' : ''}. ${deletedCount} deleted.${archivedSummary}${unknownSummary}`,
      checkedCount: toCheck.length,
      deletedCount,
      archivedCount,
      unknownCount
    };
  } catch (error) {
    console.error('[YT Comment Carbon Copy] Check failed:', error);
    return { success: false, message: 'Failed to check comments. Make sure you are on a YouTube video page.' };
  }
}

// Handle checking all comments for a video by opening it in a background tab
async function handleCheckAllComments(videoId, comments) {
  if (!comments || comments.length === 0) {
    return { success: true, videoId, deletedCount: 0, checkedCount: 0, archivedCount: 0, unknownCount: 0 };
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
    let unknownCount = 0;
    const now = Date.now();
    const byId = new Map(comments.map((comment) => [comment.id, comment]));
    if (response?.results) {
      for (const result of response.results) {
        if (result.found === null) {
          await setCommentStatus(result.id, {
            status: STATUS_UNKNOWN,
            unknownAt: now,
            unknownReason: result.reason || 'verification_incomplete'
          });
          unknownCount++;
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
    } else {
      for (const comment of comments) {
        await setCommentStatus(comment.id, {
          status: STATUS_UNKNOWN,
          unknownAt: now,
          unknownReason: 'verification_timeout'
        });
      }
      unknownCount = comments.length;
    }

    // Close the tab
    await chrome.tabs.remove(tab.id);

    return {
      success: true,
      videoId,
      deletedCount,
      archivedCount,
      unknownCount,
      checkedCount: comments.length
    };
  } catch (error) {
    console.error('[YT Comment Carbon Copy] Batch check failed for video:', videoId, error);
    return {
      success: false,
      videoId,
      error: error.message,
      deletedCount: 0,
      archivedCount: 0,
      unknownCount: 0
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

    case 'GET_SETTINGS':
      Promise.all([
        getSettings(),
        chrome.storage.local.get(LAST_AUTO_CHECK_KEY)
      ])
        .then(([settings, data]) => {
          sendResponse({
            success: true,
            settings,
            lastAutoCheck: data?.[LAST_AUTO_CHECK_KEY] || null
          });
        })
        .catch((error) => {
          console.error('[YT Comment Carbon Copy] Get settings failed:', error);
          sendResponse({ success: false, error: error.message });
        });
      return true;

    case 'UPDATE_SETTINGS':
      updateSettings(message.payload)
        .then((settings) => sendResponse({ success: true, settings }))
        .catch((error) => {
          console.error('[YT Comment Carbon Copy] Update settings failed:', error);
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
