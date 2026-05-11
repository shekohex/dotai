/**
 * Octarine Notes Integration Utility
 *
 * Manages settings for auto-saving plans to Octarine.
 * Uses octarine:// URI scheme — no vault detection needed.
 */

import { storage } from './storage';

const STORAGE_KEY_ENABLED = 'plannotator-octarine-enabled';
const STORAGE_KEY_WORKSPACE = 'plannotator-octarine-workspace';
const STORAGE_KEY_FOLDER = 'plannotator-octarine-folder';
const STORAGE_KEY_AUTOSAVE = 'plannotator-octarine-autosave';

/**
 * Octarine integration settings
 */
export interface OctarineSettings {
  enabled: boolean;
  workspace: string;
  folder: string;
  autoSave: boolean;
}

/**
 * Get current Octarine settings from storage
 */
export function getOctarineSettings(): OctarineSettings {
  return {
    enabled: storage.getItem(STORAGE_KEY_ENABLED) === 'true',
    workspace: storage.getItem(STORAGE_KEY_WORKSPACE) ?? '',
    folder: storage.getItem(STORAGE_KEY_FOLDER) || 'plannotator',
    autoSave: storage.getItem(STORAGE_KEY_AUTOSAVE) === 'true',
  };
}

/**
 * Save Octarine settings to storage
 */
export function saveOctarineSettings(settings: OctarineSettings): void {
  storage.setItem(STORAGE_KEY_ENABLED, String(settings.enabled));
  storage.setItem(STORAGE_KEY_WORKSPACE, settings.workspace);
  storage.setItem(STORAGE_KEY_FOLDER, settings.folder);
  storage.setItem(STORAGE_KEY_AUTOSAVE, String(settings.autoSave));
}

/**
 * Check if Octarine integration is properly configured
 */
export function isOctarineConfigured(): boolean {
  const settings = getOctarineSettings();
  return settings.enabled && settings.workspace.trim().length > 0;
}
