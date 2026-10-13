/** What an error says, for people: its message, without the "RpcError: " String() adds. */
export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
