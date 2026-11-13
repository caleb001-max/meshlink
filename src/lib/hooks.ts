import { useSyncExternalStore } from 'react';
import { mesh } from './mesh';

/** Stable subscription for React's useSyncExternalStore. */
export const subscribeMesh = (cb: () => void) => mesh.subscribe(cb);
