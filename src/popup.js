// YT Comment Carbon Copy - Popup Script

document.addEventListener('DOMContentLoaded', init);

const EMPTY_DEFAULT_HTML = 'No comments captured yet.<br>Submit a comment on YouTube to start tracking.';
const EMPTY_FILTERED_HTML = 'No comments match your current filters.';
const STATUS_ACTIVE = 'active';
const STATUS_DELETED = 'deleted';
const STATUS_ARCHIVED = 'archived';
const STATUS_UNKNOWN = 'unknown';
const DEFAULT_STATUS_FILTER = STATUS_ACTIVE;
const AUTO_ARCHIVE_NOTICE_KEY = 'autoArchiveNotice';
const COMMENTS_PER_PAGE = 40;
const DEFAULT_SETTINGS = {
  autoCheckEnabled: false,
  autoCheckIntervalHours: 12,
  autoCheckNotifications: false,
  autoArchiveHours: 24
};

let allComments = [];
let currentSettings = { ...DEFAULT_SETTINGS };
let currentPage = 1;

async function init() {
  bindAutoArchiveNoticeDismiss();
  bindNavigationControls();
  bindDataTools();
  bindFilterControls();
  bindPaginationControls();
  initializeDefaultFilters();
  await loadSettings();
  await renderStoredAutoArchiveNotice();
  await loadComments();
  document.getElementById('checkBtn').addEventListener('click', handleCheck);
  document.getElementById('checkAllBtn').addEventListener('click', handleCheckAll);
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
        allComments = Object.values(response.comments);
        renderComments(allComments);
      }
      resolve();
    });
  });
}

