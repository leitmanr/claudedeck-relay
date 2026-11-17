import { DurableObject } from "cloudflare:workers";

/**
 * ClaudeDeck relay: forwards Claude Code hook events from CLOUD sessions to a user's Stream Deck,
 * and the deck's answers to permission requests / questions back to the session.
 *
 * - Cloud hook:   POST /v1/event  (Authorization: Bearer <token>)  JSON hook payload
 * - Cloud hook:   POST /v1/permission  {id, request}: long-poll, waits up to POLL_MS for the deck's answer to a
 *                 permission request or question; the hook repeats it until answered. {id, cancel: true} withdraws it.
 * - Stream Deck:  WebSocket /v1/ws/<sha256(token)>, then first message {"auth": "<token>"};
 *                 later {"type": "decision", id, body} answers a permission request.
 *
 * A channel is identified by the SHA-256 of the user's token, so no accounts or registration are needed:
 * whoever holds the token can publish to and listen on that channel, nobody else can.
 * Only the fields the deck needs are relayed (no tool input, no file contents: a permission request carries a
 * short summary made in the VM, plus the options of a question), and only the latest event per session is kept
 * (so a reconnecting deck sees current state), for at most 6 hours. Permission requests live at most 2 minutes.
 */

export interface Env {
	CHANNEL: DurableObjectNamespace<Channel>;
}

const MAX_BODY = 64 * 1024;
const MIN_TOKEN = 32;
const SESSION_TTL_MS = 6 * 60 * 60 * 1000;
const MAX_SOCKETS = 8;
/** One long-poll round; the hook repeats it until it gets an answer or gives up (~88 s). */
const POLL_MS = 25_000;
/** A permission request older than this is gone (the hook gives up after ~88 s). */
const PERMISSION_TTL_MS = 120_000;
const MAX_DECISION = 16 * 1024;

/** Fields forwarded to the deck; everything else in the hook payload is dropped. */
const KEEP = ["hook_event_name", "session_id", "cwd", "tool_name", "notification_type", "message", "error", "source", "reason", "session_title", "input_hash", "host_session"] as const;

export default {
	async fetch(req: Request, env: Env): Promise<Response> {
		const url = new URL(req.url);

		if (url.pathname === "/") return new Response("ClaudeDeck relay\n");

		if (url.pathname === "/v1/event") {
			if (req.method !== "POST") return new Response(null, { status: 405 });
			const token = bearer(req);
			if (!token || token.length < MIN_TOKEN) return new Response("unauthorized\n", { status: 401 });

			const raw = await readJson(req);
			if (raw instanceof Response) return raw;
			const event = sanitize(raw);
			if (!event) return new Response("missing session_id / hook_event_name\n", { status: 400 });

			await (await channel(env, token)).publish(event);
			return new Response(null, { status: 204 });
		}

		if (url.pathname === "/v1/permission") {
			if (req.method !== "POST") return new Response(null, { status: 405 });
			const token = bearer(req);
			if (!token || token.length < MIN_TOKEN) return new Response("unauthorized\n", { status: 401 });

			const raw = await readJson(req);
			if (raw instanceof Response) return raw;
			const id = typeof raw.id === "string" && /^[A-Za-z0-9_-]{16,64}$/.test(raw.id) ? raw.id : undefined;
			if (!id) return new Response("bad id\n", { status: 400 });

			const stub = await channel(env, token);
			if (raw.cancel === true) {
				await stub.cancelPermission(id);
				return new Response(null, { status: 204 });
			}
			const request = sanitizePermission(raw.request);
			if (!request) return new Response("bad request\n", { status: 400 });
			return Response.json(await stub.awaitPermission(id, request));
		}

		const ws = /^\/v1\/ws\/([0-9a-f]{64})$/.exec(url.pathname);
		if (ws) {
			if (req.headers.get("Upgrade")?.toLowerCase() !== "websocket") return new Response("expected websocket\n", { status: 426 });
			const headers = new Headers(req.headers);
			headers.set("X-Channel", ws[1]);
			return env.CHANNEL.get(env.CHANNEL.idFromName(ws[1])).fetch(new Request(req, { headers }));
		}

		return new Response(null, { status: 404 });
	},
} satisfies ExportedHandler<Env>;

async function channel(env: Env, token: string) {
	return env.CHANNEL.get(env.CHANNEL.idFromName(await sha256Hex(token)));
}

async function readJson(req: Request): Promise<Record<string, unknown> | Response> {
	const text = await req.text();
	if (text.length > MAX_BODY) return new Response(null, { status: 413 });
	try {
		const v = JSON.parse(text);
		return v && typeof v === "object" ? v : new Response("bad json\n", { status: 400 });
	} catch {
		return new Response("bad json\n", { status: 400 });
	}
}

