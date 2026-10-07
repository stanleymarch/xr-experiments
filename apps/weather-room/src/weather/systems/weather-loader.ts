/**
 * Loads Open-Meteo weather at startup and keeps it fresh: a bounded
 * background refresh (at most one request per TTL window) plus the manual
 * Reload action. Everything else reads the store; scrubbing never fetches.
 */

import { createSystem } from '@iwsdk/core';
import { REFRESH_TTL_MS, loadWeather } from '../weather-data.js';
import { weatherStore } from '../weather-state.js';

/** Seconds between staleness checks in update(). */
const STALE_CHECK_S = 30;

/** Force a fresh network load, bypassing the TTL cache. */
export async function reloadWeather(): Promise<void> {
  weatherStore.setStatus({ kind: 'loading', label: 'Reloading weather' });
  // No `previous` argument: `loadWeather()` always refetches without it.
  const { dataset, status } = await loadWeather();
  weatherStore.setDataset(dataset);
  if (status.kind !== 'ready') weatherStore.setStatus(status);
}

export class WeatherLoaderSystem extends createSystem({}) {
  private loading = false;
  private lastCheckAt = -STALE_CHECK_S;

  init(): void {
    weatherStore.setStatus({ kind: 'loading', label: 'Loading weather' });
    this.loading = true;
    void loadWeather()
      .then(({ dataset, status }) => {
        // `setDataset` marks ready; demo outcomes overwrite with the reason.
        weatherStore.setDataset(dataset);
        if (status.kind !== 'ready') weatherStore.setStatus(status);
      })
      .finally(() => {
        this.loading = false;
      });
  }

  update(_delta: number, time: number): void {
    if (this.loading || time - this.lastCheckAt < STALE_CHECK_S) return;
    this.lastCheckAt = time;
    const dataset = weatherStore.state.peek().dataset;
    // Bounded refresh: `loadWeather(previous)` reuses the cached dataset
    // until the TTL expires, then performs at most one fetch per window.
    if (dataset == null || Date.now() - dataset.fetchedAt < REFRESH_TTL_MS) return;
    this.loading = true;
    void loadWeather(dataset)
      .then(({ dataset: next, status }) => {
        weatherStore.setDataset(next);
        if (status.kind !== 'ready') weatherStore.setStatus(status);
      })
      .finally(() => {
        this.loading = false;
      });
  }
}
