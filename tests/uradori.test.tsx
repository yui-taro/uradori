import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import {
  alternativeSourcePrompt,
  archiveDate,
  cellWidth,
  citedQuote,
  claimAnchor,
  fitCells,
  placeMarks,
  findQuote,
  fragmentQuote,
  groundVerdict,
  isPrivateHost,
  urlHoldReason,
  isPdfUrl,
  pdfPage,
  isBlockedResponse,
  claimPriority,
  evidenceRequest,
  findNamedSources,
  findSourceRefs,
  htmlToText,
  inlinePairs,
  isActionReport,
  isSecretPath,
  contextAround,
  pageTitle,
  textFragmentUrl,
  parseJudgement,
  selectExcerpt,
  toLines,
} from '../hooks/logic'

// ───────────────────────────── 純粋なロジック

describe('出典と主張の取り出し', () => {
  test('ファイル参照と URL を拾い、行番号も読む', async () => {
    const refs = findSourceRefs(
      'タイムアウトは30秒です（根拠：`src/config.ts:2`）。詳しくは https://example.com/docs/limits) を参照。Node.js 22 で動きます。',
    )
    expect(refs.map(r => r.source)).toEqual([
      { kind: 'file', ref: 'src/config.ts', line: 2 },
      { kind: 'url', ref: 'https://example.com/docs/limits' },
      { kind: 'file', ref: 'Node.js' }, // 実在しないので本体側で落とされる
    ])
  })

  test('場所つきの出典は、URL（#page や #:~:text= まで）と場所の説明を分けて拾う', async () => {
    const refs = findSourceRefs(
      '定義です（出典: https://example.go.jp/std.pdf#page=6 の6ページ 第2条）。上限は50件（出典: https://example.com/limits#:~:text=上限は50件 の「料金」節）。',
    )
    expect(refs.map(r => r.source)).toEqual([
      { kind: 'url', ref: 'https://example.go.jp/std.pdf#page=6' },
      { kind: 'url', ref: 'https://example.com/limits#:~:text=上限は50件' },
    ])
  })

  test('ドットファイルや深いパスも拾う', async () => {
    const refs = findSourceRefs('設定は `.github/workflows/ci.yml#L12` と `.env` にあります。')
    expect(refs.map(r => r.source)).toEqual([
      { kind: 'file', ref: '.github/workflows/ci.yml', line: 12 },
      { kind: 'file', ref: '.env' },
    ])
  })

  test('バージョン番号やドメイン名はファイルにしない', async () => {
    const refs = findSourceRefs('v2.1.309 を example.com で配布しています。')
    expect(refs).toEqual([])
  })

  test('出典の書かれた文から主張だけを取り出す', async () => {
    const answer = 'タイムアウトは30秒です（根拠：`src/config.ts`）。'
    const { pairs, needsPairing } = inlinePairs(answer, findSourceRefs(answer))
    expect(pairs).toEqual([{ claim: 'タイムアウトは30秒です', source: { kind: 'file', ref: 'src/config.ts' } }])
    expect(needsPairing).toEqual([])
  })

  test('「根拠は〜です」だけの文なら、直前の文を主張にする', async () => {
    const answer = 'リトライは最大3回です。根拠は `src/config.ts` の3行目です。'
    const { pairs } = inlinePairs(answer, findSourceRefs(answer))
    expect(pairs[0]?.claim).toBe('リトライは最大3回です')
  })

  test('根拠の形でないファイルの言及は、モデルに対応づけを頼む側に回す', async () => {
    const answer = 'タイムアウトは30秒、リトライは3回です。設定は `src/config.ts` で行われています。'
    const { pairs, needsPairing } = inlinePairs(answer, findSourceRefs(answer))
    expect(pairs).toEqual([])
    expect(needsPairing).toEqual([{ kind: 'file', ref: 'src/config.ts' }])
  })

  test('「〜によると」の形も根拠として読む', async () => {
    const answer = '`docs/spec.md` によると、タイムアウトは30秒です。'
    const { pairs } = inlinePairs(answer, findSourceRefs(answer))
    expect(pairs).toEqual([{ claim: 'タイムアウトは30秒です', source: { kind: 'file', ref: 'docs/spec.md' } }])
  })

  test('末尾の参考リンクは、モデルに対応づけを頼む側に回す', async () => {
    const answer = '上限は100件です。\n\nSources:\n- [Limits](https://example.com/limits)'
    const { pairs, needsPairing } = inlinePairs(answer, findSourceRefs(answer))
    expect(pairs).toEqual([])
    expect(needsPairing).toEqual([{ kind: 'url', ref: 'https://example.com/limits' }])
  })

  test('作業の報告や質問はウラ取りしない（事実の主張だけ）', async () => {
    expect(isActionReport('タイムアウトを60秒に変更しました')).toBe(true)
    expect(isActionReport('テストを追加しておきました')).toBe(true)
    expect(isActionReport('Updated the retry logic')).toBe(true)
    expect(isActionReport('このファイルを開いてもいいですか？')).toBe(true)
    expect(isActionReport('タイムアウトは60秒に設定されています')).toBe(false)
    expect(isActionReport('The default limit is 50 items')).toBe(false)

    const answer = '`src/config.ts` を修正しました。リトライは3回です（`src/config.ts:3`）。'
    const { pairs, needsPairing } = inlinePairs(answer, findSourceRefs(answer))
    expect(pairs.map(p => p.claim)).toEqual(['リトライは3回です'])
    expect(needsPairing).toEqual([])
  })

  test('秘密情報らしいファイルは読まない', async () => {
    expect(isSecretPath('.env')).toBe(true)
    expect(isSecretPath('config/.env.production')).toBe(true)
    expect(isSecretPath('keys/server.pem')).toBe(true)
    expect(isSecretPath('src/config.ts')).toBe(false)
  })
})

describe('原文ポップアップの材料', () => {
  test('テキストフラグメントで、実際のサイトの該当箇所に飛ぶURLを作る', async () => {
    expect(textFragmentUrl('https://example.com/limits', 'Each request returns at most 50 items.')).toBe(
      'https://example.com/limits#:~:text=Each%20request%20returns%20at%20most%2050%20items.',
    )
    // 記号（- , &）もエンコードし、もとの # のあとには :~: をつなぐ
    expect(textFragmentUrl('https://example.com/a#sec-2', 'A-B, C & D')).toBe(
      'https://example.com/a#sec-2:~:text=A%2DB%2C%20C%20%26%20D',
    )
    // 長い文は「最初の24文字,最後の24文字」で範囲を指定する
    const long = 'あ'.repeat(30) + 'い'.repeat(30) + 'う'.repeat(30)
    const href = textFragmentUrl('https://example.com/', long)
    expect(href).toBe(
      `https://example.com/#:~:text=${encodeURIComponent('あ'.repeat(24))},${encodeURIComponent('う'.repeat(24))}`,
    )
    // ファイルなどURLでないものはそのまま
    expect(textFragmentUrl('src/config.ts', 'x')).toBe('src/config.ts')
  })

  test('根拠の行の前後を、原文の該当箇所として切り出す', async () => {
    const lines = toLines(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'].join('\n'), 'file')
    expect(contextAround(lines, [{ line: 5, text: 'e' }]).map(l => l.line)).toEqual([2, 3, 4, 5, 6, 7, 8])
    expect(contextAround(lines, [], 1).map(l => l.line)).toEqual([1, 2, 3, 4])
    expect(contextAround(lines, [])).toEqual([])
  })

  test('ページのタイトルを取り出す', async () => {
    expect(pageTitle('<html><head><title> 自転車の交通ルール &amp; マナー｜警察庁 </title></head></html>')).toBe(
      '自転車の交通ルール & マナー｜警察庁',
    )
  })
})

describe('原文の扱い', () => {
  test('HTML から本文だけを取り出す', async () => {
    const text = htmlToText(
      '<html><head><title>x</title><script>var a=1</script></head><body><nav>menu</nav><h1>Limits</h1><p>Up to <b>50</b> items &amp; more.</p></body></html>',
    )
    expect(text).toBe('Limits\nUp to 50 items & more.')
  })

  test('小さい原文はまるごと判定に渡す', async () => {
    const lines = toLines('a\nb\nc', 'file')
    expect(selectExcerpt(lines, 'なんでも')).toEqual(lines)
  })

  test('大きい原文は、主張の言葉が出る行の前後を選ぶ', async () => {
    const filler = Array.from({ length: 3000 }, (_, i) => `line ${i} lorem ipsum dolor sit amet`)
    filler[2500] = 'MAX_ITEMS = 50'
    const excerpt = selectExcerpt(toLines(filler.join('\n'), 'file'), 'MAX_ITEMS は100件です')
    expect(excerpt.some(l => l.text === 'MAX_ITEMS = 50')).toBe(true)
    expect(excerpt.length).toBeLessThan(3000)
  })

  test('表示する抜粋はモデルの言葉ではなく原文の行から取る', async () => {
    const excerpt = toLines('export const config = {\n  timeout: 60_000,\n}', 'file')
    const judged = parseJudgement(
      '```json\n{"verdict":"mismatch","lines":[2, 99],"reason":"原文は60秒"}\n```',
      excerpt,
    )
    expect(judged).toEqual({
      verdict: 'mismatch',
      evidence: [{ line: 2, text: '  timeout: 60_000,' }],
      reason: '原文は60秒',
    })
  })

  test('読めない返答は「確認できない」にする（✔ にはしない）', async () => {
    expect(parseJudgement('たぶん合っています', []).verdict).toBe('unknown')
    expect(parseJudgement('{"verdict":"yes"}', []).verdict).toBe('unknown')
  })
})

// ───────────────────────────── mod 全体（エンジンの代わりをテストが務める）

const CONFIG = 'export const config = {\n  timeout: 60_000,\n  retries: 3,\n}\n'

const BAND = {
  plugin: 'uradori',
  component: 'AbovePrompt',
  requestId: 'band',
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 10,
    bodyColumns: 100,
    scroll: { offset: 0, bodyRows: 10 },
    view: {},
  },
} as const

