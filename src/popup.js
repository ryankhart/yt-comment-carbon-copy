// YT Comment Carbon Copy - Popup Script

document.addEventListener('DOMContentLoaded', init);

const EMPTY_DEFAULT_HTML = 'No comments captured yet.<br>Submit a comment on YouTube to start tracking.';
const EMPTY_ARCHIVED_HTML = 'No active comments.<br>Use "Show Archived" to view archived items.';
const STATUS_ACTIVE = 'active';
const STATUS_DELETED = 'deleted';
const STATUS_ARCHIVED = 'archived';
const STATUS_UNKNOWN = 'unknown';
const AUTO_ARCHIVE_NOTICE_KEY = 'autoArchiveNotice';

let showArchived = false;

async function init() {
  updateArchivedToggle();
  bindAutoArchiveNoticeDismiss();
  await renderStoredAutoArchiveNotice();
  await loadComments();
  document.getElementById('checkBtn').addEventListener('click', handleCheck);
  document.getElementById('checkAllBtn').addEventListener('click', handleCheckAll);
  document.getElementById('toggleArchivedBtn').addEventListener('click', toggleArchived);
}

// Load and display all comments
async function loadComments() {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ action: 'GET_COMMENTS' }, (response) => {
      if (chrome.runtime.lastError) {
        showStatus('Failed to load comments', 'error');
        resolve();
        return;
      }

      if (response?.success) {
        const comments = Object.values(response.comments);
        renderComments(comments);
      }
      resolve();
    });
  });
}

// Render comments list
function renderComments(comments) {
  const list = document.getElementById('comment-list');
  const empty = document.getElementById('empty-state');
  const archivedCount = comments.filter((comment) => getStatus(comment) === STATUS_ARCHIVED).length;
  const visibleComments = showArchived
    ? comments
    : comments.filter((comment) => getStatus(comment) !== STATUS_ARCHIVED);

  if (comments.length === 0) {
    list.innerHTML = '';
    empty.innerHTML = EMPTY_DEFAULT_HTML;
    empty.classList.remove('hidden');
    return;
  }

  if (visibleComments.length === 0) {
    list.innerHTML = '';
    empty.innerHTML = archivedCount > 0 ? EMPTY_ARCHIVED_HTML : EMPTY_DEFAULT_HTML;
    empty.classList.remove('hidden');
    return;
  }

  empty.classList.add('hidden');

  // Sort by date (newest first)
  const sorted = visibleComments.sort((a, b) => b.submittedAt - a.submittedAt);

  list.innerHTML = sorted.map(createCommentCard).join('');

  // Attach copy button handlers
  list.querySelectorAll('.copy-btn').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      const text = e.target.dataset.text;
      copyToClipboard(text, e.target);
    });
  });

  // Attach open button handlers
  list.querySelectorAll('.open-btn').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      const url = e.target.dataset.url;
      if (url) {
        openInNewTab(url);
      }
    });
  });

  list.querySelectorAll('.archive-btn').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      const { id, action } = e.target.dataset;
      if (!id || !action) return;
      e.target.disabled = true;
      await handleArchiveAction(id, action);
      await loadComments();
    });
  });
}

// Create HTML for a single comment card
function createCommentCard(comment) {
  const status = getStatus(comment);
  const isDeleted = status === STATUS_DELETED;
  const isArchived = status === STATUS_ARCHIVED;
  const isUnknown = status === STATUS_UNKNOWN;
  const statusClass = isDeleted
    ? 'deleted'
    : isArchived
      ? 'archived'
      : isUnknown
        ? 'unknown'
        : 'active';
  const statusLabel = isDeleted
    ? 'DELETED'
    : isArchived
      ? 'Archived'
      : isUnknown
        ? 'Unknown'
        : 'Active';

  const date = new Date(comment.submittedAt).toLocaleDateString();
  const videoTitle = comment.videoTitle || 'Unknown video';
  const targetUrl = getTargetUrl(comment);
  const archiveAction = isArchived ? 'unarchive' : 'archive';
  const archiveLabel = isArchived ? 'Unarchive' : 'Archive';

  return `
    <div class="comment-card ${isDeleted ? 'deleted' : ''} ${isArchived ? 'archived' : ''} ${isUnknown ? 'unknown' : ''}">
      <div class="comment-text">${escapeHtml(comment.text)}</div>
      <div class="comment-meta">
        <div class="comment-info">
          <span class="video-title" title="${escapeHtml(videoTitle)}">${escapeHtml(videoTitle)}</span>
          <span>${date}</span>
          <span class="status-badge ${statusClass}">${statusLabel}</span>
        </div>
        <div class="comment-actions">
          <button class="open-btn" ${targetUrl ? `data-url="${escapeHtml(targetUrl)}"` : 'disabled'}>Open</button>
          <button class="archive-btn" data-id="${escapeHtml(comment.id)}" data-action="${archiveAction}">${archiveLabel}</button>
          <button class="copy-btn" data-text="${escapeHtml(comment.text)}">Copy</button>
        </div>
      </div>
    </div>
  `;
}

