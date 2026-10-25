// ウラ取りmod（uradori）
// Claude の回答が出典（プロジェクト内のファイル・URL）を挙げたとき、
// mod 自身がその原文を読みに行き、主張と食い違っていないかを確かめる。
// 質問が根拠を求めていたとき（「根拠付きで」「一次情報は？」など）は、そのターンを必ずウラ取りし、
// 出典が名前だけ・出典なしなら、そのことを帯に出して一次情報での裏付けを頼めるようにする。
// 結果は入力欄の上の帯に出し、［原文を見る］で「原文ポップアップ」を開く。
// ポップアップには実際のページ／ファイルの該当箇所を前後の文脈ごと表示し、
// リンクから実際のサイトの該当箇所に飛んでハイライトできる。
//
//   /uradori          原文ポップアップを開く（結果の要約も返す）
//   /uradori 2        2件目の主張の原文を開く
//   /uradori recheck  直前の回答をもう一度ウラ取りする
//   /uradori off|on   回答ごとの自動ウラ取りを止める／再開する
//   /uradori strict   毎回の回答をウラ取り対象にする（もう一度で元に戻す）
//   /uradori why      直前の回答をウラ取りした／しなかった理由を表示する
//   /uradori archive on|off  アクセス拒否のとき Web Archive の保存版で確かめる（既定: on）
//   /uradori popup on|off    ✖ のとき原文ポップアップを自動で開く（既定: on）

import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { UradoriCheck, UradoriLine, UradoriRun, UradoriSource, UradoriTrigger, UradoriVerdict } from '../types'
import {
  BROWSER_HEADERS,
  EVIDENCE_CONTEXT,
  JUDGE_SYSTEM,
  MAX_CLAIMS,
  alternativeSourcePrompt,
  archiveDate,
  archiveUrl,
  claimAnchor,
  claimPriority,
  contextAround,
  correctionPrompt,
  evidenceRequest,
  findNamedSources,
  findQuote,
  fitCells,
  fragmentQuote,
  findSourceRefs,
  groundVerdict,
  groundingPrompt,
  htmlToText,
  inlinePairs,
  isBlockedResponse,
  isPdfUrl,
  isSecretPath,
  judgePrompt,
  pageTitle,
  pairingPrompt,
  parseJudgement,
  parsePairs,
  pdfPage,
  placeMarks,
  selectExcerpt,
  sourceKey,
  sourceLabel,
  textFragmentUrl,
  toLines,
  urlHoldReason,
} from './logic'

/** 判定に使うモデル。精度を上げたいときは 'sonnet' に */
const JUDGE_MODEL = 'haiku'
/** 1回の取得（リダイレクト1回ぶん）を待つ上限 */
const FETCH_TIMEOUT_MS = 15_000
/** 判定モデルの1回の呼び出しを待つ上限 */
const MODEL_TIMEOUT_MS = 30_000
/** 主張1件（取得と判定）を待つ上限。過ぎたら ？ にする（帯が「確認中」のまま残らないように） */
const CHECK_TIMEOUT_MS = 60_000
/** 原文ポップアップのパネル */
const POPUP = 'uradori'

// shape はチェック結果の形を変えたら上げる（古い版が保存した値を読まないため）
const run = atom({ plugin: 'uradori', key: 'run' } as const, null, { shape: 'run-7' })
const history = atom({ plugin: 'uradori', key: 'history' } as const, [], { shape: 'run-7' })
/** 本文の印を残しておく回答の数 */
const MAX_HISTORY = 10
const selected = atom({ plugin: 'uradori', key: 'selected' } as const, null)
const isEnabled = atom({ plugin: 'uradori', key: 'isEnabled' } as const, true)
// 既定はオン（✖ のとき原文ポップアップをダイアログで開く）。shape を上げて、前の版で保存された「オフ」は読まない
const isAutoPopup = atom({ plugin: 'uradori', key: 'isAutoPopup' } as const, true, { shape: 'v3' })
const isBandHidden = atom({ plugin: 'uradori', key: 'isBandHidden' } as const, false)
const armed = atom({ plugin: 'uradori', key: 'armed' } as const, null)
const isStrict = atom({ plugin: 'uradori', key: 'isStrict' } as const, false)
const isArchive = atom({ plugin: 'uradori', key: 'isArchive' } as const, true)

type Fetched =
  | { lines: UradoriLine[]; title: string; via: string }
  | { error: string; isBlocked: boolean; isPdf?: boolean; isHeld?: boolean }

// ✖ は「間違い」と読まれるので、いちばん重い食い違いに使う。確認できないだけのものは ？
const MARK: Record<UradoriVerdict, string> = { match: '✔', mismatch: '✖', drift: '△', unknown: '？', pending: '…' }
const markOf = (c: UradoriCheck): string => (c.isHeld ? '⏸' : c.isBlocked ? '🔒' : c.isPdf ? '📄' : MARK[c.verdict])
type Tone = 'success' | 'error' | 'warning' | 'subtle' | 'inactive'
const COLOR: Record<UradoriVerdict, Tone> = {
  match: 'success',
  mismatch: 'error',
  drift: 'warning',
  unknown: 'subtle',
  pending: 'inactive',
}

