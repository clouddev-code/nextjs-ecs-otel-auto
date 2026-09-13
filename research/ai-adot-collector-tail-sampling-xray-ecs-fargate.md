# ADOT Collector v0.50.0 における tail_sampling と awsxray 併用調査（ECS Fargateサイドカー向け）

本調査は `public.ecr.aws/aws-observability/aws-otel-collector:v0.50.0` を ECS Fargate（タスク全体メモリ1024MiB）のサイドカーとして利用し、tail-based samplingとawsxray exporterを併用する構成を検討するための技術調査である。

## 調査結果サマリー

主要な調査結果は以下の4点である。

- `tailsamplingprocessor`（tail_sampling）と `memorylimiterprocessor`（memory_limiter）は、v0.50.0を含めADOT Collectorの標準ビルドに同梱されている。
- tail_samplingとawsxray exporterは組み合わせ可能だが、パイプライン順序・トレース集約範囲・トレースID形式に関する制約を理解した上で設計する必要がある。
- ECS Fargateのサイドカーパターン（1タスク1コレクター）のままでは、複数タスクに分散したスパンを1つのコレクターに集約できないため、tail samplingの判定精度に限界がある。正確な判定にはLoad Balancing Exporterを使ったgatewayパターンへの拡張が公式に案内されている。
- `memory_limiter` の推奨値（limit_mib / spike_limit_mib / check_interval）はOpenTelemetry公式（アップストリーム）の一般的な指針であり、AWS公式ドキュメントにECS Fargateタスクメモリに対する具体的な割合の推奨は見当たらなかった（不明）。

## 1. tail_samplingプロセッサの同梱有無

