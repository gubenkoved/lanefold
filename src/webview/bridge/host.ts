import { decodeMessage, encodeMessage } from '../../shared/codec';
import type {
  Bootstrap,
  HostApi,
  HostEvents,
  HostKind,
  ThemeSnapshot,
  WebviewApi,
  WebviewEvents,
} from '../../shared/protocol';
import { RpcEndpoint, type RpcMessage, type RpcTransport } from '../../shared/rpc';

export type HostRpc = RpcEndpoint<WebviewApi, HostApi, WebviewEvents, HostEvents>;

export interface HostConnection {
  readonly kind: HostKind;
  readonly bootstrap: Bootstrap;
  readonly rpc: HostRpc;
  /** Webview-local state that VS Code restores with the view (scroll, selection, layout). */
  getState<T>(): T | undefined;
  setState(state: unknown): void;
}

function readBootstrap(): Bootstrap {
  const element = document.getElementById('lanefold-bootstrap');
  try {
    return element?.textContent ? (JSON.parse(element.textContent) as Bootstrap) : { host: 'harness' };
  } catch {
    return { host: 'harness' };
  }
}

function vscodeTransport(api: VsCodeApi): RpcTransport {
  return {
    send: (message) => api.postMessage(message),
    onMessage: (handler) => {
      const listener = (event: MessageEvent) => {
        const data = event.data as RpcMessage | undefined;
        if (data && typeof data === 'object' && 'kind' in data) handler(data);
      };
      window.addEventListener('message', listener);
      return () => window.removeEventListener('message', listener);
    },
  };
}

/** The dev harness serves the app over HTTP and the RPC over a WebSocket on the same origin. */
function webSocketTransport(url: string): RpcTransport {
  const handlers = new Set<(message: RpcMessage) => void>();
  const pending: string[] = [];
  let socket: WebSocket;

  const connect = () => {
    socket = new WebSocket(url);
    socket.addEventListener('open', () => {
      for (const text of pending.splice(0)) socket.send(text);
    });
    socket.addEventListener('message', (event) => {
      const message = decodeMessage(String(event.data));
      for (const handler of handlers) handler(message);
    });
  };
  connect();

  return {
    send: (message) => {
      const text = encodeMessage(message);
      if (socket.readyState === WebSocket.OPEN) socket.send(text);
      else pending.push(text);
    },
    onMessage: (handler) => {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
  };
}

function captureTheme(): ThemeSnapshot {
  const variables: Record<string, string> = {};
  const style = document.documentElement.style;
  for (let i = 0; i < style.length; i++) {
    const name = style.item(i);
    if (name.startsWith('--vscode-')) variables[name] = style.getPropertyValue(name).trim();
  }
  return {
    bodyClass: document.body.className,
    themeKind: document.body.dataset.vscodeThemeKind ?? '',
    variables,
  };
}

export function connectHost(): HostConnection {
  const bootstrap = readBootstrap();
  const api = typeof acquireVsCodeApi === 'function' ? acquireVsCodeApi() : undefined;
  let transport: RpcTransport;
  if (api) {
    transport = vscodeTransport(api);
  } else {
    const params = new URLSearchParams(location.search);
    const url = new URL('/rpc', location.href);
    url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    // The session's repositories (`?repo=a&repo=b`) and its id.
    for (const key of ['repo', 'session']) {
      for (const value of params.getAll(key)) if (value) url.searchParams.append(key, value);
    }
    transport = webSocketTransport(url.toString());
  }

  const rpc: HostRpc = new RpcEndpoint(transport);
  rpc.implement({ 'debug.theme': () => captureTheme() });

  const harnessStateKey = 'lanefold.harness.state';
  return {
    kind: bootstrap.host,
    bootstrap,
    rpc,
    getState: <T>() => {
      if (api) return api.getState() as T | undefined;
      try {
        const raw = sessionStorage.getItem(harnessStateKey);
        return raw ? (JSON.parse(raw) as T) : undefined;
      } catch {
        return undefined;
      }
    },
    setState: (state) => {
      if (api) api.setState(state);
      else sessionStorage.setItem(harnessStateKey, JSON.stringify(state));
    },
  };
}
