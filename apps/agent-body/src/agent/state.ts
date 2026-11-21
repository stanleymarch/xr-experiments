/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import Dexie, { liveQuery, type Table } from 'dexie';
import MiniSearch from 'minisearch';
import { z } from 'zod';
import type {
  AgentSettings,
  AgentState,
  MemoryKind,
  MemoryRecord,
} from './contracts';
import { agentSettingsSchema, DEFAULT_SETTINGS } from './settings.js';

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------


export const memoryKindSchema = z.enum(['note', 'fact', 'chat']);

export const memoryRecordSchema = z.object({
  id: z.number().int().optional(),
  text: z.string().min(1),
  kind: memoryKindSchema,
  createdAt: z.number().int().nonnegative(),
  role: z.enum(['user', 'assistant']).optional(),
});


const SETTINGS_KEY = 'agent';

// ---------------------------------------------------------------------------
// Dexie
// ---------------------------------------------------------------------------

interface SettingsRow {
  key: string;
  /** The settings plus the write revision used to drop stale liveQuery rows. */
  value: AgentSettings & { revision?: number };
}

class AgentBodyDB extends Dexie {
  memories!: Table<MemoryRecord, number>;
  settings!: Table<SettingsRow, string>;

  constructor() {
    super('agent-body');
    this.version(1).stores({
      memories: '++id, text, kind, createdAt',
      settings: 'key',
    });
  }
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

class AgentStateStore implements AgentState {
  readonly ready: Promise<void>;

  private db: AgentBodyDB | null = null;
  private settings: AgentSettings = { ...DEFAULT_SETTINGS };
  /** Monotonic stamp for local writes; stale liveQuery deliveries lose to it. */
  private settingsRevision = 0;
  private memories: MemoryRecord[] = [];
  private miniSearch = new MiniSearch<{ id: number; text: string }>({
    fields: ['text'],
    storeFields: ['id'],
    searchOptions: { fuzzy: 0.2 },
  });
  private memoryListeners = new Set<() => void>();
  private settingsListeners =
    new Set<(settings: AgentSettings) => void>();

  constructor() {
    this.ready = this.init().catch((error: unknown) => {
      // Blocked IndexedDB (private mode, quota, etc.): degrade to in-memory
      // arrays rather than killing the app with an unhandled rejection.
      console.warn('[agentState] IndexedDB unavailable, using in-memory fallback', error);
      this.db = null;
    });
  }

  private async init(): Promise<void> {
    const db = new AgentBodyDB();
    await db.open();
    this.db = db;
    const row = await db.settings.get(SETTINGS_KEY);
    // Merge over defaults so older rows (fewer fields) migrate forward
    // instead of being treated as corrupt and reset.
    const parsed = row
      ? agentSettingsSchema.safeParse({ ...DEFAULT_SETTINGS, ...row.value })
      : null;
    if (parsed && parsed.success) {
      this.settings = parsed.data;
    } else if (row) {
      // Corrupt row: reset to defaults and persist.
      await db.settings.put({ key: SETTINGS_KEY, value: { ...DEFAULT_SETTINGS } });
      this.settings = { ...DEFAULT_SETTINGS };
    }
    await this.rebuild();
    this.notifySettingsChanged();
    liveQuery(() => db.settings.get(SETTINGS_KEY)).subscribe({
      next: (nextRow: SettingsRow | undefined) => {
        if (!nextRow) {
          return;
        }
        // A delivery for a row older than the last local write is stale
        // (late liveQuery callbacks, multi-tab writes): the in-memory
        // revision wins. Unstamped rows predate the revision and lose once
        // a local write happened.
        const rowRevision = (nextRow.value as { revision?: number } | null)?.revision ?? 0;
        if (rowRevision < this.settingsRevision) {
          return;
        }
        const nextParsed = agentSettingsSchema.safeParse({
          ...DEFAULT_SETTINGS,
          ...nextRow.value,
        });
        if (
          !nextParsed.success ||
          JSON.stringify(nextParsed.data) === JSON.stringify(this.settings)
        ) {
          return;
        }
        this.settings = nextParsed.data;
        this.notifySettingsChanged();
      },
      error: (error: unknown) =>
        console.warn('[agentState] settings liveQuery failed', error),
    });
  }

  private async rebuild(): Promise<void> {
    if (!this.db) return;
    const all = await this.db.memories.toArray();
    this.memories = all.sort((a, b) => b.createdAt - a.createdAt);
    this.miniSearch.removeAll();
    this.miniSearch.addAll(
      this.memories.map((m) => ({ id: m.id as number, text: m.text })),
    );
  }

  getSettings(): AgentSettings {
    return { ...this.settings };
  }

  async updateSettings(patch: Partial<AgentSettings>): Promise<void> {
    await this.ready;
    const next = agentSettingsSchema.parse({ ...this.settings, ...patch });
    this.settingsRevision += 1;
    this.settings = next;
    if (this.db) {
      await this.db.settings.put({ key: SETTINGS_KEY, value: { ...next, revision: this.settingsRevision } });
    }
    this.notifySettingsChanged();
  }

  onSettingsChanged(cb: (settings: AgentSettings) => void): () => void {
    this.settingsListeners.add(cb);
    return () => {
      this.settingsListeners.delete(cb);
    };
  }

  async addMemory(text: string, kind: MemoryKind, role?: 'user' | 'assistant'): Promise<MemoryRecord> {
    await this.ready;
    const record: MemoryRecord = memoryRecordSchema.parse({
      text: text.trim(),
      kind,
      createdAt: Date.now(),
      role,
    });
    if (this.db) {
      const id = await this.db.memories.add(record);
      const stored = { ...record, id: id as number };
      this.memories.unshift(stored);
      this.miniSearch.add({ id: stored.id, text: stored.text });
    } else {
      record.id = this.memories.length
        ? Math.max(...this.memories.map((m) => m.id ?? 0)) + 1
        : 1;
      this.memories.unshift(record);
      this.miniSearch.add({ id: record.id, text: record.text });
    }
    this.notifyMemoriesChanged();
    return { ...this.memories[0] };
  }

  async recentMemories(limit: number): Promise<MemoryRecord[]> {
    await this.ready;
    return this.memories.slice(0, limit).map((m) => ({ ...m }));
  }

  async searchMemories(query: string, limit: number): Promise<MemoryRecord[]> {
    await this.ready;
    const hits = this.miniSearch.search(query);
    const byId = new Map<number, MemoryRecord>();
    for (const m of this.memories) if (m.id !== undefined) byId.set(m.id, m);
    const results: MemoryRecord[] = [];
    for (const hit of hits) {
      const record = byId.get(hit.id as number);
      if (record) results.push({ ...record });
      if (results.length >= limit) break;
    }
    // Newest-first among results (memories is already newest-first order).
    return results;
  }

  async clearMemories(): Promise<void> {
    await this.ready;
    if (this.db) await this.db.memories.clear();
    this.memories = [];
    this.miniSearch.removeAll();
    this.notifyMemoriesChanged();
  }

  onMemoriesChanged(cb: () => void): () => void {
    this.memoryListeners.add(cb);
    return () => {
      this.memoryListeners.delete(cb);
    };
  }

  private notifySettingsChanged(): void {
    for (const cb of this.settingsListeners) {
      cb(this.getSettings());
    }
  }

  private notifyMemoriesChanged(): void {
    for (const cb of this.memoryListeners) cb();
  }
}

// Lazy singleton: created on first import of this module.
export const agentState: AgentState = new AgentStateStore();