const PANE = {
  plugin: 'uradori',
  component: 'Pane',
  requestId: 'uradori',
  props: {
    title: 'ウラ取り',
    isFocused: false,
    bodyColumns: 80,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
} as const

const USAGE = { input_tokens: 10, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }

type World = {
  files?: Record<string, string>
  pages?: Record<string, { status: number; type: string; text: string; location?: string }>
  judge?: (prompt: string) => string
  /** 画面が狭く、人が押していないパネルが置かれない */
  isNarrow?: boolean
  /** 応答しないURL（取得がいつまでも終わらない） */
  hang?: string[]
}

/** エンジンの代わり: ファイル・ネット・モデル・プロンプトをテストが答える */
function world(on: On, w: World) {
  const seen = {
    prompts: [] as string[],
    contexts: [] as (readonly string[])[],
    judged: [] as string[],
    fetched: [] as string[],
    read: [] as string[],
    opened: [] as { id: string; focus?: true }[],
    toasts: [] as string[],
    modelTimeouts: [] as (number | undefined)[],
  }
  const files = w.files ?? {}
  const pages = w.pages ?? {}
  // エンジンは相対パスを作業フォルダからの絶対パスにしてから渡すことがある
  const file = (path: string): string | undefined =>
    Object.entries(files).find(([name]) => path === name || path.endsWith(`/${name}`))?.[1]

  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('command.register', () => ({ value: { command: 'uradori' } }))
  on('turn.complete', (_, e) => ({ text: e.answer }))
  on('session.root', () => ({ value: '/proj' }))
  on('fs.exists', (_, e) => ({ value: file(e.path) !== undefined || e.path === '/proj' }))
  on('fs.stat', (_, e) => {
    if (e.path === '/proj') return { value: { kind: 'dir', size: 0, mtimeMs: 0, isLink: false, realPath: '/proj' } }
    const text = file(e.path)
    if (text === undefined) return { deny: 'missing' }
    const name = Object.keys(files).find(n => e.path === n || e.path.endsWith(`/${n}`)) ?? e.path
    return { value: { kind: 'file', size: text.length, mtimeMs: 0, isLink: false, realPath: `/proj/${name}` } }
  })
  on('fs.read', (_, e) => {
    seen.read.push(e.path)
    const text = file(e.path)
    return text === undefined ? { deny: 'missing' } : { value: text }
  })
  on('http.fetch', (_, e) => {
    seen.fetched.push(e.url)
    if (w.hang?.includes(e.url)) return new Promise<never>(() => {})
    const page = pages[e.url]
    if (page === undefined) return { deny: 'offline' }
    const headers: Record<string, string> = { 'content-type': page.type, ...(page.location ? { location: page.location } : {}) }
    return { value: { status: page.status, ok: page.status >= 200 && page.status < 300, headers, text: page.text } }
  })
  on('model.complete', (_, e) => {
    seen.judged.push(e.prompt)
    seen.modelTimeouts.push(e.timeoutMs)
    return { value: { isAnswered: true, text: (w.judge ?? (() => '{"verdict":"unknown"}'))(e.prompt), usage: USAGE } }
  })
  on('prompt.submit', (_, e) => {
    seen.prompts.push(e.text)
    seen.contexts.push(e.context ?? [])
    return { text: e.text }
  })
  on('ui.toast', (_, e) => {
    seen.toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.log', () => ({ value: undefined }))
  on('ui.open', (_, e) => {
    seen.opened.push({ id: e.id, ...(e.focus ? { focus: e.focus } : {}) })
    if (w.isNarrow) return { value: { isPlaced: false, reason: 'unasked panes need 144 columns; 100 now' } }
    return { value: { isPlaced: true } }
  })
  on('ui.close', () => ({ value: undefined }))
  on('ui.render', ($, e) => {
    const { Box, Markdown } = $.ui.resolve(e)
    // 回答の本文は、エンジンと同じく渡された text を Markdown で描く（mod が書き換えた text を読めるように）
    if (e.component === 'AssistantMessage') return <Markdown text={e.props.text} />
    return <Box />
  })
  return seen
}

test('デモ: config.ts と食い違う主張に ✖ が付き、原文の行が帯に出る', async ($, on) => {
  const clock = mock.clock(on)
  const seen = world(on, {
    files: { 'src/config.ts': CONFIG },
    judge: p => (p.includes('timeout: 60_000') ? '{"verdict":"mismatch","lines":[2],"reason":"原文は60000ミリ秒（60秒）"}' : '{"verdict":"unknown"}'),
  })
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })

  await $.turn.complete({
    answer: 'タイムアウトは30秒です（根拠：`src/config.ts`）。',
    durationMs: 1000,
    isAborted: false,
    turnId: 't1',
    reason: 'answer',
  })
  await clock.settle()

  // mod が自分でファイルを読み、会話を持たない判定に原文を渡した
  expect(seen.read.map(p => p.replace(/^.*?(?=src\/)/, ''))).toEqual(['src/config.ts'])
  expect(seen.judged.length).toBe(1)
  expect(seen.judged[0]).toContain('タイムアウトは30秒です')
  expect(seen.judged[0]).toContain('L2:   timeout: 60_000,')

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect((await ui.find({ type: 'Text', text: /✖ 1/ }))?.text).toBe('✖ 1')
    expect((await ui.find({ type: 'Text', text: /主張: タイムアウトは30秒です/ }))?.text).toBe('✖ 主張: タイムアウトは30秒です')
    expect(await ui.find({ type: 'Text', text: /timeout: 60_000/ })).toBeDefined()
    await ui.unmount()
  }

  // 「訂正させる」で、原文つきの訂正依頼が Claude に届く
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  await ui.press({ key: 'fix-all' })
  expect(seen.prompts.length).toBe(1)
  expect(seen.prompts[0]).toContain('タイムアウトは30秒です')
  expect(seen.prompts[0]).toContain('L2: timeout: 60_000,')
  await ui.unmount()
})

test('原文と一致すれば ✔、詳細パネルにも原文が出る（すべての画面で）', async ($, on) => {
  const clock = mock.clock(on)
  world(on, {
    files: { 'src/config.ts': CONFIG },
    judge: () => '{"verdict":"match","lines":[3],"reason":"原文も3回"}',
  })
  await $.session.start({ cwd: '/proj', surface: 'desktop', isInteractive: true })
  await $.turn.complete({
    answer: 'リトライは3回です（`src/config.ts:3`）。',
    durationMs: 1000,
    isAborted: false,
    turnId: 't1',
    reason: 'answer',
  })
  await clock.settle()

  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: /✔ 原文と一致/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /retries: 3/ })).toBeDefined()
    await ui.unmount()
  }
})

