// ウラ取りmod（uradori）
// Claude の回答が出典（プロジェクト内のファイル・URL）を挙げたとき、
// mod 自身がその原文を読みに行き、主張と食い違っていないかを確かめる。
// 結果は入力欄の上の帯に出し、［原文を見る］で「原文ポップアップ」を開く。
// ポップアップには実際のページ／ファイルの該当箇所を前後の文脈ごと表示し、
// リンクから実際のサイトの該当箇所に飛んでハイライトできる。
//
//   /uradori          原文ポップアップを開く（結果の要約も返す）
//   /uradori 2        2件目の主張の原文を開く
//   /uradori recheck  直前の回答をもう一度ウラ取りする
//   /uradori off|on   回答ごとの自動ウラ取りを止める／再開する

import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { UradoriCheck, UradoriLine, UradoriRun, UradoriSource, UradoriVerdict } from '../types'
import {
  JUDGE_SYSTEM,
  MAX_CLAIMS,
  contextAround,
  correctionPrompt,
  findSourceRefs,
  htmlToText,
  inlinePairs,
  isSecretPath,
  judgePrompt,
  pageTitle,
  pairingPrompt,
  parseJudgement,
  parsePairs,
  selectExcerpt,
  sourceKey,
  sourceLabel,
  textFragmentUrl,
  toLines,
} from './logic'

/** 判定に使うモデル。精度を上げたいときは 'sonnet' に */
const JUDGE_MODEL = 'haiku'
/** 原文ポップアップのパネル */
const POPUP = 'uradori'

// shape はチェック結果の形を変えたら上げる（古い版が保存した値を読まないため）
const run = atom({ plugin: 'uradori', key: 'run' } as const, null, { shape: 'run-2' })
const selected = atom({ plugin: 'uradori', key: 'selected' } as const, null)
const isEnabled = atom({ plugin: 'uradori', key: 'isEnabled' } as const, true)
const isAutoPopup = atom({ plugin: 'uradori', key: 'isAutoPopup' } as const, true)
const isBandHidden = atom({ plugin: 'uradori', key: 'isBandHidden' } as const, false)

type Fetched = { lines: UradoriLine[]; title: string } | { error: string }

const MARK: Record<UradoriVerdict, string> = { match: '✔', mismatch: '⚠', unknown: '✖', pending: '…' }
const COLOR: Record<UradoriVerdict, 'success' | 'warning' | 'subtle' | 'inactive'> = {
  match: 'success',
  mismatch: 'warning',
  unknown: 'subtle',
  pending: 'inactive',
}

