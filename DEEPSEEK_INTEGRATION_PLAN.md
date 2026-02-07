# DeepSeek 集成计划与文档摘录

## 1. 核心文档摘要

基于 DeepSeek 官方文档（API Docs），以下是接入开发所需的关键信息摘录。

### 1.1 API 基础配置
DeepSeek API 完全兼容 OpenAI API 格式，可直接使用 OpenAI SDK。

*   **Base URL**: `https://api.deepseek.com` (兼容写法: `https://api.deepseek.com/v1`)
    *   *注意*: URL 中的 `v1` 与模型版本无关。
*   **API Key**: 在 [DeepSeek 开放平台](https://platform.deepseek.com/api_keys) 申请。
*   **上下文窗口 (Context Window)**: 128K (所有模型默认)。

### 1.2 模型列表 (Model List)
当前最新版本为 DeepSeek-V3.2。

| 模型名称 (`model`) | 对应版本 | 说明 | 适用场景 |
| :--- | :--- | :--- | :--- |
| **`deepseek-chat`** | DeepSeek-V3.2 | **非思考模式** (Non-thinking mode) | 通用对话、代码生成、工具调用、文档分析 |
| **`deepseek-reasoner`** | DeepSeek-V3.2 | **思考模式** (Thinking mode) | 复杂逻辑推理、数学问题、深度思考任务 (R1 能力) |

> **注意**: `deepseek-reasoner` 对应 R1 系列的推理能力，但在 API 中已统一升级为 V3.2 内核的思考模式。

### 1.3 关键特性支持
*   **工具调用 (Function Calling)**: 支持 (Beta 阶段)，兼容 OpenAI 格式。
*   **Anthropic API 兼容**: 支持 Anthropic API 格式调用，方便生态迁移。
*   **JSON Output**: 支持。
*   **FIM (Fill-In-the-Middle)**: 支持代码补全。
*   **LangChain 支持**: 原生支持（通过 `ChatOpenAI` 类）。
*   **联网搜索**: API **暂不支持**联网搜索功能（仅网页端/App 支持）。

### 1.4 调用示例 (Python)

```python
from openai import OpenAI

client = OpenAI(
    api_key="<DEEPSEEK_API_KEY>",
    base_url="https://api.deepseek.com"
)

response = client.chat.completions.create(
    model="deepseek-chat",
    messages=[
        {"role": "system", "content": "You are a helpful assistant"},
        {"role": "user", "content": "Hello"},
    ],
    stream=False
)

print(response.choices[0].message.content)
```

---

## 2. 当前项目集成计划

基于上述文档，本项目 (`ainote`) 的 DeepSeek 集成路线图如下：

### 阶段一：基础接入 (已完成 ✅)
- [x] **配置环境**: 添加 `DEEPSEEK_API_KEY` 和 `DEEPSEEK_BASE_URL` 到 `.env` 和 `config.py`。
- [x] **客户端封装**: 在 `LLMService` 中集成 `AsyncOpenAI` 客户端，指向 DeepSeek Base URL。
- [x] **模型路由**: 实现根据 `model` 参数 (`deepseek-chat`) 自动切换客户端。
- [x] **前端对接**: 更新 API Schema，允许前端传递 `model` 参数。

### 阶段二：高级特性适配 (进行中 🚧)
- [ ] **思考模式支持**:
    - 在前端添加切换 "深度思考" (Deep Think) 的开关。
    - 后端适配 `deepseek-reasoner` 模型参数。
    - *注*: 思考模式可能返回更长的思维链 (CoT)，需确保前端 UI 能正确展示或折叠思维过程（如果 API 返回的话）。
- [ ] **长文档优化**:
    - 利用 128K Context，优化 `document_parser`，允许一次性发送更多 Chunk 给 DeepSeek 进行全文摘要或问答，减少切片造成的语义断裂。
- [ ] **工具调用测试**:
    - 验证 `update_block`, `insert_block` 等现有工具在 `deepseek-chat` 下的稳定性。

### 阶段三：生态扩展 (计划中 📅)
- [ ] **Anthropic 格式兼容**: 如果未来引入 Claude 特定功能，可利用 DeepSeek 的 Anthropic 兼容接口作为备选/降级方案。

## 3. 常见问题 (FAQ)
*   **Q: 为什么 API 报错 `402 Payment Required`?**
    *   A: 账户余额不足，需充值。
*   **Q: `deepseek-reasoner` 支持工具调用吗?**
    *   A: 根据最新文档，V3.2-Speciale (非正式部署) 的思考模式不支持工具调用。正式版 `deepseek-reasoner` 建议主要用于纯文本推理任务，混合任务建议使用 `deepseek-chat`。
*   **Q: API 支持搜索吗？**
    *   A: 不支持。如有搜索需求，需自行实现搜索工具 (Tool) 供模型调用。
