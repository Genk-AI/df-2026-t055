# Firebase認証の接続

APIでは `AUTH_BACKEND=firebase`、`FIREBASE_PROJECT_ID`（省略時 `GOOGLE_CLOUD_PROJECT`）、`FIRESTORE_ORG_ID` とApplication Default Credentialsを指定する。Firebase Admin SDKがIDトークンの署名・発行元・対象・期限と失効を検証し、サーバーに登録された所属・役割を照合する。権限のない、未登録、失効したアカウントは拒否する。Firebase Authエミュレータの設定を本番へ渡さない。

Webのビルド時に `VITE_AUTH_BACKEND=firebase`、`VITE_FIREBASE_API_KEY`、`VITE_FIREBASE_AUTH_DOMAIN`、`VITE_FIREBASE_PROJECT_ID` を設定する。公開Web設定は秘密鍵ではないが、正しいFirebaseプロジェクトと許可ドメインの確認が必要。Firebase側でメール・パスワード認証と事前登録アカウントを設定し、同じ組織のmembersにUIDを紐づける。画面は検証済みのサーバー応答から役割を決定し、Firebaseモードでデモトークンにフォールバックしない。デモアカウント切替はローカルのdemoモードのみ。

既存の本人・職員レコードへの紐づけには `REPOSITORY_BACKEND=firestore`、`GOOGLE_CLOUD_PROJECT`、`FIRESTORE_ORG_ID` を明示し、担当者が対象を確認したうえで `node --experimental-transform-types scripts/member-link.ts scripts/firestore-member-repository.ts link <firebase-uid> <member-id>` を使う。標準出力へUIDや引数は表示しない。解除は `unlink`。必要なIAM権限を与えた環境で実行し、変更前後を担当者が確認する。

この変更ではFirebaseプロジェクト、アカウント、IAM、Web設定の作成や実接続テストは行わない。本番APIの起動ガードは残る。デプロイ前にFirebaseモードでビルドした成果物とAPI設定が一致すること、実アカウントの権限境界、失効、ログアウト、本人の停止・再接続を確認する。


IDトークンの不正・期限切れ・失効は401、検証サービスへの接続・管理者認証情報・権限などの障害は503 `AUTH_SERVICE_UNAVAILABLE` として区別する。運用ログには `firebase_auth_verification_failed` と固定された障害カテゴリだけを記録し、トークン・UID・SDKのエラー本文は記録しない。Firebase Admin SDK 14では不正トークンと公開鍵取得障害が同じ `auth/argument-error` になり得るため、SDKが生成する既知の不正トークンメッセージだけを401とし、判別できない場合は503とする。SDK更新時にはこの分類を再検証する。プロジェクトの設定違いと別プロジェクトのトークンは同じ検証エラーになる場合があり、401だけでは区別できない。WebSocketの認証障害は接続を閉じ、同じ障害ログを出す。
