---
type: Architecture Decision Record
title: ADR-0002 支援記録の音声入力をweb-api経由の非保存で行う
description: 文字起こしを職員認証のAPI経由で行い、音声を保存せず確認済みの文字だけを記録する方式を採用する。
authority: reference
status: draft
---

# ADR-0002：支援記録の音声入力をweb-api経由の非保存で行う

## 背景

支援記録の3項目（どこでつまずいたか／何をしたか／次回の改善提案）は、支援の直後に職員が入力する。入力の負担を下げるため音声入力を検討したが、本人の支援に関する発言を含み得る音声を、誰がどの経路で処理し、どこまで保存するかを決める必要があった。方式は2026-11-09に [#22](https://github.com/Genk-AI/df-2026-t055/issues/22) で決定し、実装は #76 で行った。本ADRはその判断と、#76で確定した具体的な契約を記録する。機能要件の正本は[支援記録の音声入力](../features/speech-input.md)。

## 比較した選択肢

| 選択肢 | 利点 | 負担・判断理由 |
| --- | --- | --- |
| ブラウザ内蔵のWeb Speech API（SpeechRecognition）を使う | サーバー実装が要らず、端末内で完結し得る | 送信先・保存の有無をアプリ側で制御できず、ブラウザごとに挙動が異なる。支援記録の内容がどこへ送られるかを説明できないため不採用 |
| ブラウザからSpeech-to-Textへ直接送る | 経路が短く、APIの実装が不要 | 職員の認証・所属・対象の認可をSpeech-to-Text側で検査できず、ブラウザに資格情報を渡す必要がある。不採用 |
| web-api（職員認証）経由で同期Recognizeを使う | 既存の職員認証・所属検査・状態検査をそのまま適用できる。音声を保存せずに文字起こしだけを返せる | 音声がCloud Runを経由し、変換とタイムアウトの管理が必要になる。**採用** |
| web-api経由でストリーミング認識を使う | 話しながら結果が出る | 5〜60秒の短い録音には過剰で、接続の維持・部分結果の確定・中断の扱いが増える。同期Recognizeで要件を満たすため不採用 |
| 音声を保存して後から文字起こしする | 失敗時に再処理できる | 音声の保管・削除・閲覧権限・保管期限を新たに設計する必要があり、保存する対象を増やさない方針に反する。不採用 |

## 決定

**web-api（職員認証）経由の同期Recognizeで文字起こしだけを返し、音声を保存しない方式を採用する。** 具体的には次のとおり。

- ブラウザは録音を16kHz・16bit・モノラルのWAVへ変換し、`POST /support-requests/{id}/record/transcriptions` へ `audio/wav` の生バイナリで送る。5MB以下、5秒以上60秒以下に限る。
- サーバーは職員ロールと対象の状態（`help`かつ`in_progress`または`acknowledged`）を音声の受信前に検査し、ffprobeで変換前の長さを検査してからffmpegで正規化し、変換後の長さも再検査する。文字起こしはSpeech-to-Text V2の同期Recognizeを1回呼ぶ。
- 応答は `{schemaVersion:"1",transcript}` だけ。保存・承認・再開を実行せず、`supportRecords` のスキーマを変えない。
- 認識結果はすぐには欄へ入れず、確認ブロックに出して職員が「この内容を欄に入れる」を押したときだけ、既存の文字の末尾へ追記する。取り消すと欄を変えない。
- 録音・変換結果はメモリ上と`finally`で削除する一時ディレクトリだけで扱い、Storage・Firestore・ログへ書かない。
- 既定はFake（固定の日本語を返し外部へ送らない）。`SPEECH_PROVIDER=google` のときだけ実APIを呼び、`SPEECH_LOCATION` は `us`・`eu` だけを許可する。`NODE_ENV=production` では `SPEECH_PROVIDER=google` 以外の起動を拒否する。

同期Recognizeを選んだ理由は、録音が最大60秒で、同期Recognizeの入力上限（10MBまたは1分）に収まるため。音声を保存しない理由は、保存する対象と削除運用を増やさずに済むため。確認してから反映する理由は、認識の誤りを職員が直せる状態を保ち、認識だけで記録を確定させないため。

## 影響

- 職員の記録入力を音声で行えるようになるが、認識結果の確認と訂正の手間は残る。訂正負担の実測は未実施で、Speech Adaptation（用語のバイアシング）は採用範囲外のまま。
- 音声がCloud Runを経由するため、リクエストログ・例外ログに音声や文字起こしが混入しないよう継続して確認する必要がある。data loggingへオプトインしない運用を前提にする。
- `chirp_3` は `us`・`eu` マルチリージョンのみのため、日本国内で処理できない。データの処理場所はチームが明示的に決める必要があり、[Speech-to-Text V2 の設定と確認](../deploy/speech-to-text.md)に手順を置いた。
- 費用はV2標準の$0.016/分（1秒単位の切り上げ、V2に無料枠の記載なし）を前提に試算する。実請求額は未確認。
- 保存するデータは増えない。`supportRecords` のスキーマと、既存の `PUT /support-requests/{id}/record` の `expectedRevision` 競合検査を維持する。

## 根拠・関連仕様

- [支援記録の音声入力](../features/speech-input.md)
- [HTTP APIの共通契約とエンドポイント](../contracts/api.md)
- [保存データ・状態遷移・保管期限](../contracts/data-model.md)
- [受入条件・評価の記録](../validation/acceptance.md)
- [Speech-to-Text V2 の設定と確認](../deploy/speech-to-text.md)
- [設計根拠と出典の使い方](../research/sources.md)
- [REPORT 第6節・第8節・第11節](../research/REPORT.md)
- [ADR-0001：仕様を機能ごとの文書群で管理する](0001-feature-specifications.md)
- [#22 支援記録の音声入力方式の決定](https://github.com/Genk-AI/df-2026-t055/issues/22)、[#76 実装](https://github.com/Genk-AI/df-2026-t055/issues/76)

## 確認状況

記録日：2026-11-10。記録担当：Codex。確認対象：`02aa270dff0ad673805d0cc93281cd77d42cb701`（#76 の実装コミット）。自動テストは `tests/speech-transcription.test.ts`・`tests/api-support-transcription.test.ts`・`tests/web-support-record-speech.test.ts` の39件で、transport・MediaRecorder・AudioContextをスタブした範囲を確認した。全テスト448件・型検査・Lintは成功。

未確認：実GCPのSpeech-to-Text V2への疎通・実認証・実リクエスト、実ブラウザ・実マイクでの録音、実端末でのマイク許可拒否・通信断・タイムアウト・キャンセル、実請求額とSKUの実適用、`chirp_3` 名指しの単価、本人・現場による認識精度と訂正負担の評価、実APIと実ブラウザの結合確認。本ADRへの独立レビューは未実施。方式の採用と、実装完了・実環境での動作・本人評価は別に扱う。
