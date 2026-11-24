/**
 * Typed late-binding registry for callbacks owned by the `app.ts` entrypoint.
 *
 * View modules must not import the entrypoint: `app.ts` imports them, so the
 * reverse edge would create a circular module graph. Instead the entrypoint
 * registers its implementations once through {@link initUiBridge} during boot,
 * and the functions below are thin typed forwarders.
 */
import type { BoardMessage, Snapshot } from './types.js';

export interface UiBridge {
  applyMergeFromUi: (name: string) => Promise<void>;
  crossReviewFromUi: (targetWorker: string) => Promise<void>;
  killWorkerFromUi: (name: string, removeWorktree?: boolean) => Promise<void>;
  openWorkerDiff: (name: string) => Promise<void>;
  openWorkerLogs: (name: string) => Promise<void>;
  previewMergeFromUi: (name: string) => Promise<void>;
  refreshSnapshot: (force?: boolean) => Promise<void>;
  renderSnapshot: (snap: Snapshot, force?: boolean) => void;
  retryOrSwitchWorker: (opts: {
  name: string;
  provider?: string;
  model?: string;
  prompt?: string;
}) => Promise<boolean>;
  switchTab: (tab: 'board' | 'graph' | 'workers' | 'usage' | 'settings') => void;
  syncCommanderControls: (force?: boolean) => void;
}

let impl: UiBridge | null = null;

/** Register the entrypoint-owned implementations. Called once from boot(). */
export function initUiBridge(next: UiBridge): void {
  impl = next;
}

function bound(): UiBridge {
  if (!impl) throw new Error('UI bridge accessed before initUiBridge()');
  return impl;
}

export function applyMergeFromUi(name: string): Promise<void> {
  return bound().applyMergeFromUi(name);
}

export function crossReviewFromUi(targetWorker: string): Promise<void> {
  return bound().crossReviewFromUi(targetWorker);
}

export function killWorkerFromUi(name: string, removeWorktree = false): Promise<void> {
  return bound().killWorkerFromUi(name, removeWorktree);
}

export function openWorkerDiff(name: string): Promise<void> {
  return bound().openWorkerDiff(name);
}

export function openWorkerLogs(name: string): Promise<void> {
  return bound().openWorkerLogs(name);
}

export function previewMergeFromUi(name: string): Promise<void> {
  return bound().previewMergeFromUi(name);
}

export function refreshSnapshot(force = false): Promise<void> {
  return bound().refreshSnapshot(force);
}

export function renderSnapshot(snap: Snapshot, force = false): void {
  return bound().renderSnapshot(snap, force);
}

export function retryOrSwitchWorker(opts: {
  name: string;
  provider?: string;
  model?: string;
  prompt?: string;
}): Promise<boolean> {
  return bound().retryOrSwitchWorker(opts);
}

export function switchTab(tab: 'board' | 'graph' | 'workers' | 'usage' | 'settings'): void {
  return bound().switchTab(tab);
}

export function syncCommanderControls(force = false): void {
  return bound().syncCommanderControls(force);
}
