# てじゅんのバトン — t055 MVP

手本動画から作った下書きを職員が原動画と照合・編集し、承認した写真と短文だけを本人へ渡します。新人は同じ承認版と確認済みの教え方を参照します。正本は [現行プロダクト仕様](docs/PRODUCT_SPEC.md) です。

ローカル版は **Fake生成・架空プロフィール・インメモリ保存** です。実Geminiの解析結果や福祉上の効果を実証したものではありません。比較と棄却条件は [現行プロダクト仕様](docs/PRODUCT_SPEC.md) にあります。追加フェーズとして承認時TTSを実装しています。印刷・振り返り・採点・自己登録UIは実装しません。

## ローカル起動手順

必要環境：Node.js 24以上、npm 10以上、PATH上のffmpeg / ffprobe 6以上（H.264 / AAC対応）、npmレジストリに接続可能な環境。

### devenv（推奨）

Node.js・npm・ffmpeg / ffprobe・lefthook を [devenv](https://devenv.sh/) で揃えます。Nix と devenv が入っていれば、ホスト側にNodeを入れなくても動きます。バージョンは `devenv.lock` で固定しています。

```sh
devenv shell -- npm install
devenv shell -- npm run dev
```

`devenv shell -- <command>` の形でコマンドを実行してください。ホストのPATHにあるNodeやffmpegではなく、devenvの環境が使われます。シェルに入りっぱなしにする場合は `devenv shell` を実行し、その中で `npm ...` を叩きます。

### ホストのNodeを使う場合

devenv を使わず、ホストに Node.js 24以上と ffmpeg / ffprobe 6以上を入れて実行することもできます。この場合もコマンドは上と同じです。

```sh
npm install
npm run dev
```

ブラウザで `http://localhost:5173/staff` を開きます。APIは127.0.0.1:3001、generatorは127.0.0.1:3002。Viteが `/api` をAPIへ転送します。ルートのdevスクリプトが両サーバーを起動します。個別にAPIを起動する場合は**リポジトリのルートから** `node --experimental-transform-types apps/api/src/server.ts` を実行してください。

設定は環境変数のみです。[.env.example](.env.example) の値をシェルへ設定してください（.envの自動読込はしません）。`GENERATION_GLOBAL_LIMIT` は全組織合計のモデル呼出し予算で、既定30、0で生成受付停止。1作業10回の上限も常時有効です。停止しても承認版の閲覧は継続します。内部トークンを変更する場合はAPIとgeneratorの両方へ同じ値を設定します。

画面上部のデモアカウントで切り替えます。これはローカル専用の認証アダプタで、実サービスのログインではありません。

| アカウント | 系統 | 内容 |
| --- | --- | --- |
| staff | `/staff` | 手本登録、生成、照合・編集、確認、承認、割当、支援要求 |
| learner-a | `/me` | 架空Aさん、9工程 |
| learner-b | `/me` | 架空Bさん、折るを細分化した11工程 |
| newcomer | `/handover` | 承認版、声かけ・待つ位置、完成基準、原動画の区間、既読記録 |

1. 職員で「手本を登録」。音声付きMP4（50MB・180秒以内）を選びます。実体をffprobeで検査します。手本素材は同梱していないため、チームで撮影した動画を用意してください。
2. 本人プロフィールを選択し「AIの下書きを作る」。ローカルgeneratorが1秒間隔でキューを処理し、画面は3秒間隔で状態を取得します。
3. 原動画とAI候補を照合。短文、工程境界、本人に見せる注意、職員の観察・声・声かけ・完成基準を編集します。必要な工程は追加・削除できます。写真時刻を変えたら「原動画から切り出す」を押します。
4. 各工程の動画・写真説明確認、全体の提示確認、reviewFlagsへの対応記録を入力して承認します。承認前の職員専用プレビューも使えます。
5. 「本人の端末へ渡す」で次回開始版を割り当てます。職員の「承認版を確認・割当」から、承認後にページを離れた場合も割当できます。
6. 本人アカウントに切り替えて開始。大きな写真・短文を1工程ずつ表示します。「手伝って」は支援待ち、「やめる」は確認なしで端末に先に停止を保存します。
7. 別タブの職員アカウントで `/staff/support` を開いて対応します。アカウント選択は各タブのメモリに保持するため、既存タブは同じ役割で動きます。新人は承認版の教え方を参照できます。

Fake JSONは [apps/generator/fixtures](apps/generator/fixtures) にあります。120秒の仮の候補時刻をアップロード動画の長さへ換算します。**実動画に沿った解析ではありません。すべて職員が動画と照合してください。** 写真はFake画像やAI画像ではなく、そのアップロード動画からffmpegで取り出します。

DBはAPIプロセス内、バイナリは非公開の `.local/assets` に保存します。API再起動でDBがリセットされます。再起動後にブラウザに古いセッションの停止記録があっても、その記録を解除して再開はしません。データを消す場合はプロセス停止後 `.local` を削除し、デモブラウザのサイトデータも消去します。実素材・履歴の削除日は[現行プロダクト仕様](docs/PRODUCT_SPEC.md)に従って担当者が管理します。

## TTS（本人向け読み上げ）

職員が照合・確認して承認する短文から、承認処理中に工程ごとの音声を事前生成します。架空Aさんは `audioGuidance: false`、Bさんは `true` が初期値です。職員のプロフィール更新APIでbooleanを設定できます。falseではTTSを呼びません。下書き生成・編集・プレビューや本人の再生時には生成しません。

音声は承認写真と同様に版専用の非公開資産として保存し、本人DTOには `audioAssetId` だけを追加します。本人は割当または自分の固定セッションに含まれる版の音声だけを認証付きAPIから取得できます。本人画面の音声コントロールで再生し、自動再生はしません。工程移動・支援待ち・停止でプレーヤーを閉じます。再生成や新版への割当で実行中セッションの音声は変わりません。

- `TTS_PROVIDER`：既定 `fake`。ローカルのFakeはffmpegで文字数に応じた長さの無音WAVを生成します。**実音声ではなく、読み上げ内容や聞き取りやすさを検証できないプレースホルダです。**
- `TTS_PROVIDER=vertex`：`VertexTtsAdapter` の骨格を選択します。`TTS_MODEL` の既定値は `gemini-2.5-flash-tts`。既定のローカル実行ではVertexを呼びません。骨格にはまだ実通信がなく、明示選択しても接続transport未設定なら承認が失敗します。Fakeへの自動切替はしません。
- TTSまたは音声保存が失敗すると `502 TTS_GENERATION_FAILED` を職員へ返し、版・承認資産のメタデータを作りません。同じrevisionと承認キーで再試行できます。途中保存された未参照バイナリは配信されません。本番では写真コピー同様、失敗時の未参照オブジェクトの期限削除が必要です。

実GCP接続時はADCによるVertex transportを実装し、選択モデル・ロケーションの利用可否、音声レスポンスのWAV変換・検査、タイムアウトを含む **Vertex TTSの実接続確認と料金確認** を行ってください。APIキー・鍵ファイルは使いません。承認処理から呼ぶ実行主体のVertex権限を設計し、生成先を内部サービスにする場合は認証付きの接続を用意します。現在の承認トランザクションはローカル用で、Firestoreの再実行されうるコールバック内に外部TTSをそのまま移植せず、版専用の事前生成と最終revision検査を分離する必要があります。

## テスト実行手順

```sh
devenv shell -- npm test
devenv shell -- npm run typecheck
devenv shell -- npm run build
devenv shell -- npm run lint
devenv shell -- npm run format:check
```

テストはNode標準テストランナーを使い、実際のAPIルーター・認証・スキーマ・インメモリDB・メディア処理を接続します。ポートは不要です。テスト内でffmpegのテストパターン＋音声からMP4を作るため、GCP認証や実動画の持込みも不要です。この素材はテスト専用で、手本の代用として表示しません。

権限、専用DTOの許可フィールド、承認必須チェックと同時二重送信、revision競合、写真の版専用コピー、再生成／新版割当後のセッション固定、停止と進行の競合、完了後の停止、端末の停止永続化、支援対応、生成失敗、全体／作業上限、リース回復と冪等性を検証します。

`npm run build` は型検査後にViteでビルドします。ビルド後はAPIが `apps/web/dist` を同一オリジンで配信します（APIとgeneratorを別途起動し `http://127.0.0.1:3001/staff` へ）。

## 整形とLint（oxfmt / oxlint）

- `npm run format`：全ファイルを整形します（`oxfmt`）。`npm run format:check` は差分の有無だけを確認します。
- `npm run lint`：`oxlint` で静的検査します。`npm run lint:fix` で自動修正できるものだけ直します。
- 設定は [.oxfmtrc.json](.oxfmtrc.json) と [.oxlintrc.json](.oxlintrc.json) です。整形対象は TS / TSX / JS / JSON / HTML / CSS で、Markdown・docs・ロックファイルは対象外です。
- `apps/web/src/style.css` は、CSSの記述形式を直接検証する回帰テスト（`tests/web-learner-controls.test.ts`）があるため整形対象から外しています。
- oxlint の一部ルールは、既存コードの意図的な書き方や別途の修正が必要な箇所に当たるため、理由付きで無効化しています。有効化する場合は、修正と同じPRで1ルールずつ戻してください。

### コミット時のフック（lefthook）

`npm install` の `prepare` スクリプトが `lefthook install` を実行し、clone ごとに `.git/hooks` へフックを入れます。入らない場合は `npm exec lefthook install` を手動で実行してください。設定は [lefthook.yml](lefthook.yml) です。

- **pre-commit**：ステージ済みのファイルだけを `oxfmt` で整形し、整形結果を自動で再ステージします。整形忘れでコミットが止まることはありません。`oxlint` の指摘は表示するだけで、コミットは止めません。
- **commit-msg**：pre-commit を飛ばした場合（`LEFTHOOK=0` など）に備え、コミット対象ファイルが整形済みかを確認します。未整形ならコミットを中止します。
- merge / rebase / cherry-pick / revert のコミットではフックを実行しません。緊急時は `LEFTHOOK=0 git commit ...` でそのコマンドだけ回避できます。
- CI でも `npm run format:check` と `npm run lint` を実行します。

## 構成と境界

- `packages/shared`：API DTO、Zodスキーマ、生成スキーマの時刻・一意性検査、状態定義。
- `apps/api`：Node HTTP / Fetchルーター、`/api/v1`、ロールと組織・本人認可、承認・割当・イベント。全応答no-store、変更時のOrigin・Content-Type検査。内部例外や生成原文をエラーに返しません。
- `apps/generator`：HTTP内部エンドポイント、ローカルCloud Tasks代替、動画モデルのインターフェースとFake、リース・試行予算・出力検査・ffmpeg抽出。生成失敗では本人用データを作りません。
- `apps/web`：React / TypeScript / Vite。支援・停止イベントは端末保存して再送。停止は送信成功後も端末に保持し、停止前に送ったnextの応答で画面を開きません。

Repository、Storage、Auth、VideoModelはインターフェースで分離しています。ローカルではAPIプロセスだけがDBを所有し、generatorサービスは認証付き内部HTTPを呼びます。インメモリのtransactionは単一プロセス内で直列化し、変更をコミット時にまとめて公開します。Repositoryは非同期I/Oにも対応するポートです。Cloud Runへそのまま拡張する構成ではありません。本番環境変数 `NODE_ENV=production` では両エントリーポイントが起動を拒否し、ローカル認証が誤って公開されることを防ぎます。

本人ルーターは承認済み版だけから許可フィールドのDTOを組み立てます。原動画・下書き画像は403。承認画像は版ごとにコピーし、releaseの編集・削除APIを持ちません。実行中セッションは割当ポインタから独立したreleaseIdを保持します。stopだけは古いrevisionでも優先し、completed後の遅延stopも記録します。

## 実GCP接続時に残っている作業

1. AI担当が **VertexモデルIDとロケーション** を決定し、`VideoModel` にGoogle Gen AI SDK / Vertexアダプタを実装。入力は動画URI・作業名・完成基準・説明の好みだけに限定し、正本のシステム指示とJSON responseSchemaを渡します。本人名・診断・操作履歴を渡さず、モデル自動切替をしません。
2. RepositoryをFirestoreへ置換。承認・版番号・冪等キー・生成予算・イベント・session開始をFirestoreトランザクションで実装し、複数インスタンス間の競合を検証。Storageを非公開Cloud Storageへ置換し、承認コピーは世代条件付きで不変にします。
3. AuthをFirebase ID token検証＋members参照へ置換。seed相当のアカウントは管理スクリプトから事前登録し、自己登録を許可しません。
4. ローカルdrainをCloud Tasksへ置換。**OIDCのaudience、issuer、呼出元サービスアカウント**をgenerator入口で検証し、ローカル共有トークン・開発アカウントは廃止します。キュー並列1、タスク240秒、Cloud Run 300秒、試行3回と期限切れリース回復を検証します。
5. **IAM**：web / generator / Tasks呼出用サービスアカウントを分離し、Vertex権限はgeneratorだけ。Firestore・Storage・Tasksの最小権限、公開ACL禁止、鍵ファイルなしのADCを設定。
6. **Cloud Runデプロイ**：ffmpegを含む2コンテナ、Cloud Build / Artifact Registry、同一オリジンHTTPS、最小0・最大web2/generator1、東京基本のリージョン、5/10/15ドル通知、生成停止運用、失敗コピーの期限削除、11/15の素材・履歴削除を設定。Google接続後は実動画・実モデルで中核フローと認可を再試験します。

未定義の判断と検証環境の制約は [TODO.md](TODO.md) に記録しています。現在の受入条件は [現行プロダクト仕様](docs/PRODUCT_SPEC.md) を参照してください。

移植後の検証記録（2026-11-08、新規チェックアウトから実施）：`npm ci`、`npm run typecheck`、`npm test`（21件全通過・skipなし）、`npm run build`（Viteビルド含む）、APIサーバーの単体起動とHTTP応答を確認済みです。ブラウザでの画面操作は未確認です。

## フェーズのコミット

旧MVPは別の書込可能なGit管理領域で5フェーズのコミットとして作成され、ブランチ `feat/mvp-implementation` として取り込まれました。当時の bundle ファイルは現行リポジトリには含まれていません。

元の作業ツリーには実装ファイルをそのまま配置しています。bundleから取得したブランチは、既存の未追跡ファイルとの衝突を避けるため別worktreeなどで確認してください。

追加TTSフェーズも元の `.git` が読み取り専用のため、1コミットを `tts-phase.bundle` に保存しています。書込み可能な環境で取得してください。

```sh
git fetch ./tts-phase.bundle HEAD:tts-implementation
```

TTSフェーズの検証結果：既存17件＋追加4件の全21テスト成功、`npm run typecheck` 成功。`npm run build` は型検査成功後に `vite: not found` で停止しました。オフラインの依存追加もキャッシュ不足（ENOTCACHED）で実行できず、ブラウザの再生操作確認は未実施です。
