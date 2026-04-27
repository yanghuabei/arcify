/**
 * Options - Extension settings and preferences UI
 * 
 * Purpose: Provides user interface for configuring extension behavior and preferences
 * Key Functions: Auto-archive settings, default space configuration, extension preferences management
 * Architecture: Options page that syncs with chrome.storage for persistent settings
 * 
 * Critical Notes:
 * - Settings are synced across devices via chrome.storage.sync
 * - Auto-archive timing affects background script alarm configuration
 * - Changes trigger background script updates via message passing
 * - Provides real-time feedback for setting changes
 */

import { Utils } from './utils.js';
import { LocalStorage } from './localstorage.js';
import { Logger } from './logger.js';
import { parseArcJSON, importArcSpaces } from './arc-import.js';

// Default color values (must be 6-digit hex for color picker compatibility)
const DEFAULT_COLORS = {
  grey: '#cccccc',
  blue: '#8bb3f3',
  red: '#ff9e97',
  yellow: '#ffe29f',
  green: '#8bda99',
  pink: '#fbaad7',
  purple: '#d6a6ff',
  cyan: '#a5e2ea'
};

const COLOR_NAMES = Object.keys(DEFAULT_COLORS);

// Helper to get color picker element ID from color name
function getColorPickerId(colorName) {
  return `color${colorName.charAt(0).toUpperCase() + colorName.slice(1)}`;
}

// Helper to safely get checkbox value with default
function getCheckboxValue(element, defaultValue) {
  return element ? element.checked : defaultValue;
}

// Helper to safely set checkbox value with default
function setCheckboxValue(element, value, defaultValue) {
  if (element) {
    element.checked = value !== undefined ? value : defaultValue;
  }
}

// Helper to add event listener if element exists
function addListenerIfExists(elementId, event, handler) {
  const element = document.getElementById(elementId);
  if (element) {
    element.addEventListener(event, handler);
  }
  return element;
}

function updateAutoArchiveIdleMinutesVisibility(forceEnabled) {
  const container = document.getElementById('autoArchiveIdleMinutesContainer');
  const checkbox = document.getElementById('autoArchiveEnabled');
  const input = document.getElementById('autoArchiveIdleMinutes');
  if (!container || !checkbox || !input) return;

  const isEnabled = forceEnabled !== undefined ? Boolean(forceEnabled) : Boolean(checkbox.checked);
  container.style.display = isEnabled ? '' : 'none';
  input.disabled = !isEnabled;
}

// Function to apply color overrides to CSS variables
function applyColorOverrides(colorOverrides) {
  if (!colorOverrides) return;

  const root = document.documentElement;
  Object.keys(colorOverrides).forEach(colorName => {
    const colorValue = colorOverrides[colorName];
    if (colorValue) {
      root.style.setProperty(`--user-chrome-${colorName}-color`, colorValue);
    } else {
      root.style.removeProperty(`--user-chrome-${colorName}-color`);
    }
  });
}

// Function to save options to chrome.storage
async function saveOptions() {
  const defaultSpaceNameSelect = document.getElementById('defaultSpaceName');
  const autoArchiveIdleMinutesInput = document.getElementById('autoArchiveIdleMinutes');

  // Collect color overrides (only non-default values)
  const colorOverrides = {};
  COLOR_NAMES.forEach(colorName => {
    const colorPicker = document.getElementById(getColorPickerId(colorName));
    if (colorPicker && colorPicker.value !== DEFAULT_COLORS[colorName]) {
      colorOverrides[colorName] = colorPicker.value;
    }
  });

  const settings = {
    defaultSpaceName: defaultSpaceNameSelect?.value || 'Home',
    autoArchiveEnabled: getCheckboxValue(document.getElementById('autoArchiveEnabled'), false),
    autoArchiveIdleMinutes: parseInt(autoArchiveIdleMinutesInput?.value, 10) || 360,
    invertTabOrder: getCheckboxValue(document.getElementById('invertTabOrder'), true),
    enableSpotlight: getCheckboxValue(document.getElementById('enableSpotlight'), true),
    showAllOpenTabsInCollapsedFolders: getCheckboxValue(document.getElementById('showAllOpenTabsInCollapsedFolders'), false),
    colorOverrides: Object.keys(colorOverrides).length > 0 ? colorOverrides : null,
    debugLoggingEnabled: getCheckboxValue(document.getElementById('debugLoggingEnabled'), false)
  };

  try {
    await chrome.storage.sync.set(settings);
    Logger.log('Settings saved:', settings);

    applyColorOverrides(settings.colorOverrides);
    await chrome.runtime.sendMessage({ action: 'updateAutoArchiveSettings' });
    showToast();
  } catch (error) {
    Logger.error('Error saving settings:', error);
  }
}

