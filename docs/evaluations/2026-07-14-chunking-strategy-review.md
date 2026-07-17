# 分块策略评审

**日期:** 2026-07-14
**范围:** `packages/exam-highlight-core/src/exam_highlight_core/domains/document/parsing/`
**触发:** E2E 全链路验证 (`doc_id=integration-test-e2e`, 35 页 PDF, 297 chunks)

## 现状

三层分块架构：

| 层 | 文件 | 策略 | 输入 → 输出 |
|----|------|------|-------------|
| 解析 | `pipeline.py:101-126` | OCR block 1:1 映射 | `ParsedBlock` → `chunk` |
| 归一化 | `textbook.py:25-156` | heading_path 传递、跨页合并、噪声过滤 | `list[ParsedDocument]` → `ParsedDocument` |
| 知识切分 | `task_view_builder.py:71-85` | 字符计数 + `\n` 偏好 | `CitationChunk` → `list[ModelSlice]` |

### 解析层细节

PP-DocLayoutV3 产出 29 种 layout label，通过 `layout.py:43-69` 映射到 8 种块类型（`heading`、`paragraph`、`toc_content`、`table`、`image` 等）。每个 OCR block 直接 1:1 写入 `document_chunks` 表，不做文本切割。

### 归一化层细节

- `heading_path` 跨页传递：每个段落块继承最近的标题路径（`textbook.py:52-56`）
- 跨页断句检测：连续两页的段落检测末尾标点，未终结时合并（`textbook.py:244-251`）
- 噪声过滤：页眉、页脚、页码、装饰元素自动丢弃（`textbook.py:25`）
- TOC 解析：目录页 block 提取章节条目，`TocStructureResolver` 与正文对齐后写入 `metadata.chapter_tree`

### 知识切分层细节

`TaskViewBuilder` 是唯一的文本切分逻辑：纯字符计数切割，优先在 `\n` 处切分（`task_view_builder.py:79-83`）。`chars_per_token` 默认 4。

## 发现

### 1. chunk 大小不可控（严重度：中）

block 即 chunk。E2E 实测中，短标题（如 "1. 程序结构时代"，<20 tokens）和整页长段落（如架构发展历程段落，>1000 tokens）都是 1 个 chunk。大小差异可达 50x。

**影响:** 下游 model 输入不均匀，KpExtract 对短 chunk 缺少上下文，对长 chunk 可能超出 context 窗口。

### 2. chars_per_token 中文偏差（严重度：中）

`task_view_builder.py:18` 默认 `chars_per_token=4`（英文估算：4 字符 ≈ 1 token）。中文实际约 1.5~2 字符/token，导致 `max_tokens` 限制对中文文本偏差 2~3 倍。

**影响:** `max_tokens=512` 限制下，中文 chunk 实际 token 数可达 1000+，且切分目标位置不准。

### 3. 语义连续性缺失（严重度：中）

同一 `heading_path` 下连续段落（如 "1.1.1 软件架构的发展历史" 下 3 个连续自然段）被 OCR 版面切分为多个独立 block/chunk，KP 提取时各自独立处理，缺少章节级上下文。

**影响:** KpExtract 提取的知识点可能碎片化，缺少章节主题关联。

### 4. 与下游 GraphRAG 分裂（严重度：低）

E2E 日志显示下游 GraphRAG 使用 `SentenceTokenCapChunking(max_tokens=512, overlap=2)` 独立重切为 32 chunks。两次分块策略不协同，GraphRAG 层不使用本项目的 heading_path 等元数据。

**影响:** 知识图谱实体溯源链断裂，无法从 graph node 反向定位到原始 chunk/页码。

### 5. 粒度不可配（严重度：低）

KP 提取、关系抽取、向量嵌入检索共用同一套 chunk 策略（解析层 block 1:1 + 知识层字符切分）。无法按下游任务特点配置不同 chunk 策略。

**影响:** 嵌入检索对细粒度 chunk 需求无法满足，关系抽取对粗粒度上下文需求也无法满足。

## 优化建议（优先级排序）

| 优先级 | 方向 | 成本 | 风险 | 说明 |
|--------|------|------|------|------|
| P0 | `chars_per_token: 4 → 1.8` | 10 min | 零 | 修正 `task_view_builder.py` 默认值，匹配中文 token 密度 |
| P1 | heading 下段落归并 + 可配 `max_chars` | 1-2 h | 需测试回归 | 同一 heading 下连续 paragraph 合并为一个 section chunk，标题块作为边界；超出 `max_chars` 时在 `\n` 或 `。` 处切分；跨页段落不合并保留页码精度 |
| P2 | 多粒度分块（KP/关系/嵌入各不同） | 1-2 d | 需数据验证 | 不同下游任务用不同 chunk 策略，每级保留 `parent_chunk_id` 溯源链 |
| P3 | GraphRAG chunk 元数据注入 | 待评估 | 需修改 SDK | 将 heading_path、page_number 注入 GraphRAG `create_graph` 的 chunk metadata |

### P1 详细方案

```
归一化层新增 SectionChunker:
  遍历 normalized_blocks:
    heading block → flush 当前 section, 开始新 section
    paragraph block → 加入当前 section buffer
    超出 max_chars → 在 \n 或 。处切分, 创建子 chunk

  输出 chunk 属性:
    chunk_id: "{doc_id}:{source_version}:sec-{section_index}"
    text: 归并后的段落文本
    heading_path: section 标题
    page_number: 起始页
    parent_chunk_ids: 子 block 的原始 chunk_id 列表
```
