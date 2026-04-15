# Kimi Canvas

一个为 Obsidian 打造的 **Kimi Code CLI** 集成插件，专注于 **Canvas 画板的 AI 操作与自动布局**。

> 目前市场上并没有原生支持 Kimi Code CLI 的 Obsidian 插件。Claudian、YOLO 等插件主要面向 Claude Code。本插件填补了这一空白，让 Kimi 成为你的 Obsidian 白板协作者。

---

## 核心能力

1. **侧边栏 Chat**：在 Obsidian 内直接与 Kimi 对话（类似 Claudian）。
2. **真流式 ACP 对话**：通过 `kimi acp` 启动 Agent Client Protocol 服务器，支持逐字流式输出（think + message chunk）。
3. **Canvas 感知**：自动将当前打开的 `.canvas` 文件内容注入上下文，Kimi 能“看懂”你的画板。
4. **自动层次布局**：每次 AI 修改后，插件会自动运行树形布局算法（从左到右或从上到下），让节点按逻辑关系整齐排布，避免重叠。
5. **手动布局命令**：你也可以对任意 canvas 使用命令面板里的 "Auto-layout current canvas" 快速整理。

---

## 安装方法

### 前置要求
- Obsidian **桌面版**（macOS / Windows / Linux）
- 已安装 Kimi Code CLI，且 `kimi` 命令在系统 PATH 中

### 手动安装

1. **复制插件到 Vault**
   将本文件夹 `obsidian-kimi-canvas` 整体复制到你的 Obsidian 库的插件目录下：
   ```
   <你的库路径>/.obsidian/plugins/obsidian-kimi-canvas/
   ```
   如果 `.obsidian/plugins` 不存在，请手动创建。

2. **构建产物已包含**
   `main.js`、`manifest.json`、`styles.css` 都已生成好，直接复制即可。

3. **启用插件**
   - 打开 Obsidian → 设置 → 第三方插件
   - 刷新插件列表
   - 找到 **Kimi Canvas** 并启用

---

## 使用指南

### 1. 打开聊天面板
- 点击左侧边栏的 🤖 机器人图标，或使用命令面板执行 `Open Kimi Canvas chat`。

### 2. 与 Kimi 对话（流式）
- 在输入框中输入需求，按 `Enter` 发送（`Shift+Enter` 换行）。
- 顶部状态栏会显示连接状态：**Connecting → Ready → Thinking...**
- Kimi 的思考过程会以淡灰色小字实时显示，最终答案逐字流入气泡。
- **如果当前有 `.canvas` 文件打开**，Kimi 会自动看到画板的完整 JSON 结构。

### 3. 让 Kimi 修改 Canvas
你可以这样prompt：

> "请帮我在这个 canvas 里添加一个关于 'AI Agent Protocol' 的节点，并把它和已有的 'MCP' 节点连起来。"

Kimi 会在回复末尾生成一个操作块，插件解析后会：
- 将新节点/连线合并进 canvas
- **自动运行层次布局**，让所有节点按逻辑层级排布
- 保存文件

### 4. 手动整理布局
- 打开任意 `.canvas` 文件
- 使用命令面板（`Cmd/Ctrl + P`）→ 搜索 `Auto-layout current canvas`
- 画板会立即按树形结构重新排布

---

## Kimi-Canvas 操作协议

为了让 Kimi 能安全、结构化地修改画板，本插件在 System Prompt 中教会了 Kimi 一种标准回复格式：

```markdown
// kimi-canvas-op
```json
{
  "nodes": [
    {
      "id": "a1b2c3d4",
      "type": "text",
      "x": 0,
      "y": 0,
      "width": 260,
      "height": 140,
      "text": "这是新节点"
    }
  ],
  "edges": [
    {
      "id": "e1",
      "fromNode": "已有节点ID",
      "toNode": "a1b2c3d4",
      "fromSide": "right",
      "toSide": "left",
      "toEnd": "arrow"
    }
  ]
}
```
```

**注意**：
- 你**不需要**手动写这个 JSON，Kimi 会在理解你的自然语言指令后自动生成。
- `x`/`y` 坐标可以随便填（比如填 0），因为插件会随后运行自动布局算法覆盖它们。
- 如果 Kimi 没有输出操作块，则只会进行纯文本回复，不会修改画板。

---

## 设置项

进入 `设置 → 第三方插件 → Kimi Canvas`：

| 设置项 | 说明 |
|--------|------|
| **Kimi CLI path** | `kimi` 可执行文件路径，默认 `kimi`（要求已在 PATH） |
| **Auto-layout on AI update** | Kimi 修改 canvas 后是否自动重新布局（建议开启） |
| **Default layout direction** | 自动布局方向：`Left to Right`（从左到右）或 `Top to Bottom`（从上到下） |

---

## 技术架构

- **Kimi Bridge (ACP)**：通过 `kimi acp` 建立 JSON-RPC over stdio 连接，维护真实 ACP Session，支持流式 chunk 接收。
- **Canvas Manager**：基于 JSON Canvas 1.0 规范读写 `.canvas`，实现节点增删、合并更新、层次布局。
- **Chat View**：标准的 Obsidian ItemView，提供类 Claudian 的聊天侧边栏体验。

---

## 后续可扩展方向

- 接入 `kimi acp` 实现真正的流式对话和实时工具调用。
- 增加 Force-directed（力导向）布局选项。
- 支持通过 MCP Server 暴露 Canvas 工具，让 Kimi ACP 模式直接调用。
- 添加 `@mention` 文件引用、Diff 预览等高级功能。

---

**License**: MIT