ADOT Collectorリポジトリ（`aws-observability/aws-otel-collector`）のREADME.mdに掲載されているサポートコンポーネント表を、`main`ブランチおよび`v0.50.0`タグの両方で確認した。両バージョンとも `tailsamplingprocessor`（[opentelemetry-collector-contribのtailsamplingprocessor](https://github.com/open-telemetry/opentelemetry-collector-contrib/tree/main/processor/tailsamplingprocessor)にリンク）がProcessor一覧に明記されており、同梱されていることを確認した。

v0.50.0のリリースノート（GitHub Releases）では、OpenTelemetry Collector本体/Contribの依存バージョンを更新した旨の記載があり、コンポーネント構成自体に大きな変更はないことがうかがえる。ただし、リリースノート本文にはtailsamplingprocessor固有の変更履歴は明記されていなかった。情報源は以下のとおり。

- https://github.com/aws-observability/aws-otel-collector/blob/v0.50.0/README.md
- https://github.com/aws-observability/aws-otel-collector/releases/tag/v0.50.0

## 2. memory_limiterプロセッサの同梱有無

同じくREADME.mdのコンポーネント表に `memorylimiterprocessor`（OpenTelemetry Collector本体のコアコンポーネント）が明記されており、v0.50.0にも同梱されていることを確認した。memory_limiterはコアコンポーネントであるため、コレクターディストリビューションを問わずほぼ標準搭載される位置づけである（情報源: https://github.com/aws-observability/aws-otel-collector/blob/v0.50.0/README.md）。

## 3. tail_samplingとawsxray exporter併用時の注意点
### 3.1 パイプライン順序の制約

tail_samplingは受信したスパンをトレース単位で再構成してから出力するため、**batchプロセッサより前段に配置する必要がある**。AWS公式ドキュメント「Getting Started with Advanced Sampling using AWS Distro for OpenTelemetry」でも「Group By Trace / Tail SamplingプロセッサよりもBatchプロセッサを前段に置かないこと」と明記されている。batchプロセッサをtail_samplingより前に置くと、同一トレースのスパンが別バッチに分割され、正しくグルーピングされなくなる。

推奨パイプライン構成は以下の順序である（AWS公式サンプル）。

```
processors: [groupbytrace, tail_sampling, batch]
exporters: [awsxray]
```

batchプロセッサはtail_samplingの**後段**に置き、サンプリング後のデータをexporterに渡す前のバッチ化専用として使う。情報源は以下のとおり。

- https://aws-otel.github.io/docs/getting-started/advanced-sampling
- https://docs.aws.amazon.com/eks/latest/best-practices/cost-opt-observability.html

### 3.2 num_traces設定とメモリ消費への影響

`num_traces`はtail_samplingが保持する未確定トレース数の上限であり、内部的に固定長のリングバッファでトレースを保持する。値を大きくするとメモリ消費が増える一方、トレースの取りこぼし（“trace dropped”エラー）が減る。逆に`decision_wait`（サンプリング判定までの待機時間）を短くするとメモリ消費は減るが、判定前にトレースが破棄されるリスクが高まる。

AWS公式ガイドでは、想定スループットと最大トレース遅延から`num_traces`を見積もる考え方が示されている（例: 1000 req/sec × 最大レイテンシ10秒 → 余裕を見て20,000程度）。この見積もりは、コンテナに割り当てるメモリ上限を決める際の入力値として扱う必要がある。情報源は以下のとおり。

- https://github.com/open-telemetry/opentelemetry-collector-contrib/blob/main/processor/tailsamplingprocessor/README.md
- https://aws-otel.github.io/docs/getting-started/advanced-sampling

### 3.3 ECS Fargateサイドカー構成における分散トレース集約の制約

tail_samplingは「同一トレースの全スパンが同じコレクターインスタンスで受信されること」を前提とする。ECS Fargateのサイドカーパターン（1タスクにつき1コレクターコンテナ）では、あるリクエストが複数のECSタスク（サービス）をまたいで処理される場合、各タスクのスパンはそれぞれのサイドカーコレクターに送られるため、1つのサイドカーだけでは同一トレースの全スパンを集約できない。この場合、サイドカー単体でのtail_sampling判定は不完全になる（トレースの一部しか見えていない状態でサンプリング可否を決めてしまう）。

AWS公式ドキュメントでは、この制約への対処として **gatewayパターン** が案内されている。具体的には、各サイドカー（またはエージェント層）はスパンをbatch処理のみ行いそのまま転送し、後段に配置した独立のコレクター群（gateway層）で`loadbalancingexporter`を使いtraceIDをルーティングキーとして一貫して同じgatewayインスタンスに送ることで、トレース単位の集約とtail_samplingの正確な判定を実現する。ECS Fargateで厳密なtail samplingを行う場合、サイドカーのみの構成では不十分であり、gateway層（別サービスとしてのコレクター群）の追加を検討する必要がある。情報源は以下のとおり。

- https://aws-otel.github.io/docs/getting-started/advanced-sampling
- https://github.com/open-telemetry/opentelemetry-collector-contrib/blob/main/processor/tailsamplingprocessor/README.md

### 3.4 AWS X-Ray固有の相性問題

awsxray exporterはOTLP形式のトレースIDをX-Ray形式（`1-{8桁hex}-{24桁hex}`）に変換して送信する。かつてX-RayのトレースID先頭8桁はUNIXエポック秒であることが前提とされており、OTel SDKが生成したepoch情報を含まないランダムなトレースIDをそのまま使うと`UnprocessedTraceSegments`（`InvalidTraceId`等）エラーになる問題がGitHub Issueで報告されていた。ただし、AWSは2023年10月に「X-RayがW3C Trace Context準拠のトレースID（OpenTelemetryが生成するepoch情報を含まないランダムなトレースID）をネイティブサポートする」ことを発表しており、現行のX-Ray/awsxray exporterでは本問題は**過去の制約**として扱ってよい。念のため、利用するOTel SDK/AWS Distro OpenTelemetry SDKのバージョンがX-Ray用トレースID生成戦略（AWS X-Ray ID Generatorまたは標準W3C IDのいずれか）をどちらで運用しているかは実装時に確認することを推奨する。

また、Issue #2698では「ADOTコレクターをサイドカーとして自動計装Javaアプリの前段に置いた場合、X-Rayコンソール側のサンプリングルールが無視される」という報告がある。X-Rayのサンプリングルール（SDK側のヘッドサンプリング）とtail_sampling（コレクター側のテールサンプリング）は独立した仕組みであるため、両方を有効にすると意図が競合し得る点に留意が必要である。

情報源は以下のとおり。

- https://github.com/open-telemetry/opentelemetry-collector-contrib/issues/2396（過去のトレースID形式問題）
- https://aws.amazon.com/about-aws/whats-new/2023/10/aws-x-ray-w3c-format-trace-ids-distributed-tracing（W3C形式トレースIDのネイティブサポート発表）
- https://github.com/aws-observability/aws-otel-collector/issues/2698（X-Rayサンプリングルールとの競合報告）
- https://aws-otel.github.io/docs/getting-started/x-ray/

## 4. memory_limiterプロセッサの推奨設定値
### 4.1 一般的な推奨値（OpenTelemetry公式README）

OpenTelemetry Collector本体のmemorylimiterprocessor README（AWS公式ドキュメントではなくアップストリームの一次情報）では、以下の考え方が示されている。

- `check_interval`は1秒が推奨値。トラフィックがスパイクしやすい環境ではより短い間隔に調整する。
- `spike_limit_mib`は`limit_mib`（ハード上限）のおおよそ20%を目安にする。例: ハード上限4000MiBに対しspike 800MiB、実質のソフト上限は3200MiB相当になる。
- `limit_mib`自体は、コンテナ/プロセスに割り当てられたメモリ上限（ECSでいう`memory`ハード制限）から見て安全マージンを残した値（例: ハード制限の80%程度）に設定し、ECSやコンテナランタイムにOOM Killされる前にコレクター自身がバックプレッシャーをかけて処理を絞れるようにする。
- Goランタイムを使うコレクターでは`GOMEMLIMIT`環境変数をハード上限の80%程度に設定し、GCの挙動をmemory_limiterと協調させることが推奨される。
- memory_limiterはパイプラインの**先頭**（受信直後）に配置し、後続処理へのバックプレッシャーを最大化する。

情報源: https://github.com/open-telemetry/opentelemetry-collector/blob/main/processor/memorylimiterprocessor/README.md

### 4.2 ECS Fargate 1024MiB構成への示唆

AWS公式ドキュメントには、ECS Fargate上のADOT Collectorサイドカー向けに`memory_limiter`の具体的な数値（コンテナメモリに対する割合等）を推奨する記載は見当たらなかった（不明）。実務上は、上記4.1の一般則をECSのコンテナ定義に当てはめて設計することになる。

考慮すべき点は以下のとおりである。

- タスク全体1024MiBのうち、アプリケーションコンテナとコレクターコンテナで確保するメモリを個別に見積もり、コレクター用コンテナの`memory`（ハード制限）をまず決定する。
- `memory_limiter`の`limit_mib`は、決定したコレクターコンテナのハード制限の約80%を起点にし、`spike_limit_mib`はその20%前後を起点に、実測値を見ながら調整する。
- tail_samplingを併用する場合、`num_traces`によるトレースバッファの見積もりメモリ量も、コレクターコンテナに割り当てるメモリ（延いては`limit_mib`）に加味する必要がある。tail_samplingのバッファとmemory_limiterの上限は独立した設定のため、両者を単独で決めるとどちらかが実態と乖離するおそれがある。
- ECS Fargateではコンテナがハード制限を超えるとOOM Killされ、バッファ中のスパン（tail_sampling待機中のトレースを含む）が失われる。memory_limiterのソフト上限をハード制限より十分低く設定し、OOM Killより先にコレクター側で受信抑制・データ廃棄が働くようにすることが重要である。

## 参考リンク

- [aws-observability/aws-otel-collector README（v0.50.0タグ）](https://github.com/aws-observability/aws-otel-collector/blob/v0.50.0/README.md)
- [aws-otel-collector v0.50.0 Release Notes](https://github.com/aws-observability/aws-otel-collector/releases/tag/v0.50.0)
- [Getting Started with Advanced Sampling using AWS Distro for OpenTelemetry](https://aws-otel.github.io/docs/getting-started/advanced-sampling)
- [Getting Started with the AWS X-Ray Exporter in the Collector](https://aws-otel.github.io/docs/getting-started/x-ray/)
- [opentelemetry-collector-contrib tailsamplingprocessor README](https://github.com/open-telemetry/opentelemetry-collector-contrib/blob/main/processor/tailsamplingprocessor/README.md)
- [opentelemetry-collector memorylimiterprocessor README](https://github.com/open-telemetry/opentelemetry-collector/blob/main/processor/memorylimiterprocessor/README.md)
- [Amazon EKS Best Practices: Apply Tail Sampling with ADOT](https://docs.aws.amazon.com/eks/latest/best-practices/cost-opt-observability.html)
- [AWS XRayExporter trace ID format issue (GitHub Issue #2396)](https://github.com/open-telemetry/opentelemetry-collector-contrib/issues/2396)
- [X-Ray sampling rules ignored with ADOT sidecar (GitHub Issue #2698)](https://github.com/aws-observability/aws-otel-collector/issues/2698)
- [AWS X-Ray now supports W3C format trace IDs for distributed tracing (What's New, 2023/10)](https://aws.amazon.com/about-aws/whats-new/2023/10/aws-x-ray-w3c-format-trace-ids-distributed-tracing)
