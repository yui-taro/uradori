// ウラ取りmod の純粋なロジック（$ を使わない部分）。
// 回答文から出典を拾う・主張を取り出す・原文の関連箇所を選ぶ・判定を読み取る。

import type { UradoriLine, UradoriSource, UradoriVerdict } from '../types'

/** 1回の回答でウラ取りする主張の上限（利用量を抑える） */
export const MAX_CLAIMS = 6
/** 判定モデルに渡す原文の上限（文字数） */
export const MAX_SOURCE_CHARS = 24000
/** 原文の1行がこれより長いときは文ごとに分ける */
const MAX_LINE_CHARS = 280

// ───────────────────────────── 出典を拾う

export type SourceRef = {
  source: UradoriSource
  /** 回答文の中で出典が書かれていた位置 */
  start: number
  end: number
}

const URL_RE = /https?:\/\/[^\s<>"'`）」』\]]+/g
const TRAILING_PUNCT = /[)）.,，、。;；:：!！?？'"」』\]>]+$/

// `src/config.ts`、config.ts:12、docs/a.md#L5、.env のようなファイル参照。
// 拡張子に英字を含むものだけ（バージョン番号 2.1.309 などを拾わないため）。
const FILE_RE =
  /(^|[^\w@.\/\-~])((?:\.{1,2}\/|~\/|\/)?(?:[\w@.\-]+\/)*(?:[\w@\-][\w@.\-]*\.(?=[A-Za-z0-9]*[A-Za-z])[A-Za-z0-9]{1,8}|\.[A-Za-z][\w.\-]*))(?:(?::|#L)(\d{1,6})(?:[-–]L?\d{1,6})?)?(?=$|[\s`'")）」』\],.;:：、。！？!?の])/g

/** 回答文の中の URL とファイル参照を、書かれていた順に返す */
export function findSourceRefs(answer: string): SourceRef[] {
  const refs: SourceRef[] = []
  let masked = answer

  for (const m of answer.matchAll(URL_RE)) {
    const raw = m[0].replace(TRAILING_PUNCT, '')
    const start = m.index ?? 0
    refs.push({ source: { kind: 'url', ref: raw }, start, end: start + raw.length })
    masked = masked.slice(0, start) + ' '.repeat(m[0].length) + masked.slice(start + m[0].length)
  }

  for (const m of masked.matchAll(FILE_RE)) {
    const lead = m[1] ?? ''
    const path = m[2] ?? ''
    if (!looksLikeFilePath(path)) continue
    const start = (m.index ?? 0) + lead.length
    const end = start + m[0].length - lead.length
    const line = m[3] !== undefined ? Number(m[3]) : undefined
    refs.push({
      source: line !== undefined ? { kind: 'file', ref: path, line } : { kind: 'file', ref: path },
      start,
      end,
    })
  }

  return refs.sort((a, b) => a.start - b.start)
}

function looksLikeFilePath(path: string): boolean {
  if (path.length > 240) return false
  if (/^\d+(\.\d+)+$/.test(path)) return false // 1.2.3
  if (/^(e\.g|i\.e|etc|vs|No)\./i.test(path)) return false
  const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase()
  // ドメイン名だけ（example.com）はファイルとして扱わない
  if (!path.includes('/') && ['com', 'org', 'net', 'io', 'jp', 'dev', 'ai', 'co'].includes(ext)) return false
  return true
}

/** 秘密情報が入っていそうなファイルは読まない */
export function isSecretPath(path: string): boolean {
  const name = path.split('/').pop() ?? path
  return (
    /^\.env(\..*)?$/i.test(name) ||
    /\.(pem|key|p12|pfx|keystore|jks)$/i.test(name) ||
    /^id_(rsa|dsa|ecdsa|ed25519)/i.test(name) ||
    /(^|\/)\.ssh\//.test(path) ||
    /(credential|secret)s?(\.|$)/i.test(name) ||
    /^\.netrc$|^\.npmrc$|^\.pypirc$/i.test(name)
  )
}

/** 同じ出典を1つにまとめるためのキー */
export function sourceKey(source: UradoriSource): string {
  return `${source.kind}:${source.ref}`
}

/** 表示用の出典名 */
export function sourceLabel(source: UradoriSource): string {
  if (source.kind === 'file') return source.line ? `${source.ref}:${source.line}` : source.ref
  return source.ref
}

// ───────────────────────────── 主張を取り出す

const CITATION_WORDS =
  /(根拠|出典|参照|参考|ソース|ドキュメント|資料|公式|によると|によれば|より|を見て|を参照|ください|sources?|see|refs?|reference|according to|per)/gi

/**
 * 出典が「根拠として」書かれていた文から主張を取り出す。
 * 「〜は30秒です（根拠：`config.ts`）。」→「〜は30秒です」
 * 出典の文が引用だけ（「根拠は config.ts の3行目です」）なら直前の文を使う。
 * 出典が根拠の形で書かれていない（「設定は config.ts で行われています」、
 * 末尾の参考リンクなど）ときは undefined（あとでモデルに主張との対応づけを頼む）。
 */
export function inlineClaim(answer: string, ref: SourceRef, allRefs: readonly SourceRef[]): string | undefined {
  const sentence = sentenceAround(answer, ref.start, ref.end)
  if (!isCitedAsEvidence(answer, sentence, ref)) return undefined

  // 根拠として書かれた出典だけを消す（「設定は src/config.ts で…」の src/config.ts は主張の一部）
  const cited = allRefs.filter(r => r === ref || isCitedAsEvidence(answer, sentenceAround(answer, r.start, r.end), r))
  const own = cleanClaim(removeRefs(sentence.text, sentence.start, cited))
  if (isRealClaim(own)) return own

  // 引用だけの文 → 直前の文
  if (sentence.start > 0) {
    const prev = sentenceAround(answer, sentence.start - 1, sentence.start - 1)
    if (prev.start < sentence.start) {
      const prevClaim = cleanClaim(removeRefs(prev.text, prev.start, allRefs))
      if (isRealClaim(prevClaim) && !/^[\s\-*#>]*(sources?|出典|参考|根拠)\s*[:：]?\s*$/i.test(prevClaim)) {
        return prevClaim
      }
    }
  }
  return undefined
}

/** 出典が根拠として示されているか: かっこの中、「根拠：」「出典は」の後、「〜によると」の前 */
function isCitedAsEvidence(answer: string, sentence: Span, ref: SourceRef): boolean {
  const before = answer.slice(sentence.start, ref.start)
  const after = answer.slice(ref.end, sentence.start + sentence.text.length)
  const opened = (before.match(/[（(]/g) ?? []).length - (before.match(/[）)]/g) ?? []).length
  if (opened > 0) return true
  if (/(根拠|出典|参照|参考|ソース|sources?|see|according to|per|cf\.?)\s*(は|が|として)?\s*[:：]?\s*[`'"「『\[]*\s*$/i.test(before)) return true
  if (/^\s*[`'"」』\]]*\s*(によると|によれば|に(よる|書いて|書かれて|記載)|より|参照|の\s*\d+\s*行目に)/.test(after)) return true
  return false
}

type Span = { text: string; start: number }

function sentenceAround(text: string, from: number, to: number): Span {
  let start = from
  while (start > 0) {
    const c = text[start - 1]
    if (c === '\n' || c === '。' || c === '！' || c === '？') break
    if ((c === '.' || c === '!' || c === '?') && /\s/.test(text[start] ?? '')) break
    start -= 1
  }
  let end = Math.max(to, from)
  while (end < text.length) {
    const c = text[end]
    if (c === '\n') break
    if (c === '。' || c === '！' || c === '？') {
      end += 1
      // 「。」の直後の閉じかっこも同じ文に入れる
      while (end < text.length && /[）)」』]/.test(text[end] ?? '')) end += 1
      break
    }
    if ((c === '.' || c === '!' || c === '?') && (end + 1 >= text.length || /\s/.test(text[end + 1] ?? ''))) {
      end += 1
      break
    }
    end += 1
  }
  return { text: text.slice(start, end), start }
}

function removeRefs(text: string, offset: number, refs: readonly SourceRef[]): string {
  let out = text
  // 後ろから消すと位置がずれない
  for (const ref of [...refs].sort((a, b) => b.start - a.start)) {
    const s = ref.start - offset
    const e = ref.end - offset
    if (s >= 0 && e <= out.length) out = out.slice(0, s) + out.slice(e)
  }
  return out
}

export function cleanClaim(text: string): string {
  return text
    .replace(/\[([^\]]*)\]\(\s*\)/g, '') // 中身が消えたリンク [title]()
    .replace(/`+/g, '')
    .replace(/\*\*|__|~~/g, '')
    .replace(/^\s*(?:[-*+]|\d+[.)]|#{1,6})\s+/, '') // 箇条書き・見出し
    .replace(/^\s*>\s?/, '')
    .replace(/[（(]\s*(?:根拠|出典|参照|参考|ソース|source|see|ref)?\s*[:：]?\s*(?:の\s*\d+\s*行目)?\s*[)）]/gi, '')
    // 「（出典: … の「料金」節「上限は50件」）」のような、場所や引用つきの出典の説明
    .replace(/[（(]\s*(?:根拠|出典|参照|参考|ソース|sources?|see|ref)\s*[:：][^（）()]*[)）]/gi, '')
    .replace(/[（(]([^（）()]*)[)）]/g, (whole, inner: string) => (isCitationOnly(inner) ? '' : whole))
    .replace(/\s+/g, ' ')
    .replace(/\s*[:：]\s*$/, '')
    .replace(/[。．.！!]+\s*$/, '')
    .trim()
    .replace(/^(によると|によれば|では|より)\s*[、,]?\s*/, '')
}

/** かっこの中身が「根拠：」「より」など引用の言葉だけか */
function isCitationOnly(inner: string): boolean {
  return inner.replace(CITATION_WORDS, '').replace(/[\s:：、,.。の行目\d]|から/g, '') === ''
}

function isRealClaim(claim: string): boolean {
  const content = claim
    .replace(CITATION_WORDS, '')
    .replace(/[はがをにでのとも、。.,:：\s（）()「」『』\-*>#]|です|ます|した|ある|あります|行目|\d+/g, '')
  return content.length >= 4
}

const ACTION_JA =
  /(修正|追加|作成|削除|更新|変更|実装|編集|書き換え|書き直|移動|リネーム|置き換え|インストール|実行|保存|コミット|プッシュ|反映|対応|整理|リファクタ)(し(ました|ておきました|ます|ています)|済み|完了)|(を|に)?(開き|読み|確認し)(ました|ます)|(しましょう|してください|しますか|ませんか)/
const ACTION_EN =
  /^(?:(?:i|we)(?:'ve| have)?\s+|i'll\s+|let me\s+)?(?:updated|added|created|fixed|edited|wrote|ran|removed|deleted|changed|moved|renamed|implemented|refactored|committed|pushed|opened|read|checked)\b/i

/**
 * 作業の報告（「config.ts を修正しました」「Updated foo.ts」）や依頼・質問は、
 * 原文で確かめる「主張」ではないのでウラ取りしない（利用量と誤報を減らす）
 */
export function isActionReport(claim: string): boolean {
  const t = claim.trim()
  return ACTION_JA.test(t) || ACTION_EN.test(t) || /[?？]$/.test(t)
}

/** 回答文から「主張と出典」の組を作る。主張が文中にない出典は needsPairing に入れる */
export function inlinePairs(
  answer: string,
  refs: readonly SourceRef[],
): { pairs: { claim: string; source: UradoriSource; quote?: string }[]; needsPairing: UradoriSource[] } {
  const pairs: { claim: string; source: UradoriSource; quote?: string }[] = []
  const needsPairing: UradoriSource[] = []
  const seen = new Set<string>()

  for (const ref of refs) {
    // 作業の報告の文（「`config.ts` を修正しました」）に出てくるファイルは対象外
    const sentence = sentenceAround(answer, ref.start, ref.end)
    if (isActionReport(cleanClaim(sentence.text))) continue

    const claim = inlineClaim(answer, ref, refs)
    if (claim !== undefined && isActionReport(claim)) continue
    if (claim === undefined) {
      if (!needsPairing.some(s => sourceKey(s) === sourceKey(ref.source))) needsPairing.push(ref.source)
      continue
    }
    const key = `${sourceKey(ref.source)}|${claim}`
    if (seen.has(key)) continue
    seen.add(key)
    const quote = citedQuote(answer, ref)
    pairs.push(quote !== undefined ? { claim, source: ref.source, quote } : { claim, source: ref.source })
  }
  return { pairs, needsPairing }
}

// ───────────────────────────── Claude が書いた引用を原文と照合する

/**
 * 出典のすぐ後ろ（同じかっこの中）に「」で書かれた引用。
 * 「（出典: https://… の「料金」節「上限は50件」）」→「上限は50件」（最後の「」を引用とみなす）
 */
export function citedQuote(answer: string, ref: SourceRef): string | undefined {
  const sentence = sentenceAround(answer, ref.start, ref.end)
  const before = answer.slice(sentence.start, ref.start)
  const opened = (before.match(/[（(]/g) ?? []).length - (before.match(/[）)]/g) ?? []).length
  if (opened <= 0) return undefined
  // かっこが閉じるところまで
  const rest = answer.slice(ref.end, sentence.start + sentence.text.length)
  let depth = opened
  let end = rest.length
  for (let i = 0; i < rest.length; i += 1) {
    const c = rest[i]
    if (c === '（' || c === '(') depth += 1
    if (c === '）' || c === ')') depth -= 1
    if (depth === 0) {
      end = i
      break
    }
  }
  const quotes = [...rest.slice(0, end).matchAll(/[「『"“]([^」』"”]{4,200})[」』"”]/g)].map(m => m[1] ?? '')
  return quotes.at(-1)?.trim() || undefined
}

/**
 * URL のテキストフラグメント（#:~:text=…）が指している文。
 * text=始まり,終わり の形は「始まり…終わり」にする（前後の文脈 prefix-, -suffix は外す）
 */
export function fragmentQuote(url: string): string | undefined {
  const m = /:~:(?:.*&)?text=([^&]*)/.exec(url)
  if (m?.[1] === undefined) return undefined
  const dec = (s: string): string => {
    try {
      return decodeURIComponent(s)
    } catch {
      return s
    }
  }
  const parts = m[1].split(',')
  if (parts[0]?.endsWith('-')) parts.shift()
  if (parts.at(-1)?.startsWith('-')) parts.pop()
  const text = parts.map(dec).map(s => s.trim()).filter(Boolean).join('…')
  return [...text.replace(/…/g, '')].length >= 4 ? text : undefined
}

/** 照合のための正規化: 全角・半角をそろえ、空白・表の区切り・引用符の違いを無視する */
function normalizeQuote(text: string): string {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[‘’`´]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[\s|]+/g, '')
}

/**
 * 引用が原文に一字一句あるかを確かめ、あればその行を返す（なければ undefined）。
 * 「…」「...」で省略された引用は、それぞれの部分が順に（近くに）出てくれば一致とする。
 * モデルを使わないので、判定モデルの間違いに左右されない。
 */
export function findQuote(lines: readonly UradoriLine[], quote: string): UradoriLine[] | undefined {
  const pieces = quote
    .split(/…|\.{3}|‥/)
    .map(normalizeQuote)
    .filter(p => p.length > 0)
  if (pieces.length === 0) return undefined

  // 行をつないだ文字列と、各行がどこから始まるか
  let joined = ''
  const starts: number[] = []
  for (const l of lines) {
    starts.push(joined.length)
    joined += normalizeQuote(l.text)
  }
  const lineAt = (pos: number): number => {
    let lo = 0
    let hi = starts.length - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if ((starts[mid] ?? 0) <= pos) lo = mid
      else hi = mid - 1
    }
    return lo
  }

  for (let from = joined.indexOf(pieces[0] ?? ''); from !== -1; from = joined.indexOf(pieces[0] ?? '', from + 1)) {
    let end = from + (pieces[0]?.length ?? 0)
    let isFound = true
    for (const piece of pieces.slice(1)) {
      const at = joined.indexOf(piece, end)
      // 省略をはさんだ部分は、離れすぎていたら別の文とみなす
      if (at === -1 || at - end > 1000) {
        isFound = false
        break
      }
      end = at + piece.length
    }
    if (!isFound) continue
    const first = lineAt(from)
    const last = lineAt(Math.max(from, end - 1))
    return lines.slice(first, Math.min(last, first + 2) + 1)
  }
  return undefined
}

// ───────────────────────────── 原文を整える

/** HTML から本文のテキストを取り出す（DOM がないので素朴に） */
export function htmlToText(html: string): string {
  return decodeEntities(
    html
      .slice(0, 2_000_000)
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<(script|style|noscript|svg|template|head)\b[\s\S]*?<\/\1\s*>/gi, ' ')
      .replace(/<(nav|footer)\b[\s\S]*?<\/\1\s*>/gi, ' ')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/?(p|div|section|article|li|ul|ol|tr|table|h[1-6]|pre|blockquote|dt|dd|main|header)\b[^>]*>/gi, '\n')
      .replace(/<\/?(td|th)\b[^>]*>/gi, ' | ')
      .replace(/<[^>]+>/g, ''),
  )
    .replace(/[ \t ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{2,}/g, '\n')
    .trim()
}

function decodeEntities(text: string): string {
  const named: Record<string, string> = {
    amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', hellip: '…',
  }
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, body: string) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10)
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : whole
    }
    return named[body.toLowerCase()] ?? whole
  })
}

