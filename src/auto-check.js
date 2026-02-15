// YT Comment Carbon Copy - Auto Check Settings Page

document.addEventListener('DOMContentLoaded', initAutoCheckPage);

const DEFAULT_SETTINGS = {
  autoCheckEnabled: false,
  autoCheckIntervalHours: 12,
  autoCheckNotifications: false,
  autoArchiveHours: 24
};

async function initAutoCheckPage() {
  bindControls();
  await loadSettings();
}

function bindControls() {
  document.getElementById('save-settings-btn').addEventListener('click', handleSaveSettings);
  document.getElementById('auto-check-enabled').addEventListener('change', updateSettingsFormState);
  document.getElementById('close-page-btn').addEventListener('click', () => {
    window.location.href = 'popup.html';
  });
}

async function loadSettings() {
  const response = await new Promise((resolve) => {
    chrome.runtime.sendMessage({ action: 'GET_SETTINGS' }, resolve);
  });

  if (chrome.runtime.lastError || !response?.success) {
    showStatus('Failed to load auto-check settings', 'error');
    applySettingsToForm(DEFAULT_SETTINGS);
    renderAutoCheckMeta(null);
    return;
  }

  applySettingsToForm(response.settings || DEFAULT_SETTINGS);
  renderAutoCheckMeta(response.lastAutoCheck || null);
}

function applySettingsToForm(settings) {
  const normalized = { ...DEFAULT_SETTINGS, ...(settings || {}) };
  document.getElementById('auto-check-enabled').checked = Boolean(normalized.autoCheckEnabled);
  document.getElementById('auto-check-notify').checked = Boolean(normalized.autoCheckNotifications);
  document.getElementById('auto-check-interval').value = String(normalized.autoCheckIntervalHours);
  document.getElementById('auto-archive-hours').value = String(normalized.autoArchiveHours);
  updateSettingsFormState();
}

function updateSettingsFormState() {
  const enabled = document.getElementById('auto-check-enabled').checked;
  document.getElementById('auto-check-interval').disabled = !enabled;
  document.getElementById('auto-check-notify').disabled = !enabled;
}

function setSettingsSaving(isSaving) {
  document.getElementById('save-settings-btn').disabled = isSaving;
}

async function handleSaveSettings() {
  const payload = {
    autoCheckEnabled: document.getElementById('auto-check-enabled').checked,
    autoCheckIntervalHours: Number(document.getElementById('auto-check-interval').value),
    autoCheckNotifications: document.getElementById('auto-check-notify').checked,
    autoArchiveHours: Number(document.getElementById('auto-archive-hours').value)
  };

  setSettingsSaving(true);
  const response = await new Promise((resolve) => {
    chrome.runtime.sendMessage({ action: 'UPDATE_SETTINGS', payload }, resolve);
  });
  setSettingsSaving(false);

  if (chrome.runtime.lastError || !response?.success) {
    showStatus('Failed to save auto-check settings', 'error');
    return;
  }

  applySettingsToForm(response.settings || DEFAULT_SETTINGS);
  showStatus(payload.autoCheckEnabled ? 'Scheduled checks enabled' : 'Scheduled checks disabled', 'success');
}

function renderAutoCheckMeta(lastAutoCheck) {
  const meta = document.getElementById('auto-check-meta');
  if (!lastAutoCheck?.checkedAt) {
    meta.textContent = 'No auto-check has run yet.';
    return;
  }

  const checkedAt = new Date(lastAutoCheck.checkedAt);
  const timeText = checkedAt.toLocaleString();
  const summary = `${lastAutoCheck.checkedCount || 0} checked, ${lastAutoCheck.deletedCount || 0} deleted, ${lastAutoCheck.unknownCount || 0} unknown`;
  meta.textContent = `Last run: ${timeText} (${summary})`;
}

function showStatus(message, type) {
  const status = document.getElementById('status');
  status.textContent = message;
  status.className = type || '';
}
