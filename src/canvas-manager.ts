import { TFile, Vault } from "obsidian";
import * as dagre from "dagre";

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

export interface SemanticUpdate {
	nodes?: CanvasNode[];
	edges?: CanvasEdge[];
	layout?: "tree" | "force" | "grid" | "circle" | null;
	direction?: "lr" | "tb";
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

	// Entry point for semantic layout
	applySemanticLayout(data: CanvasData, mode: string, direction: "lr" | "tb" = "lr"): CanvasData {
		switch (mode) {
			case "tree":
				return this.layoutTree(data, direction);
			case "grid":
				return this.layoutGrid(data, direction);
			case "circle":
				return this.layoutCircle(data);
			case "force":
				return this.layoutForce(data, direction);
			default:
				return this.autoLayout(data, { direction });
		}
	}

	// Dagre-based hierarchical tree layout
	layoutTree(data: CanvasData, direction: "lr" | "tb"): CanvasData {
		const { nodes, edges } = this.ensureCanvasData(data);
		if (nodes.length === 0) return data;

		const g = new dagre.graphlib.Graph();
		g.setGraph({
			rankdir: direction,
			ranksep: 200,
			nodesep: 80,
			edgesep: 40,
			marginx: 20,
			marginy: 20,
		});
		g.setDefaultEdgeLabel(() => ({}));

		for (const n of nodes) {
			g.setNode(n.id, { width: n.width, height: n.height });
		}
		for (const e of edges) {
			if (g.hasNode(e.fromNode) && g.hasNode(e.toNode)) {
				g.setEdge(e.fromNode, e.toNode);
			}
		}

		dagre.layout(g);

		const newNodes = nodes.map((n) => {
			const pos = g.node(n.id);
			return { ...n, x: pos.x - pos.width / 2, y: pos.y - pos.height / 2 };
		});

		return { nodes: newNodes, edges };
	}

	// Grid layout
	layoutGrid(data: CanvasData, direction: "lr" | "tb"): CanvasData {
		const { nodes, edges } = this.ensureCanvasData(data);
		if (nodes.length === 0) return data;

		const cols = Math.ceil(Math.sqrt(nodes.length));
		const gapX = 320;
		const gapY = 200;

		const newNodes = nodes.map((n, i) => {
			const col = i % cols;
			const row = Math.floor(i / cols);
			if (direction === "lr") {
				return { ...n, x: col * gapX + 40, y: row * gapY + 40 };
			} else {
				return { ...n, x: row * gapX + 40, y: col * gapY + 40 };
			}
		});

		return { nodes: newNodes, edges };
	}

	// Circular layout
	layoutCircle(data: CanvasData): CanvasData {
		const { nodes, edges } = this.ensureCanvasData(data);
		if (nodes.length === 0) return data;

		const radius = Math.max(300, nodes.length * 60);
		const centerX = radius + 200;
		const centerY = radius + 200;

		const newNodes = nodes.map((n, i) => {
			const angle = (2 * Math.PI * i) / Math.max(1, nodes.length);
			return {
				...n,
				x: centerX + radius * Math.cos(angle) - n.width / 2,
				y: centerY + radius * Math.sin(angle) - n.height / 2,
			};
		});

		return { nodes: newNodes, edges };
	}

	// Simple force-directed-ish layout (sugiyama fallback for complex graphs)
	layoutForce(data: CanvasData, direction: "lr" | "tb"): CanvasData {
		// For MVP, force layout falls back to dagre with tighter spacing
		return this.layoutTree(data, direction);
	}

	// Legacy simple hierarchical layout (kept for compatibility)
	autoLayout(data: CanvasData, options?: { direction?: "lr" | "tb"; rootId?: string }): CanvasData {
		const { nodes, edges } = this.ensureCanvasData(data);
		if (nodes.length === 0) return data;

		const direction = options?.direction ?? "lr";

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
			roots.push(nodes[0].id);
		}
		for (const r of roots) dfs(r, 0);

		const levelGroups = new Map<number, string[]>();
		for (const [id, lvl] of levels) {
			if (!levelGroups.has(lvl)) levelGroups.set(lvl, []);
			levelGroups.get(lvl)!.push(id);
		}

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
	parseCanvasOpBlock(text: string): { nodes?: CanvasNode[]; edges?: CanvasEdge[]; layout?: string; direction?: "lr" | "tb" } | null {
		const marker = "// kimi-canvas-op";
		const idx = text.indexOf(marker);
		if (idx < 0) return null;
		const after = text.slice(idx + marker.length);
		const match = after.match(/```json\s*([\s\S]*?)```/);
		if (!match) return null;
		try {
			return JSON.parse(match[1].trim());
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
