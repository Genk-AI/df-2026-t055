# Vertex Gemini TTS の設定と確認

TTSは任意機能であり、既定はローカルの無音Fake。実モデルを使う場合は `TTS_PROVIDER=vertex`、`GOOGLE_CLOUD_PROJECT`、`TTS_LOCATION` を設定する。`TTS_MODEL` の既定は `gemini-2.5-flash-tts`、`TTS_VOICE` の既定は `Kore`。実装が扱うモデルは `gemini-2.5-flash-tts` と `gemini-2.5-pro-tts` に限定する。SDKはApplication Default Credentialsを使う。秘密情報をリポジトリへ置かない。

リージョンは自動選択しない。設定前に[Gemini-TTSの対応モデル・Vertex AI API対応リージョン・日本語](https://docs.cloud.google.com/text-to-speech/docs/gemini-tts)を確認し、データの処理場所をチームで決める。公式表では `us-central1` 等に対応するが、これは日本国内処理を意味しない。例示は推奨や承認ではない。実際に設定したモデル、リージョン、声、日付、プロジェクト、担当者を検証記録に残す。

Vertex応答は24kHz・16bit・モノラルのPCMとして受け、WAVに変換する。空、途中終了、不正形式、30秒超のPCMは失敗扱いとし、Fakeや無音へ切り替えない。API要求は30秒でタイムアウトする。形式検査は読み上げ内容・音質・速度が本人に適切であることの証明にはならない。

費用はモデル・API・リージョン・契約で変わり得る。[Google CloudのTTS料金表](https://cloud.google.com/text-to-speech/pricing)には参考としてGemini 2.5 Flash TTSの入力100万テキストトークンあたり$0.50、出力100万音声トークンあたり$10、音声1秒あたり25トークンと記載されている。これはCloud Text-to-Speechの掲載値であり、Vertex利用時の請求額の実測ではない。利用前に対象プロジェクトのVertex側の料金と予算通知を確認し、入力・出力トークン数と課金額を記録する。実際の音質・単価・費用は未確認。

許可された環境で、架空の短文について職員が承認操作を行い、成功時の音声再生、音声不要時に呼び出されないこと、失敗時に無音版が承認されないことを確認する。生成した音声の読み違い、声、速度、周囲の騒音、手動再生の操作について、チームの確認と本人・現場による評価を分けて記録する。承認中に用いた短文以外のプロフィールや支援記録を送らない。`NODE_ENV=production` の本番構成ガードや未接続サービスは、この設定だけでは解除されない。
