# 既存Firebase・Cloud Runの検証とCD有効化の引継ぎ

既存環境を作り直さず、レビュー済みのコードと実際に配信される版を対応付ける。これは確認手順であり、この文書のマージでGCP設定・公開範囲・CDは変わらない。最終マージはユーザーが行う。

## 2026-11-10 00:05〜00:13 JSTの確認結果

Codex専用ブラウザで、プロジェクト`GoogleHackathon2026`（`intense-cortex-513613-n9`、番号`334472619104`）を閲覧した。実アカウントへのログイン、本人データ・動画の投入、設定変更は行っていない。

| 対象 | 閲覧で確認した状態 |
| --- | --- |
| Firebase | Webアプリ`t055-web`登録済み。Email/Password認証が有効 |
| Artifact Registry | 東京`asia-northeast1`にDockerリポジトリ`t055`が存在 |
| Firestore | `(default)`がNativeモード、東京、使用可能 |
| Storage | `t055-media-334472619104`は東京、均一アクセス、公開アクセス禁止。`t055-build-334472619104`も東京に存在 |
| Cloud Tasks | `t055-generation`は東京、稼働中、同時実行1、最大試行3。キューのHTTPターゲット上書きは未確認 |
| 実行・呼出用SA | `t055-web`、`t055-generator`、`t055-tasks`、`t055-scheduler`が存在・有効・鍵なし |
| web用IAM | `t055-web`にFirebase Authentication閲覧者が付与済み。ログイン後の実処理は未検証 |
| Cloud Run | 東京に`web-api`と`generator`が存在。webは`allUsers`経由で公開、generatorはIAM必須・内部ingress |
| 匿名の閲覧 | [公開Web](https://web-api-334472619104.asia-northeast1.run.app/)にログイン画面。`GET /api/v1/tasks`は`UNAUTHENTICATED`を返す。HTTPステータスの数値はブラウザ表示では未確認 |
| 手動Cloud Build | `9ae479bd-5412-45ba-9e8b-7ee2fef9698d`が成功。`t055-cd`で両イメージを作成・pushし、既存サービスを更新するステップまで完了 |
| CD | `t055-main-cd`は東京、`cloudbuild.cd.yaml`を参照し、無効 |

ビルド成功だけでは、ソースSHA・両digest・実際のトラフィックの対応や、ログイン後の認可・生成成功は証明できない。上の状態は時点情報であり、次の操作前に読み直す。Storageのオブジェクト本文、Firebase利用者一覧、トークン、秘密鍵は調べない。

## 1. PRと配信版を対応付ける

- #147は取り込み済み。#150は本番起動条件の修正。`86622be413412d88d6a860a667c3a79f5782e580`の[CI](https://github.com/Genk-AI/df-2026-t055/actions/runs/42640069224)は整形・Lint・型検査・全332テスト・build成功。
- #152はVertexへのスキーマ送信の修正を扱う別PR。作者は実VertexでのHTTP 200を報告しているが、ここでは再検証していない。未マージの実装を取り込み済みと扱わず、実生成確認の前にレビューする。
- #150等をユーザーがマージした後、採用したmain SHAを固定する。既存ビルドがそのSHAを含むか確認し、不明なら「出自未確認」と記録する。タグ名や手入力のSHAだけでは証拠にしない。

Cloud Shell等で次の読み取りを実行する。ソースコードのNode/npmコマンドをローカルで動かす場合は、AGENTS.mdどおり`devenv shell --`を使う。

```sh
export VERIFY_PROJECT=intense-cortex-513613-n9
export VERIFY_REGION=asia-northeast1
export VERIFY_BUILD_ID=9ae479bd-5412-45ba-9e8b-7ee2fef9698d

gcloud builds describe "$VERIFY_BUILD_ID" --region=global --project="$VERIFY_PROJECT" --format='yaml(id,status,sourceProvenance,results.images)'
gcloud run services describe web-api --region="$VERIFY_REGION" --project="$VERIFY_PROJECT" --format='yaml(status.conditions,status.latestReadyRevisionName,status.latestCreatedRevisionName,status.traffic,spec.traffic,spec.template.spec.serviceAccountName)'
gcloud run services describe generator --region="$VERIFY_REGION" --project="$VERIFY_PROJECT" --format='yaml(status.conditions,status.latestReadyRevisionName,status.latestCreatedRevisionName,status.traffic,spec.traffic,spec.template.spec.serviceAccountName)'
```

それぞれの`status.traffic`の配信先リビジョンを開き、以下で`VERIFY_REVISION`を実際の名前に設定してimage digestを取得する。両サービスとも想定した版へ100%配信され、同じビルドのdigestに一致することを確認する。latest Readyだけで判断しない。タグ付きURL等で別の版に到達できる場合も記録する。

```sh
gcloud run revisions describe "$VERIFY_REVISION" --region="$VERIFY_REGION" --project="$VERIFY_PROJECT" --format='yaml(metadata.name,status.imageDigest,spec.containers.image)'
gcloud builds triggers describe t055-main-cd --region="$VERIFY_REGION" --project="$VERIFY_PROJECT" --format='yaml(name,disabled,github.push,filename,serviceAccount)'
```

新しいビルドを実行した場合は、その実行先リージョンとIDで読み直す。現在の手動ビルドはglobal、CDトリガーは東京なので混同しない。既存サービスへ初回作成コマンドを重ねず、更新が必要なら対象SHA・digest・戻し先を示してから実行する。

## 2. 認証・保存・生成・支援操作を確認する

起動と匿名APIの拒否はログイン後の成功とは別である。特に`apps/api/src/firebase-auth.ts`の`verifyIdToken(token, true)`は失効確認のためユーザー情報を参照する。[#150の指摘](https://github.com/Genk-AI/df-2026-t055/pull/150#issuecomment-6743049013)どおり`firebaseauth.users.get`が必要。現在はweb用のFirebase Authentication閲覧者があるため、同じ目的の権限を重複付与せず、実ログインで確認する。

実行SAにはFirestore、対象Storage、Tasksの投入・キュー取得・OIDC呼出しに必要な権限が要る。動画解析・参考メモはgenerator、既存の承認時TTSはweb-apiがVertexを呼ぶ。権限の付与済み範囲・Vertexのモデルとロケーション・生成上限・予算担当は、実行前にチームの確認値を照合する。権限の不足があれば、対象と最小の追加内容をレビューしてから変更する。

以下は**未実施**。架空データと許可された検証用アカウントで確認する。利用者作成・権限付与・動画送信・有料生成はこの文書の追加では実行されない。

- [ ] 職員・本人・新人のログインと画面・操作権限。未登録、別所属、別本人、失効トークンを拒否する。
- [ ] FirestoreとStorageへ保存でき、再起動後も残る。画像等はAPI経由のみで、原動画・下書き・職員情報が本人に混入しない。
- [ ] 承認したモデル・ロケーション・生成上限で、実Vertexの動画→下書き→原動画照合→写真→承認→割当→本人表示→新人参照。採用する場合はTTSも確認する。
- [ ] 新版割当後も実行中の本文・画像・設定が固定される。
- [ ] 手伝って、担当決定、再開、即時停止、通信断・再読み込み・再送と進行の競合が正本第8節どおりになる。
- [ ] 復旧用Schedulerジョブの有無、専用SA、対象URL・audience、再試行を確認する。未作成なら別の設定変更として扱う。

判定根拠は[正本](../PRODUCT_SPEC.md)第4・5・8節。[REPORT](../../REPORT.md)第8・11節にある設計根拠と本人・現場への確認事項も引き継ぐ。チーム内の操作確認を本人・現場による評価済みと数えない。

## 3. 手動CDを確認してから有効化する

上の実環境確認が終わるまでは`t055-main-cd`を無効に保つ。トリガーの対象が`^main$`、設定が`cloudbuild.cd.yaml`であり、Firebase公開ビルド設定と`t055-cd`の必要な権限が揃うことを確認する。既存のIAMをまとめて上書きしない。

次は**両サービスを更新する操作**。確認者がレビュー済みmain SHAを`VERIFY_COMMIT`へ設定し、実行を了承した後だけ手動CDを実行する。

```sh
gcloud builds triggers run t055-main-cd --region="$VERIFY_REGION" --project="$VERIFY_PROJECT" --sha="$VERIFY_COMMIT"
```

成功後に手順1を新しいビルドIDで行い、配信先と両digest、主要操作を再確認する。2サービスの更新は順次なので、片方の失敗は[CD手順](cloud-run-cd.md)で復旧する。確認が揃ったら、確認者がCloud Consoleでトリガーを有効にする。`gcloud builds triggers enable`は使わない。

記録には日時・担当・main SHA・ビルドID/リージョン・両digest・配信リビジョンと割合・受入項目の結果・未確認事項・有効化した人を残す。Firebaseの公開API設定も含め、APIキー、UID、パスワード、トークン、動画・生成原文をPRやログへ貼らない。