/** 原文を行に分ける。ウェブページの長い行は文ごとに分ける（行番号は通し番号） */
export function toLines(text: string, kind: UradoriSource['kind']): UradoriLine[] {
  const raw = text.replace(/\r\n?/g, '\n').split('\n')
  if (kind === 'file') return raw.map((t, i) => ({ line: i + 1, text: t }))

  const lines: UradoriLine[] = []
  for (const row of raw) {
    if (row.trim() === '') continue
    if (row.length <= MAX_LINE_CHARS) {
      lines.push({ line: lines.length + 1, text: row.trim() })
      continue
    }
    for (const part of row.split(/(?<=[。！？])|(?<=[.!?])\s+/)) {
      if (part.trim() !== '') lines.push({ line: lines.length + 1, text: part.trim() })
    }
  }
  return lines
}

/** HTML の <title> を取り出す（「| 警察庁Webサイト」のような後ろの部分も残す） */
export function pageTitle(html: string): string {
  const m = /<title\b[^>]*>([\s\S]*?)<\/title\s*>/i.exec(html.slice(0, 200_000))
  return m?.[1] === undefined ? '' : decodeEntities(m[1]).replace(/\s+/g, ' ').trim().slice(0, 200)
}

/**
 * ポップアップに出す「原文の該当箇所」: 根拠の行と、その前後の行。
 * 根拠がないときは、ファイルの行番号の前後（なければ空）。
 */