export const register: Register = on => {
  // 直前の回答（/uradori recheck 用）。リロードで消えても困らない
  let lastAnswer = ''

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'uradori',
      description: 'ウラ取り：Claudeの回答の根拠を、原文の該当箇所つきで確かめる（recheck / on / off）',
      argumentHint: '[番号|recheck|on|off]',
    })
    return next(e)
  })

  // ───────── 回答が終わったら、Claude を止めずに裏でウラ取りを始める
  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId !== undefined || e.reason !== 'answer' || e.answer.trim() === '') return result
    lastAnswer = e.answer
    if (!(await read($, isEnabled))) return result

    const answer = e.answer
    const runId = e.turnId
    $.clock.after(0, () => {
      void checkAnswer($, runId, answer).catch(error => {
        $.ui.log(`uradori: ウラ取りに失敗しました（${String(error).slice(0, 200)}）`, { to: 'debug' })
        void finishRun($, runId)
      })
    })
    return result
  })

  // ───────── /uradori
  on('command.run', { command: 'uradori' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()

    if (arg === 'off' || arg === 'on') {
      await update($, isEnabled, () => arg === 'on')
      return {
        text: arg === 'on' ? 'ウラ取り: 回答ごとの自動チェックを再開しました。' : 'ウラ取り: 自動チェックを止めました（/uradori on で再開）。',
      }
    }

    if (arg === 'recheck') {
      const answer = lastAnswer || (await lastAssistantText($))
      if (answer === '') return { text: 'ウラ取り: まだチェックできる回答がありません。' }
      const runId = `recheck-${await $.clock.now()}`
      $.clock.after(0, () => {
        void checkAnswer($, runId, answer).catch(() => void finishRun($, runId))
      })
      return { text: 'ウラ取り: 直前の回答をもう一度チェックしています。' }
    }

    const current = await read($, run)
    // /uradori 2 → 2件目の原文を開く
    const nth = /^\d+$/.test(arg) ? current?.checks[Number(arg) - 1] : undefined
    await openPopup($, (nth ?? firstToShow(current))?.id ?? null, true)
    return { text: summaryText(current) }
  })

  // ───────── 入力欄の上の帯
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const current = await read($, run)
    if (e.props.hasSurvey || current === null || current.checks.length === 0 || (await read($, isBandHidden))) {
      return next(e)
    }
    const { Box, Text, Button } = $.ui.resolve(e)
    const counts = countVerdicts(current.checks)
    const mismatches = current.checks.filter(c => c.verdict === 'mismatch')
    const first = mismatches[0]
    const isChecking = current.status === 'checking'
    const below = await next(e)

    const band = (
      <Box flexDirection="column">
        <Box flexDirection="row" columnGap={1}>
          <Text bold>🔍 ウラ取り</Text>
          {isChecking ? (
            <Text color="inactive">
              原文を確認中… {current.checks.length - counts.pending}/{current.checks.length}
            </Text>
          ) : null}
          <Text color="success">✔ {counts.match}</Text>
          <Text color="warning">⚠ {counts.mismatch}</Text>
          <Text color="subtle">✖ {counts.unknown}</Text>
          <Button
            key="open"
            label="原文を見る"
            hotkey="1"
            variant={first !== undefined ? 'primary' : 'secondary'}
            onPress={() => void openPopup($, firstToShow(current)?.id ?? null, true)}
          />
          {first !== undefined && !isChecking ? (
            <Button key="fix-all" label="訂正させる" hotkey="2" onPress={() => void requestCorrection($, mismatches)} />
          ) : null}
          <Button key="hide" label="×" role="dismiss" onPress={() => void update($, isBandHidden, () => true)} />
        </Box>
        {first !== undefined ? (
          <Box flexDirection="column" paddingLeft={2}>
            <Text color="warning" wrap="truncate-end">
              ⚠ 主張: {first.claim}
            </Text>
            <Text wrap="truncate-end">
              <Text dimColor>  原文 {placeLabel(first)}: </Text>
              {first.evidence[0]?.text.trim() ?? '（該当箇所なし）'}
            </Text>
          </Box>
        ) : null}
      </Box>
    )

    return below ? (
      <Box flexDirection="column">
        {band}
        {below}
      </Box>
    ) : (
      band
    )
  })

  // ───────── 原文ポップアップ
  on('ui.render', { component: 'Pane', requestId: POPUP }, async ($, e) => {
    const { Box, Text, Button, Link } = $.ui.resolve(e)
    const current = await read($, run)
    const checks = current?.checks ?? []
    const id = await read($, selected)
    const index = Math.max(0, checks.findIndex(c => c.id === id))
    const check = checks[index]
    const auto = await read($, isAutoPopup)
    const width = Math.max(20, e.props.bodyColumns)

    if (check === undefined) {
      return (
        <Box flexDirection="column" rowGap={1}>
          <Text dimColor>
            {current?.note || 'まだウラ取りした回答はありません。出典（ファイルやURL）を挙げた回答を自動でチェックします。'}
          </Text>
          <Box>
            <Button key="close" label="閉じる" role="dismiss" onPress={() => void $.ui.close({ id: POPUP })} />
          </Box>
        </Box>
      )
    }

    const isUrl = check.source.kind === 'url'
    const evidenceLines = new Set(check.evidence.map(l => l.line))
    const go = (to: number) => {
      const target = checks[(to + checks.length) % checks.length]
      if (target !== undefined) void update($, selected, () => target.id)
    }

    return (
      <Box flexDirection="column" rowGap={1}>
        {/* 何件目か・判定 */}
        <Box flexDirection="row" columnGap={1}>
          <Text color={COLOR[check.verdict]} bold>
            {MARK[check.verdict]} {verdictLabel(check.verdict)}
          </Text>
          {checks.length > 1 ? <Text dimColor>（{index + 1}/{checks.length}）</Text> : null}
        </Box>

        {/* Claude の主張 */}
        <Box flexDirection="column">
          <Text dimColor>Claude の主張</Text>
          <Text bold>「{check.claim}」</Text>
        </Box>

        {/* 実際の原文 */}
        <Box flexDirection="column">
          <Text dimColor wrap="truncate-end">
            {isUrl ? '実際のページ' : '実際のファイル'}：{check.title || sourceLabel(check.source)}
          </Text>
          {isUrl && check.title ? (
            <Text dimColor wrap="truncate-middle">
              {check.source.ref}
            </Text>
          ) : null}
          <Box flexDirection="column" borderStyle="round" borderColor={COLOR[check.verdict]} paddingX={1} width={Math.min(width, 120)}>
            {check.context.length === 0 ? (
              <Text dimColor>{check.reason || '原文の該当箇所は見つかりませんでした。'}</Text>
            ) : (
              check.context.map(l => {
                const isHit = evidenceLines.has(l.line)
                const gutter = isUrl ? (isHit ? '▶ ' : '  ') : `${isHit ? '▶' : ' '}${String(l.line).padStart(4)}│ `
                return isHit ? (
                  <Text color={COLOR[check.verdict]} bold>
                    {gutter}
                    {l.text}
                  </Text>
                ) : (
                  <Text dimColor>
                    {gutter}
                    {l.text}
                  </Text>
                )
              })
            )}
          </Box>
          {check.reason && check.context.length > 0 ? <Text dimColor>判定の理由：{check.reason}</Text> : null}
        </Box>

        {/* 実際のサイトの該当箇所へ */}
        {isUrl ? (
          <Box flexDirection="column">
            <Link
              href={check.link || check.source.ref}
              label={
                check.link && check.link !== check.source.ref
                  ? '🔗 実際のサイトの該当箇所を開く（ハイライト表示）'
                  : '🔗 実際のサイトを開く'
              }
            />
          </Box>
        ) : null}

        {/* 操作 */}
        <Box flexDirection="row" columnGap={1}>
          {check.verdict === 'mismatch' ? (
            <Button key="fix" label="この主張を訂正させる" hotkey="f" variant="primary" onPress={() => void requestCorrection($, [check])} />
          ) : null}
          {checks.length > 1 ? <Button key="prev" label="← 前" hotkey="p" onPress={() => go(index - 1)} /> : null}
          {checks.length > 1 ? <Button key="next" label="次 →" hotkey="n" onPress={() => go(index + 1)} /> : null}
          <Button key="close" label="閉じる" role="dismiss" onPress={() => void $.ui.close({ id: POPUP })} />
        </Box>
        <Box flexDirection="row" columnGap={1}>
          <Text dimColor>⚠ のとき自動で開く: {auto ? 'オン' : 'オフ'}</Text>
          <Button key="auto" label="切り替え" plain onPress={() => void update($, isAutoPopup, v => !v)} />
        </Box>
      </Box>
    )
  })
}

