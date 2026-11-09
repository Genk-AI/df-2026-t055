# main更新時のCloud Run更新

`cloudbuild.cd.yaml` は型検査・テスト・ビルド後に2つのイメージを保存し、既存の `generator`、`web-api` の順で更新する。イメージはビルドIDごとに保存する。実行中の環境変数、サービスアカウント、公開範囲はCloud Runの設定を使用する。

最新の既存リソースと残る検証は[実環境検証の引継ぎ](cloud-run-verification.md)を参照する。以下の準備項目は存在・設定を先に確認し、他メンバーの作業を重ねない。

## 設定済み

- プロジェクト: `intense-cortex-513613-n9`
- リージョン: `asia-northeast1`
- GitHub接続: `github-genk-ai`（Genk-AI/df-2026-t055のみ）
- Cloud Buildトリガー: `t055-main-cd`、対象ブランチ `^main$`、設定ファイル `cloudbuild.cd.yaml`。初回公開の検証までは無効。
- ビルド用アカウント: `t055-cd@intense-cortex-513613-n9.iam.gserviceaccount.com`。2026-11-10の手動ビルド成功を確認。権限の詳細と配信版は上記の引継ぎに従って確認する。

## 有効化の条件

1. この設定をレビューしmainへ取り込む。Firebaseビルド設定の検証スクリプト `scripts/check-firebase-build-config.mjs`（#146）もmainに必要。
2. FirebaseのWeb設定をトリガーの `_FIREBASE_API_KEY`、`_FIREBASE_AUTH_DOMAIN`、`_FIREBASE_PROJECT_ID` に設定する。
3. 東京のArtifact RegistryにDockerリポジトリ `t055` があることを確認する。2026-11-10時点では存在するため新規作成しない。
4. 本番起動条件の修正を取り込み、認証・保存・キュー接続の実環境設定を確認して、Cloud Runの `web-api` と非公開 `generator` を初回配置する。認証認可、承認版の固定、即時停止を実環境で確認する。
5. ビルド用アカウントに、対象リポジトリのArtifact Registry Writer、対象Cloud RunサービスのCloud Run Developer、対象実行アカウントのService Account User、プロジェクトのLogs Writerを付与する。Cloud Buildサービスエージェントの標準権限も確認する。
6. 無効のまま手動ビルドを実施し、成功したSHAと操作確認結果を残してからトリガーを有効化する。

## 失敗時

テスト・ビルド・イメージ保存に失敗した場合、サービス更新へ進まない。サービスが存在しない場合も更新前に終了する。新しいコンテナが起動できなければ、そのサービスの更新は失敗する。

2サービスの更新は一括ではない。generator更新後にweb-api更新が失敗した場合は版が混在する。APIの互換性を確認し、必要ならCloud Runの直前のリビジョンへ戻す。データ移行はこの設定に含めない。
