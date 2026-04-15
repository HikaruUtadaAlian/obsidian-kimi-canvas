import { TFile, Vault } from "obsidian";

// JSON Canvas Spec 1.0 types
export type CanvasNodeType = "text" | "file" | "link" | "group";

export interface CanvasNode {
	id: string;
	type: CanvasNodeType;
	x: number;
	y: number;
	width: number;
	height: number;
	color?: string;
	text?: string;
	file?: string;
	subpath?: string;
	url?: string;
	label?: string;
	background?: string;
	backgroundStyle?: "cover" | "ratio" | "repeat";
}

export interface CanvasEdge {
	id: string;
	fromNode: string;
	fromSide?: "top" | "right" | "bottom" | "left";
	fromEnd?: "none" | "arrow";
	toNode: string;
	toSide?: "top" | "right" | "bottom" | "left";
	toEnd?: "none" | "arrow";
	color?: string;
	label?: string;
}

export interface CanvasData {
	nodes?: CanvasNode[];
	edges?: CanvasEdge[];
}

const DEFAULT_NODE_WIDTH = 260;
const DEFAULT_NODE_HEIGHT = 140;
const LEVEL_GAP_X = 320;
const LEVEL_GAP_Y = 200;

export class CanvasManager {
	vault: Vault;

	constructor(vault: Vault) {
		this.vault = vault;
	}

	async readCanvas(file: TFile): Promise<CanvasData> {
		const content = await this.vault.read(file);
		try {
			return JSON.parse(content) as CanvasData;
		} catch (e) {
			return { nodes: [], edges: [] };
		}
	}

	async writeCanvas(file: TFile, data: CanvasData): Promise<void> {
		const content = JSON.stringify(data, null, "\t");
		await this.vault.modify(file, content);
	}

	ensureCanvasData(data: CanvasData): Required<CanvasData> {
		return {
			nodes: data.nodes ?? [],
			edges: data.edges ?? [],
		};
	}

	// Apply a partial update (from AI) onto existing canvas
	applyCanvasUpdate(base: CanvasData, update: Partial<CanvasData>): CanvasData {
		const result: CanvasData = {
			nodes: [...(base.nodes ?? [])],
			edges: [...(base.edges ?? [])],
		};

		if (update.nodes) {
			for (const n of update.nodes) {
				const idx = result.nodes!.findIndex((x) => x.id === n.id);
				if (idx >= 0) {
					result.nodes![idx] = { ...result.nodes![idx], ...n };
				} else {
					// New node: ensure defaults
					result.nodes!.push({
						...n,
						width: n.width ?? DEFAULT_NODE_WIDTH,
						height: n.height ?? DEFAULT_NODE_HEIGHT,
					});
				}
			}
		}

		if (update.edges) {
			for (const e of update.edges) {
				const idx = result.edges!.findIndex((x) => x.id === e.id);
				if (idx >= 0) {
					result.edges![idx] = { ...result.edges![idx], ...e };
				} else {
					result.edges!.push(e);
				}
			}
		}

		return result;
	}

	// Simple hierarchical tree layout (left-to-right)
	autoLayout(data: CanvasData, options?: { direction?: "lr" | "tb"; rootId?: string }): CanvasData {
		const { nodes, edges } = this.ensureCanvasData(data);
		if (nodes.length === 0) return data;

		const direction = options?.direction ?? "lr";

		// Build adjacency
		const outgoing = new Map<string, string[]>();
		const incoming = new Map<string, string[]>();
		for (const n of nodes) {
			outgoing.set(n.id, []);
			incoming.set(n.id, []);
		}
		for (const e of edges) {
			if (outgoing.has(e.fromNode) && incoming.has(e.toNode)) {
				outgoing.get(e.fromNode)!.push(e.toNode);
				incoming.get(e.toNode)!.push(e.fromNode);
			}
		}

		// Compute levels (longest path from any root)
		const levels = new Map<string, number>();
		const visited = new Set<string>();

		const dfs = (id: string, depth: number) => {
			const prev = levels.get(id) ?? 0;
			levels.set(id, Math.max(prev, depth));
			if (visited.has(id)) return;
			visited.add(id);
			for (const child of outgoing.get(id) ?? []) {
				dfs(child, depth + 1);
			}
		};

		const roots = nodes.filter((n) => (incoming.get(n.id) ?? []).length === 0).map((n) => n.id);
		if (roots.length === 0 && nodes.length > 0) {
			// Cycle fallback: pick first node
			roots.push(nodes[0].id);
		}
		for (const r of roots) dfs(r, 0);

		// Group by level
		const levelGroups = new Map<number, string[]>();
		for (const [id, lvl] of levels) {
			if (!levelGroups.has(lvl)) levelGroups.set(lvl, []);
			levelGroups.get(lvl)!.push(id);
		}

		// Assign positions
		const newNodes = nodes.map((n) => ({ ...n }));
		for (const node of newNodes) {
			const lvl = levels.get(node.id) ?? 0;
			const group = levelGroups.get(lvl)!;
			const idx = group.indexOf(node.id);

			if (direction === "lr") {
				node.x = lvl * LEVEL_GAP_X + 40;
				node.y = idx * LEVEL_GAP_Y + 40;
			} else {
				node.x = idx * LEVEL_GAP_X + 40;
				node.y = lvl * LEVEL_GAP_Y + 40;
			}
		}

		return { nodes: newNodes, edges };
	}

	// Extract canvas operation block from AI response
	parseCanvasOpBlock(text: string): Partial<CanvasData> | null {
		const marker = "// kimi-canvas-op";
		const idx = text.indexOf(marker);
		if (idx < 0) return null;
		const after = text.slice(idx + marker.length);
		const match = after.match(/```json\s*([\s\S]*?)```/);
		if (!match) return null;
		try {
			return JSON.parse(match[1].trim()) as Partial<CanvasData>;
		} catch (e) {
			return null;
		}
	}

	// Clean the visible text by removing the operation block
	stripCanvasOpBlock(text: string): string {
		const marker = "// kimi-canvas-op";
		const idx = text.indexOf(marker);
		if (idx < 0) return text;
		return text.slice(0, idx).trim();
	}

	generateId(): string {
		return Math.random().toString(36).substring(2, 10);
	}
}