export function contextAround(
  lines: readonly UradoriLine[],
  evidence: readonly UradoriLine[],
  focusLine?: number,
  radius = 3,
  maxLines = 14,
): UradoriLine[] {
  const centers = evidence.length > 0 ? evidence.map(l => l.line) : focusLine !== undefined ? [focusLine] : []
  if (centers.length === 0) return []
  const index = new Map(lines.map((l, i) => [l.line, i]))
  const picked = new Set<number>()
  for (const c of centers) {
    const at = index.get(c)
    if (at === undefined) continue
    for (let i = Math.max(0, at - radius); i <= Math.min(lines.length - 1, at + radius); i += 1) picked.add(i)
  }
  const out: UradoriLine[] = []
  for (const i of [...picked].sort((a, b) => a - b)) {
    const l = lines[i]
    if (l === undefined) continue
    out.push({ line: l.line, text: l.text.length > 300 ? `${l.text.slice(0, 300)}…` : l.text })
  }
  // 長すぎるときは根拠の行を中心に詰める
  if (out.length > maxLines) {
    const first = out.findIndex(l => centers.includes(l.line))
    const start = Math.max(0, Math.min(first - Math.floor(maxLines / 3), out.length - maxLines))
    return out.slice(start, start + maxLines)
  }
  return out
}