type Attachment = { channel: string; authed: boolean };
type RelayEvent = Record<string, string> & { session_id: string; hook_event_name: string; at: string };
type PermissionRequest = Record<string, unknown> & { session_id: string; hook_event_name: "PermissionRequest" };
type StoredPermission = { request: PermissionRequest; created: number; decision?: string };
/** decided: the deck's hook output ("" = no decision, use the app); pending: poll again; nodeck: no deck is listening. */
type PermissionResult = { status: "decided"; body: string } | { status: "pending" } | { status: "nodeck" };

/** One per token: holds the deck's WebSocket(s), the latest event of each cloud session, and open permission requests. */
export class Channel extends DurableObject<Env> {
	/** Long-polls waiting for a decision, by permission id. In memory only: an in-flight request keeps the object alive. */
	readonly #waiters = new Map<string, Set<(body: string) => void>>();

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		// Keep-alive pings are answered without waking the object.
		ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
	}

	override async fetch(req: Request): Promise<Response> {
		const channel = req.headers.get("X-Channel") ?? "";
		const sockets = this.ctx.getWebSockets();
		if (sockets.length >= MAX_SOCKETS) sockets[0].close(4002, "too many connections");

		const { 0: client, 1: server } = new WebSocketPair();
		this.ctx.acceptWebSocket(server);
		server.serializeAttachment({ channel, authed: false } satisfies Attachment);
		return new Response(null, { status: 101, webSocket: client });
	}

	override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
		const att = ws.deserializeAttachment() as Attachment;
		if (att.authed) {
			await this.#onDeckMessage(String(message));
			return;
		}

		let token = "";
		try {
			token = String((JSON.parse(String(message)) as { auth?: unknown }).auth ?? "");
		} catch {
			/* fall through */
		}
		if (token.length < MIN_TOKEN || (await sha256Hex(token)) !== att.channel) {
			ws.close(4001, "unauthorized");
			return;
		}

		ws.serializeAttachment({ ...att, authed: true } satisfies Attachment);
		ws.send(JSON.stringify({ type: "ready" }));

		// Replay the latest event of each live session so the deck shows current state right away.
		const cutoff = Date.now() - SESSION_TTL_MS;
		const stored = await this.ctx.storage.list<RelayEvent>({ prefix: "s:" });
		for (const [key, event] of stored) {
			if (Date.parse(event.at) < cutoff) await this.ctx.storage.delete(key);
			else ws.send(JSON.stringify({ type: "event", event, replay: true }));
		}
		// ...and the permission requests still waiting for an answer.
		const held = await this.ctx.storage.list<StoredPermission>({ prefix: "p:" });
		for (const [key, p] of held) {
			if (Date.now() - p.created > PERMISSION_TTL_MS) await this.ctx.storage.delete(key);
			else if (p.decision === undefined) ws.send(JSON.stringify({ type: "permission", id: key.slice(2), request: p.request, replay: true }));
		}
	}

	override async webSocketClose(ws: WebSocket, code: number): Promise<void> {
		try {
			ws.close(code === 1005 ? 1000 : code, "bye");
		} catch {
			/* already closed */
		}
	}

	async publish(event: RelayEvent): Promise<void> {
		const key = `s:${event.session_id}`;
		if (event.hook_event_name === "SessionEnd") await this.ctx.storage.delete(key);
		else await this.ctx.storage.put(key, event);
		this.#broadcast({ type: "event", event });
	}

	/** Registers a permission request (first call) and waits up to POLL_MS for a deck's decision. */
	async awaitPermission(id: string, request: PermissionRequest): Promise<PermissionResult> {
		const key = `p:${id}`;
		let stored = await this.ctx.storage.get<StoredPermission>(key);
		if (!stored) {
			if (!this.#hasDeck()) return { status: "nodeck" };
			stored = { request, created: Date.now() };
			await this.ctx.storage.put(key, stored);
			this.#broadcast({ type: "permission", id, request });
		}
		if (stored.decision !== undefined) {
			await this.ctx.storage.delete(key);
			return { status: "decided", body: stored.decision };
		}

		return new Promise<PermissionResult>((resolve) => {
			const set = this.#waiters.get(id) ?? new Set<(body: string) => void>();
			this.#waiters.set(id, set);
			const wake = (body: string) => {
				clearTimeout(timer);
				resolve({ status: "decided", body });
			};
			const timer = setTimeout(() => {
				set.delete(wake);
				if (set.size === 0 && this.#waiters.get(id) === set) this.#waiters.delete(id);
				resolve({ status: "pending" });
			}, POLL_MS);
			set.add(wake);
		});
	}

	/** The hook gave up (timed out, or the session moved on): decks drop the request. */
	async cancelPermission(id: string): Promise<void> {
		const key = `p:${id}`;
		if (!(await this.ctx.storage.get(key))) return;
		await this.ctx.storage.delete(key);
		const waiters = this.#waiters.get(id);
		this.#waiters.delete(id);
		for (const wake of waiters ?? []) wake("");
		this.#broadcast({ type: "permission_cancel", id });
	}

	/** A deck answered a permission request: wake the hook's long-poll, or keep the answer for its next poll. */
	async #onDeckMessage(message: string): Promise<void> {
		let msg: { type?: unknown; id?: unknown; body?: unknown };
		try {
			msg = JSON.parse(message);
		} catch {
			return;
		}
		if (msg.type !== "decision" || typeof msg.id !== "string" || typeof msg.body !== "string" || msg.body.length > MAX_DECISION) return;
		const key = `p:${msg.id}`;
		const stored = await this.ctx.storage.get<StoredPermission>(key);
		if (!stored || stored.decision !== undefined) return; // already answered (by another deck) or withdrawn

		const waiters = this.#waiters.get(msg.id);
		if (waiters?.size) {
			this.#waiters.delete(msg.id);
			await this.ctx.storage.delete(key);
			for (const wake of waiters) wake(msg.body);
		} else {
			await this.ctx.storage.put(key, { ...stored, decision: msg.body } satisfies StoredPermission);
		}
		this.#broadcast({ type: "permission_cancel", id: msg.id }); // other decks drop it
	}

	#hasDeck(): boolean {
		return this.ctx.getWebSockets().some((ws) => (ws.deserializeAttachment() as Attachment | null)?.authed);
	}

	#broadcast(msg: unknown): void {
		const data = JSON.stringify(msg);
		for (const ws of this.ctx.getWebSockets()) {
			if ((ws.deserializeAttachment() as Attachment | null)?.authed) {
				try {
					ws.send(data);
				} catch {
					/* closing */
				}
			}
		}
	}
}

