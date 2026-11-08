# ロール境界・承認・固定版の回帰確認

- 対象: #63。コードと正本の基点は #142 の `a16f191`。実施者 Codex、独立レビュー担当未割当。実Firebase・Cloud Storage・Cloud Runは未接続。APIとローカルのメモリ／偽クライアントを使った自動検証であり、実サービスの権限確認とは区別する。
- 実行: Node 24で `node --experimental-transform-types --test --test-isolation=none tests/acceptance.test.ts tests/api-manual-draft.test.ts tests/api-session-projection.test.ts tests/firebase-auth.test.ts tests/cloud-storage.test.ts tests/api-support-start-acknowledge.test.ts`。62件成功、失敗0。

| 対象 | 自動テストで確認した結果 | 主な証拠 |
| --- | --- | --- |
| 未認証 | トークン不正・期限切れを拒否 | `tests/firebase-auth.test.ts`、`tests/acceptance.test.ts` |
| 本人 | 下書き・原動画・未承認画像、別本人のデータを拒否 | `tests/acceptance.test.ts`、`tests/cloud-storage.test.ts` |
| 新人 | 職員用下書き・支援記録・職員操作を拒否 | `tests/acceptance.test.ts`、`tests/api-support-start-acknowledge.test.ts` |
| 別所属 | 他所属の対象への越境を拒否 | `tests/acceptance.test.ts`、`tests/firebase-auth.test.ts` |
| 不正・競合 | 入力・認証・revisionなどの401/403/409/422、異なる承認キーの競合を検査 | `tests/acceptance.test.ts`、`tests/api-support-start-acknowledge.test.ts` |
| 承認の再送 | 同じ冪等キーの直列・同時再送で1版、別キーは競合 | `tests/acceptance.test.ts`、`tests/api-manual-draft.test.ts` |
| 版固定 | コピー画像の分離、新版割当後も開始済みセッションが旧版を保持 | `tests/api-manual-draft.test.ts`、`tests/api-session-projection.test.ts` |

未完了: 実装者と別のレビュアーによる本人権限の確認とロール別の独立結果。実GCP上の認証・IAM・ネットワーク、実利用者と実ブラウザでの評価も未実施。先行PRは未マージであり、統合先が変わったら対象SHAを固定して再実行する。