test('取得に失敗した出典は ？（確認できない）。✔ にはならない', async ($, on) => {
  const clock = mock.clock(on)
  const seen = world(on, { judge: () => '{"verdict":"match","lines":[1]}' })
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
  await $.turn.complete({
    answer: '上限は100件です（https://example.com/limits ）。',
    durationMs: 1000,
    isAborted: false,
    turnId: 't1',
    reason: 'answer',
  })
  await clock.settle()

  expect(seen.fetched).toEqual(['https://example.com/limits'])
  expect(seen.judged).toEqual([]) // 原文がないのに判定はしない
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /？ 1/ }))?.text).toBe('？ 1')
  expect((await ui.find({ type: 'Text', text: /✔ 0/ }))?.text).toBe('✔ 0')
  expect((await ui.find({ type: 'Text', text: /✖ 0/ }))?.text).toBe('✖ 0')
  await ui.unmount()
})

test('ウェブページは mod 自身が取りに行き、HTML を外した本文で判定する', async ($, on) => {
  const clock = mock.clock(on)
  const seen = world(on, {
    pages: {
      'https://example.com/limits': {
        status: 200,
        type: 'text/html; charset=utf-8',
        text: '<html><body><script>x()</script><h1>Limits</h1><p>Each request returns at most <b>50</b> items.</p></body></html>',
      },
    },
    judge: () => '{"verdict":"mismatch","lines":[2],"reason":"原文は最大50件"}',
  })
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
  await $.turn.complete({
    answer: '1回のリクエストで取れるのは最大100件です（https://example.com/limits ）。',
    durationMs: 1000,
    isAborted: false,
    turnId: 't1',
    reason: 'answer',
  })
  await clock.settle()

  expect(seen.judged[0]).toContain('L2: Each request returns at most 50 items.')
  expect(seen.judged[0]).not.toContain('<script>')
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /at most 50 items/ })).toBeDefined()
  await ui.unmount()
})

test('✖ のとき（自動では開かず）［原文を見る］で原文ポップアップが開き、実際のページの該当箇所とハイライト付きリンクが出る', async ($, on) => {
  const clock = mock.clock(on)
  const seen = world(on, {
    pages: {
      'https://example.com/limits': {
        status: 200,
        type: 'text/html',
        text:
          '<html><head><title>Limits | Example Docs</title></head><body><h1>Limits</h1>' +
          '<p>Each request returns at most 50 items.</p><p>Use paging for more.</p><p>Errors return 429.</p></body></html>',
      },
    },
    judge: () => '{"verdict":"mismatch","lines":[2],"reason":"原文は最大50件"}',
  })
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
  await $.turn.complete({
    answer: '1回のリクエストで取れるのは最大100件です（https://example.com/limits ）。',
    durationMs: 1000,
    isAborted: false,
    turnId: 't1',
    reason: 'answer',
  })
  await clock.settle()

  // 既定では ✖ のとき原文ポップアップをダイアログで開く（開けたのでトーストは出さない）
  expect(seen.opened).toEqual([{ id: 'uradori', focus: true }])
  expect(seen.toasts).toEqual([])

  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: /「1回のリクエストで取れるのは最大100件です」/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /実際のページ：Limits \| Example Docs/ })).toBeDefined()
    // 根拠の行は ▶ つきで強調、前後の行も原文どおりに出る
    expect((await ui.find({ type: 'Text', text: /▶ Each request returns at most 50 items\./ }))?.text).toBe(
      '▶ Each request returns at most 50 items.',
    )
    expect(await ui.find({ type: 'Text', text: /Use paging for more\./ })).toBeDefined()
    const link = await ui.find({ type: 'Link' })
    expect(link?.text).toContain('🔗 実際のサイトの該当箇所を開く（ハイライト表示）')
    expect(link?.text).not.toContain('https://example.com/limits#:~:text=Use')
    await ui.unmount()
  }

  // 帯の［原文を見る］で開くときはダイアログ（focus あり）
  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  await band.press({ key: 'open' })
  expect(seen.opened.at(-1)).toEqual({ id: 'uradori', focus: true })
  await band.unmount()

  // /uradori の文字の結果にも、ハイライト付きのURLが出る
  const out = await $.command.run({
    command: 'uradori',
    args: '',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: false, columns: 100 },
  })
  expect(out.text).toContain('https://example.com/limits#:~:text=Each%20request%20returns%20at%20most%2050%20items.')
})

test('ポップアップの［次 →］で、ほかの主張の原文に切り替わる', async ($, on) => {
  const clock = mock.clock(on)
  world(on, {
    files: { 'src/config.ts': CONFIG },
    judge: p =>
      p.includes('タイムアウト')
        ? '{"verdict":"mismatch","lines":[2],"reason":"原文は60秒"}'
        : '{"verdict":"match","lines":[3],"reason":"原文も3回"}',
  })
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
  await $.turn.complete({
    answer: 'タイムアウトは30秒です（`src/config.ts`）。リトライは3回です（`src/config.ts`）。',
    durationMs: 1000,
    isAborted: false,
    turnId: 't1',
    reason: 'answer',
  })
  await clock.settle()

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /✖ 原文と食い違い/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /▶   2│   timeout: 60_000,/ })).toBeDefined()
  await ui.press({ key: 'next' })
  expect(await ui.find({ type: 'Text', text: /✔ 原文と一致/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /▶   3│   retries: 3,/ })).toBeDefined()
  await ui.unmount()

  // /uradori 1 で1件目に戻る
  await $.command.run({
    command: 'uradori',
    args: '1',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: false, columns: 100 },
  })
  const again = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await again.find({ type: 'Text', text: /（1\/2）/ })).toBeDefined()
  await again.unmount()
})

test('末尾の参考リンクは、モデルが主張と対にしてからウラ取りする', async ($, on) => {
  const clock = mock.clock(on)
  const seen = world(on, {
    pages: {
      'https://example.com/limits': { status: 200, type: 'text/plain', text: 'Rate limit: 50 requests per minute.' },
    },
    judge: p =>
      p.includes('# 出典\n[1]')
        ? '[{"source":1,"claim":"レート制限は1分あたり100リクエストです。"}]'
        : '{"verdict":"mismatch","lines":[1],"reason":"原文は50"}',
  })
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
  await $.turn.complete({
    answer: 'レート制限は1分あたり100リクエストです。\n\nSources:\n- [Limits](https://example.com/limits)',
    durationMs: 1000,
    isAborted: false,
    turnId: 't1',
    reason: 'answer',
  })
  await clock.settle()

  expect(seen.judged.length).toBe(2) // 対応づけ1回 + 判定1回
  expect(seen.judged[1]).toContain('レート制限は1分あたり100リクエストです')
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /✖ 1/ }))?.text).toBe('✖ 1')
  expect(await ui.find({ type: 'Text', text: /50 requests per minute/ })).toBeDefined()
  await ui.unmount()
})

test('秘密情報らしいファイルは読まずに ？（確認できない）にする', async ($, on) => {
  const clock = mock.clock(on)
  const seen = world(on, { files: { '.env': 'API_KEY=xxx' }, judge: () => '{"verdict":"match"}' })
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
  await $.turn.complete({
    answer: 'APIキーは設定済みです（`.env`）。',
    durationMs: 1000,
    isAborted: false,
    turnId: 't1',
    reason: 'answer',
  })
  await clock.settle()

  expect(seen.read).toEqual([])
  expect(seen.judged).toEqual([])
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /秘密情報の可能性/ })).toBeDefined()
  await ui.unmount()
})

test('出典のない回答では、何も読まずモデルも呼ばない', async ($, on) => {
  const clock = mock.clock(on)
  const seen = world(on, {})
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
  await $.turn.complete({ answer: 'こんにちは。何をしましょうか？', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })
  await clock.settle()

  expect(seen.read).toEqual([])
  expect(seen.fetched).toEqual([])
  expect(seen.judged).toEqual([])
})

test('/uradori off で自動チェックが止まる', async ($, on) => {
  const clock = mock.clock(on)
  const seen = world(on, { files: { 'src/config.ts': CONFIG } })
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
  const off = await $.command.run({
    command: 'uradori',
    args: 'off',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: false, columns: 100 },
  })
  expect(off.text).toContain('止めました')

  await $.turn.complete({
    answer: 'タイムアウトは30秒です（`src/config.ts`）。',
    durationMs: 1,
    isAborted: false,
    turnId: 't1',
    reason: 'answer',
  })
  await clock.settle()
  expect(seen.read).toEqual([])
})