// Function to show toast notification
function showToast() {
  const toast = document.getElementById('saveToast');
  if (!toast) return;

  // Add show class to trigger animation
  toast.classList.add('show');

  // Remove show class after 2 seconds
  setTimeout(() => {
    toast.classList.remove('show');
  }, 2000);
}

// Function to restore options from chrome.storage
async function restoreOptions() {
  const settings = await Utils.getSettings();

  await populateSpacesDropdown(settings.defaultSpaceName);

  // Restore checkbox values
  setCheckboxValue(document.getElementById('autoArchiveEnabled'), settings.autoArchiveEnabled, false);
  setCheckboxValue(document.getElementById('invertTabOrder'), settings.invertTabOrder, true);
  setCheckboxValue(document.getElementById('enableSpotlight'), settings.enableSpotlight, true);
  setCheckboxValue(document.getElementById('showAllOpenTabsInCollapsedFolders'), settings.showAllOpenTabsInCollapsedFolders, false);
  setCheckboxValue(document.getElementById('debugLoggingEnabled'), settings.debugLoggingEnabled, false);

  // Restore number input
  const autoArchiveIdleMinutesInput = document.getElementById('autoArchiveIdleMinutes');
  if (autoArchiveIdleMinutesInput) {
    autoArchiveIdleMinutesInput.value = settings.autoArchiveIdleMinutes;
  }
  updateAutoArchiveIdleMinutesVisibility(settings.autoArchiveEnabled);

  // Restore color overrides
  const colorOverrides = settings.colorOverrides || {};
  COLOR_NAMES.forEach(colorName => {
    const colorPicker = document.getElementById(getColorPickerId(colorName));
    if (colorPicker) {
      colorPicker.value = colorOverrides[colorName] || DEFAULT_COLORS[colorName];
    }
  });

  applyColorOverrides(colorOverrides);
}

// Function to populate the spaces dropdown
async function populateSpacesDropdown(selectedSpaceName) {
  const defaultSpaceNameSelect = document.getElementById('defaultSpaceName');

  try {
    // Get space names using the LocalStorage utility function
    const spaceNames = await LocalStorage.getSpaceNames();

    // Clear existing options
    defaultSpaceNameSelect.innerHTML = '';

    // Add space options
    spaceNames.forEach(spaceName => {
      const option = document.createElement('option');
      option.value = spaceName;
      option.textContent = spaceName;
      defaultSpaceNameSelect.appendChild(option);
    });

    // Only add default "Home" option if no spaces were found
    if (spaceNames.length === 0) {
      const defaultOption = document.createElement('option');
      defaultOption.value = 'Home';
      defaultOption.textContent = 'Home';
      defaultSpaceNameSelect.appendChild(defaultOption);
    }

    // Set the selected value
    defaultSpaceNameSelect.value = selectedSpaceName || 'Home';

  } catch (error) {
    Logger.error('Error loading spaces:', error);
    // Fallback to default option if there's an error
    defaultSpaceNameSelect.innerHTML = '<option value="Home">Home</option>';
    defaultSpaceNameSelect.value = selectedSpaceName || 'Home';
  }
}

// Function to setup advanced options toggle
function setupAdvancedOptions() {
  const toggle = document.getElementById('advancedOptionsToggle');
  const content = document.getElementById('advancedOptionsContent');

  if (toggle && content) {
    toggle.addEventListener('click', () => {
      const isExpanded = content.style.display !== 'none';
      content.style.display = isExpanded ? 'none' : 'block';
      toggle.classList.toggle('expanded', !isExpanded);
    });
  }

  // Setup color reset buttons
  document.querySelectorAll('.color-reset-btn').forEach(button => {
    button.addEventListener('click', () => {
      const colorName = button.dataset.color;
      const colorPicker = document.getElementById(getColorPickerId(colorName));
      if (colorPicker && DEFAULT_COLORS[colorName]) {
        colorPicker.value = DEFAULT_COLORS[colorName];
        saveOptions();
      }
    });
  });
}

