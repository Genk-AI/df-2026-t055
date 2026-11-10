---
type: Feature
title: 支援記録の音声入力
description: 職員認証のAPIを介して文字起こしし、確認・訂正した文字だけを記録する。
authority: normative
status: stable
feature_id: speech-input
scope: core
implementation: present
verification: automated
assessed_commit: 56341d9bbb3acbc4c3eb6b1e8752657009a97d86
owner: unassigned
issues:
  - https://github.com/Genk-AI/df-2026-t055/issues/17
  - https://github.com/Genk-AI/df-2026-t055/issues/21
  - https://github.com/Genk-AI/df-2026-t055/issues/22
  - https://github.com/Genk-AI/df-2026-t055/issues/76
code:
  - apps/api/src/speech.ts
  - apps/api/src/app.ts
  - apps/web/src/speech-recorder.ts
  - apps/web/src/support-record.tsx
tests:
  - tests/speech-transcription.test.ts
  - tests/api-support-transcription.test.ts
  - tests/web-support-record-speech.test.ts
evidence:
  - docs/implementation-audits/20261110-1818-56341d9.md
gaps:
  - 実GCPのSpeech-to-Text V2への疎通・実認証・実リクエストは未実施。transportを差し替えた単体テストだけを確認した。
  - 実ブラウザ・実マイクでの録音は未実施。MediaRecorderとAudioContextはスタブ検証のみで、SafariがWebMをデコードできない場合の実挙動は未確認。
  - 実端末でのマイク許可拒否・通信断・タイムアウト・キャンセルの実機確認は未実施。
  - 実請求額・SKUの実適用、chirp_3を名指しした単価は未確認。
  - 本人・現場による認識精度と訂正負担の評価は未実施。Speech Adaptation（用語のバイアシング）は採用範囲外のまま。
  - 実APIと実ブラウザの結合確認は未実施。
verification_scope: local-automated-tests
---

# 支援記録の音声入力