// ───────────────────────────── 根拠を求められたターン

describe('根拠を求める質問', () => {
  test('「根拠付きで」「一次情報」などを手がかりにする', async () => {
    expect(evidenceRequest('醤油の原料について根拠付きでおしえて')).toBe('根拠')
    expect(evidenceRequest('一次情報はどこ？')).toBe('一次情報')
    expect(evidenceRequest('ソースは？')).toBe('ソース')
    expect(evidenceRequest('Can you cite the spec?')).toBe('cite')
  })

  test('「ソースコード」や数式の「公式」では発動しない', async () => {
    expect(evidenceRequest('このソースコードを読んで')).toBeUndefined()
    expect(evidenceRequest('二次方程式の解の公式を使って')).toBeUndefined()
    expect(evidenceRequest('config.ts を修正して')).toBeUndefined()
  })

  test('URL のない「名前だけの出典」を拾う', async () => {
    const answer = [
      '醤油の原料は大豆・小麦・食塩です。',
      '',
      '## 主な出典',
      '1. 農林水産省「しょうゆの日本農林規格」',
      '2. しょうゆ情報センター「しょうゆの知識」',
      '3. [食品表示基準](https://www.caa.go.jp/)',
    ].join('\n')
    expect(findNamedSources(answer)).toEqual(['農林水産省「しょうゆの日本農林規格」', 'しょうゆ情報センター「しょうゆの知識」'])
  })

  test('数値や規格を含む主張を先に確かめる', async () => {
    expect(claimPriority('こいくちのシェアは約8割です')).toBeGreaterThan(claimPriority('醤油は発酵食品です'))
  })
})

test('根拠を求める質問では、URL で書くよう Claude にだけ伝える（ユーザーの文は変えない）', async ($, on) => {
  const seen = world(on, {})
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
  const entered = await $.prompt.submit({ text: '醤油の原料について根拠付きでおしえて' })
  expect('text' in entered ? entered.text : '').toBe('醤油の原料について根拠付きでおしえて')
  expect(seen.contexts.at(-1)?.join('\n')).toContain('URL')
  // URL だけでなく、ページ内の場所（ページ番号・見出し・引用・テキストフラグメント）まで求める
  expect(seen.contexts.at(-1)?.join('\n')).toContain('ページ番号')
  expect(seen.contexts.at(-1)?.join('\n')).toContain('#:~:text=')
  // 普通の質問には何も足さない
  await $.prompt.submit({ text: 'ありがとう' })
  expect(seen.contexts.at(-1)).toEqual([])
})

test('根拠を求めたのに出典が名前だけなら、帯に ⚪ と［一次情報で裏付けさせる］が出る', async ($, on) => {
  const clock = mock.clock(on)
  const seen = world(on, {})
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
  await $.prompt.submit({ text: '醤油の原料について根拠付きでおしえて' })
  await $.turn.complete({
    answer: '原料は大豆・小麦・食塩です。\n\n## 主な出典\n1. 農林水産省「しょうゆの日本農林規格」',
    durationMs: 1,
    isAborted: false,
    turnId: 't1',
    reason: 'answer',
  })
  await clock.settle()
  expect(seen.judged).toEqual([])

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /URLなしの出典 1件/ })).toBeDefined()
  await ui.press({ key: 'ground' })
  expect(seen.prompts.at(-1)).toContain('農林水産省「しょうゆの日本農林規格」')
  expect(seen.prompts.at(-1)).toContain('一次情報')
  await ui.unmount()

  const why = await $.command.run({ command: 'uradori', args: 'why', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } })
  expect(why.text).toContain('「根拠」')
})

test('根拠を求めたのに出典がまったくなければ「根拠が示されていません」と出る', async ($, on) => {
  const clock = mock.clock(on)
  world(on, {})
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
  await $.prompt.submit({ text: '出典つきで教えて' })
  await $.turn.complete({ answer: '原料は大豆・小麦・食塩です。', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })
  await clock.settle()
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /根拠が示されていません/ })).toBeDefined()
  await ui.unmount()
})

test('印は1ターンかぎり: 次の普通の質問では帯を出さない', async ($, on) => {
  const clock = mock.clock(on)
  world(on, {})
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
  await $.prompt.submit({ text: '根拠付きで教えて' })
  await $.turn.complete({ answer: '大豆です。', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })
  await $.prompt.submit({ text: 'ありがとう' })
  await $.turn.complete({ answer: 'どういたしまして。', durationMs: 1, isAborted: false, turnId: 't2', reason: 'answer' })
  await clock.settle()
  const why = await $.command.run({ command: 'uradori', args: 'why', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } })
  expect(why.text).toContain('根拠を求める質問ではない')
})

// ───────────────────────────── アクセス拒否

describe('アクセス拒否の見分け', () => {
  test('403・429 やボット確認のページはアクセス拒否として扱う', async () => {
    expect(isBlockedResponse(403, '')).toBe(true)
    expect(isBlockedResponse(429, '')).toBe(true)
    expect(isBlockedResponse(200, '<html><head><title>Just a moment...</title>')).toBe(true)
    expect(isBlockedResponse(200, '<html><head><title>醤油 - Wikipedia</title>')).toBe(false)
    expect(isBlockedResponse(404, 'not found')).toBe(false)
  })

  test('保存された日時を読む', async () => {
    expect(archiveDate('Wed, 21 Oct 2026 21:22:07 GMT')).toBe('2026-10-21')
    expect(archiveDate(undefined)).toBe('')
  })
})

const LIMITS = 'https://example.com/limits'
const ANSWER_LIMITS = `1回のリクエストで取得できるのは最大100件です（出典: ${LIMITS}）。`

test('アクセス拒否のページは Web Archive の保存版で確かめ、どこで確かめたかを示す', async ($, on) => {
  const clock = mock.clock(on)
  const seen = world(on, {
    pages: {
      [LIMITS]: { status: 403, type: 'text/html', text: '<title>Just a moment...</title>' },
      [`https://web.archive.org/web/2id_/${LIMITS}`]: { status: 200, type: 'text/html', text: '<html><body><p>1回のリクエストで取得できるのは最大50件です。</p></body></html>' },
    },
    judge: p => (p.includes('最大50件') ? '{"verdict":"mismatch","lines":[1],"reason":"原文は50件"}' : '{"verdict":"unknown"}'),
  })
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
  await $.turn.complete({ answer: ANSWER_LIMITS, durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })
  await clock.settle()

  expect(seen.fetched).toEqual([LIMITS, `https://web.archive.org/web/2id_/${LIMITS}`])
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /✖ 1/ }))?.text).toBe('✖ 1')
  await ui.unmount()
  const pane = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await pane.find({ type: 'Text', text: /Web Archive/ })).toBeDefined()
  await pane.unmount()
})

test('保存版もなければ 🔒 にし、［別の出典を探させる］で一次情報を探し直させる', async ($, on) => {
  const clock = mock.clock(on)
  const seen = world(on, {
    pages: { [LIMITS]: { status: 403, type: 'text/html', text: 'Forbidden' } },
  })
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
  await $.turn.complete({ answer: ANSWER_LIMITS, durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })
  await clock.settle()
  expect(seen.judged).toEqual([])

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /🔒 1/ }))?.text).toBe('🔒 1')
  expect((await ui.find({ type: 'Text', text: /？ \d/ }))?.text).toBe('？ 0')
  await ui.press({ key: 'alt' })
  expect(seen.prompts.at(-1)).toContain('最大100件')
  expect(seen.prompts.at(-1)).toContain('一次情報')
  await ui.unmount()
})

test('/uradori archive off なら Web Archive には問い合わせない', async ($, on) => {
  const clock = mock.clock(on)
  const seen = world(on, { pages: { [LIMITS]: { status: 403, type: 'text/html', text: 'Forbidden' } } })
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'uradori', args: 'archive off', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } })
  await $.turn.complete({ answer: ANSWER_LIMITS, durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })
  await clock.settle()
  expect(seen.fetched).toEqual([LIMITS])
})

// ───────────────────────────── 前の回答の結果を残さない