/**
 * 実際のサイトの該当箇所に飛んで、そこをハイライトする URL（テキストフラグメント）。
 * 例: https://example.com/page#:~:text=上限は50件,です
 * Chrome・Edge・Safari などが対応。対応していないブラウザでもページ自体は開く。
 */
export function textFragmentUrl(url: string, quote: string): string {
  const text = quote.replace(/\s+/g, ' ').trim()
  if (text === '' || !/^https?:\/\//i.test(url)) return url
  // 特別な意味を持つ記号（- , &）も含めてエンコードする
  const enc = (s: string) => encodeURIComponent(s).replace(/-/g, '%2D').replace(/,/g, '%2C').replace(/&/g, '%26')
  const chars = [...text]
  const directive =
    chars.length <= 80
      ? `text=${enc(text)}`
      : `text=${enc(chars.slice(0, 24).join('').trim())},${enc(chars.slice(-24).join('').trim())}`
  const base = url.replace(/:~:.*$/, '')
  const href = base.includes('#') ? `${base}:~:${directive}` : `${base}#:~:${directive}`
  return href.length <= 2000 ? href : base
}

/** 比べるための正規化（60_000 → 60000、MAX_ITEMS → maxitems） */
function normalize(text: string): string {
  return text.toLowerCase().replace(/[,_]/g, '')
}

type Keyword = { word: string; weight: number; isNumber: boolean }

function keywords(claim: string): Keyword[] {
  const words = new Map<string, Keyword>()
  const add = (word: string, weight: number, isNumber = false) => {
    const w = normalize(word)
    if (w.length === 0) return
    const prev = words.get(w)
    if (prev === undefined || prev.weight < weight) words.set(w, { word: w, weight, isNumber })
  }
  for (const m of claim.matchAll(/\d+(?:[.,_]\d+)*/g)) add(m[0], 2, true)
  for (const m of claim.matchAll(/[A-Za-z][A-Za-z0-9_\-]{2,}/g)) {
    const isIdentifier = /[_\-]|[a-z][A-Z]/.test(m[0]) || m[0].length >= 8
    add(m[0], isIdentifier ? 6 : m[0].length >= 5 ? 3 : 1)
    for (const part of m[0].split(/(?=[A-Z][a-z])|[_\-]/)) if (part.length >= 3) add(part, 1)
  }
  // 日本語は2文字ずつの組（バイグラム）で比べる
  for (const m of claim.matchAll(/[\u3040-\u30ff\u4e00-\u9fff]{2,}/g)) {
    for (let i = 0; i + 2 <= m[0].length; i += 1) add(m[0].slice(i, i + 2), 1)
  }
  return [...words.values()]
}

function lineScore(line: string, words: readonly Keyword[]): number {
  const text = normalize(line)
  let s = 0
  for (const k of words) {
    if (k.isNumber) {
      // 数字は前後が数字でないときだけ（「100」が「1000」に当たらないように）
      let at = text.indexOf(k.word)
      while (at !== -1) {
        const before = text[at - 1] ?? ''
        const after = text[at + k.word.length] ?? ''
        if (!/\d/.test(before) && !/\d/.test(after)) {
          s += k.weight
          break
        }
        at = text.indexOf(k.word, at + 1)
      }
    } else if (text.includes(k.word)) {
      s += k.weight
    }
  }
  return s
}

/**
 * 判定モデルに渡す原文の行を選ぶ。
 * 小さい原文はまるごと。大きい原文は、行番号の前後と、主張の言葉が多く出る行の前後。
 * 戻り値は原文そのものの行（行番号つき）なので、表示する抜粋も原文どおりになる。
 */
export function selectExcerpt(lines: readonly UradoriLine[], claim: string, focusLine?: number): UradoriLine[] {
  const total = lines.reduce((n, l) => n + l.text.length + 8, 0)
  if (total <= MAX_SOURCE_CHARS) return [...lines]

  const words = keywords(claim)
  const score = lines.map(l => lineScore(l.text, words))

  const picked = new Set<number>()
  const add = (center: number, radius: number) => {
    for (let i = Math.max(0, center - radius); i <= Math.min(lines.length - 1, center + radius); i += 1) picked.add(i)
  }
  const size = () => [...picked].reduce((n, i) => n + (lines[i]?.text.length ?? 0) + 8, 0)

  if (focusLine !== undefined) add(focusLine - 1, 10)

  const order = score
    .map((s, i) => ({ s, i }))
    .filter(x => x.s > 0)
    .sort((a, b) => b.s - a.s)
  for (const { i } of order) {
    if (size() >= MAX_SOURCE_CHARS) break
    add(i, 3)
  }

  // 言葉が1つも重ならない（例: 日本語の主張と英語の原文）ときは先頭から
  if (picked.size === 0) {
    for (let i = 0; i < lines.length && size() < MAX_SOURCE_CHARS; i += 1) picked.add(i)
  }

  const out: UradoriLine[] = []
  let budget = MAX_SOURCE_CHARS
  for (const i of [...picked].sort((a, b) => a - b)) {
    const l = lines[i]
    if (l === undefined) continue
    budget -= l.text.length + 8
    if (budget < 0) break
    out.push(l)
  }
  return out
}

// ───────────────────────────── 判定モデルへの依頼と、その読み取り

export const JUDGE_SYSTEM =
  'あなたは厳密なファクトチェッカーです。与えられた「主張」が「原文」によって裏付けられるかだけを判定します。' +
  '原文に書かれていないことを知識や推測で補ってはいけません。出力はJSONだけにしてください。'

export function judgePrompt(claim: string, source: UradoriSource, excerpt: readonly UradoriLine[]): string {
  const body: string[] = []
  let prev = 0
  for (const l of excerpt) {
    if (prev !== 0 && l.line !== prev + 1) body.push('（…中略…）')
    body.push(`L${l.line}: ${l.text.length > 600 ? `${l.text.slice(0, 600)}…` : l.text}`)
    prev = l.line
  }
  return [
    '# 主張',
    claim,
    '',
    '# 出典',
    `${sourceLabel(source)}（${source.kind === 'file' ? 'プロジェクト内のファイル' : 'ウェブページ'}）`,
    '',
    '# 原文（ツールが直接読んだもの。各行の先頭は行番号）',
    body.join('\n') || '（空）',
    '',
    '# 判定のルール',
    '- match: 主張の中心となる事実（数値・名前・条件など）が原文に書かれていて、内容が同じ',
    '- mismatch: 原文に関係する記述があり、主張と食い違う（数値が違う、否定されている、条件が違う など）',
    '- unknown: 原文に主張に関係する記述が見当たらない、または原文だけでは判断できない',
    '- 単位の換算や表記の違い（60000ミリ秒と60秒、60_000と60000）は同じ値として扱う',
    '- 主張のうち出典と関係ない部分（意見・提案・手順の説明）は判定に含めない',
    '',
    '# 出力（JSONだけ。前後に説明を書かない）',
    '{"verdict":"match | mismatch | unknown","lines":[根拠の行番号を最大3つ],"reason":"日本語で40字以内の理由"}',
  ].join('\n')
}

export type Judgement = { verdict: Exclude<UradoriVerdict, 'pending'>; evidence: UradoriLine[]; reason: string }

/** 判定モデルの返答を読む。表示する抜粋は、モデルの言葉ではなく原文の行から取る */
export function parseJudgement(text: string, excerpt: readonly UradoriLine[]): Judgement {
  const json = firstJson(text)
  if (json === undefined || typeof json !== 'object' || json === null || Array.isArray(json)) {
    return { verdict: 'unknown', evidence: [], reason: '判定結果を読み取れませんでした' }
  }
  const obj = json as Record<string, unknown>
  const raw = String(obj.verdict ?? '').toLowerCase().trim()
  const verdict: Judgement['verdict'] = raw === 'match' || raw === 'mismatch' ? raw : 'unknown'
  const wanted = Array.isArray(obj.lines) ? obj.lines.map(Number).filter(n => Number.isInteger(n)) : []
  const byLine = new Map(excerpt.map(l => [l.line, l]))
  const evidence = wanted
    .map(n => byLine.get(n))
    .filter((l): l is UradoriLine => l !== undefined)
    .slice(0, 3)
  const reason = typeof obj.reason === 'string' ? obj.reason.trim().slice(0, 120) : ''
  return { verdict, evidence, reason }
}

/**
 * 根拠の行を示せない判定は信じない: 一致・食い違いでも、原文の行を1つも示せなければ unknown（？）。
 * ただし Claude の引用が原文に一字一句あったときは、その行を一致の根拠にする（モデルの言葉ではなく原文の行なので）
 */
export function groundVerdict(judged: Judgement, quoteHit?: readonly UradoriLine[]): Judgement {
  if (judged.verdict === 'unknown' || judged.evidence.length > 0) return judged
  if (judged.verdict === 'match' && quoteHit !== undefined && quoteHit.length > 0) {
    return { ...judged, evidence: [...quoteHit] }
  }
  const said = judged.verdict === 'match' ? '一致' : '食い違い'
  return {
    verdict: 'unknown',
    evidence: [],
    reason: `判定モデルが原文の根拠の行を示さなかったため、確認できないにしました（モデルの判定: ${said}${judged.reason ? `・${judged.reason}` : ''}）`,
  }
}

/** 文字列の中の最初の JSON（{...} か [...]）を取り出す */
export function firstJson(text: string): unknown {
  const cleaned = text.replace(/```(?:json)?/gi, '')
  for (let i = 0; i < cleaned.length; i += 1) {
    const c = cleaned[i]
    if (c !== '{' && c !== '[') continue
    const close = c === '{' ? '}' : ']'
    for (let j = cleaned.lastIndexOf(close); j > i; j = cleaned.lastIndexOf(close, j - 1)) {
      try {
        return JSON.parse(cleaned.slice(i, j + 1))
      } catch {
        // もっと短い範囲で試す
      }
    }
  }
  return undefined
}

// ───────────────────────────── 主張と出典の対応づけ（文中に主張がない出典だけ）

export function pairingPrompt(answer: string, sources: readonly UradoriSource[]): string {
  return [
    '次の「回答」の中から、各「出典」を根拠にしている主張（事実を述べている文）を取り出してください。',
    '',
    '# 回答',
    answer.length > 8000 ? `${answer.slice(0, 8000)}…` : answer,
    '',
    '# 出典',
    ...sources.map((s, i) => `[${i + 1}] ${sourceLabel(s)}`),
    '',
    '# ルール',
    '- 出典の中身を読めば正誤を確かめられる、具体的な事実（数値・設定値・名前・仕様・挙動）を選ぶ',
    '- 回答が「〜は（出典）で設定されている／（出典）に書かれている」と述べているときは、その出典に書かれているはずだと回答が言っている具体的な値や事実を主張にする',
    '  例: 回答「タイムアウトは30秒です。設定は config.ts にあります。」→ config.ts の主張は「タイムアウトは30秒」',
    '- 「出典に〜がある」という場所だけの主張や、作業の報告・意見・提案は含めない',
    '- claim は回答の文言をできるだけそのまま使い、1文にする',
    '- 1つの出典につき最大3件、全体で最大6件。該当がなければ空の配列 []',
    '',
    '# 出力（JSONの配列だけ）',
    '[{"source": 出典の番号, "claim": "主張の文"}]',
  ].join('\n')
}

export function parsePairs(text: string, sources: readonly UradoriSource[]): { claim: string; source: UradoriSource }[] {
  const json = firstJson(text)
  if (!Array.isArray(json)) return []
  const out: { claim: string; source: UradoriSource }[] = []
  for (const item of json) {
    if (typeof item !== 'object' || item === null) continue
    const obj = item as Record<string, unknown>
    const source = sources[Number(obj.source) - 1]
    const claim = typeof obj.claim === 'string' ? cleanClaim(obj.claim) : ''
    if (source === undefined || claim.length < 4 || isActionReport(claim)) continue
    out.push({ claim: claim.slice(0, 300), source })
  }
  return out
}

// ───────────────────────────── 訂正の依頼文

export function correctionPrompt(
  items: readonly { claim: string; source: UradoriSource; evidence: readonly UradoriLine[]; reason: string }[],
): string {
  const blocks = items.map((c, i) => {
    const quote = c.evidence.length > 0
      ? c.evidence.map(l => (c.source.kind === 'file' ? `  L${l.line}: ${l.text.trim()}` : `  「${l.text.trim()}」`)).join('\n')
      : '  （該当箇所を特定できませんでした）'
    return [
      `${i + 1}. あなたの主張: ${c.claim}`,
      `   出典: ${sourceLabel(c.source)}`,
      '   原文:',
      quote,
      c.reason ? `   食い違い: ${c.reason}` : '',
    ].filter(Boolean).join('\n')
  })
  return [
    '【ウラ取りmod】直前の回答のうち、次の主張が出典の原文と食い違っています。',
    '出典を自分で開き直して確認し、正しい内容に訂正してください。原文が正しいとは限らない場合は、その理由も説明してください。',
    '',
    ...blocks,
  ].join('\n')
}

// ───────────────────────────── 根拠を求められた質問（ウラ取り対象のターン）

// 「根拠付きで」「一次情報は？」「ソースは？」など、根拠そのものを求める言い方。
// 「ソースコード」「公式（数式）」のような別の意味は拾わない
const EVIDENCE_REQUEST_RE =
  /(根拠|出典|一次(?:情報|資料|ソース)|原典|典拠|引用元|参考文献|裏付け|裏取り|ウラ取り|エビデンス|ファクトチェック|事実確認|ソース(?!コード|ファイル|を(?:書|直|修正|編集|読))|公式(?:サイト|ドキュメント|情報|発表|資料)|正確な情報|正確に(?:教えて|知りたい)|どこに書いて(?:ある|あります)|本当に(?:正しい|合って)|\b(?:sources?|citations?|cite|evidence|primary sources?|fact[- ]?check)\b)/i

/** 質問が根拠を求めているなら、その手がかりになった言葉を返す */
export function evidenceRequest(prompt: string): string | undefined {
  return EVIDENCE_REQUEST_RE.exec(prompt)?.[0]
}

/** 根拠を求められたターンで、Claude だけに渡す指示（ユーザーには見えない） */
export const EVIDENCE_CONTEXT = [
  '【ウラ取りmod】この質問は根拠を求めています。回答では次を守ってください。',
  '- 主張ごとに出典を、確認できる URL（https://…）かプロジェクト内のファイルパス（行番号つき）で書く。出典名だけ（URLなし）の書き方はしない。',
  '- URL だけでなく、そのページの「どこに」書いてあるかも示す。見出し（節の名前）と、根拠になった箇所の短い引用（原文そのまま、15語程度まで）を「」で添える。引用はウラ取りmod が原文と一字一句照合する。',
  '- 引用した箇所へ直接飛べるよう、Web ページの URL には可能ならテキストフラグメント（#:~:text=原文の一部）を付ける。引用は実際に開いた原文と一字一句同じにする。',
  '- 出典は HTML のページを優先する。PDF はウラ取りmod が自動で読めないので、同じ内容の HTML ページ（公式サイトの本文、法令データベースなど）があればそちらを書く。',
  '- PDF しかないときだけ PDF の URL を書き、#page=N とページ番号・短い引用を添える（自動では確かめられず、利用者が自分で開いて確かめることになる）。',
  '- URL のすぐ後ろは半角スペースで区切ってから場所を書く（URL に場所の説明が混ざらないように）。',
  '- 書き方の例: 「上限は50件です（出典: https://example.com/limits#:~:text=上限は50件 の「料金と上限」節「1回あたり上限は50件」）」',
  '- 確かめられなかった主張は「未確認」と明記する。',
].join('\n')

// 「主な出典」「参考」「Sources」などの見出し
const SOURCES_HEADING_RE =
  /^\s*(?:#{1,6}\s*|\*\*\s*)?(?:主な|参考)?(?:出典|参考(?:文献|資料|リンク)?|根拠|引用元|典拠|sources?|references?)/i
const LIST_ITEM_RE = /^\s*(?:[-*+]|\d+[.)]|[①-⑳])\s+(.+)$/
// 「農林水産省「〜」によると」のように、URLのない出典名を主語にした言い方
const NAMED_BY_RE =
  /([^\s、。（(]{0,30}(?:「[^」]{1,60}」|『[^』]{1,60}』|省|庁|協会|機構|機関|センター|大学|研究所|規格|白書|統計|ガイドライン|公式サイト|ドキュメント))\s*(?:によると|によれば|では|の資料)/g

/**
 * URL もファイルパスもない「名前だけの出典」を返す。
 * 出典の見出しの下の箇条書きと、「〇〇によると」の〇〇が対象。
 */
export function findNamedSources(answer: string): string[] {
  const named: string[] = []
  const add = (text: string): void => {
    const name = text.replace(/\*\*|`/g, '').replace(/\s+/g, ' ').trim().slice(0, 80)
    if (name.length >= 2 && !named.includes(name)) named.push(name)
  }
  let inSources = false
  for (const line of answer.split('\n')) {
    if (line.trim() === '') continue
    if (SOURCES_HEADING_RE.test(line) && !LIST_ITEM_RE.test(line)) {
      inSources = true
      continue
    }
    if (/^\s*#{1,6}\s/.test(line)) {
      inSources = false
      continue
    }
    const item = LIST_ITEM_RE.exec(line)
    if (inSources && item?.[1] !== undefined && findSourceRefs(line).length === 0) add(item[1])
  }
  for (const m of answer.matchAll(NAMED_BY_RE)) {
    const sentence = answer.slice(Math.max(0, (m.index ?? 0) - 1), (m.index ?? 0) + m[0].length + 80)
    if (m[1] !== undefined && !/https?:\/\//.test(sentence)) add(m[1])
  }
  return named
}

/**
 * 一次情報で確かめたい度合い。数値・日付・法令・規格などを含む主張ほど高い。
 * 根拠を求められたターンでは、上限の枠をこれが高い主張から使う
 */
export function claimPriority(claim: string): number {
  const digits = (claim.match(/\d+/g) ?? []).length
  const facts = (claim.match(/[%％]|年|月|日|件|円|回|秒|条|項|号|規格|法|令|JAS|ISO|JIS|RFC|版|以上|以下|未満|最大|最小|上限|下限|約|割/g) ?? []).length
  return digits * 2 + facts
}

/** ［一次情報で裏付けさせる］で Claude に送る依頼文 */
export function groundingPrompt(named: readonly string[]): string {
  return [
    '【ウラ取りmod】直前の回答の根拠を、一次情報で裏付けてください。',
    named.length > 0
      ? `次の出典は名前だけで、URL がないため原文を確かめられませんでした:\n${named.map(n => `- ${n}`).join('\n')}`
      : '直前の回答には、確かめられる出典（URL・ファイル）がありませんでした。',
    '',
    '主要な主張ごとに、一次情報（公的機関・法令・規格・原典・論文・公式ドキュメント）を検索して実際に開き、',
    '「主張（出典: https://… の該当ページ・見出し「原文の短い引用」）」の形で、ページ内のどこに書いてあるかまで示して書き直してください。',
    '一次情報で確かめられなかった主張は「未確認」と明記してください。',
  ].join('\n')
}

// ───────────────────────────── アクセス拒否（ボット対策）への対処

/** ブラウザと同じ見え方で取りに行くためのヘッダー（UA だけで弾くサイトがある） */
export const BROWSER_HEADERS: Record<string, string> = {
  'user-agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
  accept: 'text/html,application/xhtml+xml,text/plain,application/json;q=0.9,*/*;q=0.5',
  'accept-language': 'ja,en;q=0.8',
}

// Cloudflare などの「人間か確認します」ページ。200 で返ってくることもある
const CHALLENGE_RE =
  /<title>\s*(?:just a moment|attention required|access denied|forbidden|403 forbidden|please wait|security check|are you a robot)|cf-chl-|challenge-platform|enable javascript and cookies to continue|captcha-delivery|perimeterx|px-captcha/i

/** アクセス拒否・ボット対策のページか（本文を原文として使えない） */
export function isBlockedResponse(status: number, text: string): boolean {
  if ([401, 403, 407, 429, 451, 503].includes(status)) return true
  return CHALLENGE_RE.test(text.slice(0, 4000))
}

/** Web Archive（Wayback Machine）の最新の保存版。id_ で保存時の原文そのものを返す */
export function archiveUrl(url: string): string {
  return `https://web.archive.org/web/2id_/${url}`
}

/** memento-datetime ヘッダー（保存された日時）を YYYY-MM-DD にする */
export function archiveDate(header: string | undefined): string {
  if (header === undefined) return ''
  const d = new Date(header)
  return Number.isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10)
}

