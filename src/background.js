// YT Comment Carbon Copy - Background Service Worker

const STATUS_ACTIVE = 'active';
const STATUS_DELETED = 'deleted';
const STATUS_ARCHIVED = 'archived';
const STATUS_UNKNOWN = 'unknown';
const SETTINGS_KEY = 'settings';
const LAST_AUTO_CHECK_KEY = 'lastAutoCheck';
const COMMENTS_BY_VIDEO_KEY = 'commentsByVideo';
const AUTO_CHECK_ALARM = 'autoCheckComments';
const SUPPORTED_AUTO_CHECK_INTERVALS = [6, 12, 24];
const SUPPORTED_AUTO_ARCHIVE_HOURS = [0, 24, 72, 168];
const DEFAULT_SETTINGS = {
  autoCheckEnabled: false,
  autoCheckIntervalHours: 12,
  autoCheckNotifications: false,
  autoArchiveHours: 24
};

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
  const autoArchiveHours = SUPPORTED_AUTO_ARCHIVE_HOURS.includes(Number(source.autoArchiveHours))
    ? Number(source.autoArchiveHours)
    : DEFAULT_SETTINGS.autoArchiveHours;

  return {
    autoCheckEnabled: Boolean(source.autoCheckEnabled),
    autoCheckIntervalHours,
    autoCheckNotifications: Boolean(source.autoCheckNotifications),
    autoArchiveHours
  };
}

function getAutoArchiveAfterMs(autoArchiveHours) {
  if (!autoArchiveHours) {
    return null;
  }
  return autoArchiveHours * 60 * 60 * 1000;
}

function buildAutoCheckSummaryMessage(summary) {
  const deletedPart = `${summary.deletedCount} deleted`;
  const unknownPart = `${summary.unknownCount} unknown`;
  return `Checked ${summary.checkedCount} comments across ${summary.videoCount} videos: ${deletedPart}, ${unknownPart}.`;
}

function buildCommentsByVideoIndex(comments) {
  const index = {};
  Object.values(comments || {}).forEach((comment) => {
    if (!comment?.videoId || !comment?.id) {
      return;
    }
    if (!index[comment.videoId]) {
      index[comment.videoId] = [];
    }
    index[comment.videoId].push(comment.id);
  });
  return index;
}

function normalizeCommentsByVideoIndex(comments, commentsByVideo) {
  const validIds = new Set(Object.keys(comments || {}));
  const normalized = {};
  const source = commentsByVideo && typeof commentsByVideo === 'object' ? commentsByVideo : {};

  Object.entries(source).forEach(([videoId, ids]) => {
    if (!videoId || !Array.isArray(ids)) {
      return;
    }
    const filteredIds = ids.filter((id) => validIds.has(id));
    if (filteredIds.length > 0) {
      normalized[videoId] = filteredIds;
    }
  });

  return normalized;
}

function indexesEqual(a, b) {
  const aKeys = Object.keys(a || {});
  const bKeys = Object.keys(b || {});
  if (aKeys.length !== bKeys.length) {
    return false;
  }
  for (const key of aKeys) {
    const aIds = a[key] || [];
    const bIds = b[key] || [];
    if (aIds.length !== bIds.length) {
      return false;
    }
    for (let i = 0; i < aIds.length; i++) {
      if (aIds[i] !== bIds[i]) {
        return false;
      }
    }
  }
  return true;
}

async function getCommentsWithIndex() {
  const data = await chrome.storage.local.get(['comments', COMMENTS_BY_VIDEO_KEY]);
  const comments = data.comments || {};
  const existingIndex = normalizeCommentsByVideoIndex(comments, data[COMMENTS_BY_VIDEO_KEY]);
  const rebuiltIndex = buildCommentsByVideoIndex(comments);

  if (!indexesEqual(existingIndex, rebuiltIndex)) {
    await chrome.storage.local.set({ [COMMENTS_BY_VIDEO_KEY]: rebuiltIndex });
  }

  return {
    comments,
    commentsByVideo: rebuiltIndex
  };
}

