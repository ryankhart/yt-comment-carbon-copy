// YouTube Comment Monitor - Popup Script

document.addEventListener('DOMContentLoaded', init);

async function init() {
  await loadComments();
  document.getElementById('checkBtn').addEventListener('click', handleCheck);
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

  if (comments.length === 0) {
    list.innerHTML = '';
    empty.classList.remove('hidden');
    return;
  }

  empty.classList.add('hidden');

  // Sort by date (newest first)
  const sorted = comments.sort((a, b) => b.submittedAt - a.submittedAt);

  list.innerHTML = sorted.map(createCommentCard).join('');

  // Attach copy button handlers
  list.querySelectorAll('.copy-btn').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      const text = e.target.dataset.text;
      copyToClipboard(text, e.target);
    });
  });
}

// Create HTML for a single comment card
function createCommentCard(comment) {
  const isDeleted = comment.status === 'deleted';
  const statusClass = isDeleted ? 'deleted' : 'active';
  const statusLabel = isDeleted ? 'DELETED' : 'Active';

  const date = new Date(comment.submittedAt).toLocaleDateString();
  const videoTitle = comment.videoTitle || 'Unknown video';

  return `
    <div class="comment-card ${isDeleted ? 'deleted' : ''}">
      <div class="comment-text">${escapeHtml(comment.text)}</div>
      <div class="comment-meta">
        <div class="comment-info">
          <span class="video-title" title="${escapeHtml(videoTitle)}">${escapeHtml(videoTitle)}</span>
          <span>${date}</span>
          <span class="status-badge ${statusClass}">${statusLabel}</span>
        </div>
        <button class="copy-btn" data-text="${escapeHtml(comment.text)}">Copy</button>
      </div>
    </div>
  `;
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
      const url = new URL(tab.url);
      videoId = url.searchParams.get('v');
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