// ───────────────────────────── 自動で取りに行ってよい URL か

/**
 * 社内・ローカルのアドレスか: localhost、プライベート・リンクローカルの IP、
 * .local や .internal、ドットのないホスト名（社内のサーバー名）。
 * new URL() を通したホスト名を渡す（10進・16進の IP は 127.0.0.1 の形に直っている）
 */
export function isPrivateHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '')
  if (h === '') return true
  if (/(^|\.)(localhost|local|internal|intranet|corp|lan|home\.arpa)$/.test(h)) return true
  if (h.includes(':')) {
    // IPv6: ループバック・未指定・ユニークローカル（fc00::/7）・リンクローカル（fe80::/10）・IPv4 射影
    return h === '::1' || h === '::' || /^f[cd]/.test(h) || /^fe[89ab]/.test(h) || h.startsWith('::ffff:')
  }
  const ip = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h)
  if (ip === null) return !h.includes('.')
  const [a, b] = [Number(ip[1]), Number(ip[2])]
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) || // CGNAT
    (a === 169 && b === 254) || // リンクローカル（クラウドのメタデータもここ）
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    a >= 224
  )
}

// 認証情報が入っていそうなクエリの名前
const SECRET_PARAM_RE = /token|secret|passw|pwd|api[_-]?key|apikey|access[_-]?key|auth|session|signature|credential/i
const SECRET_PARAM_NAMES = new Set(['code', 'key', 'sig', 'sid', 'jwt'])

