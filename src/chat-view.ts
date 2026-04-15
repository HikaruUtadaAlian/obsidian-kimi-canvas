import { ItemView, WorkspaceLeaf, TFile, setIcon } from "obsidian";
import type KimiCanvasPlugin from "./main";
import type { CanvasData } from "./canvas-manager";
import type { ACPChunk } from "./kimi-bridge";

export const VIEW_TYPE_KIMI_CHAT = "kimi-canvas-chat";

interface ChatMessage {
	role: "user" | "assistant";
	content: string;
	ts: number;
}

export class KimiChatView extends ItemView {
	plugin: KimiCanvasPlugin;
	messages: ChatMessage[] = [];
	messageContainer?: HTMLElement;
	inputEl?: HTMLTextAreaElement;
	sendBtn?: HTMLButtonElement;
	statusEl?: HTMLElement;
	isProcessing = false;

	// Streaming state
	currentAssistantBubble?: HTMLElement;
	currentAssistantContent?: HTMLElement;
	currentAssistantThinking?: HTMLElement;
	currentAssistantText = "";
	currentThinkingText = "";

	constructor(leaf: WorkspaceLeaf, plugin: KimiCanvasPlugin) {
		super(leaf);
		this.plugin = plugin;
		this.bindBridgeEvents();
	}

	getViewType(): string {
		return VIEW_TYPE_KIMI_CHAT;
	}

	getDisplayText(): string {
		return "Kimi Canvas";
	}

	getIcon(): string {
		return "bot";
	}

	async onOpen(): Promise<void> {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass("kimi-canvas-container");

		// Header
		const header = contentEl.createEl("div", { cls: "kimi-canvas-header" });
		header.createEl("span", { text: "Kimi Canvas", cls: "kimi-canvas-title" });

		const controls = header.createEl("span", { cls: "kimi-canvas-header-controls" });

		const reconnectBtn = controls.createEl("button", { cls: "kimi-canvas-header-btn", attr: { "aria-label": "Reconnect ACP" } });
		setIcon(reconnectBtn, "refresh-cw");
		reconnectBtn.addEventListener("click", () => {
			this.appendSystemMessage("Reconnecting to Kimi ACP...");
			this.plugin.kimi.reconnect();
		});

		const clearBtn = controls.createEl("button", { cls: "kimi-canvas-header-btn", attr: { "aria-label": "Clear chat" } });
		setIcon(clearBtn, "trash-2");
		clearBtn.addEventListener("click", () => this.clearChat());

		// Status
		this.statusEl = contentEl.createEl("div", { cls: "kimi-canvas-status" });
		this.updateStatus("disconnected");

		// Messages
		this.messageContainer = contentEl.createEl("div", { cls: "kimi-canvas-messages" });

		// Input area
		const inputArea = contentEl.createEl("div", { cls: "kimi-canvas-input-area" });
		this.inputEl = inputArea.createEl("textarea", { cls: "kimi-canvas-input" });
		this.inputEl.placeholder = "Ask Kimi about your canvas, or type a command...";
		this.inputEl.addEventListener("keydown", (evt) => {
			if (evt.key === "Enter" && !evt.shiftKey) {
				evt.preventDefault();
				this.sendMessage();
			}
		});

		this.sendBtn = inputArea.createEl("button", { cls: "kimi-canvas-send-btn" });
		setIcon(this.sendBtn, "send");
		this.sendBtn.addEventListener("click", () => this.sendMessage());

		this.addWelcomeMessage();

		// Auto-connect ACP if not already connected
		if (this.plugin.kimi.currentState === "idle") {
			this.plugin.kimi.connect();
		} else {
			this.updateStatus(this.plugin.kimi.currentState);
		}
	}

	bindBridgeEvents(): void {
		const bridge = this.plugin.kimi;
		bridge.on("connected", () => this.updateStatus("ready"));
		bridge.on("disconnected", () => this.updateStatus("disconnected"));
		bridge.on("error", (msg: string) => {
			this.updateStatus("error");
			this.appendSystemMessage(`Error: ${msg}`);
			this.setProcessing(false);
		});
		bridge.on("authRequired", (msg: string) => {
			this.updateStatus("auth");
			this.appendSystemMessage(`Auth required: ${msg}\nPlease run "kimi login" in your terminal first.`);
			this.setProcessing(false);
		});
		bridge.on("promptStarted", () => {
			this.beginAssistantStream();
		});
		bridge.on("chunk", (chunk: ACPChunk) => {
			this.onStreamChunk(chunk);
		});
		bridge.on("promptDone", async (info: { stopReason: string; fullText: string }) => {
			await this.onStreamDone(info);
		});
	}