// ───────────────────────────── ポップアップを開く

async function openPopup($: EngineInterface, checkId: string | null, asked: boolean): Promise<void> {
  await update($, selected, () => checkId)
  // 人が押したときはダイアログとして開く（Esc で閉じる）。自動のときはキー入力を奪わない
  const opened = await $.ui.open(
    asked ? { id: POPUP, title: 'ウラ取り：原文', focus: true, closeOnEscape: true } : { id: POPUP, title: 'ウラ取り：原文' },
  )
  if (!opened.isPlaced && asked) $.ui.toast('原文ポップアップを開けませんでした。/uradori で結果を文字で表示できます')
}

function firstToShow(current: UradoriRun | null): UradoriCheck | undefined {
  if (current === null) return undefined
  return current.checks.find(c => c.verdict === 'mismatch') ?? current.checks[0]
}

// ───────────────────────────── ウラ取りの本体

async function checkAnswer($: EngineInterface, runId: string, answer: string): Promise<void> {
  const root = await $.session.root()
  const refs = findSourceRefs(answer)
  if (refs.length === 0) return

  // ファイルは実在してプロジェクト内にあるものだけ（「Node.js」などの誤検出を落とす）
  const usable: typeof refs = []
  const blocked = new Map<string, string>()
  for (const ref of refs) {
    if (ref.source.kind === 'url') {
      usable.push(ref)
      continue
    }
    const verdict = await checkFilePath($, root, ref.source.ref)
    if (verdict === 'missing') continue
    if (verdict !== 'ok') blocked.set(sourceKey(ref.source), verdict)
    usable.push(ref)
  }
  if (usable.length === 0) return

  // 主張と出典の組。文中に主張がない出典（末尾の参考リンクなど）はモデルに対応づけを頼む
  const { pairs, needsPairing } = inlinePairs(answer, usable)
  const covered = new Set(pairs.map(p => sourceKey(p.source)))
  const toPair = needsPairing.filter(s => !covered.has(sourceKey(s)))
  if (toPair.length > 0 && pairs.length < MAX_CLAIMS) {
    const reply = await $.model.complete({ model: JUDGE_MODEL, prompt: pairingPrompt(answer, toPair), maxTokens: 800 })
    if (reply.isAnswered) pairs.push(...parsePairs(reply.text, toPair))
  }
  if (pairs.length === 0) return

  const checks: UradoriCheck[] = pairs.slice(0, MAX_CLAIMS).map((p, i) => ({
    id: `${runId}-${i}`,
    claim: p.claim,
    source: p.source,
    verdict: 'pending',
    evidence: [],
    context: [],
    title: '',
    link: p.source.kind === 'url' ? p.source.ref : '',
    reason: '',
  }))
  await update($, run, () => ({ id: runId, status: 'checking', checks, note: '' }) satisfies UradoriRun)
  await update($, isBandHidden, () => false)

  // 出典ごとに1回だけ原文を取りに行く（Claude が読んだ要約は使わない）
  const fetched = new Map<string, Promise<Fetched>>()
  const fetchOnce = (source: UradoriSource): Promise<Fetched> => {
    const key = sourceKey(source)
    const reason = blocked.get(key)
    if (reason !== undefined) return Promise.resolve({ error: reason })
    let p = fetched.get(key)
    if (p === undefined) {
      p = fetchSource($, source)
      fetched.set(key, p)
    }
    return p
  }

  // 主張ごとに並行して判定し、終わったものから帯に反映する
  await Promise.all(
    checks.map(async check => {
      const result = await judgeOne($, check, await fetchOnce(check.source))
      await update($, run, current =>
        current === null || current.id !== runId
          ? current
          : { ...current, checks: current.checks.map(c => (c.id === check.id ? { ...c, ...result } : c)) },
      )
    }),
  )

  const done = await finishRun($, runId)
  const firstMismatch = done?.checks.find(c => c.verdict === 'mismatch')
  if (firstMismatch !== undefined) {
    const n = done?.checks.filter(c => c.verdict === 'mismatch').length ?? 0
    $.ui.toast(`⚠ 原文と食い違う主張が${n}件あります（帯の［原文を見る］で原文を表示）`, { timeoutMs: 6000 })
    if (await read($, isAutoPopup)) await openPopup($, firstMismatch.id, false)
  }
}