/** 長いランダムな文字列か（git のコミットハッシュは除く） */
function isTokenLike(text: string): boolean {
  if (/^[0-9a-f]{40}$|^[0-9a-f]{64}$/i.test(text)) return false
  return text.length >= 32 && /^[A-Za-z0-9+/_=.-]+$/.test(text) && /\d/.test(text) && /[A-Za-z]/.test(text) &&
    (text.match(/-/g) ?? []).length <= 3
}

/**
 * Claude が書いた URL を、人の確認なしに取りに行かない理由（取りに行ってよければ undefined）。
 * 読んだページに仕込まれた指示で、Claude が「出典」として秘密を載せた URL や
 * 社内のアドレスを書かされても、mod が勝手にそこへアクセスしないように
 */
export function urlHoldReason(url: string): string | undefined {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return 'URL として読めないため'
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return 'http・https 以外の URL のため'
  if (u.username !== '' || u.password !== '') return 'URL にユーザー名・パスワードが含まれるため'
  if (isPrivateHost(u.hostname)) return '社内・ローカルのアドレスのため'
  if (u.search.length > 300) return 'URL のクエリが長すぎるため'
  const params: [string, string][] = []
  u.searchParams.forEach((value, name) => params.push([name, value]))
  for (const [name, value] of params) {
    if (SECRET_PARAM_RE.test(name) || SECRET_PARAM_NAMES.has(name.toLowerCase())) {
      return `URL に認証情報らしい値（${name.slice(0, 20)}=…）が含まれるため`
    }
    if (value.length >= 64 || isTokenLike(value)) return 'URL のクエリに長いランダムな文字列が含まれるため'
  }
  for (const segment of u.pathname.split('/')) {
    let part = segment
    try {
      part = decodeURIComponent(segment)
    } catch {
      // そのまま調べる
    }
    if (isTokenLike(part)) return 'URL のパスに長いランダムな文字列が含まれるため'
  }
  return undefined
}