	updateStatus(state: string): void {
		if (!this.statusEl) return;
		const map: Record<string, { text: string; cls: string }> = {
			idle: { text: "Idle", cls: "kimi-status-idle" },
			connecting: { text: "Connecting...", cls: "kimi-status-connecting" },
			initializing: { text: "Initializing...", cls: "kimi-status-connecting" },
			creating_session: { text: "Creating session...", cls: "kimi-status-connecting" },
			ready: { text: "Ready", cls: "kimi-status-ready" },
			prompting: { text: "Thinking...", cls: "kimi-status-prompting" },
			disconnected: { text: "Disconnected", cls: "kimi-status-disconnected" },
			error: { text: "Error", cls: "kimi-status-error" },
			auth: { text: "Auth Required", cls: "kimi-status-error" },
		};
		const s = map[state] ?? { text: state, cls: "" };
		this.statusEl.textContent = s.text;
		this.statusEl.className = `kimi-canvas-status ${s.cls}`;
	}

	addWelcomeMessage(): void {
		this.appendSystemMessage(
			"Welcome! I can help you organize and generate Canvas boards.\n" +
			"- Open a .canvas file, then chat here.\n" +
			"- I can create nodes, connect ideas, and auto-layout your board.\n" +
			"- Make sure you have run `kimi login` in terminal."
		);
	}

	appendUserMessage(text: string): void {
		this.messages.push({ role: "user", content: text, ts: Date.now() });
		this.renderStaticMessage("user", text);
	}

	appendSystemMessage(text: string): void {
		this.renderStaticMessage("system", text);
	}

	renderStaticMessage(role: "user" | "assistant" | "system", text: string): void {
		if (!this.messageContainer) return;
		const row = this.messageContainer.createEl("div", { cls: `kimi-msg-row kimi-msg-${role}` });
		const bubble = row.createEl("div", { cls: "kimi-msg-bubble" });
		bubble.createEl("div", { cls: "kimi-msg-content" }).innerHTML = this.markdownToHtml(text);
		this.scrollToBottom();
	}

	beginAssistantStream(): void {
		this.currentAssistantText = "";
		this.currentThinkingText = "";
		if (!this.messageContainer) return;

		const row = this.messageContainer.createEl("div", { cls: "kimi-msg-row kimi-msg-assistant" });
		const bubble = row.createEl("div", { cls: "kimi-msg-bubble" });

		this.currentAssistantThinking = bubble.createEl("div", { cls: "kimi-msg-thinking" });
		this.currentAssistantThinking.style.display = "none";

		this.currentAssistantContent = bubble.createEl("div", { cls: "kimi-msg-content" });
		this.currentAssistantContent.innerHTML = "";

		this.currentAssistantBubble = bubble;
		this.scrollToBottom();
	}

	onStreamChunk(chunk: ACPChunk): void {
		if (chunk.type === "thought") {
			this.currentThinkingText += chunk.text;
			if (this.currentAssistantThinking) {
				this.currentAssistantThinking.style.display = "block";
				this.currentAssistantThinking.textContent = this.currentThinkingText;
			}
		} else {
			this.currentAssistantText += chunk.text;
			if (this.currentAssistantContent) {
				this.currentAssistantContent.innerHTML = this.markdownToHtml(this.currentAssistantText);
			}
		}
		this.scrollToBottom();
	}

	async onStreamDone(info: { stopReason: string; fullText: string }): Promise<void> {
		// Hide thinking after completion
		if (this.currentAssistantThinking) {
			this.currentAssistantThinking.style.display = "none";
		}

		let displayText = info.fullText;
		const activeCanvas = this.getActiveCanvasFile();
		let canvasApplied = false;

		if (activeCanvas) {
			const op = this.plugin.canvasManager.parseCanvasOpBlock(displayText);
			if (op) {
				const current = await this.plugin.canvasManager.readCanvas(activeCanvas);
				let updated = this.plugin.canvasManager.applyCanvasUpdate(current, op);
				if (this.plugin.settings.autoLayoutOnUpdate) {
					updated = this.plugin.canvasManager.autoLayout(updated, {
						direction: this.plugin.settings.defaultLayoutDirection,
					});
				}
				await this.plugin.canvasManager.writeCanvas(activeCanvas, updated);
				displayText = this.plugin.canvasManager.stripCanvasOpBlock(displayText);
				canvasApplied = true;
			}
		}

		// Finalize DOM with stripped text
		if (this.currentAssistantContent) {
			this.currentAssistantContent.innerHTML = this.markdownToHtml(displayText);
		}
		if (canvasApplied && this.currentAssistantBubble) {
			this.currentAssistantBubble.createEl("div", {
				cls: "kimi-msg-meta",
				text: "✓ Canvas updated and auto-layout applied.",
			});
		}

		this.messages.push({ role: "assistant", content: displayText, ts: Date.now() });
		this.currentAssistantBubble = undefined;
		this.currentAssistantContent = undefined;
		this.currentAssistantThinking = undefined;
		this.setProcessing(false);
		this.updateStatus(this.plugin.kimi.currentState);
	}

