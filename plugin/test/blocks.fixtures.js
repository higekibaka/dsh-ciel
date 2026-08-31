// Shared fixtures for the block splitter: every sample is a draft shape the
// critic pipeline actually sees. Both copies of splitMarkdownBlocks (host
// index.js, client client.js) must produce IDENTICAL id/type sequences and
// byte-identical block texts on every one of these.

export const BLOCK_FIXTURES = [
  {
    name: 'single paragraph',
    text: '一段普通的回复。',
    expect: [['paragraph', '一段普通的回复。']],
  },
  {
    name: 'paragraphs separated by blank lines',
    text: '第一段。\n\n第二段。\n\n\n第三段。',
    expect: [['paragraph', '第一段。'], ['paragraph', '第二段。'], ['paragraph', '第三段。']],
  },
  {
    name: 'heading then paragraph',
    text: '## 实现方案\n正文内容。',
    expect: [['heading', '## 实现方案'], ['paragraph', '正文内容。']],
  },
  {
    name: 'fenced code with inner short fence in text',
    text: '前文。\n```js\nconst a = 1\n```\n后文。',
    expect: [['paragraph', '前文。'], ['code', '```js\nconst a = 1\n```'], ['paragraph', '后文。']],
  },
  {
    name: 'long fence swallows short fence',
    text: '````markdown\n示例：\n```js\ncode\n```\n````',
    expect: [['code', '````markdown\n示例：\n```js\ncode\n```\n````']],
  },
  {
    name: 'tilde fence',
    text: '~~~\nraw\n~~~',
    expect: [['code', '~~~\nraw\n~~~']],
  },
  {
    name: 'unclosed fence runs to end',
    text: '前文。\n```\n没有闭合',
    expect: [['paragraph', '前文。'], ['code', '```\n没有闭合']],
  },
  {
    name: 'simple list',
    text: '- 甲\n- 乙\n- 丙',
    expect: [['list', '- 甲\n- 乙\n- 丙']],
  },
  {
    name: 'loose list keeps one block across blank lines',
    text: '- 甲\n\n- 乙\n\n- 丙',
    expect: [['list', '- 甲\n\n- 乙\n\n- 丙']],
  },
  {
    name: 'list with indented continuation',
    text: '- 甲\n  续行内容\n- 乙',
    expect: [['list', '- 甲\n  续行内容\n- 乙']],
  },
  {
    name: 'ordered list from 3',
    text: '3. 第三步\n4. 第四步',
    expect: [['list', '3. 第三步\n4. 第四步']],
  },
  {
    name: 'table',
    text: '| 字段 | 默认 |\n|---|---|\n| a | 1 |',
    expect: [['table', '| 字段 | 默认 |\n|---|---|\n| a | 1 |']],
  },
  {
    name: 'blockquote with lazy continuation',
    text: '> 引用第一行\n懒惰续行\n> 引用第三行',
    expect: [['quote', '> 引用第一行\n懒惰续行\n> 引用第三行']],
  },
  {
    name: 'thematic break between paragraphs',
    text: '上文。\n---\n下文。',
    expect: [['paragraph', '上文。'], ['hr', '---'], ['paragraph', '下文。']],
  },
  {
    name: 'paragraph with hard line breaks stays one block',
    text: '第一行\n第二行\n第三行',
    expect: [['paragraph', '第一行\n第二行\n第三行']],
  },
  {
    name: 'the full mix',
    text: '## 标题\n引入段。\n```ts\nlet x = 1\n```\n- 一\n- 二\n\n| a | b |\n|---|---|\n> 引用\n\n结尾段。',
    expect: [
      ['heading', '## 标题'],
      ['paragraph', '引入段。'],
      ['code', '```ts\nlet x = 1\n```'],
      ['list', '- 一\n- 二'],
      ['table', '| a | b |\n|---|---|'],
      ['quote', '> 引用'],
      ['paragraph', '结尾段。'],
    ],
  },
]