async function finishRun($: EngineInterface, runId: string): Promise<UradoriRun | null> {
  let finished: UradoriRun | null = null
  await update($, run, current => {
    if (current === null || current.id !== runId) return current
    // 判定が終わらなかったものは「確認できない」にする（✔ にはしない）
    finished = {
      ...current,
      status: 'done',
      checks: current.checks.map(c =>
        c.verdict === 'pending' ? { ...c, verdict: 'unknown', reason: c.reason || '判定が終わりませんでした' } : c,
      ),
    }
    return finished
  })
  return finished
}

type PathVerdict = 'ok' | 'missing' | string

async function checkFilePath($: EngineInterface, root: string, path: string): Promise<PathVerdict> {
  if (isSecretPath(path)) return '秘密情報の可能性があるファイルなので読みませんでした'
  try {
    if (!(await $.fs.exists(path))) return 'missing'
    const [stat, rootStat] = await Promise.all([$.fs.stat(path, { resolve: true }), $.fs.stat(root, { resolve: true })])
    if (stat.kind !== 'file') return 'missing'
    const real = stat.realPath
    const base = rootStat.realPath ?? root
    if (real === undefined || !(real === base || real.startsWith(base.endsWith('/') ? base : `${base}/`))) {
      return 'プロジェクトの外のファイルなので読みませんでした'
    }
    if (stat.size > 2_000_000) return 'ファイルが大きすぎるため確認できませんでした'
    return 'ok'
  } catch {
    return 'missing'
  }
}

