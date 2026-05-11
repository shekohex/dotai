/**
 * AI Setup Dialog Utility
 *
 * Tracks whether the user has seen the first-run AI setup dialog.
 * Uses cookies (not localStorage) for the same reason as all other settings.
 */

import { storage } from './storage';

const STORAGE_KEY = 'plannotator-ai-setup-done';

export function needsAISetup(): boolean {
  return storage.getItem(STORAGE_KEY) !== 'true';
}

export function markAISetupDone(): void {
  storage.setItem(STORAGE_KEY, 'true');
}