export const register: Register = on => {
  // 直前の回答（/uradori recheck 用）と、ウラ取りした／しなかった理由（/uradori why 用）。
  // リロードで消えても困らない
  let lastAnswer = ''
  let lastTrigger: UradoriTrigger = 'auto'
  const why = { text: 'まだ回答がありません。' }

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'uradori',
      description: 'ウラ取り：Claudeの回答の根拠を、原文の該当箇所つきで確かめる（recheck / on / off / strict / why）',
      argumentHint: '[番号|recheck|on|off|strict|why|archive on|archive off|popup on|popup off]',
    })
    // リロードや再起動で途中のチェックは止まる。「確認中」のまま残さず ？ にする
    const interrupted = (r: UradoriRun): UradoriRun => (r.status === 'checking' ? settleRun(r, '確認の途中で中断されました') : r)
    await update($, run, r => (r === null ? r : interrupted(r)))
    await update($, history, h => h.map(interrupted))
    return next(e)
  })

  // ───────── 根拠を求める質問なら、次の回答をウラ取り対象にし、URL つきで答えるよう Claude にだけ伝える
  on('prompt.submit', async ($, e, next) => {
    if (e.command !== undefined || !(await read($, isEnabled))) return next(e)
    const strict = await read($, isStrict)
    const word = evidenceRequest(e.text)
    if (word === undefined && !strict) return next(e)
    await update($, armed, () => word ?? 'strict')
    return next({ ...e, context: [...(e.context ?? []), EVIDENCE_CONTEXT] })
  })

  // ───────── 回答が終わったら、Claude を止めずに裏でウラ取りを始める
  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId !== undefined) return result
    // 印はこのターンかぎり（中断されたターンでも消す）
    const word = await read($, armed)
    if (word !== null) await update($, armed, () => null)
    if (e.reason !== 'answer' || e.answer.trim() === '') return result
    lastAnswer = e.answer
    if (!(await read($, isEnabled))) {
      why.text = 'ウラ取り: 自動チェックがオフです（/uradori on で再開）。'
      // 前の回答の結果を、この回答の結果のように見せない
      await update($, run, current => (current?.status === 'checking' ? current : null))
      return result
    }

    const answer = e.answer
    const runId = e.turnId
    const trigger: UradoriTrigger = word === null ? 'auto' : word === 'strict' ? 'strict' : 'asked'
    lastTrigger = trigger
    why.text =
      trigger === 'asked'
        ? `ウラ取り対象: 質問に「${word}」があったため、この回答は必ずチェックします。`
        : trigger === 'strict'
          ? 'ウラ取り対象: /uradori strict 中のため、この回答は必ずチェックします。'
          : 'ウラ取り: 根拠を求める質問ではないため、回答に URL・ファイルの出典があるときだけチェックします。'
    $.clock.after(0, () => {
      void checkAnswer($, runId, answer, trigger, why).catch(error => {
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

    if (arg === 'strict') {
      const now = await update($, isStrict, v => !v)
      return {
        text: now
          ? 'ウラ取り: strict モード。毎回の回答をウラ取り対象にし、Claude に出典を URL で書くよう伝えます（/uradori strict でもう一度押すと戻ります）。'
          : 'ウラ取り: 通常モードに戻しました。根拠を求める質問のときと、回答に URL・ファイルがあるときにチェックします。',
      }
    }

    if (arg === 'why') return { text: why.text }

    if (arg === 'archive on' || arg === 'archive off') {
      await update($, isArchive, () => arg === 'archive on')
      return {
        text:
          arg === 'archive on'
            ? 'ウラ取り: アクセス拒否のページは Web Archive（web.archive.org）の保存版で確かめます。'
            : 'ウラ取り: Web Archive は使いません。アクセス拒否のページは 🔒 になります。',
      }
    }

    if (arg === 'popup on' || arg === 'popup off') {
      await update($, isAutoPopup, () => arg === 'popup on')
      return {
        text:
          arg === 'popup on'
            ? 'ウラ取り: ✖（原文と食い違い）のとき、原文ポップアップを自動で開きます。'
            : 'ウラ取り: ✖ のときも自動では開きません（帯の［原文を見る］で開けます）。',
      }
    }

    if (arg === 'recheck') {
      const answer = lastAnswer || (await lastAssistantText($))
      if (answer === '') return { text: 'ウラ取り: まだチェックできる回答がありません。' }
      const runId = `recheck-${await $.clock.now()}`
      const trigger = lastTrigger
      $.clock.after(0, () => {
        void checkAnswer($, runId, answer, trigger, why).catch(() => void finishRun($, runId))
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
    if (e.props.hasSurvey) return next(e)
    const { Box, Text, Button } = $.ui.resolve(e)
    // 根拠モードで送ったターンは、回答を待っているあいだも、そのことと理由を出しておく
    // （Claude にだけ見える指示を足しているので、回答の書き方が変わる理由が分かるように）
    const word = await read($, armed)
    const armedLine =
      word === null ? null : (
        <Box key="armed" flexDirection="row" columnGap={1}>
          <Text bold>🔍 根拠モードで送信</Text>
          <Text color="subtle" wrap="truncate-end">
            {word === 'strict' ? '（/uradori strict 中）' : `（質問の「${word}」に反応）`}
            Claude に出典を URL・ファイルで書くよう伝え、回答後に原文で確かめます
          </Text>
        </Box>
      )

    const current = await read($, run)
    // 根拠を求められたターン（trigger が auto 以外）は、チェックできる主張がなくても帯を出す
    const isAsked = current !== null && current.trigger !== 'auto'
    if (current === null || (current.checks.length === 0 && !isAsked) || (await read($, isBandHidden))) {
      if (armedLine === null) return next(e)
      const under = await next(e)
      return under ? (
        <Box flexDirection="column">
          {armedLine}
          {under}
        </Box>
      ) : (
        armedLine
      )
    }
    const counts = tally(current.checks)
    const mismatches = current.checks.filter(c => c.verdict === 'mismatch')
    const first = mismatches[0]
    const isChecking = current.status === 'checking'
    const named = current.unsourced ?? []
    const blocked = current.checks.filter(c => c.isBlocked)
    const pdfs = current.checks.filter(c => c.isPdf)
    const below = await next(e)
    const hide = <Button key="hide" label="×" role="dismiss" onPress={() => void update($, isBandHidden, () => true)} />
    const groundButton = (
      <Button key="ground" label="一次情報で裏付けさせる" hotkey="3" variant="primary" onPress={() => void requestGrounding($, named)} />
    )

    const band =
      current.checks.length === 0 ? (
        // 根拠を求められたのに、URL・ファイルで確かめられる出典がなかった
        <Box flexDirection="column">
          <Box flexDirection="row" columnGap={1}>
            <Text bold>🔍 ウラ取り</Text>
            {isChecking ? (
              <Text color="inactive">回答の出典を確認中…</Text>
            ) : (
              <Text color="subtle">⚪ {named.length > 0 ? `URLなしの出典 ${named.length}件（原文を確かめられません）` : '根拠が示されていません'}</Text>
            )}
            {isChecking ? null : groundButton}
            {hide}
          </Box>
          {!isChecking && named.length > 0 ? (
            <Box paddingLeft={2}>
              <Text dimColor wrap="truncate-end">
                {named.join(' / ')}
              </Text>
            </Box>
          ) : null}
        </Box>
      ) : (
      <Box flexDirection="column">
        <Box flexDirection="row" columnGap={1}>
          <Text bold>🔍 ウラ取り</Text>
          {isChecking ? (
            <Text color="inactive">
              原文を確認中… {current.checks.length - counts.pending}/{current.checks.length}
            </Text>
          ) : null}
          {tallyCells(counts).map(cell => (
            <Text key={cell.text} color={cell.color}>
              {cell.text}
            </Text>
          ))}
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
          {blocked.length + pdfs.length > 0 && !isChecking ? (
            <Button key="alt" label="別の出典を探させる" hotkey="4" onPress={() => void requestAlternative($, [...blocked, ...pdfs])} />
          ) : null}
          {hide}
        </Box>
        {named.length > 0 && !isChecking ? (
          <Box flexDirection="row" columnGap={1} paddingLeft={2}>
            <Text color="subtle" wrap="truncate-end">
              ⚪ ほかに URLなしの出典 {named.length}件
            </Text>
            {groundButton}
          </Box>
        ) : null}
        {first !== undefined ? (
          <Box flexDirection="column" paddingLeft={2}>
            <Text color="error" wrap="truncate-end">
              ✖ 主張: {first.claim}
            </Text>
            <Text wrap="truncate-end">
              <Text dimColor>  原文 {placeLabel(first)}: </Text>
              {first.evidence[0]?.text.trim() ?? '（該当箇所なし）'}
            </Text>
          </Box>
        ) : null}
      </Box>
      )

    return armedLine !== null || below ? (
      <Box flexDirection="column">
        {armedLine}
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
            {markOf(check)}{' '}
            {check.isHeld
              ? '自動では取りに行かなかったURL'
              : check.isBlocked
                ? 'アクセス拒否で確認できない'
                : check.isPdf
                  ? 'PDFのため自動で確認できない'
                  : verdictLabel(check.verdict)}
          </Text>
          {checks.length > 1 ? <Text dimColor>（{index + 1}/{checks.length}）</Text> : null}
        </Box>

        {/* Claude の主張 */}
        <Box flexDirection="column">
          <Text dimColor>Claude の主張</Text>
          <Text bold>「{check.claim}」</Text>
          {check.quote ? (
            <Text
              color={check.isQuoteFound === true ? 'success' : check.isQuoteFound === false ? 'warning' : 'subtle'}
              wrap="truncate-end"
            >
              Claude の引用「{check.quote}」
              {check.isQuoteFound === true ? ' ✔ 原文にあり' : check.isQuoteFound === false ? ' △ 原文に見つかりません' : ''}
            </Text>
          ) : null}
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
          {check.via ? (
            <Text color="subtle">📦 {check.via} の保存版で確認しました（今のページとは内容が違う可能性があります）</Text>
          ) : null}
        </Box>

        {/* 実際のサイトの該当箇所へ。保留の URL は開くだけでも中身が送られるので、リンクにしない */}
        {isUrl && !check.isHeld ? (
          <Box flexDirection="column">
            <Link
              href={check.link || check.source.ref}
              label={
                check.isPdf
                  ? `🔗 PDFを開いて自分で確かめる${pdfPage(check.source.ref) !== undefined ? `（${pdfPage(check.source.ref)}ページ）` : ''}`
                  : check.isBlocked
                  ? '🔗 ブラウザで開いて自分で確かめる'
                  : check.link && check.link !== check.source.ref
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
          {check.isHeld && current?.status === 'done' ? (
            <Button key="fetch" label="原文を取りに行く" hotkey="g" variant="primary" onPress={() => void fetchHeld($, check)} />
          ) : null}
          {check.isBlocked || check.isPdf ? (
            <Button key="alt" label="別の出典を探させる" hotkey="a" variant="primary" onPress={() => void requestAlternative($, [check])} />
          ) : null}
          {checks.length > 1 ? <Button key="prev" label="← 前" hotkey="p" onPress={() => go(index - 1)} /> : null}
          {checks.length > 1 ? <Button key="next" label="次 →" hotkey="n" onPress={() => go(index + 1)} /> : null}
          <Button key="close" label="閉じる" role="dismiss" onPress={() => void $.ui.close({ id: POPUP })} />
        </Box>
        <Box flexDirection="row" columnGap={1}>
          <Text dimColor>✖（食い違い）のとき自動で開く: {auto ? 'オン' : 'オフ'}</Text>
          <Button key="auto" label="切り替え" plain onPress={() => void update($, isAutoPopup, v => !v)} />
        </Box>
      </Box>
    )
  })

  // ───────── 回答の本文: 主張の文の後ろに ✔ ✖ などを付け、マウスを乗せると原文のカードを出す
  on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
    if (e.props.isSummary) return next(e)
    const text = e.props.text
    // どの回答のウラ取りか: 本文の頭がその回答に含まれ、主張の文が本文にあるもの（新しい順）
    const head = text.trim().slice(0, 80)
    const runs = await read($, history)
    const found = runs.find(r => head !== '' && r.answer.includes(head) && r.checks.some(c => c.anchor !== '' && text.includes(c.anchor)))
    if (found === undefined) return next(e)

    const { text: marked, placed } = placeMarks(
      text,
      found.checks.map(c => ({ anchor: c.anchor, mark: inlineMark(c) })),
    )
    if (placed.length === 0) return next(e)
    // 本文はエンジンにそのまま描かせる（表示だけ変わり、保存された回答は変わらない）
    const drawn = await next({ ...e, props: { ...e.props, text: marked } })
    // スマートフォンにはマウスがないので、カードは出さない（詳しくは帯と /uradori で）
    if (e.surface === 'mobile' || !drawn) return drawn

    const { Box, Text } = $.ui.resolve(e)
    const checks = placed
      .map(i => found.checks[i])
      .filter((c): c is UradoriCheck => c !== undefined)
      .sort((a, b) => cardOrder(a) - cardOrder(b))
    const shown = checks.slice(0, MAX_CARD_CLAIMS)
    const width = Math.max(30, Math.min((e.viewport?.columns ?? 100) - 4, 96))
    const rows: { text: string; color?: Tone; isDim?: boolean; isBold?: boolean }[] = []
    // 件数は帯と同じ数え方で、この回答のチェック全体を数える（本文に印を付けられなかった主張も）
    const counts = tallyCells(tally(found.checks))
      .map(cell => cell.text)
      .join('  ')
    rows.push({
      text: `🔍 ウラ取り ${found.status === 'checking' ? '原文を確認中…' : counts}`,
      isBold: true,
    })
    for (const c of shown) {
      const isLoud = c.verdict === 'mismatch' || c.verdict === 'drift'
      rows.push({ text: `${markOf(c)} ${c.claim}`, color: COLOR[c.verdict], isBold: isLoud })
      if (c.verdict === 'pending') continue
      if (c.evidence.length > 0) {
        for (const l of c.evidence.slice(0, 2)) rows.push({ text: `  ▶ ${placeLabel(c, l)}: ${l.text.trim()}`, isDim: !isLoud })
      } else {
        rows.push({ text: `  ${sourceLabel(c.source)} ― ${c.reason || '該当箇所なし'}`, isDim: true })
      }
    }
    if (checks.length > shown.length) rows.push({ text: `ほか ${checks.length - shown.length}件は /uradori で`, isDim: true })
    const worst: Tone = checks.some(c => c.verdict === 'mismatch')
      ? 'error'
      : checks.some(c => c.verdict === 'drift')
        ? 'warning'
        : checks.every(c => c.verdict === 'match')
          ? 'success'
          : 'subtle'
    // 枠の上下 2 行ぶん。カードは本文の上に重ねて出す（下は入力欄に近く、切れやすい）
    const height = rows.length + 2

    return (
      <Box key={`uradori-msg-${e.requestId}`} flexDirection="column">
        {drawn}
        <Box
          position="absolute"
          top={-height}
          left={2}
          width={width}
          height={height}
          display="none"
          hover={{ display: 'flex' }}
          flexDirection="column"
          borderStyle="round"
          borderColor={worst}
          paddingX={1}
        >
          {rows.map(r => (
            // 行の幅いっぱいまで空白で埋めて、下にある本文の文字を上書きする（透けないように）
            <Text color={r.color} dimColor={r.isDim} bold={r.isBold} wrap="truncate-end">
              {fitCells(r.text, width - 4)}
            </Text>
          ))}
        </Box>
      </Box>
    )
  })
}

// ───────────────────────────── ポップアップを開く

async function openPopup($: EngineInterface, checkId: string | null, asked: boolean): Promise<void> {
  await update($, selected, () => checkId)
  // ダイアログとして開く（Esc で閉じる）。focus は頼むだけで、入力欄に文字があるときはエンジンがキー入力を渡さない
  const opened = await $.ui.open({ id: POPUP, title: 'ウラ取り：原文', focus: true, closeOnEscape: true })
  if (opened.isPlaced) return
  // 人が押していないパネルは、画面が広いときしか置かれない（ターミナルで 144 桁から）。そのときはトーストで知らせる
  $.ui.toast(
    asked
      ? '原文ポップアップを開けませんでした。/uradori で結果を文字で表示できます'
      : '✖ 原文と食い違う主張があります。帯の［原文を見る］か /uradori で原文を開けます',
  )
}

function firstToShow(current: UradoriRun | null): UradoriCheck | undefined {
  if (current === null) return undefined
  return (
    current.checks.find(c => c.verdict === 'mismatch') ??
    current.checks.find(c => c.verdict === 'drift') ??
    current.checks.find(c => c.isHeld) ??
    current.checks[0]
  )
}

// ───────────────────────────── ウラ取りの本体

async function checkAnswer(
  $: EngineInterface,
  runId: string,
  answer: string,
  trigger: UradoriTrigger,
  why: { text: string },
): Promise<void> {
  // 根拠を求められたターンは、出典がなくても結果を帯に必ず出す
  const isAsked = trigger !== 'auto'
  const named = isAsked ? findNamedSources(answer) : []
  const unsourced = isAsked ? named : null
  if (isAsked) {
    await update($, run, () => ({ id: runId, status: 'checking', checks: [], note: '', trigger, unsourced: null, answer: '' }) satisfies UradoriRun)
    await update($, isBandHidden, () => false)
  }
  /** チェックできる主張がなかったとき。根拠を求められたターンだけ、そのことを帯に残す */
  const nothingToCheck = async (reason: string): Promise<void> => {
    why.text = `${why.text}
→ ${reason}${named.length > 0 ? `（名前だけの出典 ${named.length}件: ${named.join(' / ')}）` : ''}`
    await update($, run, current => {
      // ほかの回答をまだチェック中（/uradori recheck など）なら、そちらを残す
      if (current !== null && current.id !== runId && current.status === 'checking') return current
      // 根拠を求められたターンだけ、確かめられなかったことを帯に残す。
      // それ以外は前の回答の結果を消す（帯に残ると、この回答の結果に見えてしまう）
      return isAsked ? ({ id: runId, status: 'done', checks: [], note: reason, trigger, unsourced: named, answer: '' }) satisfies UradoriRun : null
    })
  }

  const root = await $.session.root()
  const refs = findSourceRefs(answer)
  if (refs.length === 0) return nothingToCheck('回答に URL・ファイルの出典がありませんでした。')

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
  if (usable.length === 0) return nothingToCheck('出典らしいファイル名はありましたが、プロジェクト内に実在しませんでした。')

  // 主張と出典の組。文中に主張がない出典（末尾の参考リンクなど）はモデルに対応づけを頼む
  const { pairs, needsPairing } = inlinePairs(answer, usable)
  const covered = new Set(pairs.map(p => sourceKey(p.source)))
  const toPair = needsPairing.filter(s => !covered.has(sourceKey(s)))
  if (toPair.length > 0 && pairs.length < MAX_CLAIMS) {
    const reply = await $.model.complete({
      model: JUDGE_MODEL,
      prompt: pairingPrompt(answer, toPair),
      maxTokens: 800,
      timeoutMs: MODEL_TIMEOUT_MS,
    })
    if (reply.isAnswered) pairs.push(...parsePairs(reply.text, toPair))
  }
  if (pairs.length === 0) return nothingToCheck('出典はありましたが、確かめる主張と対にできませんでした（作業の報告など）。')

  // 根拠を求められたターンは、数値・日付・規格などの主張から先に枠を使う（並び替えは安定）
  if (isAsked) pairs.sort((a, b) => claimPriority(b.claim) - claimPriority(a.claim))
  why.text = `${why.text}
→ 主張 ${Math.min(pairs.length, MAX_CLAIMS)}件を原文で確認しました。`

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
    isBlocked: false,
    via: '',
    isPdf: false,
    isHeld: false,
    // 「」で添えた引用を優先し、なければ URL のテキストフラグメント
    quote: p.quote ?? (p.source.kind === 'url' ? fragmentQuote(p.source.ref) : undefined) ?? '',
    isQuoteFound: null,
    anchor: claimAnchor(answer, p.claim),
  }))
  await startRun($, { id: runId, status: 'checking', checks, note: '', trigger, unsourced, answer: answer.slice(0, 50_000) })
  await update($, isBandHidden, () => false)

  // 出典ごとに1回だけ原文を取りに行く（Claude が読んだ要約は使わない）
  const useArchive = await read($, isArchive)
  const fetched = new Map<string, Promise<Fetched>>()
  const fetchOnce = (source: UradoriSource): Promise<Fetched> => {
    const key = sourceKey(source)
    const reason = blocked.get(key)
    if (reason !== undefined) return Promise.resolve({ error: reason, isBlocked: false })
    let p = fetched.get(key)
    if (p === undefined) {
      p = fetchSource($, source, useArchive)
      fetched.set(key, p)
    }
    return p
  }

  // 主張ごとに並行して判定し、終わったものから帯に反映する。時間内に終わらないものは ？ にする
  await Promise.all(
    checks.map(async check => {
      const result =
        (await withTimeout($, CHECK_TIMEOUT_MS, (async () => judgeOne($, check, await fetchOnce(check.source)))())) ??
        timedOut(check)
      await updateRun($, runId, current => ({
        ...current,
        checks: current.checks.map(c => (c.id === check.id ? { ...c, ...result } : c)),
      }))
    }),
  )

  // 知らせるのは帯だけ（トーストは出さない）。ポップアップの自動表示は、オンにした人だけ
  const done = await finishRun($, runId)
  const firstMismatch = done?.checks.find(c => c.verdict === 'mismatch')
  if (firstMismatch !== undefined && (await read($, isAutoPopup))) await openPopup($, firstMismatch.id, false)
}

async function finishRun($: EngineInterface, runId: string): Promise<UradoriRun | null> {
  return updateRun($, runId, current => settleRun(current, '判定が終わりませんでした'))
}

/** チェックを終わりにする。判定が終わらなかったものは「確認できない」にする（✔ にはしない） */
function settleRun(current: UradoriRun, reason: string): UradoriRun {
  return {
    ...current,
    status: 'done',
    checks: current.checks.map(c => (c.verdict === 'pending' ? { ...c, verdict: 'unknown', reason: c.reason || reason } : c)),
  }
}

/** ms のうちに終わらなければ undefined（work そのものは止められないので、結果を使わないだけ） */
function withTimeout<T>($: EngineInterface, ms: number, work: Promise<T>): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    let isSettled = false
    const timer = $.clock.after(ms, () => {
      if (isSettled) return
      isSettled = true
      resolve(undefined)
    })
    work.then(
      value => {
        if (isSettled) return
        isSettled = true
        timer.cancel()
        resolve(value)
      },
      (error: unknown) => {
        if (isSettled) return
        isSettled = true
        timer.cancel()
        reject(error)
      },
    )
  })
}

