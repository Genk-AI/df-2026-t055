# Cloud Tasks による生成配送

この実装は先行するFirestore・Cloud Storage・VertexのPRに依存する。APIはジョブを永続化してからCloud Tasksに投入する。投入が失敗してもジョブを残し、別途設定するCloud Schedulerからgeneratorの復旧エンドポイントを定期実行して再投入する。Schedulerが停止すると投入失敗や配送回数を使い切ったジョブは自動復旧しないため、Schedulerの実行失敗とキュー滞留を監視する。

- Cloud Tasksキューは同時配送数1、最大試行3回に設定する。各タスクの配送期限は240秒。generatorのCloud Runリクエスト期限は300秒、最大インスタンス数は1とする。
- APIでは `QUEUE_BACKEND=cloud`、`GOOGLE_CLOUD_PROJECT`、`TASKS_LOCATION`、`TASKS_QUEUE`、`GENERATOR_URL`（`https://…/api/v1/internal/generate`）、`GENERATOR_AUDIENCE`、`TASKS_SERVICE_ACCOUNT_EMAIL` を設定する。generatorでは同じ値と `GENERATOR_BACKEND=cloud`、`REPOSITORY_BACKEND=firestore`、`STORAGE_BACKEND=cloud`、`MODEL_PROVIDER=vertex`、各アダプターの必須設定を指定する。
- Cloud Schedulerは5分ごとに `/api/v1/internal/reconcile` へPOSTし、`GENERATOR_AUDIENCE` と一致するaudienceのOIDC IDトークンを付ける。`SCHEDULER_SERVICE_ACCOUNT_EMAIL` はタスク用とは異なる専用サービスアカウントにする。generatorのアプリ内検証とCloud Run IAMの両方で、各サービスアカウントに必要な呼び出し権限だけを与える。キューへの投入権限とサービスアカウントの `iam.serviceAccounts.actAs` も必要。
- 同じ5分枠の再投入には同一タスク名を使い、次の枠では新しい名前を使う。Cloud Tasksが完了済みタスクの名前を一時的に保持するため、同名の409は処理済みとして扱う。Firestoreのリースが残っている配送は503を返し、成功済み・失敗済みは再実行しない。試行3回後に期限切れリースを検出するとジョブと下書きを失敗にする。

本番APIの起動ガードは残っている。実際のキュー設定、Cloud Scheduler、Cloud Run IAM、サービスアカウント、ADCとVertexを使った一連の検証は未実施。誤った設定やクラウド側の障害で滞留する場合があるため、運用開始前に確認する。
