const API_TIMEOUT_MS = 500;
const FAILURE_BACKOFF_MS = 60_000;

let backoffUntilMs = 0;

/**
 * Optionally queries Antigravity's local Connect RPC ConversationService to calibrate
 * live child run states. Silently returns null when env credentials are absent or unreachable.
 */
export async function fetchLiveChildRunStates(
  parentConversationId: string,
): Promise<Map<string, 'working' | 'waiting'> | null> {
  const lsAddr = process.env.ANTIGRAVITY_LS_ADDRESS?.trim();
  const csrfToken = process.env.ANTIGRAVITY_CSRF_TOKEN?.trim();
  if (!lsAddr || !csrfToken) return null;

  const now = Date.now();
  if (now < backoffUntilMs) return null;

  const url = `http://${lsAddr}/product.v1.ConversationService/ListConversations`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Connect-Protocol-Version': '1',
        'x-antigravity-csrf-token': csrfToken,
      },
      body: JSON.stringify({
        parentConversationId,
        pageSize: 100,
      }),
      signal: AbortSignal.timeout(API_TIMEOUT_MS),
    });

    if (!res.ok) {
      backoffUntilMs = now + FAILURE_BACKOFF_MS;
      return null;
    }

    const payload = (await res.json()) as {
      conversations?: Array<{
        id?: unknown;
        state?: { runState?: unknown };
      }>;
    };

    const map = new Map<string, 'working' | 'waiting'>();
    for (const conv of payload.conversations || []) {
      const id = typeof conv.id === 'string' ? conv.id.trim() : '';
      const runState = typeof conv.state?.runState === 'string' ? conv.state.runState : '';
      if (!id) continue;
      if (runState === 'RUN_STATE_RUNNING' || runState === 'RUN_STATE_CANCELLING') {
        map.set(id, 'working');
      } else if (runState === 'RUN_STATE_IDLE') {
        map.set(id, 'waiting');
      }
    }
    return map;
  } catch {
    backoffUntilMs = now + FAILURE_BACKOFF_MS;
    return null;
  }
}
