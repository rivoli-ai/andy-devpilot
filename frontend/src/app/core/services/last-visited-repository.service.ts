import { Injectable } from '@angular/core';

const STORAGE_KEY = 'devpilot.lastVisitedRepositoryIds';
const LEGACY_STORAGE_KEY = 'devpilot.lastVisitedRepositoryId';
const MAX_RECENT = 6;

/**
 * Persists the most recently opened repositories (backlog / code) so the repositories
 * list can surface quick access at the top (most recent first, capped at MAX_RECENT).
 */
@Injectable({ providedIn: 'root' })
export class LastVisitedRepositoryService {
  remember(repositoryId: string): void {
    const trimmed = repositoryId?.trim();
    if (!trimmed) return;
    try {
      const ids = this.readIdsFromStorage();
      const without = ids.filter(id => String(id) !== String(trimmed));
      const next = [trimmed, ...without].slice(0, MAX_RECENT);
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      try {
        localStorage.removeItem(LEGACY_STORAGE_KEY);
      } catch {
        /* ignore */
      }
    } catch {
      /* private mode / quota */
    }
  }

  /** Up to six ids, most recent first. Migrates legacy single-id storage once. */
  peekOrderedIds(): string[] {
    try {
      let ids = this.readIdsFromStorage();
      if (ids.length === 0) {
        const legacy = localStorage.getItem(LEGACY_STORAGE_KEY)?.trim();
        if (legacy) {
          ids = [legacy];
          localStorage.setItem(STORAGE_KEY, JSON.stringify(ids));
          localStorage.removeItem(LEGACY_STORAGE_KEY);
        }
      }
      return ids.slice(0, MAX_RECENT);
    } catch {
      return [];
    }
  }

  private readIdsFromStorage(): string[] {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return [];
      const parsed = JSON.parse(raw) as unknown;
      if (!Array.isArray(parsed)) return [];
      return parsed.map(String).filter(Boolean);
    } catch {
      return [];
    }
  }
}