test('出典のない次の回答では、前の回答の帯を消す', async ($, on) => {
  const clock = mock.clock(on)
  world(on, {
    files: { 'src/config.ts': CONFIG },
    judge: () => '{"verdict":"mismatch","lines":[2],"reason":"原文は60秒"}',
  })
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
  await $.turn.complete({ answer: 'タイムアウトは30秒です（根拠：`src/config.ts`）。', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })
  await clock.settle()
  const first = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await first.find({ type: 'Text', text: /✖ 1/ }))?.text).toBe('✖ 1')
  await first.unmount()

  await $.turn.complete({ answer: 'どういたしまして。', durationMs: 1, isAborted: false, turnId: 't2', reason: 'answer' })
  await clock.settle()
  const second = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await second.find({ type: 'Text', text: /ウラ取り|✖ 1/ })).toBeUndefined()
  await second.unmount()
})

test('/uradori off のあとの回答でも、前の回答の帯は残さない', async ($, on) => {
  const clock = mock.clock(on)
  world(on, {
    files: { 'src/config.ts': CONFIG },
    judge: () => '{"verdict":"mismatch","lines":[2],"reason":"原文は60秒"}',
  })
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
  await $.turn.complete({ answer: 'タイムアウトは30秒です（根拠：`src/config.ts`）。', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })
  await clock.settle()
  await $.command.run({ command: 'uradori', args: 'off', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } })
  await $.turn.complete({ answer: 'リトライは3回です（`src/config.ts`）。', durationMs: 1, isAborted: false, turnId: 't2', reason: 'answer' })
  await clock.settle()
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /✖ 1/ })).toBeUndefined()
  await ui.unmount()
})

// ───────────────────────────── PDF

describe('PDF の見分け', () => {
  test('パスが .pdf の URL を PDF とみなし、#page=N を読む', async () => {
    expect(isPdfUrl('https://example.go.jp/std.pdf#page=6')).toBe(true)
    expect(isPdfUrl('https://example.go.jp/std.PDF?v=2')).toBe(true)
    expect(isPdfUrl('https://example.go.jp/std.html#pdf')).toBe(false)
    expect(pdfPage('https://example.go.jp/std.pdf#page=6')).toBe(6)
    expect(pdfPage('https://example.go.jp/std.pdf')).toBeUndefined()
  })

  test('PDF の出典を探し直させる依頼文は、HTML のページを求める', async () => {
    const text = alternativeSourcePrompt([
      { claim: '定義は清澄な液体調味料です', source: { kind: 'url', ref: 'https://example.go.jp/std.pdf#page=6' }, isPdf: true },
    ])
    expect(text).toContain('PDF')
    expect(text).toContain('HTML')
    expect(text).not.toContain('アクセス制限')
  })
})

test('根拠を求める質問では、PDF より HTML のページを出典にするよう伝える', async ($, on) => {
  const seen = world(on, {})
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
  await $.prompt.submit({ text: '醤油の定義を根拠付きでおしえて' })
  const context = seen.contexts.at(-1)?.join('\n') ?? ''
  expect(context).toContain('HTML のページを優先')
  expect(context).toContain('PDF しかないときだけ')
})

test('PDF の出典は取りに行かず 📄 にし、自分で開くリンクと［別の出典を探させる］を出す', async ($, on) => {
  const clock = mock.clock(on)
  const PDF = 'https://example.go.jp/std.pdf#page=6'
  const seen = world(on, { judge: () => '{"verdict":"match","lines":[1]}' })
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
  await $.turn.complete({
    answer: `しょうゆは清澄な液体調味料と定義されています（出典: ${PDF} の6ページ 第2条）。`,
    durationMs: 1,
    isAborted: false,
    turnId: 't1',
    reason: 'answer',
  })
  await clock.settle()

  expect(seen.fetched).toEqual([]) // PDF は読めないので取りに行かない
  expect(seen.judged).toEqual([])
  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await band.find({ type: 'Text', text: /📄 \d/ }))?.text).toBe('📄 1')
  expect((await band.find({ type: 'Text', text: /？ \d/ }))?.text).toBe('？ 0')
  await band.press({ key: 'alt' })
  expect(seen.prompts.at(-1)).toContain('PDF')
  expect(seen.prompts.at(-1)).toContain('清澄な液体調味料')
  await band.unmount()

  const pane = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await pane.find({ type: 'Text', text: /PDFのため自動で確認できない/ })).toBeDefined()
  const link = await pane.find({ type: 'Link' })
  expect(link?.text).toContain('PDFを開いて自分で確かめる（6ページ）')
  await pane.unmount()
})

test('URL が .pdf でなくても、中身が PDF なら 📄 にする', async ($, on) => {
  const clock = mock.clock(on)
  world(on, { pages: { [LIMITS]: { status: 200, type: 'application/pdf', text: '%PDF-1.7' } } })
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
  await $.turn.complete({ answer: ANSWER_LIMITS, durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })
  await clock.settle()
  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await band.find({ type: 'Text', text: /📄 \d/ }))?.text).toBe('📄 1')
  await band.unmount()
})

// ───────────────────────────── 引用の照合

describe('Claude が書いた引用', () => {
  test('出典のかっこの中の最後の「」を引用として拾い、主張からは出典の説明を外す', async () => {
    const answer = '上限は50件です（出典: https://example.com/limits の「料金と上限」節「1回あたり上限は50件」）。'
    const refs = findSourceRefs(answer)
    expect(citedQuote(answer, refs[0]!)).toBe('1回あたり上限は50件')
    expect(inlinePairs(answer, refs).pairs).toEqual([
      { claim: '上限は50件です', source: { kind: 'url', ref: 'https://example.com/limits' }, quote: '1回あたり上限は50件' },
    ])
  })

  test('かっこの外の「」や、短すぎる「」は引用にしない', async () => {
    const answer = '「設定」は必須です（根拠: `src/config.ts`）。'
    expect(citedQuote(answer, findSourceRefs(answer)[0]!)).toBeUndefined()
    const short = '上限は50件です（出典: https://example.com/limits の「料金」節）。'
    expect(citedQuote(short, findSourceRefs(short)[0]!)).toBeUndefined()
  })

  test('テキストフラグメントの文を読む（始まり,終わり の形と前後の文脈も）', async () => {
    expect(fragmentQuote('https://example.com/limits#:~:text=上限は50件')).toBe('上限は50件')
    expect(fragmentQuote(`https://example.com/#:~:text=pre-,${encodeURIComponent('最初の文です')},${encodeURIComponent('最後の文です')},-post`)).toBe(
      '最初の文です…最後の文です',
    )
    expect(fragmentQuote('https://example.com/limits')).toBeUndefined()
  })

  test('引用を原文と一字一句照合する（空白・全角半角の違いは無視、数字の違いは不一致）', async () => {
    const lines = toLines('料金と上限\n1回あたり 上限は５０件 です。\nそれ以上はページングしてください。', 'url')
    expect(findQuote(lines, '1回あたり上限は50件')?.map(l => l.line)).toEqual([2])
    expect(findQuote(lines, '1回あたり…ページングして')?.map(l => l.line)).toEqual([2, 3])
    expect(findQuote(lines, '1回あたり上限は100件')).toBeUndefined()
    expect(findQuote(lines, 'ページングして…1回あたり')).toBeUndefined() // 順番が逆
  })
})

const LIMITS_PAGE = {
  status: 200,
  type: 'text/html',
  text: '<html><body><h1>Limits</h1><p>Each request returns at most 50 items.</p><p>Use paging for more.</p></body></html>',
}

test('引用が原文にないが内容は一致なら、✖ ではなく △ 引用ずれにする', async ($, on) => {
  const clock = mock.clock(on)
  world(on, { pages: { [LIMITS]: LIMITS_PAGE }, judge: () => '{"verdict":"match","lines":[2],"reason":"原文も50件"}' })
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
  await $.turn.complete({
    answer: `最大50件です（出典: ${LIMITS} の「Limits」節「Each request returns up to 50 items」）。`,
    durationMs: 1,
    isAborted: false,
    turnId: 't1',
    reason: 'answer',
  })
  await clock.settle()

  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await band.find({ type: 'Text', text: /△ \d/ }))?.text).toBe('△ 1')
  expect((await band.find({ type: 'Text', text: /✖ \d/ }))?.text).toBe('✖ 0')
  // 事実の食い違いではないので、［訂正させる］は出さない
  expect(await band.find({ type: 'Button', text: /訂正させる/ })).toBeUndefined()
  await band.unmount()
  const pane = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await pane.find({ type: 'Text', text: /△ 引用ずれ/ })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: /原文と食い違い/ })).toBeUndefined()
  expect(await pane.find({ type: 'Text', text: /原文に見つかりません/ })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: /主張の内容は原文と一致/ })).toBeDefined()
  await pane.unmount()
})