async function fetchSource($: EngineInterface, source: UradoriSource): Promise<Fetched> {
  if (source.kind === 'file') {
    try {
      const text = await $.fs.read(source.ref)
      if (text.includes('\u0000')) return { error: 'バイナリファイルなので確認できませんでした' }
      return { lines: toLines(text, 'file'), title: source.ref }
    } catch {
      return { error: 'ファイルを読めませんでした' }
    }
  }

  try {
    const res = await $.http.fetch(source.ref, {
      headers: { accept: 'text/html,text/plain,application/json;q=0.9,*/*;q=0.5' },
    })
    if (!res.ok) return { error: `ページを取得できませんでした（HTTP ${res.status}）` }
    const type = (res.headers['content-type'] ?? '').toLowerCase()
    if (type.includes('pdf')) return { error: 'PDFはまだ確認できません' }
    const isHtml = type.includes('html') || /^\s*<(!doctype|html|head|body)/i.test(res.text.slice(0, 200))
    const text = isHtml ? htmlToText(res.text) : res.text.slice(0, 2_000_000)
    if (text.trim() === '') return { error: '本文を取り出せませんでした（JavaScriptで描画されるページかもしれません）' }
    return { lines: toLines(text, 'url'), title: isHtml ? pageTitle(res.text) : '' }
  } catch (error) {
    return { error: `ページを取得できませんでした（${String(error).slice(0, 80)}）` }
  }
}

