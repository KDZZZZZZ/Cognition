# TB_WRITE_NOTES Method

1. 写小节头：目标/输出/为什么现在做
2. 先读取当前 note 的最新 effective text；如果已有 pending diff 或 block 边界不稳定，直接构造完整新文本并调用 `update_file`，不要猜 block index
3. 逐条写 D：formal + 几何意义（文字）+ 动机 + 易错点（如有）
4. 逐条写 T：statement + 用途预告
5. 证明/推导按 Step 1/2/3 写，并在每步写“旧知识 + 动机 + 条件”
6. 写 Bridge：指出教材从 A 到 B 的跳跃，补上缺失的 1–3 句关键理由 + 适用前提
7. 写“有什么用/相近知识”：只写最相关 2–4 个工具，重点是选择逻辑