test('引用が原文にあれば ✔ のままで、その引用の箇所へのハイライトリンクを作る', async ($, on) => {
  const clock = mock.clock(on)
  const seen = world(on, { pages: { [LIMITS]: LIMITS_PAGE }, judge: () => '{"verdict":"match","lines":[],"reason":"原文も50件"}' })
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
  await $.turn.complete({
    answer: `最大50件です（出典: ${LIMITS} の「Limits」節「at most 50 items」）。`,
    durationMs: 1,
    isAborted: false,
    turnId: 't1',
    reason: 'answer',
  })
  await clock.settle()

  expect(seen.judged[0]).toContain('最大50件です')
  const pane = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await pane.find({ type: 'Text', text: /✔ 原文と一致/ })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: /原文にあり/ })).toBeDefined()
  // 判定モデルが根拠の行を返さなくても、引用が見つかった行を ▶ で示す
  expect(await pane.find({ type: 'Text', text: /▶ Each request returns at most 50 items\./ })).toBeDefined()
  await pane.unmount()
  const out = await $.command.run({ command: 'uradori', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } })
  expect(out.text).toContain(`${LIMITS}#:~:text=at%20most%2050%20items`)
})

test('テキストフラグメントの文が原文になく、内容も判定できなければ △ 引用ずれにする', async ($, on) => {
  const clock = mock.clock(on)
  world(on, { pages: { [LIMITS]: LIMITS_PAGE }, judge: () => '{"verdict":"unknown"}' })
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
  await $.turn.complete({
    answer: `上限は100件です（出典: ${LIMITS}#:~:text=at%20most%20100%20items ）。`,
    durationMs: 1,
    isAborted: false,
    turnId: 't1',
    reason: 'answer',
  })
  await clock.settle()
  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await band.find({ type: 'Text', text: /△ \d/ }))?.text).toBe('△ 1')
  await band.unmount()
})

test('引用が原文になく、内容も食い違うなら ✖ のまま', async ($, on) => {
  const clock = mock.clock(on)
  world(on, { pages: { [LIMITS]: LIMITS_PAGE }, judge: () => '{"verdict":"mismatch","lines":[2],"reason":"原文は50件"}' })
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
  await $.turn.complete({
    answer: `最大100件です（出典: ${LIMITS} の「Limits」節「Each request returns up to 100 items」）。`,
    durationMs: 1,
    isAborted: false,
    turnId: 't1',
    reason: 'answer',
  })
  await clock.settle()
  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await band.find({ type: 'Text', text: /✖ \d/ }))?.text).toBe('✖ 1')
  expect(await band.find({ type: 'Text', text: /△ \d/ })).toBeUndefined()
  await band.unmount()
})

// ───────────────────────────── 回答の本文の印と、ホバーで出る原文カード

describe('本文に印を付ける位置', () => {
  test('主張が書かれていた文を、回答の原文どおりに返す', async () => {
    const answer = 'タイムアウトは30秒です（根拠：`src/config.ts`）。リトライは3回です。'
    expect(claimAnchor(answer, 'タイムアウトは30秒です')).toBe('タイムアウトは30秒です（根拠：`src/config.ts`）。')
    // 強調や `` ` `` を外した主張でも見つける
    expect(claimAnchor('上限は**50件**です。', '上限は50件です')).toBe('上限は**50件**です。')
    expect(claimAnchor(answer, 'まったく別の主張です')).toBe('')
  })

  test('文の後ろに印を差し込み、同じ文の印はまとめる。コードブロックの中には付けない', async () => {
    const text = 'Aは1です。Bは2です。\n```\nCは3です。\n```'
    const out = placeMarks(text, [
      { anchor: 'Aは1です。', mark: '✔' },
      { anchor: 'Aは1です。', mark: '✖ 原文と違う' },
      { anchor: 'Cは3です。', mark: '✔' },
      { anchor: 'ないです。', mark: '✔' },
    ])
    expect(out.text).toBe('Aは1です。 ✔ ✖ 原文と違うBは2です。\n```\nCは3です。\n```')
    expect(out.placed).toEqual([0, 1])
  })

  test('カードの行を、全角を2マスと数えてちょうどの幅にする', async () => {
    expect(cellWidth('あa')).toBe(3)
    expect(fitCells('ab', 4)).toBe('ab  ')
    expect(fitCells('あいう', 5)).toBe('あい…')
  })
})

const DEMO_ANSWER = 'タイムアウトは30秒です（根拠：`src/config.ts`）。リトライは3回です（`src/config.ts:3`）。'
const MESSAGE = (text: string) => ({
  plugin: 'uradori',
  component: 'AssistantMessage',
  requestId: 'm1',
  props: { text, isFirstOfReply: true },
}) as const

async function checkDemo($: Engine, on: On) {
  const clock = mock.clock(on)
  world(on, {
    files: { 'src/config.ts': CONFIG },
    judge: p =>
      p.includes('タイムアウト')
        ? '{"verdict":"mismatch","lines":[2],"reason":"原文は60秒"}'
        : '{"verdict":"match","lines":[3],"reason":"原文も3回"}',
  })
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
  await $.turn.complete({ answer: DEMO_ANSWER, durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })
  await clock.settle()
  return clock
}

/**
 * ホバーで出るカード: 絶対配置で、ふだんは隠れている Box。
 * マウスを乗せると出す hover は、テストの find からは見えない（FoundElement に hover がない）ので、位置と表示で見分ける
 */
async function hoverCard(ui: { findAll: (q: { type: string }) => Promise<{ props: Record<string, unknown> }[]> }) {
  return (await ui.findAll({ type: 'Box' })).find(b => b.props.position === 'absolute' && b.props.display === 'none')
}

test('回答の本文の、主張の文の後ろに ✖ ✔ が付く（保存された回答は変えない）', async ($, on) => {
  await checkDemo($, on)
  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    const ui = await $.ui.mount({ ...MESSAGE(DEMO_ANSWER), surface })
    const body = await ui.find({ type: 'Markdown' })
    expect(body?.text).toBe(
      'タイムアウトは30秒です（根拠：`src/config.ts`）。 ✖ 原文と違うリトライは3回です（`src/config.ts:3`）。 ✔',
    )
    await ui.unmount()
  }
  // 保存された回答は元のまま
  const out = await $.command.run({ command: 'uradori', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } })
  expect(out.text).not.toContain('原文と違う')
})

test('本文にマウスを乗せると、原文の該当行のカードが出る（食い違いが先頭）', async ($, on) => {
  await checkDemo($, on)
  for (const surface of ['terminal', 'desktop', 'vscode'] as const) {
    const ui = await $.ui.mount({ ...MESSAGE(DEMO_ANSWER), surface, viewport: { columns: 100, rows: 40 } })
    const card = await hoverCard(ui)
    expect(card).toBeDefined()
    expect(card?.props.borderColor).toBe('error')
    // ふだんは隠れていて、本文の上に重ねて出す（本文の並びは動かさない）
    expect(card?.props.height).toBe(-(card?.props.top as number))
    const rows = await ui.findAll({ type: 'Text' })
    const texts = rows.map(r => r.text.trimEnd())
    expect(texts[0]).toContain('✔ 1  ✖ 1  ？ 0')
    expect(texts[1]).toBe('✖ タイムアウトは30秒です')
    expect(texts[2]).toBe('  ▶ src/config.ts L2: timeout: 60_000,')
    expect(texts).toContain('✔ リトライは3回です')
    // 下にある本文の文字が透けないよう、行は幅いっぱいまで埋めてある
    expect(new Set(rows.map(r => cellWidth(r.text))).size).toBe(1)
    await ui.unmount()
  }
})

