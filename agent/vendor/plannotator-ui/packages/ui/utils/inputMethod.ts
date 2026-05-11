import { storage } from './storage';
import type { InputMethod } from '../types';

const STORAGE_KEY = 'plannotator-input-method';
const DEFAULT_METHOD: InputMethod = 'drag';

export function getInputMethod(): InputMethod {
  const stored = storage.getItem(STORAGE_KEY);
  if (stored === 'drag' || stored === 'pinpoint') {
    return stored;
  }
  return DEFAULT_METHOD;
}

export function saveInputMethod(method: InputMethod): void {
  storage.setItem(STORAGE_KEY, method);
}
