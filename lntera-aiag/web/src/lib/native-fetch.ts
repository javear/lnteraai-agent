// Native streaming `fetch` for Android, backed by the StreamHttpPlugin (OkHttp). The Android WebView's
// fetch can buffer streamed responses; OkHttp streams them. We expose a `fetch`-shaped function that the
// Mastra SDK uses as its transport (makeMastraClient passes it on Android), so the SDK parses the stream
// exactly as on web — only the transport changes. Non-streamable bodies fall back to the platform fetch.
import { registerPlugin, Capacitor } from '@capacitor/core';

interface StreamEvent {
  id: string;
  type: 'open' | 'data' | 'end' | 'error';
  status?: number;
  chunk?: string; // base64
  message?: string;
}

interface StreamHttpPlugin {
  start(opts: { id: string; url: string; method: string; headers: Record<string, string>; body?: string }): Promise<void>;
  cancel(opts: { id: string }): Promise<void>;
  addListener(event: 'streamHttp', cb: (e: StreamEvent) => void): Promise<{ remove: () => void }>;
}

const StreamHttp = registerPlugin<StreamHttpPlugin>('StreamHttp');

/** True only where the native streaming plugin exists (Android build). */
export function nativeStreamingSupported(): boolean {
  return Capacitor.getPlatform() === 'android' && Capacitor.isPluginAvailable('StreamHttp');
}

let counter = 0;

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function headersToRecord(h: HeadersInit | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!h) return out;
  if (h instanceof Headers) h.forEach((v, k) => (out[k] = v));
  else if (Array.isArray(h)) for (const [k, v] of h) out[k] = String(v);
  else Object.assign(out, h as Record<string, string>);
  return out;
}

/** A `fetch` that streams via the native plugin. Delegates non-string bodies to the platform fetch. */
export const nativeFetch: typeof fetch = async (input, init) => {
  // Only intercept string-body (or bodyless) requests; anything exotic (FormData/Blob) → platform fetch.
  if (init?.body != null && typeof init.body !== 'string') {
    return fetch(input as RequestInfo, init);
  }

  const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as Request).url;
  const method = (init?.method ?? 'GET').toUpperCase();
  const headers = headersToRecord(init?.headers);
  const body = typeof init?.body === 'string' ? init.body : undefined;
  const id = `s${Date.now()}_${counter++}`;

  let resolveOpen!: (status: number) => void;
  let rejectOpen!: (e: unknown) => void;
  const openPromise = new Promise<number>((res, rej) => {
    resolveOpen = res;
    rejectOpen = rej;
  });

  let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  let opened = false;
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
    cancel() {
      void StreamHttp.cancel({ id });
    },
  });

  // Attach the listener BEFORE start() so no early events are missed.
  const handle = await StreamHttp.addListener('streamHttp', (e) => {
    if (e.id !== id) return;
    if (e.type === 'open') {
      opened = true;
      resolveOpen(e.status ?? 200);
    } else if (e.type === 'data' && e.chunk) {
      controller?.enqueue(b64ToBytes(e.chunk));
    } else if (e.type === 'end') {
      controller?.close();
      handle.remove();
    } else if (e.type === 'error') {
      const err = new Error(e.message ?? 'native stream error');
      if (!opened) rejectOpen(err);
      else controller?.error(err);
      handle.remove();
    }
  });

  try {
    await StreamHttp.start({ id, url, method, headers, body });
  } catch (e) {
    handle.remove();
    throw e;
  }

  const status = await openPromise;
  return new Response(stream, { status });
};