test('スマートフォンでは本文の印だけで、カードは出さない', async ($, on) => {
  await checkDemo($, on)
  const ui = await $.ui.mount({ ...MESSAGE(DEMO_ANSWER), surface: 'mobile' })
  expect(await hoverCard(ui)).toBeUndefined()
  expect((await ui.find({ type: 'Markdown' }))?.text).toContain('✖ 原文と違う')
  await ui.unmount()
})

test('ウラ取りしていない回答の本文はそのまま', async ($, on) => {
  await checkDemo($, on)
  const ui = await $.ui.mount({ ...MESSAGE('こんにちは。タイムアウトの話は別の回答です。'), surface: 'terminal' })
  expect((await ui.find({ type: 'Markdown' }))?.text).toBe('こんにちは。タイムアウトの話は別の回答です。')
  expect(await hoverCard(ui)).toBeUndefined()
  await ui.unmount()
})

test('次の回答に出典がなく帯が消えても、前の回答の本文の印は残る', async ($, on) => {
  const clock = await checkDemo($, on)
  await $.turn.complete({ answer: 'どういたしまして。', durationMs: 1, isAborted: false, turnId: 't2', reason: 'answer' })
  await clock.settle()
  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await band.find({ type: 'Text', text: /✖ 1/ })).toBeUndefined()
  await band.unmount()
  const ui = await $.ui.mount({ ...MESSAGE(DEMO_ANSWER), surface: 'terminal' })
  expect((await ui.find({ type: 'Markdown' }))?.text).toContain('✖ 原文と違う')
  await ui.unmount()
})


test('カードの行の字下げは残す', async () => {
  expect(fitCells('  ▶ L2: x', 12)).toBe('  ▶ L2: x   ')
  expect(fitCells('a\nb', 3)).toBe('a b')
})


// ───────────────────────────── 件数・知らせ方・根拠モードの表示

test('帯とホバーのカードは、同じ数え方の件数を出す（🔒 は ？ に含めない）', async ($, on) => {
  const clock = mock.clock(on)
  world(on, {
    files: { 'src/config.ts': CONFIG },
    pages: { [LIMITS]: { status: 403, type: 'text/html', text: 'Forbidden' } },
    judge: () => '{"verdict":"mismatch","lines":[2],"reason":"原文は60秒"}',
  })
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'uradori', args: 'archive off', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } })
  const answer = `タイムアウトは30秒です（根拠：\`src/config.ts\`）。${ANSWER_LIMITS}`
  await $.turn.complete({ answer, durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })
  await clock.settle()

  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  const cells = (await band.findAll({ type: 'Text' })).map(t => t.text).filter(t => /^(✔|✖|△|？|🔒|📄) \d+$/.test(t))
  expect(cells).toEqual(['✔ 0', '✖ 1', '？ 0', '🔒 1'])
  await band.unmount()

  const ui = await $.ui.mount({ ...MESSAGE(answer), surface: 'desktop', viewport: { columns: 100, rows: 40 } })
  expect(await hoverCard(ui)).toBeDefined()
  const header = (await ui.findAll({ type: 'Text' }))[0]?.text.trimEnd()
  expect(header).toBe(`🔍 ウラ取り ${cells.join('  ')}`)
  await ui.unmount()
})

test('✖ のとき原文ポップアップをダイアログで自動で開き、［切り替え］や /uradori popup off で止められる', async ($, on) => {
  const clock = mock.clock(on)
  const seen = world(on, {
    files: { 'src/config.ts': CONFIG },
    judge: () => '{"verdict":"mismatch","lines":[2],"reason":"原文は60秒"}',
  })
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
  const answer = 'タイムアウトは30秒です（根拠：`src/config.ts`）。'
  await $.turn.complete({ answer, durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })
  await clock.settle()
  // 既定はオン。ダイアログとして開く（focus は頼むだけで、入力中ならエンジンがキー入力を渡さない）
  expect(seen.opened).toEqual([{ id: 'uradori', focus: true }])
  expect(seen.toasts).toEqual([])

  const pane = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await pane.find({ type: 'Text', text: /自動で開く: オン/ })).toBeDefined()
  await pane.press({ key: 'auto' })
  expect(await pane.find({ type: 'Text', text: /自動で開く: オフ/ })).toBeDefined()
  await pane.unmount()

  await $.turn.complete({ answer, durationMs: 1, isAborted: false, turnId: 't2', reason: 'answer' })
  await clock.settle()
  expect(seen.opened.length).toBe(1)

  // コマンドでもオンに戻せる
  expect((await $.command.run({ command: 'uradori', args: 'popup on' })).text).toContain('自動で開きます')
  await $.turn.complete({ answer, durationMs: 1, isAborted: false, turnId: 't3', reason: 'answer' })
  await clock.settle()
  expect(seen.opened.length).toBe(2)
})

test('✔ だけの回答では自動で開かない', async ($, on) => {
  const clock = mock.clock(on)
  const seen = world(on, {
    files: { 'src/config.ts': CONFIG },
    judge: () => '{"verdict":"match","lines":[3],"reason":"3回"}',
  })
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
  await $.turn.complete({ answer: 'リトライは3回です（`src/config.ts:3`）。', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })
  await clock.settle()
  expect(seen.opened).toEqual([])
})

test('画面が狭くてポップアップを置けないときは、トーストで食い違いを知らせる', async ($, on) => {
  const clock = mock.clock(on)
  const seen = world(on, {
    files: { 'src/config.ts': CONFIG },
    judge: () => '{"verdict":"mismatch","lines":[2],"reason":"原文は60秒"}',
    isNarrow: true,
  })
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
  await $.turn.complete({ answer: 'タイムアウトは30秒です（根拠：`src/config.ts`）。', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })
  await clock.settle()
  expect(seen.toasts).toEqual(['✖ 原文と食い違う主張があります。帯の［原文を見る］か /uradori で原文を開けます'])
})

test('根拠モードで送ったら、回答を待つあいだ帯にそのことと理由が出て、回答後は消える', async ($, on) => {
  const clock = mock.clock(on)
  world(on, {})
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })

  // 普通の質問では出ない
  await $.prompt.submit({ text: 'こんにちは' })
  const quiet = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await quiet.find({ type: 'Text', text: /根拠モード/ })).toBeUndefined()
  await quiet.unmount()

  await $.prompt.submit({ text: '醤油の原料について根拠付きでおしえて' })
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect(await ui.find({ type: 'Text', text: /🔍 根拠モードで送信/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /質問の「根拠」に反応/ })).toBeDefined()
    await ui.unmount()
  }

  await $.turn.complete({ answer: '原料は大豆・小麦・食塩です。', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })
  await clock.settle()
  const after = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await after.find({ type: 'Text', text: /根拠モードで送信/ })).toBeUndefined()
  expect(await after.find({ type: 'Text', text: /根拠が示されていません/ })).toBeDefined()
  await after.unmount()

  // strict のときは、その理由を出す
  await $.command.run({ command: 'uradori', args: 'strict', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } })
  await $.prompt.submit({ text: 'ありがとう' })
  const strict = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await strict.find({ type: 'Text', text: /\/uradori strict 中/ })).toBeDefined()
  await strict.unmount()
})

// ───────────────────────────── 安全のため: 自動で取りに行かない URL・根拠のない判定・止まらない確認中