// Debounce function to avoid excessive saves for color pickers
let saveTimeout;
function debouncedSave() {
  clearTimeout(saveTimeout);
  saveTimeout = setTimeout(() => {
    saveOptions();
  }, 500); // Wait 500ms after last change before saving
}

// Function to setup auto-save listeners
function setupAutoSave() {
  // Auto-save for dropdown
  addListenerIfExists('defaultSpaceName', 'change', saveOptions);

  // Auto-save for checkboxes (most just save immediately)
  const checkboxIds = ['invertTabOrder', 'enableSpotlight', 'showAllOpenTabsInCollapsedFolders', 'debugLoggingEnabled'];
  checkboxIds.forEach(id => addListenerIfExists(id, 'change', saveOptions));

  // Auto-archive checkbox needs special handling to update visibility
  const autoArchiveCheckbox = addListenerIfExists('autoArchiveEnabled', 'change', () => {
    updateAutoArchiveIdleMinutesVisibility(autoArchiveCheckbox?.checked);
    saveOptions();
  });

  // Auto-save for number input (with debounce)
  addListenerIfExists('autoArchiveIdleMinutes', 'input', debouncedSave);

  // Auto-save for color pickers (with debounce)
  COLOR_NAMES.forEach(colorName => {
    addListenerIfExists(getColorPickerId(colorName), 'input', debouncedSave);
  });
}

// ---- Arc Import ----

function setImportStatus(message, type = 'info') {
  const el = document.getElementById('arcImportStatus');
  if (!el) return;
  el.textContent = message;
  el.className = `import-arc-status import-arc-status--${type}`;
}

function setupArcImport() {
  const fileInput = document.getElementById('arcImportFile');
  const fileLabel = document.getElementById('arcImportFileLabel');
  const importBtn = document.getElementById('arcImportBtn');
  const pinnedOnlyCheckbox = document.getElementById('arcImportPinnedOnly');

  if (!fileInput || !importBtn) return;

  // Update label text when a file is chosen and enable the import button
  fileInput.addEventListener('change', () => {
    const file = fileInput.files?.[0];
    if (file) {
      fileLabel.textContent = file.name;
      importBtn.disabled = false;
      setImportStatus('');
    } else {
      fileLabel.textContent = 'Choose StorageV2.json…';
      importBtn.disabled = true;
    }
  });

  importBtn.addEventListener('click', async () => {
    const file = fileInput.files?.[0];
    if (!file) return;

    importBtn.disabled = true;
    setImportStatus('Reading file…', 'info');

    try {
      const text = await file.text();
      const parsed = parseArcJSON(text);

      if (!parsed.spaces.length) {
        setImportStatus('No spaces found in the selected file.', 'error');
        importBtn.disabled = false;
        return;
      }

      const includePinnedOnly = pinnedOnlyCheckbox?.checked ?? true;
      const totalSpaces = parsed.spaces.length;

      setImportStatus(`Importing ${totalSpaces} space${totalSpaces !== 1 ? 's' : ''}…`, 'info');

      const result = await importArcSpaces(parsed, {
        includePinnedOnly,
        onProgress: (msg) => setImportStatus(msg, 'info'),
      });

      const { imported, skipped, errors } = result;
      if (errors.length) {
        setImportStatus(
          `Import completed with errors. Imported: ${imported}, Skipped: ${skipped}. Errors: ${errors.join('; ')}`,
          'error'
        );
      } else {
        setImportStatus(
          `Import successful! ${imported} bookmark${imported !== 1 ? 's' : ''} imported across ${totalSpaces} space${totalSpaces !== 1 ? 's' : ''}.${skipped ? ` ${skipped} duplicate${skipped !== 1 ? 's' : ''} skipped.` : ''}`,
          'success'
        );
      }

      // Refresh the spaces dropdown so newly imported spaces show up
      await populateSpacesDropdown(document.getElementById('defaultSpaceName')?.value);
    } catch (err) {
      Logger.error('[ArcImport] Import failed:', err);
      setImportStatus(`Import failed: ${err.message}`, 'error');
    } finally {
      importBtn.disabled = false;
    }
  });
}

document.addEventListener('DOMContentLoaded', () => {
  restoreOptions();
  setupAdvancedOptions();
  setupAutoSave();
  setupArcImport();
});