function sanitize(raw: Record<string, unknown>): RelayEvent | undefined {
	const out: Record<string, string> = {};
	for (const k of KEEP) {
		const v = raw[k];
		if (typeof v === "string" && v) out[k] = v.slice(0, k === "cwd" ? 300 : 200);
	}
	if (!out.session_id || !out.hook_event_name) return undefined;
	out.at = new Date().toISOString();
	return out as RelayEvent;
}

const str = (v: unknown, max: number): string | undefined => (typeof v === "string" && v ? v.slice(0, max) : undefined);

/**
 * What the deck needs to show and answer a permission request: tool, a short summary, the question and its
 * options (AskUserQuestion), and Claude Code's "don't ask again" suggestions (for Always allow). No tool input.
 */
function sanitizePermission(raw: unknown): PermissionRequest | undefined {
	if (!raw || typeof raw !== "object") return undefined;
	const r = raw as Record<string, unknown>;
	const session_id = str(r.session_id, 200);
	const tool_name = str(r.tool_name, 200);
	if (!session_id || !tool_name) return undefined;
	const out: PermissionRequest = { session_id, hook_event_name: "PermissionRequest", tool_name };
	for (const [k, max] of [["cwd", 300], ["detail", 300], ["input_hash", 64], ["session_title", 200]] as const) {
		const v = str(r[k], max);
		if (v) out[k] = v;
	}

	const qs = (r.tool_input as { questions?: unknown } | undefined)?.questions;
	if (Array.isArray(qs)) {
		const questions = qs.slice(0, 4).map((raw) => {
			const q = (raw ?? {}) as Record<string, unknown>;
			const options = Array.isArray(q.options) ? q.options.slice(0, 8) : [];
			return {
				question: str(q.question, 500),
				header: str(q.header, 60),
				multiSelect: q.multiSelect === true,
				options: options.map((o) => ({
					label: str((o as Record<string, unknown>)?.label, 200),
					description: str((o as Record<string, unknown>)?.description, 300),
				})),
			};
		});
		out.tool_input = { questions };
	}

	if (Array.isArray(r.permission_suggestions) && JSON.stringify(r.permission_suggestions).length <= 8 * 1024) {
		out.permission_suggestions = r.permission_suggestions;
	}
	return out;
}

function bearer(req: Request): string | undefined {
	const m = /^Bearer\s+(\S+)\s*$/i.exec(req.headers.get("Authorization") ?? "");
	return m?.[1];
}

async function sha256Hex(s: string): Promise<string> {
	const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
	return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