// Render comments list
function renderComments(comments) {
  const list = document.getElementById('comment-list');
  const empty = document.getElementById('empty-state');
  const visibleComments = filterComments(comments).sort((a, b) => b.submittedAt - a.submittedAt);

  if (comments.length === 0) {
    list.innerHTML = '';
    renderPaginationMeta(0, 0);
    empty.innerHTML = EMPTY_DEFAULT_HTML;
    empty.classList.remove('hidden');
    return;
  }

  if (visibleComments.length === 0) {
    list.innerHTML = '';
    renderPaginationMeta(0, 0);
    empty.innerHTML = EMPTY_FILTERED_HTML;
    empty.classList.remove('hidden');
    return;
  }

  empty.classList.add('hidden');

  const totalPages = Math.max(1, Math.ceil(visibleComments.length / COMMENTS_PER_PAGE));
  if (currentPage > totalPages) {
    currentPage = totalPages;
  }
  if (currentPage < 1) {
    currentPage = 1;
  }
  const start = (currentPage - 1) * COMMENTS_PER_PAGE;
  const pagedComments = visibleComments.slice(start, start + COMMENTS_PER_PAGE);

  list.innerHTML = pagedComments.map(createCommentCard).join('');
  renderPaginationMeta(currentPage, totalPages, visibleComments.length);

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

function bindFilterControls() {
  const rerender = () => {
    currentPage = 1;
    renderComments(allComments);
  };
  document.getElementById('filter-query').addEventListener('input', rerender);
  document.getElementById('filter-status').addEventListener('change', rerender);
  document.getElementById('filter-date-range').addEventListener('change', rerender);
}

function initializeDefaultFilters() {
  document.getElementById('filter-status').value = DEFAULT_STATUS_FILTER;
}

function bindPaginationControls() {
  document.getElementById('prev-page-btn').addEventListener('click', () => {
    if (currentPage <= 1) return;
    currentPage -= 1;
    renderComments(allComments);
  });

  document.getElementById('next-page-btn').addEventListener('click', () => {
    currentPage += 1;
    renderComments(allComments);
  });
}

function renderPaginationMeta(page, totalPages, totalItems = 0) {
  const container = document.getElementById('pagination');
  const info = document.getElementById('pagination-info');
  const prev = document.getElementById('prev-page-btn');
  const next = document.getElementById('next-page-btn');

  if (!totalPages || totalPages <= 1) {
    container.classList.add('hidden');
    return;
  }

  container.classList.remove('hidden');
  info.textContent = `Page ${page} of ${totalPages} (${totalItems} matches)`;
  prev.disabled = page <= 1;
  next.disabled = page >= totalPages;
}

function filterComments(comments) {
  const query = document.getElementById('filter-query').value.trim().toLowerCase();
  const selectedStatus = document.getElementById('filter-status').value;
  const selectedRange = document.getElementById('filter-date-range').value;
  const rangeDays = selectedRange === 'all' ? null : Number(selectedRange);
  const cutoff = Number.isFinite(rangeDays) ? Date.now() - (rangeDays * 24 * 60 * 60 * 1000) : null;

  return comments.filter((comment) => {
    const status = getStatus(comment);
    if (selectedStatus !== 'all' && status !== selectedStatus) {
      return false;
    }

    if (cutoff && Number(comment.submittedAt) < cutoff) {
      return false;
    }

    if (!query) {
      return true;
    }

    const searchable = `${comment.text || ''} ${comment.videoTitle || ''}`.toLowerCase();
    return searchable.includes(query);
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
  showProgress('Checking all active comments...', 35);

  try {
    const response = await new Promise((resolve) => {
      chrome.runtime.sendMessage({ action: 'CHECK_ALL_ACTIVE_COMMENTS' }, resolve);
    });

    if (chrome.runtime.lastError || !response?.success) {
      showStatus(response?.message || 'Batch check failed', 'error');
      return;
    }

    const checkedCount = response.checkedCount || 0;
    const totalVideos = response.videoCount || 0;
    if (checkedCount === 0) {
      showStatus('No active comments to check', 'success');
      return;
    }

    const totalDeleted = response.deletedCount || 0;
    const totalArchived = response.archivedCount || 0;
    const totalUnknown = response.unknownCount || 0;
    const archivedSummary = totalArchived
      ? ` ${totalArchived} archived.`
      : '';
    const unknownSummary = totalUnknown
      ? ` ${totalUnknown} unknown.`
      : '';
    showStatus(`Checked ${checkedCount} comment${checkedCount !== 1 ? 's' : ''} across ${totalVideos} video${totalVideos !== 1 ? 's' : ''}. ${totalDeleted} deleted.${archivedSummary}${unknownSummary}`, 'success');
    await handleAutoArchiveNotice(totalArchived, currentSettings.autoArchiveHours);

    // Refresh the comment list
    await loadComments();
  } catch (error) {
    showStatus('Error during batch check: ' + error.message, 'error');
  } finally {
    hideProgress();
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
        await handleAutoArchiveNotice(response.archivedCount || 0, response.autoArchiveHours ?? currentSettings.autoArchiveHours);
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

function bindNavigationControls() {
  document.getElementById('auto-check-page-btn').addEventListener('click', () => {
    chrome.tabs.create({ url: chrome.runtime.getURL('auto-check.html') });
  });
}

function bindDataTools() {
  const menuButton = document.getElementById('more-tools-btn');
  const menu = document.getElementById('tools-menu');
  const importInput = document.getElementById('import-json-input');

  const closeMenu = () => {
    menu.classList.add('hidden');
    menuButton.setAttribute('aria-expanded', 'false');
  };

  const toggleMenu = (event) => {
    event.stopPropagation();
    const isOpen = !menu.classList.contains('hidden');
    if (isOpen) {
      closeMenu();
      return;
    }
    menu.classList.remove('hidden');
    menuButton.setAttribute('aria-expanded', 'true');
  };

  menuButton.addEventListener('click', toggleMenu);
  document.addEventListener('click', (event) => {
    if (menu.classList.contains('hidden')) return;
    if (menu.contains(event.target) || menuButton.contains(event.target)) return;
    closeMenu();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      closeMenu();
    }
  });

  document.getElementById('export-json-btn').addEventListener('click', async () => {
    closeMenu();
    await handleExport('json');
  });
  document.getElementById('export-csv-btn').addEventListener('click', async () => {
    closeMenu();
    await handleExport('csv');
  });
  document.getElementById('import-json-btn').addEventListener('click', () => {
    closeMenu();
    importInput.click();
  });
  importInput.addEventListener('change', handleImportJsonFile);
}

async function loadSettings() {
  const response = await new Promise((resolve) => {
    chrome.runtime.sendMessage({ action: 'GET_SETTINGS' }, resolve);
  });

  if (chrome.runtime.lastError || !response?.success) {
    currentSettings = { ...DEFAULT_SETTINGS };
    return;
  }

  currentSettings = { ...DEFAULT_SETTINGS, ...(response.settings || {}) };
}

async function handleExport(format) {
  const response = await new Promise((resolve) => {
    chrome.runtime.sendMessage({ action: 'EXPORT_COMMENTS', format }, resolve);
  });

  if (chrome.runtime.lastError || !response?.success) {
    showStatus('Failed to export comments', 'error');
    return;
  }

  const blob = new Blob([response.content], { type: response.mimeType || 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = response.filename || `yt-comment-carbon-copy.${format}`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);

  showStatus(`Exported ${format.toUpperCase()} backup`, 'success');
}

async function handleImportJsonFile(event) {
  const file = event.target.files?.[0];
  event.target.value = '';
  if (!file) {
    return;
  }

  let rawText = '';
  try {
    rawText = await file.text();
  } catch (error) {
    showStatus('Failed to read import file', 'error');
    return;
  }

  const response = await new Promise((resolve) => {
    chrome.runtime.sendMessage({ action: 'IMPORT_COMMENTS_JSON', rawText }, resolve);
  });

  if (chrome.runtime.lastError || !response?.success) {
    showStatus(response?.error || 'Failed to import comments', 'error');
    return;
  }

  const imported = response.importedCount || 0;
  const skipped = response.skippedCount || 0;
  showStatus(`Imported ${imported} comments. ${skipped} skipped.`, 'success');
  await loadComments();
}

function getStatus(comment) {
  return comment.status || STATUS_ACTIVE;
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
  const hours = data?.[AUTO_ARCHIVE_NOTICE_KEY]?.hours ?? currentSettings.autoArchiveHours;
  if (count > 0) {
    showAutoArchiveNotice(count, hours);
  } else {
    hideAutoArchiveNotice();
  }
}

async function handleAutoArchiveNotice(count, hours) {
  if (!count) {
    return;
  }

  const notice = {
    count,
    hours,
    createdAt: Date.now()
  };
  await chrome.storage.local.set({ [AUTO_ARCHIVE_NOTICE_KEY]: notice });
  showAutoArchiveNotice(count, hours);
}

function showAutoArchiveNotice(count, hours) {
  const archiveLabel = Number(hours) === 1
    ? '1 hour'
    : Number(hours) === 24
      ? '24 hours'
      : Number(hours) === 72
        ? '3 days'
        : Number(hours) === 168
          ? '7 days'
          : `${hours} hours`;
  const notice = document.getElementById('auto-archive-notice');
  const text = document.getElementById('auto-archive-notice-text');
  text.textContent = `${count} comment${count !== 1 ? 's were' : ' was'} auto-archived after ${archiveLabel} to keep your active feed clean.`;
  notice.classList.remove('hidden');
}

function hideAutoArchiveNotice() {
  const notice = document.getElementById('auto-archive-notice');
  notice.classList.add('hidden');
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
