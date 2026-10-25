// ウラ取りmod（uradori）の $.state の型。register.tsx はここから型を読み込む。

/** 出典: プロジェクト内のファイル（行番号つきのこともある）か、ウェブページ */
export type UradoriSource =
  | { kind: 'file'; ref: string; line?: number }
  | { kind: 'url'; ref: string }

/** 判定: 一致 / 食い違い / 確認できない / 判定中 */
export type UradoriVerdict = 'match' | 'mismatch' | 'unknown' | 'pending'

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
}

/** 1回の回答に対するウラ取り */
export type UradoriRun = {
  id: string
  status: 'checking' | 'done'
  checks: UradoriCheck[]
  note: string
}

declare module 'claude-code' {
  interface PluginState {
    uradori: {
      run: Shaped<UradoriRun | null>
      /** 原文ポップアップで表示中のチェックの id */
      selected: string | null
      isEnabled: boolean
      isAutoPopup: boolean
      isBandHidden: boolean
    }
  }
}
