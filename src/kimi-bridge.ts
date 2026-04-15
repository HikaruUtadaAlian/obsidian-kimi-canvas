import { ChildProcess, spawn } from "child_process";
import { EventEmitter } from "events";

export interface ACPChunk {
	type: "thought" | "message";
	text: string;
}

export interface PromptDoneInfo {
	stopReason: string;
	fullText: string;
}

type BridgeState = "idle" | "connecting" | "initializing" | "creating_session" | "ready" | "prompting";

export class KimiBridge extends EventEmitter {
	private cp?: ChildProcess;
	private cwd: string;
	private kimiPath: string;
	private buffer = "";
	private requestId = 0;
	private pendingRequestIds = new Set<number>();
	private state: BridgeState = "idle";
	private sessionId?: string;
	private messageAccumulator = "";

	public get currentState(): BridgeState {
		return this.state;
	}

	public get activeSessionId(): string | undefined {
		return this.sessionId;
	}

	constructor(cwd: string, kimiPath = "kimi") {
		super();
		this.cwd = cwd;
		this.kimiPath = kimiPath;
	}

	connect(): void {
		if (this.cp || this.state !== "idle") return;
		this.state = "connecting";
		this.sessionId = undefined;
		this.requestId = 0;
		this.pendingRequestIds.clear();
		this.messageAccumulator = "";

		try {
			this.cp = spawn(this.kimiPath, ["acp"], {
				cwd: this.cwd,
				env: process.env,
				stdio: ["pipe", "pipe", "pipe"],
			});
		} catch (e: any) {
			this.state = "idle";
			const msg = e?.code === "ENOENT"
				? `Cannot find kimi executable at "${this.kimiPath}". Please set the correct path in Kimi Canvas settings.`
				: `Failed to spawn kimi acp: ${e?.message ?? e}`;
			this.emit("error", msg);
			return;
		}

		this.cp.stdout?.on("data", (chunk: Buffer) => {
			this.buffer += chunk.toString("utf-8");
			this.processBuffer();
		});

		this.cp.stderr?.on("data", (chunk: Buffer) => {
			const text = chunk.toString("utf-8").trim();
			if (text) this.emit("stderr", text);
		});

		this.cp.on("exit", (code) => {
			const wasReady = this.state === "ready" || this.state === "prompting";
			this.cp = undefined;
			this.state = "idle";
			this.sessionId = undefined;
			if (wasReady) {
				this.emit("disconnected", code);
			} else {
				this.emit("error", `kimi acp exited unexpectedly (code ${code ?? "unknown"})`);
			}
		});

		this.cp.on("error", (err: any) => {
			const msg = err?.code === "ENOENT"
				? `Cannot find kimi executable at "${this.kimiPath}". Please set the correct path in Kimi Canvas settings.`
				: `kimi acp process error: ${err.message}`;
			this.emit("error", msg);
			if (this.state !== "idle") {
				this.state = "idle";
				this.cp = undefined;
			}
		});

		// Step 1: initialize
		this.sendRequest("initialize", {
			protocolVersion: 1,
			clientCapabilities: {},
			clientInfo: { name: "obsidian-kimi-canvas", version: "0.2.0" },
		});
		this.state = "initializing";
	}

	disconnect(): void {
		this.cp?.kill();
		this.cp = undefined;
		this.state = "idle";
		this.sessionId = undefined;
		this.pendingRequestIds.clear();
	}

	reconnect(): void {
		this.disconnect();
		this.connect();
	}

	private sendRequest(method: string, params: unknown): number {
		const id = ++this.requestId;
		const line = JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n";
		this.pendingRequestIds.add(id);
		this.cp?.stdin?.write(line);
		return id;
	}

	private sendNotification(method: string, params: unknown): void {
		const line = JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n";
		this.cp?.stdin?.write(line);
	}