async function ensureStorageDefaults() {
  const data = await chrome.storage.local.get(['comments', SETTINGS_KEY, COMMENTS_BY_VIDEO_KEY]);
  const updates = {};

  const comments = data.comments || {};
  if (!data.comments) {
    updates.comments = comments;
  }

  const normalizedSettings = normalizeSettings(data[SETTINGS_KEY]);
  if (!data[SETTINGS_KEY] || JSON.stringify(data[SETTINGS_KEY]) !== JSON.stringify(normalizedSettings)) {
    updates[SETTINGS_KEY] = normalizedSettings;
  }

  const normalizedIndex = normalizeCommentsByVideoIndex(comments, data[COMMENTS_BY_VIDEO_KEY]);
  const rebuiltIndex = buildCommentsByVideoIndex(comments);
  if (!data[COMMENTS_BY_VIDEO_KEY] || !indexesEqual(normalizedIndex, rebuiltIndex)) {
    updates[COMMENTS_BY_VIDEO_KEY] = rebuiltIndex;
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

async function maybeNotifyAutoCheck(summary, settings, trigger) {
  if (trigger !== 'alarm') {
    return;
  }

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

    const { comments, commentsByVideo } = await getCommentsWithIndex();
    const activeComments = [];
    const commentsByVideoForCheck = {};

    Object.entries(commentsByVideo).forEach(([videoId, ids]) => {
      const toCheck = ids
        .map((id) => comments[id])
        .filter((comment) => {
          if (!comment) return false;
          const status = comment.status || STATUS_ACTIVE;
          return status === STATUS_ACTIVE || status === STATUS_UNKNOWN;
        });

      if (toCheck.length > 0) {
        commentsByVideoForCheck[videoId] = toCheck;
        activeComments.push(...toCheck);
      }
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

    const videoIds = Object.keys(commentsByVideoForCheck);
    let deletedCount = 0;
    let archivedCount = 0;
    let unknownCount = 0;

    for (const videoId of videoIds) {
      const result = await handleCheckAllComments(videoId, commentsByVideoForCheck[videoId]);
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
    await maybeNotifyAutoCheck(summary, settings, trigger);

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
  const { comments, commentsByVideo } = await getCommentsWithIndex();
  const nextComments = { ...comments };
  const nextIndex = { ...commentsByVideo };

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
  if (comment.videoId) {
    const ids = nextIndex[comment.videoId] ? [...nextIndex[comment.videoId]] : [];
    ids.push(id);
    nextIndex[comment.videoId] = ids;
  }

  await chrome.storage.local.set({
    comments: nextComments,
    [COMMENTS_BY_VIDEO_KEY]: nextIndex
  });

  return id;
}

// Get all comments from storage
async function getComments() {
  const { comments } = await getCommentsWithIndex();
  return comments;
}

function normalizeCommentText(value) {
  if (!value) return '';
  return String(value).replace(/\s+/g, ' ').trim();
}

function escapeCsv(value) {
  const str = value == null ? '' : String(value);
  const escaped = str.replace(/"/g, '""');
  return `"${escaped}"`;
}

function commentFingerprint(comment) {
  const normalizedText = normalizeCommentText(comment.text);
  const submittedAt = Number(comment.submittedAt) || 0;
  const commentId = comment.commentId || '';
  const videoId = comment.videoId || '';
  return `${videoId}|${commentId}|${normalizedText}|${submittedAt}`;
}

function normalizeImportedComment(rawComment) {
  if (!rawComment || typeof rawComment !== 'object') {
    return null;
  }

  const text = typeof rawComment.text === 'string' ? rawComment.text : '';
  if (!normalizeCommentText(text)) {
    return null;
  }

  const status = [STATUS_ACTIVE, STATUS_DELETED, STATUS_ARCHIVED, STATUS_UNKNOWN].includes(rawComment.status)
    ? rawComment.status
    : STATUS_ACTIVE;

  return {
    id: typeof rawComment.id === 'string' && rawComment.id ? rawComment.id : generateId(),
    text,
    videoId: rawComment.videoId || null,
    videoTitle: rawComment.videoTitle || '',
    videoUrl: rawComment.videoUrl || null,
    submittedAt: Number(rawComment.submittedAt) || Date.now(),
    status,
    lastCheckedAt: Number(rawComment.lastCheckedAt) || null,
    deletedAt: Number(rawComment.deletedAt) || null,
    archivedAt: Number(rawComment.archivedAt) || null,
    unknownAt: Number(rawComment.unknownAt) || null,
    unknownReason: rawComment.unknownReason || null,
    commentId: rawComment.commentId || null,
    commentUrl: rawComment.commentUrl || null
  };
}

async function exportComments(format) {
  const comments = await getComments();
  const records = Object.values(comments).sort((a, b) => (b.submittedAt || 0) - (a.submittedAt || 0));
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');

  if (format === 'csv') {
    const headers = [
      'id',
      'text',
      'videoId',
      'videoTitle',
      'videoUrl',
      'submittedAt',
      'status',
      'lastCheckedAt',
      'deletedAt',
      'archivedAt',
      'unknownAt',
      'unknownReason',
      'commentId',
      'commentUrl'
    ];

    const lines = [headers.join(',')];
    records.forEach((comment) => {
      const row = headers.map((field) => escapeCsv(comment[field]));
      lines.push(row.join(','));
    });

    return {
      filename: `yt-comment-carbon-copy-${timestamp}.csv`,
      mimeType: 'text/csv;charset=utf-8',
      content: lines.join('\n')
    };
  }

  const payload = {
    exportedAt: Date.now(),
    formatVersion: 1,
    comments: records
  };

  return {
    filename: `yt-comment-carbon-copy-${timestamp}.json`,
    mimeType: 'application/json;charset=utf-8',
    content: JSON.stringify(payload, null, 2)
  };
}

async function importCommentsFromJson(rawText) {
  if (!rawText || typeof rawText !== 'string') {
    throw new Error('Import data is empty');
  }

  let parsed;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    throw new Error('Invalid JSON file');
  }

  const importedArray = Array.isArray(parsed)
    ? parsed
    : Array.isArray(parsed?.comments)
      ? parsed.comments
      : parsed?.comments && typeof parsed.comments === 'object'
        ? Object.values(parsed.comments)
        : [];

  if (importedArray.length === 0) {
    throw new Error('No comments found in import file');
  }

  const existing = await getComments();
  const existingFingerprints = new Set(Object.values(existing).map(commentFingerprint));
  const nextComments = { ...existing };

  let importedCount = 0;
  let skippedCount = 0;

  importedArray.forEach((entry) => {
    const normalized = normalizeImportedComment(entry);
    if (!normalized) {
      skippedCount++;
      return;
    }

    const fingerprint = commentFingerprint(normalized);
    if (existingFingerprints.has(fingerprint)) {
      skippedCount++;
      return;
    }

    let id = normalized.id;
    while (nextComments[id]) {
      id = generateId();
    }

    nextComments[id] = { ...normalized, id };
    existingFingerprints.add(fingerprint);
    importedCount++;
  });

  if (importedCount > 0) {
    await chrome.storage.local.set({
      comments: nextComments,
      [COMMENTS_BY_VIDEO_KEY]: buildCommentsByVideoIndex(nextComments)
    });
  }

  return {
    importedCount,
    skippedCount
  };
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

function shouldAutoArchive(comment, autoArchiveAfterMs, now = Date.now()) {
  if (!autoArchiveAfterMs) return false;
  if (!comment?.submittedAt) return false;
  return now - comment.submittedAt >= autoArchiveAfterMs;
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
  const { comments, commentsByVideo } = await getCommentsWithIndex();
  const settings = await getSettings();
  const autoArchiveAfterMs = getAutoArchiveAfterMs(settings.autoArchiveHours);
  const commentIds = commentsByVideo[videoId] || [];
  const toCheck = commentIds
    .map((id) => comments[id])
    .filter((c) => c && (c.status === STATUS_ACTIVE || c.status === STATUS_UNKNOWN));

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
        if (comment && shouldAutoArchive(comment, autoArchiveAfterMs, now)) {
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
      unknownCount,
      autoArchiveHours: settings.autoArchiveHours
    };
  } catch (error) {
    console.error('[YT Comment Carbon Copy] Check failed:', error);
    return { success: false, message: 'Failed to check comments. Make sure you are on a YouTube video page.' };
  }
}

// Handle checking all comments for a video by opening it in a background tab
async function handleCheckAllComments(videoId, comments) {
  const settings = await getSettings();
  const autoArchiveAfterMs = getAutoArchiveAfterMs(settings.autoArchiveHours);

  if (!comments || comments.length === 0) {
    return {
      success: true,
      videoId,
      deletedCount: 0,
      checkedCount: 0,
      archivedCount: 0,
      unknownCount: 0,
      autoArchiveHours: settings.autoArchiveHours
    };
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
          if (comment && shouldAutoArchive(comment, autoArchiveAfterMs, now)) {
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
      checkedCount: comments.length,
      autoArchiveHours: settings.autoArchiveHours
    };
  } catch (error) {
    console.error('[YT Comment Carbon Copy] Batch check failed for video:', videoId, error);
    return {
      success: false,
      videoId,
      error: error.message,
      deletedCount: 0,
      archivedCount: 0,
      unknownCount: 0,
      autoArchiveHours: settings.autoArchiveHours
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

    case 'EXPORT_COMMENTS':
      exportComments(message.format)
        .then((data) => sendResponse({ success: true, ...data }))
        .catch((error) => {
          console.error('[YT Comment Carbon Copy] Export failed:', error);
          sendResponse({ success: false, error: error.message });
        });
      return true;

    case 'IMPORT_COMMENTS_JSON':
      importCommentsFromJson(message.rawText)
        .then((result) => sendResponse({ success: true, ...result }))
        .catch((error) => {
          console.error('[YT Comment Carbon Copy] Import failed:', error);
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

    case 'CHECK_ALL_ACTIVE_COMMENTS':
      runAutoCheckCycle('manual_batch')
        .then((result) => {
          if (!result?.success) {
            sendResponse({ success: false, message: result?.reason || 'Batch check failed' });
            return;
          }
          sendResponse({
            success: true,
            ...result.summary
          });
        })
        .catch((error) => {
          console.error('[YT Comment Carbon Copy] Manual batch check failed:', error);
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