type JudgeResult = Pick<
  UradoriCheck,
  'verdict' | 'evidence' | 'context' | 'title' | 'link' | 'reason' | 'isBlocked' | 'via' | 'isPdf' | 'isHeld' | 'isQuoteFound'
>

/** 時間内に取得・判定が終わらなかった主張 */
function timedOut(check: UradoriCheck): JudgeResult {
  return {
    verdict: 'unknown',
    evidence: [],
    context: [],
    title: '',
    link: check.source.kind === 'url' ? check.source.ref : '',
    reason: `${CHECK_TIMEOUT_MS / 1000}秒以内に原文を確かめられませんでした`,
    isBlocked: false,
    via: '',
    isPdf: false,
    isHeld: false,
    isQuoteFound: null,
  }
}

/**
 * ⏸（自動では取りに行かなかった URL）を、人が［原文を取りに行く］を押したときだけ取りに行く。
 * Web Archive には送らない（秘密らしい値を含むかもしれない URL を第三者に渡さない）
 */
async function fetchHeld($: EngineInterface, check: UradoriCheck): Promise<void> {
  const runId = check.id.slice(0, check.id.lastIndexOf('-'))
  const apply = (result: Partial<UradoriCheck>, status: UradoriRun['status']) =>
    updateRun($, runId, current => ({
      ...current,
      status,
      checks: current.checks.map(c => (c.id === check.id ? { ...c, ...result } : c)),
    }))
  await apply({ verdict: 'pending', isHeld: false, reason: '' }, 'checking')
  const result =
    (await withTimeout($, CHECK_TIMEOUT_MS, (async () => judgeOne($, check, await fetchSource($, check.source, false, true)))()).catch(
      () => undefined,
    )) ?? timedOut(check)
  await apply(result, 'done')
}

