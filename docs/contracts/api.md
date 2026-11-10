---
type: Specification
title: HTTP APIの共通契約とエンドポイント
authority: normative
status: stable
---

# HTTP APIの共通契約とエンドポイント

## 共通契約

ベースは`/api/v1`、JSONはcamelCase、`schemaVersion: "1"`。Firebase AuthenticationのIDトークンをBearerで送り、APIで検証してmembersのroleを取得する。本人アカウントはlearnerIdにひも付ける。URLのIDを変えたアクセスも権限検査する。401は認証失敗、403は権限不足、404は対象なし、409は状態・revision競合、422は入力不正、503 `AUTH_SERVICE_UNAVAILABLE` は認証サービスの障害や検証不能。エラー形は`{error:{code,message,requestId}}`とし、内部例外や生成原文を返さない。

| メソッド・パス | 利用者 | 入力 → 出力・処理 |
| --- | --- | --- |
| `POST /tasks` | 職員 | `{title}` → `{taskId}` |
| `POST /tasks/{id}/video` | 職員 | multipart MP4 → `{assetId,status:"ready"}`。上限50MB・180秒、音声付き、実体形式を検査 |
| `GET /tasks` / `GET /tasks/{id}` | 職員 | 一覧／作業メタデータ |
| `GET /learners` / `GET /learners/{id}` | 職員 | 同じ所属のプロフィールの一覧／詳細。障害に関する任意項目は詳細でのみ返す |
| `POST /learners` / `PATCH /learners/{id}` | 職員 | 表示名、本人の希望、提示設定、確認済みの配慮、任意の記録を登録／更新。更新は `expectedRevision` を検査し、`disabilityInfo: null` で任意項目を消せる。登録は認証アカウントの作成と分ける |
| `GET /learners/{id}/work-guides` / `GET /learners/{id}/work-guides/{taskId}/support-records` | 職員 | 作業別の次回版・未反映件数・生成／確認状態と、対象の本人・作業の支援記録。前者は `{schemaVersion,items:[{taskId,title,assignment,unappliedCount,latestDraft,latestGeneration}]}` を返す。未存在の割当・下書き・生成は `null`。後者は `{schemaVersion,records}` を返し、各記録の `applied` は割当版とその継承元が採用した同一ID・revisionに限りtrueとする。継承元が欠落・循環・別対象の場合は409を返す |
| `GET /learners/{id}/work-guides/{taskId}/corrections` | 職員 | 同じ所属の対象本人・作業の修正履歴、参考メモ、要約ジョブの状態。保存済みの修正とAIの提案を分けて返す |
| `POST /tasks/{id}/generations` | 職員 | `{learnerId}` → 202 `{jobId,draftId}`。記録からの改善では `sourceReleaseId, supportInputs:[{recordId, revision, summary}], clientRequestId` も送る。新規生成・改善を合わせて1作業あたり手順下書きの生成試行10回まで |
| `GET /jobs/{id}` | 職員 | `{kind,status,draftId,modelId,promptVersion,errorCode?}`。画面は3秒間隔で取得。下書きの生成状態にはguideのジョブを使う。失敗した改善ジョブには、再試行用に受付時の本人・元版・確認済み要約と記録版を `retryInput` として返す |
| `GET /drafts/{id}` | 職員 | AI原文と編集データを別オブジェクトで返す |
| `PATCH /drafts/{id}` | 職員 | `{expectedRevision,editedSteps,reviewChecks,displayMode?,audioGuidance?,appliedSupportRecordRefs?,correctionReason?}` → `{revision,reviewChecks}`。内容を変更した場合は[関連仕様](../product/workflows.md)の規則で確認チェックを外し、保存後のチェック状態を返す。編集内容の差分があれば修正履歴も保存し、参考メモの生成を非同期で受け付ける。確認チェックだけの変更や、競合で保存できなかった修正からは履歴を作らない |
| `POST /drafts/{id}/frames` | 職員 | `{frameMs}` → `{imageAssetId}`。サーバーのffmpegで原動画から静止画を切り出す |
| `POST /drafts/{id}/approve` | 職員 | `{expectedRevision,approvalRequestId}` → `{releaseId,version}`。二重送信は同じ版を返す |
| `POST /releases/{id}/drafts` | 職員 | `{clientRequestId}` → 201 `{draftId,status:"editing",revision}`。同じ所属の承認版から編集用下書きを作る。本人・作業・コピーする内容はサーバーが元版から確定し、確認チェックをすべてfalseにする。同じキーの再送は同じ下書きを返す |
| `PUT /assignments/{learnerId}/{taskId}` | 職員 | `{releaseId}` → 次回開始版の割当 |
| `GET /me/assignments` | 本人 | 作業名・割当版IDのみ。下書きがあっても応答は変えない |
| `POST /me/sessions` | 本人 | `{taskId,clientRequestId}` → `{sessionId,releaseId,displayMode,audioGuidance,steps}`。固定した版の許可フィールドで組み立てる |
| `GET /me/sessions/{id}` | 本人 | 固定版の手順・表示方法・読み上げの設定とセッション状態。支援待ちでは `support:{requestId,status,revision}` も返す |
| `POST /me/sessions/{id}/events` | 本人 | `{clientEventId,expectedRevision,type: next / back / help / resume / stop / complete}` → `{status,stepIndex,revision,support?}`。helpでは要求を作り、対象IDをセッションに保存する。resumeはその要求の対応完了後に限る |
| `GET /support-requests` | 職員 | `open`・`assigned`・`in_progress` の要求一覧。記録の後入力では `?status=acknowledged` で対応完了した要求を取得できる |
| `GET /staff/me` | 職員 | `{schemaVersion,uid}`。認証済み職員自身のIDを返し、担当操作の表示に使う。操作の認可はサーバーでも検査する |
| `GET /support-requests/{id}/session-state` | 担当職員 | `{schemaVersion,sessionId,status,revision,currentRequest}`。対応中・完了済みのhelpについて担当者だけが取得し、再開要求の競合検査に使う。`currentRequest` はセッションの現在の支援要求と一致するかを表す。停止・別org・担当外を再開できる意味ではない |
| `POST /support-requests/{id}/claim` | 職員 | `{}` → `{status:"assigned",assignedTo,assignedAt,revision}`。helpの担当を自分にする。別の職員が担当済みなら409 |
| `POST /support-requests/{id}/start` | 担当職員 | `{}` → `{status,startedAt}`。対象はassignedのhelp。初回はin_progressにする |
| `POST /support-requests/{id}/acknowledge` | 職員 | `{}` → `{status:"acknowledged",acknowledgedAt}`。helpは担当職員が対応完了を記録する。stopは同じ所属の職員が通知を確認する |
| `POST /support-requests/{id}/resume` | 担当職員 | `{clientRequestId,expectedSessionRevision}` → `{sessionId,status,stepIndex,revision}`。対応中または対応完了のhelpに対し、必要なら対応完了の記録と、対象の呼出しで支援待ちになっているセッションの再開・イベント保存を一つのトランザクションで行う。記録入力は不要。同じキーの再送で再開を重ねない |
| `GET /support-requests/{id}/record` / `PUT /support-requests/{id}/record` | 職員 | 支援記録の取得／保存。保存は `{expectedRevision,observedDifficulty,assistanceGiven,improvementSuggestion}`。初回は `expectedRevision: 0`。対応開始後から、対応完了後も保存できる |
| `POST /support-requests/{id}/record/transcriptions` | 職員 | 支援記録欄の音声を文字起こしする（方式は[関連仕様](../features/speech-input.md)・[#22](https://github.com/Genk-AI/df-2026-t055/issues/22)）。`Content-Type: audio/wav`の生バイナリ（16kHz・16bit・モノラル）を受け、5MB以下・5秒以上60秒以下に限る。60秒ちょうどは許可し60秒超は422。サーバーはffprobeで変換前の長さを検査し、ffmpeg（タイムアウト20秒）で正規化して変換後も再検査し、Speech-to-Text V2の同期Recognize（タイムアウト30秒）を1回呼ぶ。`{schemaVersion:"1",transcript}`だけを返し、音声はメモリ上でのみ処理してこのAPIは保存・承認・再開を行わない。対象が`help`かつ`in_progress`または`acknowledged`でなければ409`INVALID_STATE`（音声の受信前に検査）。入力不正は422（`INVALID_AUDIO`・`AUDIO_TOO_SHORT`・`AUDIO_TOO_LONG`・`AUDIO_TOO_LARGE`）、文字起こしの失敗は502（`SPEECH_REQUEST_FAILED`・`SPEECH_NO_TRANSCRIPT`・`SPEECH_TRANSCRIPT_TOO_LONG`・`SPEECH_NOT_CONFIGURED`・`SPEECH_INVALID_CONFIG`）とし、未知の例外も502`SPEECH_REQUEST_FAILED`へ丸める。記録への反映は職員が確認・訂正した後に既存の `PUT /support-requests/{id}/record` で行い、ブラウザは失敗時も入力済みの文字を保つ |
| `GET /handover/releases` / `GET /handover/releases/{id}` | 職員・新人 | 承認済み一覧／本人手順とstaffGuide |
| `POST /handover/releases/{id}/read` | 新人 | `{}` → `{readAt}` |
| `GET /assets/{id}` | 各ロール | 所属・版・用途を検査してメディアをストリーム配信。本人には対象の承認画像・音声だけ |
| `POST /internal/generate` | Cloud Tasksのみ | `{jobId}` → ジョブ実行。OIDCと呼出元サービスアカウントを検証 |

変更系APIはJSONとOriginを検査する。本人のstopはexpectedRevisionの一致より停止を優先し、同じセッションの進行操作と競合しても、止める操作を失わせない。ブラウザは停止状態を先に保持し、再読み込み後も送信完了まで再開しない。

同じ `clientRequestId` で同じ改善要求を再送した場合は元のジョブを返し、異なる内容でのキーの再利用は409で拒否する。新規受付では、元の承認版が対象の本人・作業の次回版であることと、選択された記録が同じ所属・本人・作業の最新revisionであることを検査する。変わっていれば409で再選択を求める。承認時は、実際に反映した記録のIDとrevisionがジョブで参照した範囲内にあることを検査する。

手作業用のコピーを承認するとき、サーバーは生成ジョブの検査を適用せず、コピー元の所属・本人・作業が下書きと一致するかを検査する。新しい承認版のsourceReleaseIdにはコピー元を保存する。appliedSupportRecordRefsへの新規追加は422で拒否する。工程の照合、写真・代替テキスト、提示内容の確認と、版専用資産の作成はAI生成の下書きと同じ条件で行う。
