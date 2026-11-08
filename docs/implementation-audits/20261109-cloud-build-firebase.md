# Cloud BuildのFirebase設定監査

- 対象 #30 の統合後の設定差分。基点はCloud Tasks検査PRの `c112485`。従来のCloud BuildはViteへ認証設定を渡さず、ブラウザが既定のdemoモードでビルドされる可能性があった。
- Cloud BuildではFirebaseモードとWeb用公開設定を明示し、設定が欠けた場合はイメージ作成前に失敗する。ローカル開発のdemo設定は維持。本番APIの起動ガードは変更しない。
- Web公開設定の受け渡しと設定不足の拒否をプロセステストで確認し、ダミー公開設定によるFirebaseモードのWebビルドとYAMLの構文解析を実施した。現在のアダプター構成と未検証事項に合わせて運用手順・環境変数例を更新した。実Cloud Build、Artifact Registryへのpush、GCP設定・デプロイは未実施。