// Show/hide progress indicator
function showProgress(text, percent) {
  const progress = document.getElementById('progress');
  const progressText = document.getElementById('progress-text');
  const progressFill = document.getElementById('progress-fill');

  progress.classList.add('visible');
  progressText.textContent = text;
  progressFill.style.width = `${percent}%`;
}

function hideProgress() {
  const progress = document.getElementById('progress');
  progress.classList.remove('visible');
}

// Handle "Check All Comments" button click
async function handleCheckAll() {
  const checkBtn = document.getElementById('checkBtn');
  const checkAllBtn = document.getElementById('checkAllBtn');

  checkBtn.disabled = true;
  checkAllBtn.disabled = true;
  showStatus('Starting batch check...', '');

  try {
    const response = await new Promise((resolve) => {
      chrome.runtime.sendMessage({ action: 'GET_COMMENTS' }, resolve);
    });

    if (!response?.success) {
      showStatus('Failed to load comments', 'error');
      checkBtn.disabled = false;
      checkAllBtn.disabled = false;
      return;
    }

    const allComments = Object.values(response.comments);
    const activeComments = allComments.filter((c) => {
      const status = getStatus(c);
      return (status === STATUS_ACTIVE || status === STATUS_UNKNOWN) && c.videoId;
    });

    if (activeComments.length === 0) {
      showStatus('No active comments to check', 'success');
      checkBtn.disabled = false;
      checkAllBtn.disabled = false;
      return;
    }

    // Group comments by video
    const commentsByVideo = {};
    for (const comment of activeComments) {
      if (!commentsByVideo[comment.videoId]) {
        commentsByVideo[comment.videoId] = [];
      }
      commentsByVideo[comment.videoId].push(comment);
    }

    const videoIds = Object.keys(commentsByVideo);
    const totalVideos = videoIds.length;
    let processedVideos = 0;
    let totalDeleted = 0;
    let totalArchived = 0;
    let totalUnknown = 0;

    showProgress(`Checking 0/${totalVideos} videos...`, 0);

    // Process each video
    for (const videoId of videoIds) {
      const comments = commentsByVideo[videoId];
      const videoTitle = comments[0].videoTitle || 'Unknown video';

      showProgress(`Checking "${videoTitle.substring(0, 30)}..." (${processedVideos + 1}/${totalVideos})`,
                   (processedVideos / totalVideos) * 100);

      try {
        const result = await new Promise((resolve) => {
          chrome.runtime.sendMessage(
            { action: 'CHECK_ALL_COMMENTS', videoId, comments },
            resolve
          );
        });

        if (result?.deletedCount) {
          totalDeleted += result.deletedCount;
        }
        if (result?.archivedCount) {
          totalArchived += result.archivedCount;
        }
        if (result?.unknownCount) {
          totalUnknown += result.unknownCount;
        }
      } catch (error) {
        console.error(`Failed to check video ${videoId}:`, error);
      }

      processedVideos++;

      // Small delay between videos to avoid overwhelming YouTube
      if (processedVideos < totalVideos) {
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }

    hideProgress();
    const archivedSummary = totalArchived
      ? ` ${totalArchived} archived.`
      : '';
    const unknownSummary = totalUnknown
      ? ` ${totalUnknown} unknown.`
      : '';
    showStatus(`Checked ${activeComments.length} comment${activeComments.length !== 1 ? 's' : ''} across ${totalVideos} video${totalVideos !== 1 ? 's' : ''}. ${totalDeleted} deleted.${archivedSummary}${unknownSummary}`, 'success');
    await handleAutoArchiveNotice(totalArchived);

    // Refresh the comment list
    await loadComments();
  } catch (error) {
    hideProgress();
    showStatus('Error during batch check: ' + error.message, 'error');
  } finally {
    checkBtn.disabled = false;
    checkAllBtn.disabled = false;
  }
}

// Handle "Check Current Video" button click
async function handleCheck() {
  const checkBtn = document.getElementById('checkBtn');
  checkBtn.disabled = true;
  showStatus('Checking...', '');

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

    if (!tab?.url) {
      showStatus('Could not access current tab', 'error');
      checkBtn.disabled = false;
      return;
    }

    let videoId;
    try {
      videoId = getVideoIdFromUrl(tab.url);
    } catch {
      videoId = null;
    }

    if (!videoId) {
      showStatus('Not on a YouTube video page', 'error');
      checkBtn.disabled = false;
      return;
    }

    chrome.runtime.sendMessage({ action: 'CHECK_COMMENTS', videoId }, async (response) => {
      if (chrome.runtime.lastError) {
        showStatus('Check failed: ' + chrome.runtime.lastError.message, 'error');
      } else if (response?.success) {
        showStatus(response.message, 'success');
        await handleAutoArchiveNotice(response.archivedCount || 0);
      } else {
        showStatus(response?.message || 'Check failed', 'error');
      }

      // Refresh the comment list
      await loadComments();
      checkBtn.disabled = false;
    });
  } catch (error) {
    showStatus('Error: ' + error.message, 'error');
    checkBtn.disabled = false;
  }
}