	sendPrompt(text: string): void {
		if (this.state !== "ready" || !this.sessionId) {
			this.emit("error", "Kimi ACP is not ready. Please wait for connection or reconnect.");
			return;
		}
		this.messageAccumulator = "";
		this.sendRequest("session/prompt", {
			sessionId: this.sessionId,
			prompt: [{ type: "text", text }],
		});
		this.state = "prompting";
		this.emit("promptStarted");
	}

	private processBuffer(): void {
		const lines = this.buffer.split("\n");
		this.buffer = lines.pop() ?? "";
		for (const line of lines) {
			if (!line.trim()) continue;
			try {
				const msg = JSON.parse(line);
				this.handleMessage(msg);
			} catch (e) {
				// ignore malformed lines
			}
		}
	}

	private handleMessage(msg: any): void {
		// Notification
		if (msg.method && msg.params !== undefined) {
			this.handleNotification(msg.method, msg.params);
			return;
		}

		// Response
		if (msg.id !== undefined) {
			this.pendingRequestIds.delete(msg.id);
			if (msg.error) {
				this.handleErrorResponse(msg.error);
				return;
			}
			this.handleSuccessResponse(msg.id, msg.result);
		}
	}

	private handleNotification(method: string, params: any): void {
		if (method === "session/update") {
			const update = params?.update;
			if (!update) return;
			switch (update.sessionUpdate) {
				case "agent_thought_chunk":
				case "agent_message_chunk": {
					const text = update.content?.text ?? "";
					if (update.sessionUpdate === "agent_message_chunk") {
						this.messageAccumulator += text;
						this.emit("chunk", { type: "message", text } as ACPChunk);
					} else {
						this.emit("chunk", { type: "thought", text } as ACPChunk);
					}
					break;
				}
				case "tool_call_update": {
					this.emit("toolCall", update);
					break;
				}
				case "available_commands_update":
				case "current_mode_update":
				case "usage_update":
				case "plan":
				case "config_option_update":
				case "session_info_update": {
					this.emit("notification", { method, params });
					break;
				}
				default:
					this.emit("notification", { method, params });
					break;
			}
		} else {
			this.emit("notification", { method, params });
		}
	}

	private handleSuccessResponse(id: number, result: any): void {
		if (this.state === "initializing") {
			// Step 2: create session
			this.sendRequest("session/new", {
				cwd: this.cwd,
				mcpServers: [],
			});
			this.state = "creating_session";
			return;
		}

		if (this.state === "creating_session") {
			this.sessionId = result?.sessionId;
			if (this.sessionId) {
				this.state = "ready";
				this.emit("connected", { sessionId: this.sessionId });
			} else {
				this.state = "idle";
				this.emit("error", "ACP session/new did not return a sessionId");
			}
			return;
		}

		if (this.state === "prompting") {
			this.state = "ready";
			const stopReason = result?.stopReason ?? "unknown";
			this.emit("promptDone", { stopReason, fullText: this.messageAccumulator } as PromptDoneInfo);
			return;
		}
	}

	private handleErrorResponse(error: any): void {
		const code = error?.code;
		const message = error?.message ?? "Unknown ACP error";

		if (code === -32000) {
			this.emit("authRequired", message);
			this.disconnect();
			return;
		}

		if (this.state === "initializing" || this.state === "creating_session") {
			this.state = "idle";
		}
		if (this.state === "prompting") {
			this.state = "ready";
		}
		this.emit("error", `ACP error [${code}]: ${message}`);
	}

	clearSession(): void {
		this.sessionId = undefined;
		this.messageAccumulator = "";
		if (this.state === "ready" || this.state === "prompting") {
			this.disconnect();
			this.connect();
		}
	}

	// Legacy fallback helpers (keep compatibility with quiet mode code if needed)
	async runQuiet(_prompt: string, _extraArgs: string[] = []): Promise<string> {
		throw new Error("Quiet mode is deprecated in ACP bridge.");
	}

	async runQuietWithContext(_system: string, _history: { role: string; content: string }[], _user: string): Promise<string> {
		throw new Error("Quiet mode is deprecated in ACP bridge.");
	}
}