describe('自動で取りに行ってよい URL か', () => {
  test('社内・ローカルのアドレスは自動で取りに行かない', async () => {
    for (const host of ['localhost', 'app.localhost', '127.0.0.1', '10.0.0.5', '172.16.3.4', '192.168.1.1', '169.254.169.254', '[::1]', '[fd00::1]', 'intranet', 'wiki.corp', 'nas.local']) {
      expect(urlHoldReason(`http://${host}/docs`)).toBe('社内・ローカルのアドレスのため')
    }
    // 10進や16進で書いた IP も、URL として読むと 127.0.0.1 になる
    expect(urlHoldReason('http://2130706433/')).toBe('社内・ローカルのアドレスのため')
    expect(urlHoldReason('http://0x7f000001/')).toBe('社内・ローカルのアドレスのため')
    expect(isPrivateHost('172.32.0.1')).toBe(false)
    expect(isPrivateHost('docs.example.com')).toBe(false)
  })

  test('秘密らしい値を含む URL は自動で取りに行かない', async () => {
    expect(urlHoldReason('https://evil.example/collect?token=abc')).toContain('認証情報らしい値（token=…）')
    expect(urlHoldReason('https://evil.example/c?api_key=1')).toContain('認証情報らしい値')
    expect(urlHoldReason('https://evil.example/c?d=c2stYW50LWFwaTAzLVhYWFhYWFhYWFhYWFhYWFhY')).toBe('URL のクエリに長いランダムな文字列が含まれるため')
    expect(urlHoldReason('https://evil.example/c2stYW50LWFwaTAzLVhYWFhYWFhYWFhYWFhYWFhY/page')).toBe('URL のパスに長いランダムな文字列が含まれるため')
    expect(urlHoldReason('https://user:pass@example.com/')).toBe('URL にユーザー名・パスワードが含まれるため')
    expect(urlHoldReason(`https://example.com/?q=${'a'.repeat(301)}`)).toBe('URL のクエリが長すぎるため')
  })

  test('ふつうの公開ページは取りに行く（ドキュメントの長い見出しやコミットハッシュは止めない）', async () => {
    expect(urlHoldReason('https://example.com/limits')).toBeUndefined()
    expect(urlHoldReason('https://docs.example.com/guide/configure-the-request-timeout-for-the-client?lang=ja#retries')).toBeUndefined()
    expect(urlHoldReason('https://github.com/o/r/blob/0123456789abcdef0123456789abcdef01234567/src/a.ts')).toBeUndefined()
    expect(urlHoldReason('https://www.e-gov.go.jp/law?lawId=322AC0000000049')).toBeUndefined()
  })
})

describe('根拠の行を示せない判定', () => {
  test('一致・食い違いでも、原文の行を示せなければ ？ にする', async () => {
    expect(groundVerdict({ verdict: 'match', evidence: [], reason: '同じ' })).toEqual({
      verdict: 'unknown',
      evidence: [],
      reason: '判定モデルが原文の根拠の行を示さなかったため、確認できないにしました（モデルの判定: 一致・同じ）',
    })
    expect(groundVerdict({ verdict: 'mismatch', evidence: [], reason: '' }).verdict).toBe('unknown')
  })

  test('Claude の引用が原文に一字一句あれば、その行を一致の根拠にする', async () => {
    const hit = [{ line: 4, text: '上限は50件です。' }]
    expect(groundVerdict({ verdict: 'match', evidence: [], reason: '' }, hit)).toEqual({ verdict: 'match', evidence: hit, reason: '' })
    // 食い違いは引用があっても、モデルが行を示さなければ信じない
    expect(groundVerdict({ verdict: 'mismatch', evidence: [], reason: '' }, hit).verdict).toBe('unknown')
  })

  test('行を示した判定はそのまま', async () => {
    const judged = { verdict: 'mismatch' as const, evidence: [{ line: 2, text: 'timeout: 60_000,' }], reason: '60秒' }
    expect(groundVerdict(judged)).toBe(judged)
  })
})

test('判定モデルが行番号を示さずに「一致」と答えても ✔ にしない', async ($, on) => {
  const clock = mock.clock(on)
  world(on, { files: { 'src/config.ts': CONFIG }, judge: () => '{"verdict":"match","lines":[99],"reason":"同じ"}' })
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
  await $.turn.complete({ answer: 'タイムアウトは60秒です（根拠：`src/config.ts`）。', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })
  await clock.settle()

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /✔ \d/ }))?.text).toBe('✔ 0')
  expect((await ui.find({ type: 'Text', text: /？ \d/ }))?.text).toBe('？ 1')
  await ui.unmount()
  const out = await $.command.run({ command: 'uradori', args: '' })
  expect(out.text).toContain('判定モデルが原文の根拠の行を示さなかった')
})

test('社内のアドレスや秘密らしい値の URL は取りに行かず ⏸ にし、押したときだけ取りに行く', async ($, on) => {
  const clock = mock.clock(on)
  const INTERNAL = 'http://wiki.corp/limits'
  const EXFIL = 'https://evil.example/c?token=sk-123'
  const seen = world(on, {
    pages: { [INTERNAL]: { status: 200, type: 'text/plain', text: '1回のリクエストで取得できるのは最大50件です。' } },
    judge: p => (p.includes('最大50件') ? '{"verdict":"mismatch","lines":[1],"reason":"原文は50件"}' : '{"verdict":"unknown"}'),
  })
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
  await $.turn.complete({
    answer: `最大100件です（出典: ${INTERNAL}）。保存期間は30日です（出典: ${EXFIL}）。`,
    durationMs: 1,
    isAborted: false,
    turnId: 't1',
    reason: 'answer',
  })
  await clock.settle()

  // 1つも取りに行かず、判定モデルも呼ばない（Web Archive にも送らない）
  expect(seen.fetched).toEqual([])
  expect(seen.judged).toEqual([])
  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await band.find({ type: 'Text', text: /⏸ \d/ }))?.text).toBe('⏸ 2')
  expect((await band.find({ type: 'Text', text: /？ \d/ }))?.text).toBe('？ 0')
  await band.unmount()

  // ポップアップには理由が出て、保留の URL はリンクにしない
  await $.command.run({ command: 'uradori', args: '1' })
  const pane = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await pane.find({ type: 'Text', text: /社内・ローカルのアドレスのため/ })).toBeDefined()
  expect(await pane.find({ type: 'Link' })).toBeUndefined()
  // ［原文を取りに行く］を押したときだけ取りに行く
  await pane.press({ key: 'fetch' })
  await clock.settle()
  await pane.unmount()
  expect(seen.fetched).toEqual([INTERNAL])

  const after = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await after.find({ type: 'Text', text: /✖ \d/ }))?.text).toBe('✖ 1')
  expect((await after.find({ type: 'Text', text: /⏸ \d/ }))?.text).toBe('⏸ 1')
  await after.unmount()
})

test('公開のページから社内のアドレスへリダイレクトされたら、そこへは行かない', async ($, on) => {
  const clock = mock.clock(on)
  const seen = world(on, {
    pages: { [LIMITS]: { status: 302, type: 'text/html', text: '', location: 'http://169.254.169.254/latest/meta-data/' } },
  })
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
  await $.turn.complete({ answer: ANSWER_LIMITS, durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })
  await clock.settle()

  expect(seen.fetched).toEqual([LIMITS])
  const out = await $.command.run({ command: 'uradori', args: '' })
  expect(out.text).toContain('⏸')
  expect(out.text).toContain('リダイレクト先（169.254.169.254）')
})

test('応答しないページは待つ時間を区切って ？ にし、「確認中」のまま残さない', async ($, on) => {
  const clock = mock.clock(on)
  const seen = world(on, {
    files: { 'src/config.ts': CONFIG },
    hang: [LIMITS],
    judge: p => (p.includes('retries: 3') ? '{"verdict":"match","lines":[3],"reason":"3回"}' : '{"verdict":"unknown"}'),
  })
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
  await $.turn.complete({
    answer: `${ANSWER_LIMITS}リトライは3回です（\`src/config.ts:3\`）。`,
    durationMs: 1,
    isAborted: false,
    turnId: 't1',
    reason: 'answer',
  })
  await clock.settle()
  // ファイルの主張は終わり、応答しないページを待っている
  const waiting = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await waiting.find({ type: 'Text', text: /確認中/ }))?.text).toBe('原文を確認中… 1/2')
  await waiting.unmount()
  await clock.advance(15_000)
  await clock.settle()

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /確認中/ })).toBeUndefined()
  expect((await ui.find({ type: 'Text', text: /✔ \d/ }))?.text).toBe('✔ 1')
  expect((await ui.find({ type: 'Text', text: /？ \d/ }))?.text).toBe('？ 1')
  await ui.unmount()
  const out = await $.command.run({ command: 'uradori', args: '' })
  expect(out.text).toContain('15秒以内に応答しませんでした')
  // 判定モデルの呼び出しにも時間の上限を付けている
  expect(seen.modelTimeouts).toEqual([30_000])
})

test('リロードで途中になったチェックは、次の起動で ？ にする', async ($, on) => {
  const clock = mock.clock(on)
  world(on, { hang: [LIMITS] })
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
  await $.turn.complete({ answer: ANSWER_LIMITS, durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })
  await clock.settle()
  // 取得の途中でリロードされた（session.start がもう一度来る）
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /確認中/ })).toBeUndefined()
  expect((await ui.find({ type: 'Text', text: /？ \d/ }))?.text).toBe('？ 1')
  await ui.unmount()
})