async function judgeOne(
  $: EngineInterface,
  check: UradoriCheck,
  fetched: Fetched,
): Promise<Pick<UradoriCheck, 'verdict' | 'evidence' | 'context' | 'title' | 'link' | 'reason'>> {
  const plainLink = check.source.kind === 'url' ? check.source.ref : ''
  if ('error' in fetched) {
    return { verdict: 'unknown', evidence: [], context: [], title: '', link: plainLink, reason: fetched.error }
  }

  const focus = check.source.kind === 'file' ? check.source.line : undefined
  const excerpt = selectExcerpt(fetched.lines, check.claim, focus)
  // 会話の履歴を持たない、まっさらな呼び出しで判定する（同じ思い込みを引き継がない）
  const reply = await $.model.complete({
    model: JUDGE_MODEL,
    system: JUDGE_SYSTEM,
    prompt: judgePrompt(check.claim, check.source, excerpt),
    maxTokens: 400,
  })
  if (!reply.isAnswered) {
    return {
      verdict: 'unknown',
      evidence: [],
      context: contextAround(fetched.lines, [], focus),
      title: fetched.title,
      link: plainLink,
      reason: `判定できませんでした（${reply.reason}）`,
    }
  }

  const judged = parseJudgement(reply.text, excerpt)
  // 根拠の行が取れなかったときは、出典の行番号の行を見せる
  if (judged.evidence.length === 0 && focus !== undefined) {
    const at = fetched.lines.find(l => l.line === focus)
    if (at !== undefined) judged.evidence = [at]
  }
  const quote = longestCell(judged.evidence[0]?.text ?? '')
  return {
    ...judged,
    context: contextAround(fetched.lines, judged.evidence, focus, check.source.kind === 'url' ? 2 : 3),
    title: fetched.title,
    link: check.source.kind === 'url' && quote !== '' ? textFragmentUrl(check.source.ref, quote) : plainLink,
  }
}

/** 表のセル（" | " 区切り）が混ざった行は、いちばん長いセルをハイライト用の文にする */
function longestCell(text: string): string {
  return text
    .split(' | ')
    .map(s => s.trim())
    .reduce((a, b) => (b.length > a.length ? b : a), '')
}

async function requestCorrection($: EngineInterface, items: readonly UradoriCheck[]): Promise<void> {
  if (items.length === 0) return
  await update($, isBandHidden, () => true)
  await $.ui.close({ id: POPUP })
  $.ui.toast('Claudeに訂正を依頼しました')
  await $.prompt.submit({ text: correctionPrompt(items) })
}

async function lastAssistantText($: EngineInterface): Promise<string> {
  const messages = await $.session.messages()
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i]
    if (m !== undefined && m.role === 'assistant' && m.text.trim() !== '') return m.text
  }
  return ''
}

// ───────────────────────────── 表示の小物

function countVerdicts(checks: readonly UradoriCheck[]): Record<UradoriVerdict, number> {
  const counts: Record<UradoriVerdict, number> = { match: 0, mismatch: 0, unknown: 0, pending: 0 }
  for (const c of checks) counts[c.verdict] += 1
  return counts
}

function verdictLabel(v: UradoriVerdict): string {
  return v === 'match' ? '原文と一致' : v === 'mismatch' ? '原文と食い違い' : v === 'unknown' ? '確認できない' : '確認中…'
}

/** 帯に出す「どこの原文か」: ファイルなら「config.ts L3」、URL ならホスト名 */
function placeLabel(check: UradoriCheck): string {
  const first = check.evidence[0]
  if (check.source.kind === 'file') return first !== undefined ? `${check.source.ref} L${first.line}` : check.source.ref
  return hostOf(check.source.ref)
}

function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

function summaryText(current: UradoriRun | null): string {
  if (current === null || current.checks.length === 0) {
    return 'ウラ取り: まだチェックした回答はありません。'
  }
  const c = countVerdicts(current.checks)
  const lines = [
    `ウラ取り: ✔ 一致 ${c.match} / ⚠ 食い違い ${c.mismatch} / ✖ 確認できない ${c.unknown}${c.pending ? ` / 確認中 ${c.pending}` : ''}`,
  ]
  for (const check of current.checks) {
    const ev = check.evidence[0]
    const quote = ev ? ` ― 原文${check.source.kind === 'file' ? ` L${ev.line}` : ''}: ${ev.text.trim().slice(0, 100)}` : ''
    const why = !ev && check.reason ? ` ― ${check.reason}` : ''
    lines.push(`${MARK[check.verdict]} ${check.claim.slice(0, 80)}（${sourceLabel(check.source)}）${quote}${why}`)
    if (check.source.kind === 'url' && check.link) lines.push(`   🔗 該当箇所を開く: ${check.link}`)
  }
  return lines.join('\n')
}