/** チェックを始める: 帯の結果にし、本文の印のための履歴の先頭にも入れる */
async function startRun($: EngineInterface, value: UradoriRun): Promise<void> {
  await update($, run, () => value)
  await update($, history, h => [value, ...h.filter(r => r.id !== value.id)].slice(0, MAX_HISTORY))
}

/**
 * runId のチェック結果を書き換える。帯の結果（いまもその回答のものなら）と履歴の両方。
 * 次の回答で帯の結果が入れ替わっても、前の回答の本文の印は履歴で最後まで更新される
 */
async function updateRun(
  $: EngineInterface,
  runId: string,
  fn: (current: UradoriRun) => UradoriRun,
): Promise<UradoriRun | null> {
  let changed: UradoriRun | null = null
  await update($, run, current => {
    if (current === null || current.id !== runId) return current
    changed = fn(current)
    return changed
  })
  await update($, history, h =>
    h.map(r => {
      if (r.id !== runId) return r
      const next = fn(r)
      changed ??= next
      return next
    }),
  )
  return changed
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

/** allowHeld: 人が［原文を取りに行く］を押したときだけ true（⏸ の URL も取りに行く） */
async function fetchSource($: EngineInterface, source: UradoriSource, useArchive: boolean, allowHeld = false): Promise<Fetched> {
  if (source.kind === 'file') {
    try {
      const text = await $.fs.read(source.ref)
      if (text.includes('\u0000')) return { error: 'バイナリファイルなので確認できませんでした', isBlocked: false }
      return { lines: toLines(text, 'file'), title: source.ref, via: '' }
    } catch {
      return { error: 'ファイルを読めませんでした', isBlocked: false }
    }
  }

  // PDF は本文を取り出せないので、取りに行かずに 📄（利用者が自分で開いて確かめる）
  if (isPdfUrl(source.ref)) return { error: PDF_ERROR, isBlocked: false, isPdf: true }

  // Claude が書いた URL に、人の確認なしにアクセスしてよいか（社内のアドレス・秘密らしい値を含む URL は ⏸）
  const hold = allowHeld ? undefined : urlHoldReason(source.ref)
  if (hold !== undefined) return { error: `${hold}、自動では取りに行きませんでした`, isBlocked: false, isHeld: true }

  const direct = await fetchPage($, source.ref, allowHeld)
  if (!('error' in direct) || !direct.isBlocked || !useArchive) return direct

  // アクセス拒否（ボット対策など）→ Web Archive の保存版で確かめる
  const archived = await fetchPage($, archiveUrl(source.ref), false)
  if ('error' in archived) {
    return { error: `${direct.error}。Web Archive にも読める保存版がありませんでした`, isBlocked: true }
  }
  return archived
}

const PDF_ERROR = 'PDFは自動で読めません。PDFを開いて、自分で確かめてください'

/** ページを1つ取りに行き、本文の行にする。アクセス拒否は isBlocked で返す */
async function fetchPage($: EngineInterface, link: string, allowHeld: boolean): Promise<Fetched> {
  // #page=6 や #:~:text=… はブラウザ向けの場所の指定。取りに行くのはページそのもの
  const url = link.split('#')[0] ?? link
  // $.http.fetch には時間の上限がないので、応答のないサイトで止まらないように待つ時間を区切る
  const get = (target: string) => withTimeout($, FETCH_TIMEOUT_MS, $.http.fetch(target, { headers: BROWSER_HEADERS }))
  const noReply = { error: `ページが${FETCH_TIMEOUT_MS / 1000}秒以内に応答しませんでした`, isBlocked: false }
  try {
    let res = await get(url)
    if (res === undefined) return noReply
    // リダイレクトを自分で追う（Web Archive は最新の保存版へ 302 で飛ばす）
    for (let hop = 0; hop < 3 && res.status >= 300 && res.status < 400 && res.headers.location; hop += 1) {
      const to = new URL(res.headers.location, url).toString()
      // 公開のページから社内のアドレスへ飛ばされることもあるので、行き先も確かめる
      const hold = allowHeld ? undefined : urlHoldReason(to)
      if (hold !== undefined) {
        return { error: `リダイレクト先（${hostOf(to)}）は${hold}、自動では取りに行きませんでした`, isBlocked: false, isHeld: true }
      }
      res = await get(to)
      if (res === undefined) return noReply
    }
    if (isBlockedResponse(res.status, res.text)) {
      return { error: `アクセスを拒否されました（${res.ok ? 'ボット確認のページ' : `HTTP ${res.status}`}）`, isBlocked: true }
    }
    if (!res.ok) return { error: `ページを取得できませんでした（HTTP ${res.status}）`, isBlocked: false }
    const type = (res.headers['content-type'] ?? '').toLowerCase()
    if (type.includes('pdf')) return { error: PDF_ERROR, isBlocked: false, isPdf: true }
    const isHtml = type.includes('html') || /^\s*<(!doctype|html|head|body)/i.test(res.text.slice(0, 200))
    const text = isHtml ? htmlToText(res.text) : res.text.slice(0, 2_000_000)
    if (text.trim() === '') {
      return { error: '本文を取り出せませんでした（JavaScriptで描画されるページかもしれません）', isBlocked: false }
    }
    const saved = archiveDate(res.headers['memento-datetime'])
    const via = url.startsWith('https://web.archive.org/') ? `Web Archive ${saved}`.trim() : ''
    return { lines: toLines(text, 'url'), title: isHtml ? pageTitle(res.text) : '', via }
  } catch (error) {
    return { error: `ページを取得できませんでした（${String(error).slice(0, 80)}）`, isBlocked: false }
  }
}

async function judgeOne(
  $: EngineInterface,
  check: UradoriCheck,
  fetched: Fetched,
): Promise<JudgeResult> {
  const plainLink = check.source.kind === 'url' ? check.source.ref : ''
  if ('error' in fetched) {
    return {
      verdict: 'unknown',
      evidence: [],
      context: [],
      title: '',
      link: plainLink,
      reason: fetched.error,
      isBlocked: fetched.isBlocked,
      via: '',
      isPdf: fetched.isPdf ?? false,
      isHeld: fetched.isHeld ?? false,
      isQuoteFound: null,
    }
  }
  const { via } = fetched

  // Claude が添えた引用が原文に一字一句あるかは、モデルを使わずに確かめる
  const quoteHit = check.quote ? findQuote(fetched.lines, check.quote) : undefined
  const isQuoteFound = check.quote ? quoteHit !== undefined : null
  const quoteMissing = check.quote ? `引用「${check.quote.slice(0, 40)}」が原文に見つかりません` : ''

  const focus = check.source.kind === 'file' ? check.source.line : undefined
  const excerpt = selectExcerpt(fetched.lines, check.quote ? `${check.claim} ${check.quote}` : check.claim, focus)
  // 会話の履歴を持たない、まっさらな呼び出しで判定する（同じ思い込みを引き継がない）
  const reply = await $.model.complete({
    model: JUDGE_MODEL,
    system: JUDGE_SYSTEM,
    prompt: judgePrompt(check.claim, check.source, excerpt),
    maxTokens: 400,
    timeoutMs: MODEL_TIMEOUT_MS,
  })
  if (!reply.isAnswered) {
    return {
      // 引用が原文にないことは、判定モデルがなくても分かる（内容は未判定なので △ 引用ずれ）
      verdict: isQuoteFound === false ? 'drift' : 'unknown',
      evidence: quoteHit ?? [],
      context: contextAround(fetched.lines, quoteHit ?? [], focus),
      title: fetched.title,
      link: plainLink,
      reason: isQuoteFound === false ? `${quoteMissing}（主張の内容は判定できませんでした）` : `判定できませんでした（${reply.reason}）`,
      isBlocked: false,
      via,
      isPdf: false,
      isHeld: false,
      isQuoteFound,
    }
  }

  // 原文の行を根拠に示せない ✔ ✖ は信じない（？ にする）
  const judged = groundVerdict(parseJudgement(reply.text, excerpt), quoteHit)
  // 根拠の行が取れなかったときは、引用が見つかった行か、出典の行番号の行を見せる
  if (judged.evidence.length === 0 && quoteHit !== undefined) judged.evidence = quoteHit
  if (judged.evidence.length === 0 && focus !== undefined) {
    const at = fetched.lines.find(l => l.line === focus)
    if (at !== undefined) judged.evidence = [at]
  }
  // 引用が原文にないときは、事実の食い違い（✖）とは分けて △ 引用ずれにする。
  // HTML を文字にするときの差でも起きるので、内容まで食い違っているときだけ ✖ のまま
  if (isQuoteFound === false) {
    judged.reason =
      judged.verdict === 'match'
        ? `${quoteMissing}（主張の内容は原文と一致）`
        : judged.verdict === 'unknown'
          ? `${quoteMissing}（主張の内容は判定できませんでした）`
          : [quoteMissing, judged.reason].filter(Boolean).join('／')
    if (judged.verdict !== 'mismatch') judged.verdict = 'drift'
  }
  // ハイライトには、原文で見つかった引用そのものを使うのがいちばん確実
  const quote =
    isQuoteFound === true && !/…|\.{3}|‥/.test(check.quote) ? check.quote : longestCell(judged.evidence[0]?.text ?? '')
  return {
    ...judged,
    context: contextAround(fetched.lines, judged.evidence, focus, check.source.kind === 'url' ? 2 : 3),
    title: fetched.title,
    link: check.source.kind === 'url' && quote !== '' ? textFragmentUrl(check.source.ref, quote) : plainLink,
    isBlocked: false,
    via,
    isPdf: false,
    isHeld: false,
    isQuoteFound,
  }
}

/** 表のセル（" | " 区切り）が混ざった行は、いちばん長いセルをハイライト用の文にする */
function longestCell(text: string): string {
  return text
    .split(' | ')
    .map(s => s.trim())
    .reduce((a, b) => (b.length > a.length ? b : a), '')
}

async function requestGrounding($: EngineInterface, named: readonly string[]): Promise<void> {
  await update($, isBandHidden, () => true)
  $.ui.toast('Claudeに一次情報での裏付けを依頼しました')
  // 依頼文に「一次情報」「根拠」が入るので、返ってきた回答もウラ取り対象になる
  await $.prompt.submit({ text: groundingPrompt(named) })
}

async function requestAlternative($: EngineInterface, items: readonly UradoriCheck[]): Promise<void> {
  if (items.length === 0) return
  await update($, isBandHidden, () => true)
  await $.ui.close({ id: POPUP })
  $.ui.toast('Claudeに別の一次情報を探すよう依頼しました')
  // 依頼文に「一次情報」が入るので、返ってきた回答もウラ取り対象になる
  await $.prompt.submit({ text: alternativeSourcePrompt(items) })
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

/** カードに出す主張の上限（カードが本文を覆いすぎないように） */
const MAX_CARD_CLAIMS = 4

/** 本文に差し込む印。食い違いと引用ずれは言葉も添えて、印の意味が分かるようにする */
function inlineMark(c: UradoriCheck): string {
  if (c.verdict === 'pending') return '🔍'
  if (c.verdict === 'mismatch') return '✖ 原文と違う'
  if (c.verdict === 'drift') return '△ 引用ずれ'
  return markOf(c)
}

/** カードの並び: 食い違い → 引用ずれ → 確認できない → 一致 → 確認中 */
function cardOrder(c: UradoriCheck): number {
  const order: Record<UradoriVerdict, number> = { mismatch: 0, drift: 1, unknown: 2, match: 3, pending: 4 }
  return order[c.verdict]
}

/** 件数。unknown は ⏸（保留）・🔒（アクセス拒否）・📄（PDF）を除いた数（帯・カード・/uradori で同じ数え方にする） */
type Tally = Record<UradoriVerdict | 'held' | 'blocked' | 'pdf', number>

function tally(checks: readonly UradoriCheck[]): Tally {
  const t: Tally = { match: 0, mismatch: 0, drift: 0, unknown: 0, pending: 0, held: 0, blocked: 0, pdf: 0 }
  for (const c of checks) {
    if (c.isHeld) t.held += 1
    else if (c.isBlocked) t.blocked += 1
    else if (c.isPdf) t.pdf += 1
    else t[c.verdict] += 1
  }
  return t
}

/** 帯とカードに並べる件数。✔ ✖ ？ はいつも、△ ⏸ 🔒 📄 はあるときだけ */
function tallyCells(t: Tally): { text: string; color: Tone }[] {
  return [
    { text: `✔ ${t.match}`, color: 'success' as const },
    { text: `✖ ${t.mismatch}`, color: 'error' as const },
    ...(t.drift > 0 ? [{ text: `△ ${t.drift}`, color: 'warning' as const }] : []),
    { text: `？ ${t.unknown}`, color: 'subtle' as const },
    ...(t.held > 0 ? [{ text: `⏸ ${t.held}`, color: 'warning' as const }] : []),
    ...(t.blocked > 0 ? [{ text: `🔒 ${t.blocked}`, color: 'subtle' as const }] : []),
    ...(t.pdf > 0 ? [{ text: `📄 ${t.pdf}`, color: 'subtle' as const }] : []),
  ]
}

function verdictLabel(v: UradoriVerdict): string {
  return v === 'match'
    ? '原文と一致'
    : v === 'mismatch'
      ? '原文と食い違い'
      : v === 'drift'
        ? '引用ずれ（引用が原文に見つからない）'
        : v === 'unknown'
          ? '確認できない'
          : '確認中…'
}

/** 帯に出す「どこの原文か」: ファイルなら「config.ts L3」、URL ならホスト名 */
function placeLabel(check: UradoriCheck, line?: UradoriLine): string {
  const first = line ?? check.evidence[0]
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
  const c = tally(current.checks)
  const lines = [
    `ウラ取り: ✔ 一致 ${c.match} / ✖ 食い違い ${c.mismatch}${c.drift ? ` / △ 引用ずれ ${c.drift}` : ''} / ？ 確認できない ${c.unknown}${c.held ? ` / ⏸ 自動では取得しなかったURL ${c.held}` : ''}${c.blocked ? ` / 🔒 アクセス拒否 ${c.blocked}` : ''}${c.pdf ? ` / 📄 PDF ${c.pdf}` : ''}${c.pending ? ` / 確認中 ${c.pending}` : ''}`,
  ]
  for (const check of current.checks) {
    const ev = check.evidence[0]
    const quote = ev ? ` ― 原文${check.source.kind === 'file' ? ` L${ev.line}` : ''}: ${ev.text.trim().slice(0, 100)}` : ''
    const why = !ev && check.reason ? ` ― ${check.reason}` : ''
    const via = check.via ? `（${check.via} の保存版）` : ''
    lines.push(`${markOf(check)} ${check.claim.slice(0, 80)}（${sourceLabel(check.source)}）${via}${quote}${why}`)
    if (check.isQuoteFound === false) lines.push(`   △ 引用「${check.quote.slice(0, 60)}」は原文に見つかりませんでした`)
    if (check.isHeld) lines.push('   ⏸ 原文ポップアップの［原文を取りに行く］を押すと取得します')
    else if (check.source.kind === 'url' && check.link) lines.push(`   🔗 該当箇所を開く: ${check.link}`)
  }
  return lines.join('\n')
}
