import { createContext, useContext } from 'react';
import type { HostConnection } from './bridge/host';

export const HostContext = createContext<HostConnection | undefined>(undefined);

export function useHost(): HostConnection {
  const host = useContext(HostContext);
  if (!host) throw new Error('HostContext is missing');
  return host;
}
