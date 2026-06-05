import { config } from "./config.js";
import { log } from "./log.js";

/**
 * Minimal Kan REST client. Authenticates as a service account using
 * email+password (the credentials Better-Auth flow), keeps a session
 * cookie, and refreshes on 401.
 *
 * The bridge intentionally avoids the admin API key because not every
 * Kan endpoint accepts it; a normal session cookie works everywhere.
 */
export class KanClient {
  private cookie: string | null = null;
  private loginPromise: Promise<void> | null = null;
  private lastLoginAt: number | null = null;
  private base = config.KAN_API_BASE;
  private authBase = config.KAN_API_BASE.replace(/\/api\/v1$/, "/api/auth");

  /** Last successful login time (epoch ms), or null. Used by /healthz. */
  get lastLoginEpochMs(): number | null {
    return this.lastLoginAt;
  }

  private async ensureLogin(): Promise<void> {
    if (this.cookie) return;
    if (!this.loginPromise) {
      this.loginPromise = this.doLogin().finally(() => {
        this.loginPromise = null;
      });
    }
    return this.loginPromise;
  }

  private async doLogin(): Promise<void> {
    const res = await fetch(`${this.authBase}/sign-in/email`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "http://kan-web:3000" },
      body: JSON.stringify({
        email: config.KAN_INTERNAL_EMAIL,
        password: config.KAN_INTERNAL_PASSWORD,
      }),
    });
    if (!res.ok) {
      throw new Error(`Kan login failed (${res.status}): ${await res.text()}`);
    }
    // Better Auth's session cookie is named `kan.session_token` today; tolerate
    // any cookie ending in `session_token` so a future rename doesn't break us.
    const setCookie = res.headers.get("set-cookie") ?? "";
    const m = setCookie.match(/[a-zA-Z0-9_.\-]*session_token=[^;]+/);
    if (!m) throw new Error("No session cookie returned by Better Auth");
    this.cookie = m[0];
    this.lastLoginAt = Date.now();
    log.info("Kan session established");
  }

  async request<T = unknown>(
    method: string,
    path: string,
    body?: unknown,
    retried = false,
    rateLimitAttempt = 0,
  ): Promise<T> {
    await this.ensureLogin();
    const res = await fetch(`${this.base}${path}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        Cookie: this.cookie!,
      },
      body: body == null ? undefined : JSON.stringify(body),
    });
    if (res.status === 401 && !retried) {
      this.cookie = null;
      return this.request<T>(method, path, body, true, rateLimitAttempt);
    }
    // Rate-limit: Kan returns 429 when too many requests in a window.
    // Honour Retry-After if present, else exponential backoff with jitter.
    // Up to 5 retries (~30s worst-case); beyond that we surface the error so
    // Temporal's activity retry takes over.
    if (res.status === 429 && rateLimitAttempt < 5) {
      const retryAfter = Number(res.headers.get("retry-after"));
      const baseMs = Number.isFinite(retryAfter) && retryAfter > 0
        ? retryAfter * 1000
        : Math.min(8000, 500 * Math.pow(2, rateLimitAttempt));
      const jitterMs = Math.floor(Math.random() * 250);
      const wait = baseMs + jitterMs;
      log.warn({ method, path, attempt: rateLimitAttempt, waitMs: wait }, "Kan 429 — backing off");
      await new Promise((r) => setTimeout(r, wait));
      return this.request<T>(method, path, body, retried, rateLimitAttempt + 1);
    }
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Kan ${method} ${path} -> ${res.status}: ${text.slice(0, 400)}`);
    }
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  // ---- domain helpers -----------------------------------------------------
  getCard(cardPublicId: string) {
    return this.request<KanCard>("GET", `/cards/${cardPublicId}`);
  }
  getBoard(boardPublicId: string) {
    return this.request<KanBoard>("GET", `/boards/${boardPublicId}`);
  }
  postComment(cardPublicId: string, comment: string) {
    return this.request("POST", `/cards/${cardPublicId}/comments`, { comment });
  }
  moveCard(cardPublicId: string, listPublicId: string, index = 0) {
    // Kan's card.update only triggers the move when `index` is supplied.
    return this.request("PUT", `/cards/${cardPublicId}`, { listPublicId, index });
  }
  listWorkspaces() {
    return this.request<Array<{ workspace: KanWorkspace; role: string }>>(
      "GET",
      `/workspaces`,
    );
  }
  listBoards(workspacePublicId: string) {
    return this.request<KanBoard[]>(
      "GET",
      `/workspaces/${workspacePublicId}/boards`,
    );
  }
  createLabel(boardPublicId: string, name: string, colourCode: string) {
    return this.request<{ publicId: string }>(
      "POST",
      `/labels`,
      { boardPublicId, name, colourCode },
    );
  }
  // Create a new board in the given workspace with the supplied lane
  // (list) names and label names. Kan generates the publicId and
  // derives a URL slug from `name`. Returns {publicId, name}.
  createBoard(
    workspacePublicId: string,
    name: string,
    lists: string[],
    labels: string[],
  ) {
    return this.request<{ publicId: string; name: string }>(
      "POST",
      `/workspaces/${workspacePublicId}/boards`,
      { name, workspacePublicId, lists, labels, type: "regular" },
    );
  }
}

export const kan = new KanClient();

// ---- types --------------------------------------------------------------
export interface KanWorkspace {
  publicId: string;
  name: string;
  slug: string;
}
export interface KanLabel {
  publicId: string;
  name: string;
  colourCode: string | null;
}
export interface KanList {
  publicId: string;
  name: string;
  index: number;
  cards?: KanCard[];
}
export interface KanCard {
  publicId: string;
  title: string;
  description: string | null;
  list?: { publicId: string; name: string };
  labels?: KanLabel[];
  board?: { publicId: string; slug: string };
}
export interface KanBoard {
  publicId: string;
  name: string;
  slug: string;
  lists: KanList[];
  labels: KanLabel[];
  workspace?: { publicId: string };
}
