// ウラ取りmod（uradori）の $.state の型。register.tsx はここから型を読み込む。

/** 出典: プロジェクト内のファイル（行番号つきのこともある）か、ウェブページ */
export type UradoriSource =
  | { kind: 'file'; ref: string; line?: number }
  | { kind: 'url'; ref: string }

/**
 * 判定: 一致 / 食い違い / 引用ずれ / 確認できない / 判定中。
 * drift = Claude が添えた引用が原文に一字一句は見つからないが、主張の内容は食い違っていない
 * （原文と一致、または判定できなかった）。事実の食い違い（mismatch）とは分けて示す
 */
export type UradoriVerdict = 'match' | 'mismatch' | 'drift' | 'unknown' | 'pending'

/** 原文から取り出した1行（mod自身が読んだテキストそのもの） */
export type UradoriLine = { line: number; text: string }

/** 主張1つぶんのチェック結果 */
export type UradoriCheck = {
  id: string
  claim: string
  source: UradoriSource
  verdict: UradoriVerdict
  /** 判定の根拠になった原文の行 */
  evidence: UradoriLine[]
  /** 根拠の行とその前後（原文ポップアップに出す、実際の原文の該当箇所） */
  context: UradoriLine[]
  /** ページのタイトル（URL）またはファイル名 */
  title: string
  /** 実際のサイトの該当箇所に飛んでハイライトするリンク（テキストフラグメント） */
  link: string
  reason: string
  /** アクセス拒否（ボット対策など）で原文を取得できなかった */
  isBlocked: boolean
  /** 原文の入手先が本人のページでないとき（例: 'Web Archive 2026-04-25'）。直接読めたときは '' */
  via: string
  /** PDF なので自動では読めなかった（📄。利用者が自分で開いて確かめる） */
  isPdf: boolean
  /** 社内のアドレスや秘密らしい値を含む URL なので、自動では取りに行かなかった（⏸。人が押したときだけ取りに行く） */
  isHeld: boolean
  /** Claude が出典に添えた引用（「」やテキストフラグメント）。なければ '' */
  quote: string
  /** 引用が原文に一字一句あったか。引用がない・原文を読めなかったときは null */
  isQuoteFound: boolean | null
  /** 主張が書かれていた回答の文（回答の原文どおり）。本文の印はこの文の後ろに付ける。見つからなければ '' */
  anchor: string
}

/**
 * ウラ取りを始めたきっかけ:
 * auto = 回答に出典（URL・ファイル）があった / asked = 質問が根拠を求めていた / strict = /uradori strict 中
 */
export type UradoriTrigger = 'auto' | 'asked' | 'strict'

/** 1回の回答に対するウラ取り */
export type UradoriRun = {
  id: string
  status: 'checking' | 'done'
  checks: UradoriCheck[]
  note: string
  trigger: UradoriTrigger
  /** URL もファイルもない「名前だけの出典」。auto のときは null（数えない） */
  unsourced: string[] | null
  /** チェックした回答の本文（本文に印を付けるとき、どのメッセージの結果かを見分ける） */
  answer: string
}

declare module 'claude-code' {
  interface PluginState {
    uradori: {
      run: Shaped<UradoriRun | null>
      /** 最近のウラ取り（新しい順、最大 10 件）。前の回答の本文の印も残すため */
      history: Shaped<UradoriRun[]>
      /** 原文ポップアップで表示中のチェックの id */
      selected: string | null
      isEnabled: boolean
      /** ✖（食い違い）のとき原文ポップアップを自動で開く（既定: オフ） */
      isAutoPopup: Shaped<boolean>
      isBandHidden: boolean
      /** 根拠を求める質問を受けて、次の回答を必ずウラ取りする印（手がかりの言葉） */
      armed: string | null
      /** /uradori strict: 毎回の回答をウラ取り対象にする */
      isStrict: boolean
      /** アクセス拒否のとき Web Archive の保存版で確かめる */
      isArchive: boolean
    }
  }
}
