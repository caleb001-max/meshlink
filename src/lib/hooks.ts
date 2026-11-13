import { useSyncExternalStore } from 'react';
import { engine, type EngineSnapshot } from './engine';

/** Live MeshLink engine snapshot for React screens. */
export function useEngineSnapshot(): EngineSnapshot {
  return useSyncExternalStore(engine.subscribe, engine.getSnapshot, engine.getSnapshot);
}

/** Re-render on any engine change when only a version counter is needed. */
export function useEngineVersion(): number {
  return useSyncExternalStore(engine.subscribe, () => engine.version, () => engine.version);
}