// ───────────────────────────── PDF（自動では読めない）

/** URL のパスが .pdf で終わるか（?query や #page=6 は見ない） */
export function isPdfUrl(url: string): boolean {
  return /\.pdf$/i.test(url.split(/[?#]/)[0] ?? '')
}

/** PDF の URL の #page=6 を読む */
export function pdfPage(url: string): number | undefined {
  const m = /#(?:.*&)?page=(\d{1,5})\b/i.exec(url)
  return m?.[1] === undefined ? undefined : Number(m[1])
}

/** 🔒（アクセス拒否）・📄（PDF）の主張を、自動で取得できる別の一次情報で裏付け直す依頼文 */
export function alternativeSourcePrompt(
  items: readonly { claim: string; source: UradoriSource; isPdf?: boolean }[],
): string {
  const hasPdf = items.some(c => c.isPdf)
  const hasBlocked = items.some(c => !c.isPdf)
  const why = [hasBlocked ? 'アクセス制限（ボット対策など）' : '', hasPdf ? 'PDF（ウラ取りmod は自動で読めません）' : '']
    .filter(Boolean)
    .join('や')
  return [
    `【ウラ取りmod】次の主張の出典は${why}のため、原文を自動で確かめられませんでした。`,
    ...items.map((c, i) => `${i + 1}. ${c.claim}（出典: ${sourceLabel(c.source)}${c.isPdf ? '・PDF' : ''}）`),
    '',
    '同じ内容を、別の一次情報（公的機関・法令・規格・原典・公式ドキュメント。ログインやボット確認のない HTML のページ）で探して実際に開き、',
    '「主張（出典: https://… の該当ページ・見出し「原文の短い引用」）」の形で、ページ内のどこに書いてあるかまで示して書き直してください。見つからなければ「未確認」と明記してください。',
  ].join('\n')
}

// ───────────────────────────── 回答の本文に印を付ける

/**
 * 主張が回答のどの文にあるか: その文を回答の原文どおりに返す（印はこの文の後ろに付ける）。
 * 主張はかっこ・強調・`` ` `` を外してあるので、それらを無視して探す。見つからなければ ''
 */
export function claimAnchor(answer: string, claim: string): string {
  // `` ` `` と * ~ を外した回答と、外した位置から元の位置への対応
  const kept: number[] = []
  let bare = ''
  for (let i = 0; i < answer.length; i += 1) {
    const c = answer[i] ?? ''
    if (c === '`' || c === '*' || c === '~') continue
    kept.push(i)
    bare += c
  }
  const wanted = claim.replace(/[`*~]/g, '').trim()
  if (wanted === '') return ''
  // 主張の途中にあった出典の説明を外していることがあるので、見つからなければ頭の部分で探す
  let at = bare.indexOf(wanted)
  let length = wanted.length
  if (at === -1 && [...wanted].length >= 8) {
    const head = [...wanted].slice(0, 12).join('')
    at = bare.indexOf(head)
    length = head.length
  }
  if (at === -1) return ''
  const start = kept[at] ?? 0
  const end = (kept[at + length - 1] ?? start) + 1
  return sentenceAround(answer, start, end).text.trim()
}

/** 本文のこの位置がコードブロック（``` の中）か */
function isInFence(text: string, at: number): boolean {
  return ((text.slice(0, at).match(/^\s*(```|~~~)/gm) ?? []).length) % 2 === 1
}

/**
 * 本文の、各主張の文の後ろに印を差し込む（表示だけ。保存された回答は変えない）。
 * 同じ文の主張の印はまとめる。見つからない文・コードブロックの中の文には付けない。
 * 戻り値の placed は、印を付けられた items の番号
 */
export function placeMarks(
  text: string,
  items: readonly { anchor: string; mark: string }[],
): { text: string; placed: number[] } {
  const at = new Map<number, string[]>()
  const placed: number[] = []
  items.forEach((item, i) => {
    if (item.anchor === '') return
    const start = text.indexOf(item.anchor)
    if (start === -1) return
    const end = start + item.anchor.length
    if (isInFence(text, start)) return
    at.set(end, [...(at.get(end) ?? []), item.mark])
    placed.push(i)
  })
  let out = text
  // 後ろから差し込むと位置がずれない
  for (const end of [...at.keys()].sort((a, b) => b - a)) {
    out = `${out.slice(0, end)} ${(at.get(end) ?? []).join(' ')}${out.slice(end)}`
  }
  return { text: out, placed }
}

/** 端末での表示幅（全角・絵文字は2マス） */
export function cellWidth(text: string): number {
  let n = 0
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0
    if (cp < 0x20 || (cp >= 0x300 && cp < 0x370) || cp === 0x200d || (cp >= 0xfe00 && cp <= 0xfe0f)) continue
    const isWide =
      (cp >= 0x1100 && cp <= 0x115f) ||
      (cp >= 0x2e80 && cp <= 0xa4cf) ||
      (cp >= 0xac00 && cp <= 0xd7a3) ||
      (cp >= 0xf900 && cp <= 0xfaff) ||
      (cp >= 0xfe30 && cp <= 0xfe4f) ||
      (cp >= 0xff00 && cp <= 0xff60) ||
      (cp >= 0xffe0 && cp <= 0xffe6) ||
      (cp >= 0x1f300 && cp <= 0x1faff) ||
      (cp >= 0x20000 && cp <= 0x3fffd) ||
      cp === 0x26a0 || cp === 0x2714 || cp === 0x2716
    n += isWide ? 2 : 1
  }
  return n
}

/** ちょうど cells マスにする: 長ければ「…」で切り、短ければ空白で埋める */
export function fitCells(text: string, cells: number): string {
  // 改行・タブだけを空白にする（行頭の字下げは残す）
  const flat = text.replace(/[\r\n\t]+/g, ' ')
  if (cellWidth(flat) <= cells) return flat + ' '.repeat(cells - cellWidth(flat))
  let out = ''
  for (const ch of flat) {
    if (cellWidth(out + ch) > cells - 1) break
    out += ch
  }
  return `${out}…${' '.repeat(Math.max(0, cells - 1 - cellWidth(out)))}`
}
