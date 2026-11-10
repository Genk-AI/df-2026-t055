---
type: Runbook
title: Speech-to-Text V2 の設定と確認
authority: operational
status: stable
---

# Speech-to-Text V2 の設定と確認

音声入力は任意の接続先を持つ。既定はローカルのFakeで、外部へ音声を送らず固定の日本語を返す。実モデルを使う場合は `SPEECH_PROVIDER=google`、`GOOGLE_CLOUD_PROJECT`、`SPEECH_LOCATION` を設定する。`SPEECH_MODEL` の既定は `chirp_3`、`SPEECH_LANGUAGE` の既定は `ja-JP`、`SPEECH_RECOGNIZER` の既定は `_`（暗黙のRecognizer）。`SPEECH_PROVIDER` は `fake`・`google`・`vertex` だけを受け付け、それ以外は起動時に拒否する。SDKはApplication Default Credentialsを使い、スコープは `https://www.googleapis.com/auth/cloud-platform`。秘密情報をリポジトリへ置かない。

## リージョンとデータの処理場所

リージョンは自動選択しない。**`SPEECH_LOCATION` は必須で既定値を持たず、`us` と `eu` だけを許可する。** これは `chirp_3` が `us`・`eu` のマルチリージョンでのみGAであるためで、`us-central1` などの単一リージョンを指定すると `SPEECH_INVALID_CONFIG` で拒否する。設定前に[Chirp 3のモデル・リージョン・言語](https://docs.cloud.google.com/speech-to-text/docs/models/chirp-3)を確認し、データの処理場所をチームで決める。`us`・`eu` は日本国内処理を意味しない。最新の対応状況はLocations APIで確認するのが正であり、実プロジェクトでの確認は未実施。実際に設定したモデル、リージョン、日付、プロジェクト、担当者を検証記録に残す。

エンドポイントは `https://{location}-speech.googleapis.com/v2/projects/{project}/locations/{location}/recognizers/{recognizer}:recognize`。音声はJSONの `content` にbase64で載せ、`config` は `autoDecodingConfig: {}`（ヘッダ付きWAVの自動判定）、`languageCodes`、`model` を送る。ヘッダ付きWAVは自動判定できるため `explicitDecodingConfig` は使わない。

## IAM

呼び出し元のサービスアカウントに `roles/speech.client`（Cloud Speech Client）を付ける。このロールは `speech.recognizers.recognize` を含む。`roles/speech.editor` など書き込み権限は不要。[Speech-to-TextのIAM](https://docs.cloud.google.com/speech-to-text/docs/iam)を参照する。

## 入力の制約

音声は5秒以上60秒以下、リクエストは5MB以下。60秒ちょうどは許可し、60秒を超える入力は `AUDIO_TOO_LONG` で拒否する。サーバーはffprobeで変換前の長さを検査し、ffmpeg（タイムアウト20秒）で16kHz・16bit・モノラルのWAVへ正規化してから変換後の長さも再検査する。文字起こしは同期Recognizeを1回呼び、タイムアウトは30秒。空の結果、不正な応答、5xx、タイムアウトは失敗扱いとし、Fakeへ切り替えない。同期Recognizeの上限は10MBまたは1分のうち先に達した方で、16kHzは最適なサンプルレートとされている（[割り当てと上限](https://docs.cloud.google.com/speech-to-text/docs/quotas)、[短い音声の書き起こし](https://docs.cloud.google.com/speech-to-text/docs/sync-recognize)）。形式検査は認識精度を保証しない。

## 料金

費用はモデル・リージョン・契約で変わり得る。[Speech-to-Textの料金表](https://docs.cloud.google.com/speech-to-text/docs/pricing)には、V2の標準認識が0〜500,000分/月で$0.016/分、以降500,000〜1,000,000分は$0.01/分、1,000,000〜2,000,000分は$0.008/分、2,000,000分以上は$0.004/分と記載されている。課金は1秒単位で切り上げ、サーバーエラーは課金対象外、空応答でも課金される。**V2の料金表に無料枠の記載はない**（60分の無料枠はV1の表にのみ存在する）。`chirp_3` を名指しした単価の行は料金表になく、標準モデルとして適用されると読めるが明示はない。**実請求額・SKUの実適用は未確認。** 利用前に対象プロジェクトの予算通知を確認し、入力秒数と課金額を記録する。60秒の録音1本は1分課金で$0.016の試算になるが、これは掲載値による試算であり請求の実測ではない。

## 音声・文字起こしの扱い

音声と文字起こしはStorage・Firestore・アプリのログへ保存しない。アプリは音声バイト・transcript・base64をconsole・エラー本文・例外メッセージへ出さない。**data loggingへオプトインしない。** [データログ](https://docs.cloud.google.com/speech-to-text/docs/data-logging)によればCloud Speech-to-Textは既定で音声・文字起こしをログしないが、オプトインするとGoogleがサービス改善に使い、プロジェクトを削除してもデータは消えない。本人の音声には支援や障害に関する発言が含まれ得るため、割引より安全側を優先する。Cloud Runやプロキシのリクエストログ、例外・外部SDKログにも同じ情報が入っていないか、テストデータで閲覧権限を持つ担当が確認する。実環境のログ確認は未実施。

## 確認手順と未確認事項

許可された環境で、架空の短文について職員が録音・停止し、確認ブロックに認識結果が出ること、欄へ入れるまで欄が変わらないこと、取り消すと欄が変わらないこと、失敗時に文字が残ることを確認する。マイク許可の拒否、通信断、タイムアウト、60秒の自動停止も実機で試す。認識の読み違い、騒音下の精度、話し方の差、訂正にかかる時間について、チームの確認と本人・現場による評価を分けて記録する。

未確認：実GCPのSpeech-to-Text V2への疎通・実認証・実リクエスト、実ブラウザ・実マイクでの録音（SafariがWebMをデコードできない場合の実挙動を含む）、実端末での許可拒否・通信断・タイムアウト・キャンセル、Locations APIによる実リージョン確認、同期Recognizeの保持期間の数値、`chirp_3` 名指しの単価、V2無料枠の将来付与、実請求額・SKUの実適用、日本語の認識精度と訂正負担の本人・現場評価。`NODE_ENV=production` では `SPEECH_PROVIDER=google` 以外の起動を拒否するが、この設定だけでは本番の疎通確認を済ませたことにならない。
