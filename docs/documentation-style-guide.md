# 中文技术文档写作准则

本仓库采用阮一峰的《中文技术文档的写作规范》。
权威来源为 [document-style-guide](https://github.com/ruanyf/document-style-guide)。
维护者应同时遵循以下要求。

## 标题和结构

- 标题按层级展开，最多使用四级。
- 下级标题应有并列内容，并避免重复上级名称。
- 文档分别说明用途、环境、操作和结果。
- 当前要求、执行报告和历史证据分别维护。
- 文件名使用半角小写字母和连字符。
- `README`、`LICENSE` 等惯用名称保留。

## 文本和段落

- 使用正式、常见的现代汉语。
- 优先使用短句、主动语态和肯定表达。
- 指代应明确，避免双重否定。
- 单个分句尽量控制在 20 个字以内。
- 超过 40 个字的分句必须改写。
- 一个段落只表达一个主题，中心句放在段首。
- 段落之间留空行，避免连续长段落。
- 首次使用外文术语时，解释术语含义。
- 引用第三方文字和图片时，注明来源。

## 数值和标点

- 中英文之间留一个半角空格。
- 中文与数字之间统一留一个半角空格。
- 数值与英文单位之间留一个半角空格。
- 阿拉伯数字使用半角形式。
- 超过四位的普通数值使用千分号。
- 范围使用“至”“～”或“—”。
- 中文句子使用全角标点，完整句子以句号结束。
- 标题末尾省略句号、逗号、分号和冒号。
- 时间、代码和英文原文保留各自的标点。

## 审查范围

`npm run check:docs` 会检查基础排版和文档链接。
维护者还需检查语义、句式、术语和章节组织。
静态检查通过只证明机器可以检查的规则。

代码、命令、网址和精确标识符保持原值。
历史证据和用户原文保持原值。
产品界面文案继续遵循已确认的体验要求。

## 规范来源

- [标题](https://github.com/ruanyf/document-style-guide/blob/master/docs/title.md)
- [文本](https://github.com/ruanyf/document-style-guide/blob/master/docs/text.md)
- [段落](https://github.com/ruanyf/document-style-guide/blob/master/docs/paragraph.md)
- [数值](https://github.com/ruanyf/document-style-guide/blob/master/docs/number.md)
- [标点符号](https://github.com/ruanyf/document-style-guide/blob/master/docs/marks.md)
- [文档体系](https://github.com/ruanyf/document-style-guide/blob/master/docs/structure.md)
