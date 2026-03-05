# TB_WRITE_NOTES

## 目的

把抽取结果写成可直接追加到单 md 的正文，严格使用“章节小节模板”。

## 输入

- TB_PARSE_SCOPE 的骨架
- TB_EXTRACT_CORE 的 D/T/K/Q + Bridge 线索
- 教材原文（用于补齐 formal 细节）

## 输出

- 一段或多段完整 md：包含“本节要干什么 + D/T/K + Bridge + 应用 + 相近知识”

## Rules

- 强制使用你的模板结构。
- 关键内容与推导放在一起写：每个 D/T 紧跟解释/推导/动机。
- 每个 T：推导必须包含“旧知识引用 + 动机 + 条件检查”。
- Bridge 必写：若教材跳步，必须补桥；若无法补（缺材料），必须列出缺失点。
- 如果当前目标 note 已经有 pending diff，或者你不确定 markdown block 的准确序号，优先使用 `update_file` 基于最新 effective text 整体改写；不要猜 `insert_block` / `update_block` 的 block index。
- 如果笔记正文出现图表/figure/chart/表格证据描述，且来源文档可读，优先补充对应图表到 note（`inspect_document_visual` + `add_file_charts_to_note`），并附简短解释。