**支援記録の音声入力の方式（2026-11-09に [#22](https://github.com/Genk-AI/df-2026-t055/issues/22) で決定。実装は #76）。** 音声入力は支援記録フォームの3項目（`observedDifficulty` / `assistanceGiven` / `improvementSuggestion`）の入力時だけに提供し、担当者が claim → start → 対応 → acknowledge した後の記録入力時に使う。作業セッション中に常時聞き続ける用途には使わない。認識はGoogle Cloud Speech-to-Text V2（`chirp_3`・`ja-JP`）とし、ブラウザはCloud Runの`web-api`（職員認証）へ音声を送り、`web-api`からSpeech-to-Textへ渡して**文字起こしだけ**を返す。ブラウザからSpeech-to-Textへ直接送らず、ブラウザ内蔵のWeb Speech API（SpeechRecognition）は送信先・保存をアプリ側で制御できないため使わない。音声は`web-api`のメモリ上でのみ処理し、Storage・Firestore・ログへ保存しない。保存するのは職員が確認・訂正した文字だけで、既存の`PUT /support-requests/{id}/record`（`expectedRevision`競合検査つき）を使い、`supportRecords`のスキーマは変えない。Chirp 3は`us`/`eu`マルチリージョンのみのため、音声は東京リージョンでは処理しない。マイク許可の拒否・非対応・通信断・タイムアウト・認識失敗・キャンセルでも入力済みの文字を残し、再試行で既存の文字を上書きしない。費用はV2標準 $0.016/分（V2に無料枠なし、1秒単位の切り上げ）で、実装PRにモデルID・リージョン・単価・利用量の確認結果を残す。Speech Adaptation（用語のバイアシング）は今回の採用範囲外とし、デモ期間中に訂正負担を実測してから採否を判断する。

## 実装した契約

音声は`audio/wav`（16kHz・16bit・モノラルのPCM）の生バイナリとして`POST /support-requests/{id}/record/transcriptions`へ送る。リクエストは5MB以下、音声は5秒以上60秒以下とし、60秒ちょうどは許可し60秒を超える入力は`AUDIO_TOO_LONG`で拒否する。ブラウザは録音開始から60秒で自動停止する。サーバーは変換前の長さをffprobeで検査し、ffmpeg（タイムアウト20秒）で16kHz・16bit・モノラルのWAVへ正規化してから、変換後の長さも再検査する。文字起こしはSpeech-to-Text V2の同期Recognize（タイムアウト30秒）を1回呼び、`{schemaVersion:"1",transcript}`だけを返す。録音・変換結果はメモリ上と`finally`で削除する一時ディレクトリだけで扱う。

職員ロールだけが呼べ、対象が`help`かつ`in_progress`または`acknowledged`でなければ409`INVALID_STATE`を返す。この検査は音声の受信より前に行う。入力不正は422（`INVALID_AUDIO`・`AUDIO_TOO_SHORT`・`AUDIO_TOO_LONG`・`AUDIO_TOO_LARGE`）、文字起こしの失敗は502（`SPEECH_REQUEST_FAILED`・`SPEECH_NO_TRANSCRIPT`・`SPEECH_TRANSCRIPT_TOO_LONG`・`SPEECH_NOT_CONFIGURED`・`SPEECH_INVALID_CONFIG`）とし、未知の例外も502`SPEECH_REQUEST_FAILED`へ丸めて内部情報を応答に出さない。このAPIは保存・承認・再開を実行せず、`supportRecords`・`sessions`・`sessionEvents`を書き換えない。

接続先は`SPEECH_PROVIDER`で選ぶ。既定は`fake`（固定の日本語を返し、外部へ送らない）で、`google`または`vertex`のときだけ実APIを呼ぶ。`SPEECH_LOCATION`は必須で既定値を持たず、`us`と`eu`だけを許可する。`SPEECH_MODEL`の既定は`chirp_3`、`SPEECH_LANGUAGE`の既定は`ja-JP`、`SPEECH_RECOGNIZER`の既定は`_`（暗黙のRecognizer）。`NODE_ENV=production`では`SPEECH_PROVIDER`が`google`でなければ起動を拒否する。設定と運用手順は[Speech-to-Textの設定と確認](../deploy/speech-to-text.md)に置く。

## 画面と確認・訂正

支援記録フォームの3欄それぞれの直後に「音声で入力」ボタンを置く。録音中・文字起こし中は保存ボタンを押せない。認識結果はすぐには欄へ入れず、確認ブロック（`role='group'`、`aria-label='音声入力の確認'`）に読み取り専用で表示し、「この内容を欄に入れる」で既存の文字の末尾へ改行を挟んで追記する。既存の文字は上書きも置換もしない。「取り消す」では欄を一切変えない。失敗・拒否・変換失敗・短すぎる録音は`role='alert'`で理由を出し、入力済みの文字を残す。マイク許可の拒否は専用の案内にする。録音中に「後で記録する」で閉じた場合、フォームが`open=false`になった場合、アンマウントされた場合は、録音を止めてマイクを解放する。文字起こしの送信は`apps/web/src/main.tsx`の`transcribeAudio`が`audio/wav`を送る。

## 共通契約と受入条件

- [APIとエンドポイント](../contracts/api.md)
- [データと状態遷移](../contracts/data-model.md)
- [受入条件・評価の記録](../validation/acceptance.md)
- [設計根拠と限界](../research/sources.md)
- [Speech-to-Textの設定と確認](../deploy/speech-to-text.md)
- [ADR-0002：支援記録の音声入力をweb-api経由の非保存で行う](../adr/0002-speech-input-transcription.md)

## 設計根拠と未確認事項

[REPORT 第6節](../research/REPORT.md)と第8節の「音声」、第11節の本人・音声比較を確認した。第6節の出典ID T0・T1・T5は読み上げの効果を本製品の作業達成へ換算できないことを示し、音声だけに依存しない方針を支える。音声入力の認識精度と訂正負担を比較した研究は今回の連鎖から確認できていない。第8節の「音声」は承認時の事前生成を対象にした判断であり、職員の記録入力を音声で行うことへの直接の根拠ではない。第11節の「本人・音声比較」は読み上げの速度・操作を対象にしており、職員が話した音声の認識精度は含まない。対応する判断IDがないため、関連する節として第6節・第11節を示す。

操作結果を事実に応じて返す点は第8節A3（出典ID C0・W5・W6・W7）、通信断でも入力済みの内容を失わない点はA5（出典ID C0・N0・M1・AV0・B1）と方向が同じである。ただしA3・A5はいずれも本人画面の支援要求・承認版に関する判断で、職員の記録入力を対象にした検証ではない。本機能では「認識結果を確認してから欄へ入れる」「失敗しても入力済みの文字を残す」という形で採用した。チーム内の自動テストで確認した範囲と、本人・現場による評価は区別する。

## 実装・検証の確認範囲

実GCPのSpeech-to-Text V2への疎通・実認証・実リクエスト、実ブラウザ・実マイクでの録音、実端末でのマイク許可拒否・通信断・タイムアウト・キャンセル、実請求額とSKUの実適用、本人・現場による認識精度と訂正負担の評価は未実施。自動テストはtransport・MediaRecorder・AudioContextをスタブした範囲の確認であり、実環境の動作を保証しない。 実装状況はフロントマターに記録する。`present`は対応コードが存在するという静的確認であり、全要件の実装完了を示さない。
