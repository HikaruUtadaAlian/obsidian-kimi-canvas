import {
	App,
	Plugin,
	PluginSettingTab,
	Setting,
	WorkspaceLeaf,
} from "obsidian";
import { KimiBridge } from "./kimi-bridge";
import { CanvasManager } from "./canvas-manager";
import { KimiChatView, VIEW_TYPE_KIMI_CHAT } from "./chat-view";

interface KimiCanvasSettings {
	kimiPath: string;
	autoLayoutOnUpdate: boolean;
	defaultLayoutDirection: "lr" | "tb";
	screenshotMode: "full" | "window" | "region";
	autoScreenshotOnLayoutRequest: boolean;
}

const DEFAULT_SETTINGS: KimiCanvasSettings = {
	kimiPath: "/Users/utadahikaru/.local/bin/kimi",
	autoLayoutOnUpdate: true,
	defaultLayoutDirection: "lr",
	screenshotMode: "window",
	autoScreenshotOnLayoutRequest: true,
};

export default class KimiCanvasPlugin extends Plugin {
	settings: KimiCanvasSettings;
	kimi: KimiBridge;
	canvasManager: CanvasManager;

	async onload(): Promise<void> {
		await this.loadSettings();
		this.canvasManager = new CanvasManager(this.app.vault);
		this.kimi = new KimiBridge(this.getVaultPath(), this.settings.kimiPath);

		this.registerView(VIEW_TYPE_KIMI_CHAT, (leaf) => new KimiChatView(leaf, this));

		this.addRibbonIcon("bot", "Open Kimi Canvas chat", () => {
			this.activateView();
		});

		this.addCommand({
			id: "open-kimi-canvas-chat",
			name: "Open Kimi Canvas chat",
			callback: () => this.activateView(),
		});

		this.addCommand({
			id: "kimi-auto-layout-canvas",
			name: "Auto-layout current canvas",
			checkCallback: (checking: boolean) => {
				const file = this.app.workspace.getActiveFile();
				const isCanvas = file?.extension === "canvas";
				if (checking) return isCanvas;
				if (file && isCanvas) {
					this.autoLayoutFile(file);
				}
				return true;
			},
		});

		this.addCommand({
			id: "kimi-canvas-screenshot",
			name: "Capture canvas screenshot for Kimi",
			callback: () => {
				const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_KIMI_CHAT);
				if (leaves.length > 0) {
					const view = leaves[0].view as KimiChatView;
					view.triggerManualScreenshot();
				} else {
					this.activateView().then(() => {
						setTimeout(() => {
							const newLeaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_KIMI_CHAT);
							if (newLeaves.length > 0) {
								(newLeaves[0].view as KimiChatView).triggerManualScreenshot();
							}
						}, 500);
					});
				}
			},
		});

		this.addSettingTab(new KimiCanvasSettingTab(this.app, this));
	}

	onunload(): void {
		this.kimi.disconnect();
		this.app.workspace.detachLeavesOfType(VIEW_TYPE_KIMI_CHAT);
	}

	async loadSettings(): Promise<void> {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}

	getVaultPath(): string {
		// @ts-ignore
		const adapter = this.app.vault.adapter;
		return (adapter as any).getBasePath ? (adapter as any).getBasePath() : ".";
	}

	async activateView(): Promise<void> {
		const { workspace } = this.app;
		let leaf: WorkspaceLeaf | null = null;
		const leaves = workspace.getLeavesOfType(VIEW_TYPE_KIMI_CHAT);
		if (leaves.length > 0) {
			leaf = leaves[0];
		} else {
			leaf = workspace.getRightLeaf(false);
			if (leaf) await leaf.setViewState({ type: VIEW_TYPE_KIMI_CHAT, active: true });
		}
		if (leaf) workspace.revealLeaf(leaf);
	}

	async autoLayoutFile(file: import("obsidian").TFile): Promise<void> {
		const data = await this.canvasManager.readCanvas(file);
		const laidOut = this.canvasManager.autoLayout(data, {
			direction: this.settings.defaultLayoutDirection,
		});
		await this.canvasManager.writeCanvas(file, laidOut);
	}
}

class KimiCanvasSettingTab extends PluginSettingTab {
	plugin: KimiCanvasPlugin;

	constructor(app: App, plugin: KimiCanvasPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		containerEl.createEl("h2", { text: "Kimi Canvas Settings" });

		new Setting(containerEl)
			.setName("Kimi CLI path")
			.setDesc("Path to the kimi executable. Leave as 'kimi' if it's in your system PATH.")
			.addText((text) =>
				text
					.setPlaceholder("/Users/utadahikaru/.local/bin/kimi")
					.setValue(this.plugin.settings.kimiPath)
					.onChange(async (value) => {
						this.plugin.settings.kimiPath = value.trim() || "/Users/utadahikaru/.local/bin/kimi";
						this.plugin.kimi = new KimiBridge(this.plugin.getVaultPath(), this.plugin.settings.kimiPath);
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Auto-layout on AI update")
			.setDesc("Automatically re-layout the canvas after Kimi modifies it.")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.autoLayoutOnUpdate)
					.onChange(async (value) => {
						this.plugin.settings.autoLayoutOnUpdate = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Default layout direction")
			.setDesc("Direction for auto-layout: Left-to-Right or Top-to-Bottom.")
			.addDropdown((drop) =>
				drop
					.addOption("lr", "Left to Right")
					.addOption("tb", "Top to Bottom")
					.setValue(this.plugin.settings.defaultLayoutDirection)
					.onChange(async (value) => {
						this.plugin.settings.defaultLayoutDirection = value as "lr" | "tb";
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Screenshot mode")
			.setDesc("How to capture the screen when Kimi requests a screenshot or you click the camera button.")
			.addDropdown((drop) =>
				drop
					.addOption("full", "Full Screen")
					.addOption("window", "Active Window")
					.addOption("region", "Selected Region")
					.setValue(this.plugin.settings.screenshotMode)
					.onChange(async (value) => {
						this.plugin.settings.screenshotMode = value as "full" | "window" | "region";
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Auto-respond to screenshot requests")
			.setDesc("If enabled, the plugin will automatically capture the screen and send it back when Kimi outputs // kimi-action: screenshot.")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.autoScreenshotOnLayoutRequest)
					.onChange(async (value) => {
						this.plugin.settings.autoScreenshotOnLayoutRequest = value;
						await this.plugin.saveSettings();
					})
			);
	}
}