	setProcessing(processing: boolean): void {
		this.isProcessing = processing;
		if (this.sendBtn) {
			this.sendBtn.disabled = processing;
			this.sendBtn.toggleClass("kimi-spin", processing);
		}
		if (this.inputEl) {
			this.inputEl.disabled = processing;
		}
	}

	async sendMessage(): Promise<void> {
		if (!this.inputEl) return;
		const text = this.inputEl.value.trim();
		if (!text || this.isProcessing) return;

		if (this.plugin.kimi.currentState !== "ready") {
			this.appendSystemMessage("Kimi ACP is not ready yet. Please wait a moment or click the reconnect button.");
			return;
		}

		this.inputEl.value = "";
		this.appendUserMessage(text);
		this.setProcessing(true);
		this.updateStatus("prompting");

		// Build system prompt with canvas context and send
		const activeCanvas = this.getActiveCanvasFile();
		let canvasData: CanvasData | undefined;
		if (activeCanvas) {
			canvasData = await this.plugin.canvasManager.readCanvas(activeCanvas);
		}
		const system = this.buildSystemPrompt(canvasData, activeCanvas?.path);

		// Prepend system instruction as a hidden user turn workaround:
		// ACP session/prompt only sends user prompt. Kimi doesn't have an explicit
		// system parameter in session/prompt. We prefix the system prompt to the
		// user text for this MVP.
		const fullPrompt = `${system}\n\n--- User Request ---\n${text}`;
		this.plugin.kimi.sendPrompt(fullPrompt);
	}

	getActiveCanvasFile(): TFile | null {
		const file = this.app.workspace.getActiveFile();
		if (file && file.extension === "canvas") return file;
		let canvasFile: TFile | null = null;
		this.app.workspace.iterateAllLeaves((l) => {
			const f = (l.view as any).file as TFile | undefined;
			if (f && f.extension === "canvas" && !canvasFile) canvasFile = f;
		});
		return canvasFile;
	}

	buildSystemPrompt(canvasData?: CanvasData, canvasPath?: string): string {
		let prompt =
			"You are Kimi Canvas, an AI assistant embedded in Obsidian. " +
			"You help users think, organize, and visualize ideas on an infinite canvas. " +
			"You can read and modify Obsidian Canvas files (JSON Canvas format).\n\n" +
			"When the user asks you to change the canvas, you MUST reply with a human-friendly explanation first, " +
			"then append a special JSON Canvas operation block at the very end of your response using this exact format:\n\n" +
			"// kimi-canvas-op\n" +
			"```json\n" +
			"{ \"nodes\": [...], \"edges\": [...] }\n" +
			"```\n\n" +
			"Rules for the operation block:\n" +
			"1. Only include fields you want to add or update.\n" +
			"2. Each node must have: id, type (text/file/link/group), x, y, width, height.\n" +
			"3. For text nodes, include a 'text' field with Markdown content.\n" +
			"4. For file nodes, include 'file' (path inside vault).\n" +
			"5. Each edge must have: id, fromNode, toNode. Optional: fromSide, toSide, fromEnd, toEnd, label, color.\n" +
			"6. If you create new nodes, generate short random alphanumeric IDs (8 chars).\n" +
			"7. You do NOT need to worry about exact coordinates: the plugin will run auto-layout after applying your changes.\n\n";

		if (canvasData && canvasPath) {
			prompt += `The current canvas file is: ${canvasPath}\nCurrent canvas JSON:\n${JSON.stringify(canvasData, null, 2)}\n\n`;
		} else {
			prompt += "No canvas is currently open. If the user asks for canvas operations, tell them to open a .canvas file first.\n\n";
		}

		prompt += "Be concise, helpful, and creative when organizing ideas visually.";
		return prompt;
	}

	clearChat(): void {
		this.messages = [];
		this.messageContainer?.empty();
		this.plugin.kimi.clearSession();
		this.addWelcomeMessage();
	}

	scrollToBottom(): void {
		if (this.messageContainer) {
			this.messageContainer.scrollTop = this.messageContainer.scrollHeight;
		}
	}

	markdownToHtml(md: string): string {
		return md
			.replace(/&/g, "&amp;")
			.replace(/</g, "&lt;")
			.replace(/>/g, "&gt;")
			.replace(/```([\s\S]*?)```/g, "<pre><code>$1</code></pre>")
			.replace(/`([^`]+)`/g, "<code>$1</code>")
			.replace(/\*\*(.*?)\*\*/g, "<strong>$1</strong>")
			.replace(/\*(.*?)\*/g, "<em>$1</em>")
			.replace(/\n/g, "<br>");
	}
}
