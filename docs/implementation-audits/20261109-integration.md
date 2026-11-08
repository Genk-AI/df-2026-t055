# 未統合PRの結合確認

- 対象: `a09cd59`、基点 #143 / `97129b0`。TTS #125 / `a0a2ed9`、支援一覧とフォールバック #128 / `4ba8597`、本人停止・支援待ち #129 / `723308d`、PR手順 #141 / `5c135e0`、CI #89 / `79cc983` を各依存とともに統合した。各PRはmainへ未マージ。実装・競合解消 Codex、独立レビュー担当未割当。
- TTSとの競合はAPIの `@google/genai`、Firestore、Firebase Admin、Google認証をすべて保持し、Node 24のnpmでロックを再生成した。支援一覧との競合は、支援APIのスキーマ群と履歴・作業一覧のスキーマ群、Firebaseのトークン取得と職員通知の購読をいずれも保持した。`git show --remerge-diff` で両方の競合解消を確認した。
- Node 24で `npm ci` 後、全310テスト、typecheck、build、`git diff --check` が成功。停止優先・認可・版固定・音声・支援画面・改善生成のテストを含む。npm auditは先行依存由来の中程度4件を検出。
- 未確認: GitHub Actionsの実行結果、実Firebase・Firestore・Storage・Cloud Tasks・Scheduler・Vertex・TTSの結合、クラウド環境・IAM・本番URL、独立レビュー、実利用者による表示とアクセシビリティ。API本番起動ガードは維持。先行PRの統合先やSHAが変われば対象を固定して再検証する。
- #76 の音声入力は、ユーザーの回答に従い方式・送信先などの人間による設計判断 #22 が終わるまで保留。