// Show status message
function showStatus(message, type) {
  const status = document.getElementById('status');
  status.textContent = message;
  status.className = type || '';
}

function getStatus(comment) {
  return comment.status || STATUS_ACTIVE;
}

function updateArchivedToggle() {
  const toggleBtn = document.getElementById('toggleArchivedBtn');
  toggleBtn.textContent = showArchived ? 'Hide Archived' : 'Show Archived';
}

function bindAutoArchiveNoticeDismiss() {
  const dismissButton = document.getElementById('dismiss-auto-archive-notice');
  dismissButton.addEventListener('click', async () => {
    hideAutoArchiveNotice();
    await chrome.storage.local.remove(AUTO_ARCHIVE_NOTICE_KEY);
  });
}

async function renderStoredAutoArchiveNotice() {
  const data = await chrome.storage.local.get(AUTO_ARCHIVE_NOTICE_KEY);
  const count = data?.[AUTO_ARCHIVE_NOTICE_KEY]?.count || 0;
  if (count > 0) {
    showAutoArchiveNotice(count);
  } else {
    hideAutoArchiveNotice();
  }
}

async function handleAutoArchiveNotice(count) {
  if (!count) {
    return;
  }

  const notice = {
    count,
    createdAt: Date.now()
  };
  await chrome.storage.local.set({ [AUTO_ARCHIVE_NOTICE_KEY]: notice });
  showAutoArchiveNotice(count);
}

function showAutoArchiveNotice(count) {
  const notice = document.getElementById('auto-archive-notice');
  const text = document.getElementById('auto-archive-notice-text');
  text.textContent = `${count} comment${count !== 1 ? 's were' : ' was'} auto-archived after 24 hours to keep your active feed clean.`;
  notice.classList.remove('hidden');
}

function hideAutoArchiveNotice() {
  const notice = document.getElementById('auto-archive-notice');
  notice.classList.add('hidden');
}

function toggleArchived() {
  showArchived = !showArchived;
  updateArchivedToggle();
  loadComments();
}

async function handleArchiveAction(id, action) {
  const isUnarchive = action === 'unarchive';
  const response = await new Promise((resolve) => {
    chrome.runtime.sendMessage(
      { action: isUnarchive ? 'UNARCHIVE_COMMENT' : 'ARCHIVE_COMMENT', id },
      resolve
    );
  });

  if (chrome.runtime.lastError || !response?.success) {
    showStatus('Failed to update archive state', 'error');
    return;
  }

  showStatus(isUnarchive ? 'Comment restored' : 'Comment archived', 'success');
}

function getTargetUrl(comment) {
  if (getStatus(comment) !== STATUS_DELETED && comment.commentUrl) {
    return comment.commentUrl;
  }

  if (comment.videoUrl) {
    return comment.videoUrl;
  }

  if (comment.videoId) {
    return `https://www.youtube.com/watch?v=${comment.videoId}`;
  }

  return null;
}

function openInNewTab(url) {
  chrome.tabs.create({ url });
}

// Copy text to clipboard
async function copyToClipboard(text, button) {
  try {
    await navigator.clipboard.writeText(text);
    const originalText = button.textContent;
    button.textContent = 'Copied!';
    setTimeout(() => {
      button.textContent = originalText;
    }, 1500);
  } catch (err) {
    console.error('Failed to copy:', err);
    showStatus('Failed to copy to clipboard', 'error');
  }
}

// Escape HTML to prevent XSS
function escapeHtml(str) {
  if (!str) return '';
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
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
