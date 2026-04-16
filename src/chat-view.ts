import { ItemView, WorkspaceLeaf, TFile, setIcon } from "obsidian";
import type KimiCanvasPlugin from "./main";
import type { CanvasData } from "./canvas-manager";
import type { ACPChunk, ImagePayload } from "./kimi-bridge";

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

	// Pending images for next prompt
	pendingImages: ImagePayload[] = [];

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

		const screenshotBtn = controls.createEl("button", { cls: "kimi-canvas-header-btn", attr: { "aria-label": "Capture canvas screenshot" } });
		setIcon(screenshotBtn, "camera");
		screenshotBtn.addEventListener("click", () => this.triggerManualScreenshot());

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

		// Hidden file input
		const fileInput = inputArea.createEl("input", {
			cls: "kimi-file-input",
			attr: { type: "file", accept: "image/*", multiple: "true" },
		});
		fileInput.addEventListener("change", (evt) => this.onFileSelected(evt));

		const attachBtn = inputArea.createEl("button", { cls: "kimi-canvas-attach-btn", attr: { "aria-label": "Attach image" } });
		setIcon(attachBtn, "paperclip");
		attachBtn.addEventListener("click", () => fileInput.click());

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
			"- You can attach screenshots (📎) or let Kimi request a screen capture.\n" +
			"- Make sure you have run `kimi login` in terminal."
		);
	}

	appendUserMessage(text: string, imagePreviews?: string[]): void {
		this.messages.push({ role: "user", content: text, ts: Date.now() });
		this.renderStaticMessage("user", text, imagePreviews);
	}

	appendSystemMessage(text: string): void {
		this.renderStaticMessage("system", text);
	}

	appendErrorMessage(text: string): void {
		if (!this.messageContainer) return;
		const row = this.messageContainer.createEl("div", { cls: "kimi-msg-row kimi-msg-error" });
		const bubble = row.createEl("div", { cls: "kimi-msg-bubble" });
		bubble.createEl("div", { cls: "kimi-msg-content" }).innerHTML = this.markdownToHtml(text);
		this.scrollToBottom();
	}

	renderStaticMessage(role: "user" | "assistant" | "system", text: string, imagePreviews?: string[]): void {
		if (!this.messageContainer) return;
		const row = this.messageContainer.createEl("div", { cls: `kimi-msg-row kimi-msg-${role}` });
		const bubble = row.createEl("div", { cls: "kimi-msg-bubble" });
		if (imagePreviews && imagePreviews.length > 0) {
			const imgContainer = bubble.createEl("div", { cls: "kimi-msg-images" });
			for (const src of imagePreviews) {
				imgContainer.createEl("img", { cls: "kimi-msg-thumb", attr: { src } });
			}
		}
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

		// Check for screenshot action request
		if (displayText.includes("// kimi-action: screenshot")) {
			if (this.plugin.settings.autoScreenshotOnLayoutRequest) {
				this.setProcessing(false);
				this.updateStatus(this.plugin.kimi.currentState);
				await this.handleScreenshotAction();
				return;
			}
		}

		if (activeCanvas) {
			const op = this.plugin.canvasManager.parseCanvasOpBlock(displayText);
			if (op) {
				const current = await this.plugin.canvasManager.readCanvas(activeCanvas);
				let updated = this.plugin.canvasManager.applyCanvasUpdate(current, op);

				// If Kimi asks for a specific layout, run semantic layout engine
				if (op.layout) {
					updated = this.plugin.canvasManager.applySemanticLayout(
						updated,
						op.layout,
						op.direction ?? this.plugin.settings.defaultLayoutDirection
					);
					canvasApplied = true;
				} else if (op.nodes || op.edges) {
					// Backward compatibility: if nodes/edges updated but no layout specified,
					// optionally auto-layout based on user setting
					if (this.plugin.settings.autoLayoutOnUpdate) {
						updated = this.plugin.canvasManager.applySemanticLayout(
							updated,
							"tree",
							this.plugin.settings.defaultLayoutDirection
						);
					}
					canvasApplied = true;
				}

				await this.plugin.canvasManager.writeCanvas(activeCanvas, updated);
				displayText = this.plugin.canvasManager.stripCanvasOpBlock(displayText);
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
		if ((!text && this.pendingImages.length === 0) || this.isProcessing) return;

		if (this.plugin.kimi.currentState !== "ready") {
			this.appendSystemMessage("Kimi ACP is not ready yet. Please wait a moment or click the reconnect button.");
			return;
		}

		const imagesToSend = [...this.pendingImages];
		this.pendingImages = [];
		this.clearPendingImagePreview();

		this.inputEl.value = "";
		const imagePreviews = imagesToSend.map((img) => `data:${img.mimeType};base64,${img.data}`);
		this.appendUserMessage(text || "(image)", imagePreviews);
		this.setProcessing(true);
		this.updateStatus("prompting");

		// Build system prompt with canvas context and send
		const activeCanvas = this.getActiveCanvasFile();
		let canvasData: CanvasData | undefined;
		if (activeCanvas) {
			canvasData = await this.plugin.canvasManager.readCanvas(activeCanvas);
		}
		const system = this.buildSystemPrompt(canvasData, activeCanvas?.path, imagesToSend.length > 0);

		const fullPrompt = `${system}\n\n--- User Request ---\n${text}`;
		this.plugin.kimi.sendPrompt(fullPrompt, imagesToSend);
	}

	onFileSelected(evt: Event): void {
		const input = evt.target as HTMLInputElement;
		const files = input.files;
		if (!files || files.length === 0) return;

		for (const file of Array.from(files)) {
			if (!file.type.startsWith("image/")) continue;
			const reader = new FileReader();
			reader.onload = (e) => {
				const result = e.target?.result as string;
				if (!result) return;
				const base64 = result.split(",")[1];
				this.pendingImages.push({ mimeType: file.type, data: base64 });
				this.updatePendingImagePreview();
			};
			reader.readAsDataURL(file);
		}
		input.value = "";
	}

	updatePendingImagePreview(): void {
		if (this.inputEl) {
			const count = this.pendingImages.length;
			this.inputEl.placeholder = count > 0 ? `${count} image(s) attached. Type a message...` : "Ask Kimi about your canvas, or type a command...";
		}
	}

	clearPendingImagePreview(): void {
		if (this.inputEl) {
			this.inputEl.placeholder = "Ask Kimi about your canvas, or type a command...";
		}
	}

	async triggerManualScreenshot(): Promise<void> {
		if (this.isProcessing) return;
		this.appendSystemMessage("Capturing screenshot...");
		const { image, error } = await this.captureScreen();
		if (!image) {
			this.appendErrorMessage(`Failed to capture screenshot.\nReason: ${error ?? "Unknown error"}`);
			return;
		}
		this.pendingImages.push(image);
		this.updatePendingImagePreview();
		this.appendSystemMessage("Screenshot captured. It will be sent with your next message.");
	}

	async handleScreenshotAction(): Promise<void> {
		this.appendSystemMessage("Kimi requested a screenshot. Capturing now...");
		const { image, error } = await this.captureScreen();
		if (!image) {
			this.appendErrorMessage(`Failed to capture screenshot.\nReason: ${error ?? "Unknown error"}`);
			this.setProcessing(false);
			return;
		}
		this.appendSystemMessage("Screenshot captured and sent back to Kimi.");
		this.setProcessing(true);
		this.updateStatus("prompting");

		const activeCanvas = this.getActiveCanvasFile();
		let canvasData: CanvasData | undefined;
		if (activeCanvas) {
			canvasData = await this.plugin.canvasManager.readCanvas(activeCanvas);
		}
		const system = this.buildSystemPrompt(canvasData, activeCanvas?.path, true);
		const promptText = `${system}\n\n--- User Request ---\nHere is the screenshot of the current canvas. Please analyze the visual layout and suggest improvements. If needed, output a canvas operation block.`;
		this.plugin.kimi.sendPrompt(promptText, [image]);
	}

	async captureScreen(): Promise<{ image: ImagePayload | null; error?: string }> {
		const { screenshotMode } = this.plugin.settings;
		const tmpPath = "/tmp/obsidian-kimi-canvas-screenshot.png";
		let args: string[] = [];
		if (screenshotMode === "full") {
			args = ["-x", tmpPath];
		} else if (screenshotMode === "window") {
			args = ["-w", tmpPath];
		} else {
			args = ["-i", tmpPath];
		}
		try {
			const { execFile } = require("child_process");
			const stderr = await new Promise<string>((resolve, reject) => {
				let errOut = "";
				const child = execFile("screencapture", args, (err: any) => {
					if (err) {
						reject(new Error(errOut.trim() || err.message));
					} else {
						resolve(errOut.trim());
					}
				});
				child.stderr?.on("data", (chunk: Buffer) => {
					errOut += chunk.toString("utf-8");
				});
			});
			if (stderr) {
				console.warn("screencapture stderr:", stderr);
			}
			const fs = require("fs");
			const buffer = fs.readFileSync(tmpPath) as Buffer;
			const base64 = buffer.toString("base64");
			return { image: { mimeType: "image/png", data: base64 } };
		} catch (e: any) {
			console.error("Screenshot failed:", e);
			let reason = e?.message ?? String(e);
			if ((screenshotMode === "window" || screenshotMode === "region") && reason.includes("could not create image")) {
				reason += "\n\nTip: Window/Region mode requires user interaction. Please switch to 'Full Screen' mode in Kimi Canvas settings for automatic capture.";
			}
			return { image: null, error: reason };
		}
	}

	arrayBufferToBase64(buffer: ArrayBuffer): string {
		const bytes = new Uint8Array(buffer);
		let binary = "";
		for (let i = 0; i < bytes.byteLength; i++) {
			binary += String.fromCharCode(bytes[i]);
		}
		return btoa(binary);
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

	buildSystemPrompt(canvasData?: CanvasData, canvasPath?: string, hasImages = false): string {
		let prompt =
			"You are Kimi Canvas, an AI assistant embedded in Obsidian with FULL AUTHORITY to read and modify the user's Canvas whiteboard.\n\n" +
			"You have two powers:\n" +
			"1. Structural changes: add, update, or remove nodes and edges.\n" +
			"2. Layout changes: tell the plugin which algorithm to use for automatic coordinate calculation.\n\n";

		if (hasImages) {
			prompt +=
				"You are provided with screenshot(s) of the current canvas. " +
				"Analyze the visual layout, spacing, alignment, and grouping. " +
				"Suggest concrete improvements and APPLY them by outputting the operation block below.\n\n";
		}

		prompt +=
			"IMPORTANT: You do NOT need to calculate x/y coordinates. The plugin will compute coordinates automatically when you specify a layout. " +
			"But you MUST still output the operation block to make ANY change to the canvas.\n\n" +
			"To modify the canvas, append a special JSON block at the very end of your response using this exact format:\n\n" +
			"// kimi-canvas-op\n" +
			"```json\n" +
			'{ "nodes": [...], "edges": [...], "layout": "tree", "direction": "lr" }\n' +
			"```\n\n" +
			"Examples:\n\n" +
			"- Only re-layout existing nodes:\n" +
			"```json\n" +
			'{ "layout": "tree", "direction": "lr" }\n' +
			"```\n\n" +
			"- Add a new node and re-layout everything:\n" +
			"```json\n" +
			'{ "nodes": [{ "id": "abc123", "type": "text", "width": 260, "height": 140, "text": "New Idea" }], "layout": "tree", "direction": "lr" }\n' +
			"```\n\n" +
			"- Add a node AND connect it to an existing node:\n" +
			"```json\n" +
			'{ "nodes": [{ "id": "abc123", "type": "text", "width": 260, "height": 140, "text": "New Idea" }], "edges": [{ "id": "e1", "fromNode": "existing-node-id", "toNode": "abc123" }], "layout": "tree", "direction": "lr" }\n' +
			"```\n\n" +
			"Rules:\n" +
			"1. ALWAYS output the operation block if you intend to change the canvas in any way.\n" +
			"2. For layout-only requests, you can omit 'nodes' and 'edges'.\n" +
			"3. For new nodes, you MUST provide: id (8-char random), type, width, height. For text nodes, also provide 'text'.\n" +
			"4. For new edges, you MUST provide: id, fromNode, toNode.\n" +
			"5. Available layouts: tree, grid, circle, force. If unsure, use 'tree'.\n" +
			"6. direction is optional: 'lr' (left-to-right) or 'tb' (top-to-bottom).\n" +
			"7. If you need a screenshot to visually inspect the board, output exactly `// kimi-action: screenshot`.\n\n";

		if (canvasData && canvasPath) {
			prompt += `The current canvas file is: ${canvasPath}\nCurrent canvas JSON:\n${JSON.stringify(canvasData, null, 2)}\n\n`;
		} else {
			prompt += "No canvas is currently open. If the user asks for canvas operations, tell them to open a .canvas file first.\n\n";
		}

		prompt += "Be proactive: when the user asks you to organize, add, connect, or clean up the board, always output the operation block and actually modify the canvas.";
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
