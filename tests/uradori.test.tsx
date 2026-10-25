import { describe, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import {
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
  pages?: Record<string, { status: number; type: string; text: string }>
  judge?: (prompt: string) => string
}

/** エンジンの代わり: ファイル・ネット・モデル・プロンプトをテストが答える */
function world(on: On, w: World) {
  const seen = {
    prompts: [] as string[],
    judged: [] as string[],
    fetched: [] as string[],
    read: [] as string[],
    opened: [] as { id: string; focus?: true }[],
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
    const page = pages[e.url]
    if (page === undefined) return { deny: 'offline' }
    return { value: { status: page.status, ok: page.status < 300, headers: { 'content-type': page.type }, text: page.text } }
  })
  on('model.complete', (_, e) => {
    seen.judged.push(e.prompt)
    return { value: { isAnswered: true, text: (w.judge ?? (() => '{"verdict":"unknown"}'))(e.prompt), usage: USAGE } }
  })
  on('prompt.submit', (_, e) => {
    seen.prompts.push(e.text)
    return { text: e.text }
  })
  on('ui.toast', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  on('ui.open', (_, e) => {
    seen.opened.push({ id: e.id, ...(e.focus ? { focus: e.focus } : {}) })
    return { value: { isPlaced: true } }
  })
  on('ui.close', () => ({ value: undefined }))
  on('ui.render', ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box />
  })
  return seen
}

test('デモ: config.ts と食い違う主張に ⚠ が付き、原文の行が帯に出る', async ($, on) => {
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
    expect((await ui.find({ type: 'Text', text: /⚠ 1/ }))?.text).toBe('⚠ 1')
    expect(await ui.find({ type: 'Text', text: /主張: タイムアウトは30秒です/ })).toBeDefined()
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

test('取得に失敗した出典は ✖（確認できない）。✔ にはならない', async ($, on) => {
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
  expect((await ui.find({ type: 'Text', text: /✖ 1/ }))?.text).toBe('✖ 1')
  expect((await ui.find({ type: 'Text', text: /✔ 0/ }))?.text).toBe('✔ 0')
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

test('⚠ のとき原文ポップアップが開き、実際のページの該当箇所とハイライト付きリンクが出る', async ($, on) => {
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

  // 自動で開くときは、キー入力を奪わない（focus なし）
  expect(seen.opened).toEqual([{ id: 'uradori' }])

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
  expect(await ui.find({ type: 'Text', text: /⚠ 原文と食い違い/ })).toBeDefined()
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
  expect((await ui.find({ type: 'Text', text: /⚠ 1/ }))?.text).toBe('⚠ 1')
  expect(await ui.find({ type: 'Text', text: /50 requests per minute/ })).toBeDefined()
  await ui.unmount()
})

test('秘密情報らしいファイルは読まずに ✖ にする', async ($, on) => {
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
