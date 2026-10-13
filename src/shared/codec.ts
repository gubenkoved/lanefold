import type { RpcMessage } from './rpc';

/**
 * JSON codec for RPC messages over text transports (the dev harness WebSocket).
 * VS Code's postMessage already structured-clones typed arrays, so it does not need this.
 * Typed arrays and ArrayBuffers are tagged and base64-encoded.
 */

const TYPED_ARRAYS = {
  Int8Array,
  Uint8Array,
  Uint8ClampedArray,
  Int16Array,
  Uint16Array,
  Int32Array,
  Uint32Array,
  Float32Array,
  Float64Array,
} as const;

type TypedArrayName = keyof typeof TYPED_ARRAYS;

interface NodeBufferLike {
  from(data: Uint8Array | string, encoding?: string): Uint8Array & { toString(encoding: string): string };
}

function nodeBuffer(): NodeBufferLike | undefined {
  return (globalThis as { Buffer?: NodeBufferLike }).Buffer;
}

export function bytesToBase64(bytes: Uint8Array): string {
  const buffer = nodeBuffer();
  if (buffer) return buffer.from(bytes).toString('base64');
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export function base64ToBytes(base64: string): Uint8Array {
  const buffer = nodeBuffer();
  if (buffer) return new Uint8Array(buffer.from(base64, 'base64'));
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function encodeMessage(message: RpcMessage): string {
  return JSON.stringify(message, (_key, value: unknown) => {
    if (value instanceof ArrayBuffer) return { $ab: bytesToBase64(new Uint8Array(value)) };
    if (ArrayBuffer.isView(value) && !(value instanceof DataView)) {
      const name = value.constructor.name as TypedArrayName;
      if (name in TYPED_ARRAYS) {
        return {
          $ta: name,
          b64: bytesToBase64(new Uint8Array(value.buffer, value.byteOffset, value.byteLength)),
        };
      }
    }
    return value;
  });
}

export function decodeMessage(text: string): RpcMessage {
  // A reviver runs for every value: skip it when nothing is tagged (refs of a big repository
  // are megabytes of plain JSON).
  if (!text.includes('"$ab"') && !text.includes('"$ta"')) return JSON.parse(text) as RpcMessage;
  return JSON.parse(text, (_key, value: unknown) => {
    if (value && typeof value === 'object') {
      const tagged = value as { $ab?: string; $ta?: TypedArrayName; b64?: string };
      if (typeof tagged.$ab === 'string') return base64ToBytes(tagged.$ab).slice().buffer;
      if (typeof tagged.$ta === 'string' && typeof tagged.b64 === 'string' && tagged.$ta in TYPED_ARRAYS) {
        // Copy into a fresh, aligned buffer before viewing it as the original element type.
        const bytes = base64ToBytes(tagged.b64).slice();
        return new TYPED_ARRAYS[tagged.$ta](bytes.buffer);
      }
    }
    return value;
  }) as RpcMessage;
}
