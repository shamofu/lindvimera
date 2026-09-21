# Lindvimera 開発仕様

利用者向けの操作・設定・対応環境は[README](../README.md)を参照してください。この文書はビルド、実装の境界、上流ソース、検証の契約を定義します。

## ビルドと配布

Git、Node.js 24系、pnpm **12.4.2**を使用します。ルートでサブモジュールを初期化し、ロックファイルどおりに依存を取得します。

```powershell
git submodule update --init --recursive
pnpm install --frozen-lockfile
pnpm check
```

| コマンド                          | 内容                                                   |
| --------------------------------- | ------------------------------------------------------ |
| `pnpm prepare:vendor`             | 固定した上流ソースを再生成し、patchを順に適用          |
| `pnpm build`                      | 上流ソースを再生成し、配布物を`dist/`へ出力            |
| `pnpm build:probe`                | 配布対象外の検証用プラグインを別ビルド                 |
| `pnpm dev`                        | 起動時に上流ソースを再生成し、監視ビルドを開始         |
| `pnpm lint` / `pnpm format:check` | 静的解析／整形確認                                     |
| `pnpm typecheck`                  | 上流の型宣言を生成し、本体とテストを型検査             |
| `pnpm lint:obsidian`              | 型検査後に本体・manifest・package情報を公式Lintで検査  |
| `pnpm audit:dependencies`         | 開発用を含むnpm依存を検査し、High・Criticalで失敗      |
| `pnpm test:unit`                  | 上流ソースを再生成し、Vitestを実行                     |
| `pnpm check`                      | Oxlint、整形確認、型検査、公式Lint、単体テスト、ビルド |
| `pnpm probe`                      | 手動検証用の独立Vaultを準備して起動                    |
| `pnpm test:e2e`                   | Obsidianを新規起動し、既存suite・OS入力を自動検証      |

配布物の正本は`scripts/distribution.mjs`です。実行に必要なのは`main.js`・`manifest.json`・`styles.css`の3ファイルです。WASM・辞書はgzip＋base64としてbundleに内包し、既存の非同期辞書初期化でメモリ上へ復元します。実行時の通信やディスクへの展開は行いません。ビルドはminifyし、開発ビルドはインラインsource mapを付けます。

ライセンス文書と改変ソースは`dist/`の別ファイルにも、bundle末尾のパス付き行コメントにも全文を保持します。コメントは改行をLFへ統一して読みやすく連結し、監視ビルドでも更新します。ビルド時にJavaScript構文を確認し、内包したWASM・辞書の動作は自動E2Eで検査します。配布ZIPの作成と公開はworkflow内で行い、ZIPには`lindvimera/`ディレクトリ以下に3ファイルと元のライセンス文書・改変ソースを揃えます。

LinderaのJavaScript・WASM・LICENSEは、lockfileに従ってインストールした`lindera-wasm`パッケージを使用します。`scripts/lindera-assets.mjs`は別配布のIPADIC辞書ZIPだけを取得し、SHA-256を検証して展開します。初回取得にはネットワークが必要で、以後はcache内のZIPも毎回検証して利用します。`dist/`、`.generated/`、`.cache/`、`.test-runtime/`、`.release/`、`.release-gate/`は生成物としてGit管理から除外します。

`obsidian`、`electron`、`@codemirror/*`、`@lezer/*`、`node:*`はObsidian desktopが提供するため外部依存にします。Vim engineはnpm版ではなく、`.generated/codemirror-vim`のソースへ解決します。ローカル検査のCodeMirrorバージョンは`pnpm-workspace.yaml`で統一し、StateFieldやAnnotationの同一性を維持します。プラグイン本体は通常のNode.jsプロセスで実行しません。

## 実装の境界

| 所在                             | 責務                                                              |
| -------------------------------- | ----------------------------------------------------------------- |
| `src/main.ts`、`src/settings.ts` | Obsidian登録、組み込みVimとの排他、設定の検証・保存               |
| `src/runtime`                    | 親エディタのVimセッション、本文・セルの編集対象、親文書の履歴     |
| `src/navigation`                 | ノート内のマーク・ジャンプリスト、編集差分による位置追跡          |
| `src/ex`                         | Exの構文・範囲検証、編集・検索、確認付き置換                      |
| `src/input`                      | 対応操作、UI・モード別の入力優先順位、挿入脱出キーと候補表示      |
| `src/word`                       | 辞書サービス、単語・文・書記素境界、テキストオブジェクト、行cache |
| `src/markdown`                   | Markdown構造、テキストオブジェクト、Surround                      |
| `src/table`                      | セルと親文書の座標対応、セル移動、ネイティブadapter               |
| `test/probe`                     | 配布対象外の検証プラグイン、検証画面と入力診断・記録              |
| `patches`                        | 上流への汎用拡張点と対応する回帰テスト                            |

カウント・レジスタ・マクロ・`.`は上流Vimのdispatcherを経由させます。親エディタのセッションを保ったまま本文とセルを編集対象として切り替え、セルの変更を親文書へ反映します。モード・記録とUndo／Redoは親ノートで共有し、セル再生成で新たな履歴を作りません。Obsidian内部table APIへのアクセスはネイティブadapterへ隔離します。

入力はIME、専用入力UI、補完候補、現在の編集モードの順に担当を決めます。Normal／Visual／operator待ちは対応するVim操作を優先し、InsertはObsidianの通常入力・リスト継続・貼り付けを維持します。Replaceの入力は置換処理を使います。未対応キーをホストの通常編集へ流さず、登録済みのアプリショートカットだけに委譲します。委譲前には未完のoperator・カウント・レジスタを解除します。

本文用ScopeとDOM入力は共通の入口を使い、一つのイベントを一度だけ判定・実行します。IME中のキーや検索欄・モーダルには本文のキー処理を適用しません。候補表示中のEscは候補だけを閉じ、その次のEscでモードを解除します。`Ctrl-[`も編集面で同じ取消規則です。NormalのEscは本文・セルから退出しません。

`src/input/policy.ts`の対応一覧にモード遷移とoperator情報をまとめ、engineの候補選択、割り当て検証、テストの基準にします。部分一致・完全一致の両方を制限し、非対応操作を間接再生からも実行しません。文字引数、Insert文字列、検索語、Ex入力はコマンドと区別します。不成立のキー列は待機を解除して終了し、接頭辞や後続文字をホストへ再送しません。非対応の割り当ては保存内容を保持して適用だけを停止します。

脱出候補は表示だけを先行し、成立時に本文や挿入記録へ混入させません。保留中のEscでは候補を本文へ一度確定してから脱出します。Insert中の実際のカーソル移動と内部更新を区別してUndoを区切ります。モード表示ではReplace、Visual各種、未完入力、マクロ記録を区別します。

## 単語境界と辞書の寿命

解析結果は変更しない原文に対するUTF-16範囲です。非空白runをLinderaの`tokenizeSurfaces()`へ渡し、surfaceと原文の完全一致を検査しながらUTF-16長を累積します。空白・改行、連続記号、ASCII英数字と`_`、書記素境界、WORD、operatorのカウントは共通層で扱います。正規化による原文変更や書記素内部への境界を作りません。

必要な行だけを解析し、単語と書記素のcacheはそれぞれ512行・262,144 UTF-16文字まで保持します。文字移動の`h/l`は形態素解析を呼びません。本文・セルとも同じ境界providerとテキストオブジェクトの規則を使います。

文移動の`(`/`)`と`is/as`は共通の文境界providerを使います。`japanese`が有効なら空白を挟まない`。！？`も境界にし、連続する文末記号と閉じ括弧を含めます。選択の端点は書記素内部へ置きません。段落移動は空行、`ip/ap`は空白だけの行も境界にします。

Linderaはプラグイン単位で非同期初期化し、`normal`と`decompose`のtokenizerで一つの辞書を共有します。初期化後の移動・選択は同期処理です。読込中・初期化失敗・解析失敗時はBudouXを使い、失敗通知は一度だけ行います。破棄中に初期化が完了した場合も資源を解放します。

辞書wrapperは`setDictionaryInstance()`へ所有権を渡した後に直接解放しません。builder、setterの戻り値のhandle、tokenizerをそれぞれの寿命に合わせて解放します。WASMと辞書は個別のデータとしてbundleに内包し、復元した辞書のバイト列を`loadDictionaryFromBytes()`へ渡します。

日本語設定・分割モードの変更や辞書読込完了時は境界providerだけを交換します。未完のoperator、カウント、レジスタ指定、マクロ記録・再生中は交換を延期し、選択範囲、Vimセッション、編集履歴を維持します。`linderaMode`の欠落・不正値は`normal`として読み込みます。

## 上流ソースとpatch

マークとジャンプリストは親エディタ・ノート識別子ごとのNavigationSessionで管理します。本文は親Markdownのoffset、セルはsource範囲とdecoded offsetを保持し、ネイティブviewの寿命に依存しません。セルのViewPluginで内部差分を先に追跡し、親へのセル全体同期で位置を二重に動かさないようにします。

表の表示・取得・フォーカス・座標照合はnative adapterへ閉じ込めます。非同期復帰中のマクロ・マッピングは共通continuationで待機し、内側の処理から再開します。失敗・取消・ノート切替・破棄では後続の再生を解除します。非同期処理の間は論理的な編集のUndoグループを保持します。

Exは`src/ex/parser.ts`で略称・範囲・引数・正規表現を検証し、`src/ex/session.ts`で現在の編集対象へ範囲を解決します。内部CommandPolicyの`allowsEx`で解析済みコマンドを検査してから、本文・選択・レジスタ・履歴を更新します。手入力、マッピング、マクロ、`@:`は同じproviderを使います。上流の未検証Ex dispatcherは利用しません。

置換は元文書に対する一致を先に確定し、範囲を越える一致と書記素の途中で始終する一致を除外します。確認待ちは共通continuationとUndo保持を使い、対象view・ノート・本文が変わった場合は中止します。完了処理は一度だけ実行し、取消後の古いダイアログ入力を無視します。記録したEx入力はキー列として保持し、Visual範囲・文字としての山括弧を再生時にも復元します。

[replit/codemirror-vim](https://github.com/replit/codemirror-vim)をサブモジュールとして固定します。サブモジュールのgitlinkと`patches/series.json`の`baseCommit`は同じcommitを指します。上流の出典とライセンスは[第三者ライセンス](../THIRD_PARTY_NOTICES.md)に記載します。

`scripts/prepare-vendor.mjs`はHEADの一致を確認し、固定commitのGit blobから`.generated/codemirror-vim`を再作成します。生成先に一時Gitリポジトリを作り、`patches`配列の順に`git apply --whitespace=error-all`で適用します。サブモジュール作業ツリーの変更・未追跡ファイルは生成物へ取り込みません。

`baseCommit`は40桁の小文字16進数、`sourceDirectory`はワークスペース内のパスです。各patchは`patches/`内の重複しない`file`、`purpose`、空でない`tests`配列を持ちます。基準commitの不一致、範囲外パス、適用失敗では停止します。`tests`は回帰条件の対応表であり、prepareがテストを実行するわけではありません。

patchには上流への汎用的な接続点を置き、Obsidian固有処理はプラグイン側へ置きます。patchを追加・更新する場合は、生成ソースの差分をUTF-8・BOMなし・LFのGit形式patchとして保存し、対応するテストをseriesへ登録してから再生成します。上流更新ではgitlinkと`baseCommit`を揃え、全patchを新しい基準で適用できる状態にします。

prepare・build・typecheck・testは同じ生成先を置き換えるため、並列実行しません。生成ソースを編集中なら先に差分を保存します。`pnpm dev`のpatch適用は起動時だけなので、patch・seriesの変更後は監視プロセスを再起動します。

## 依存関係の確認

`pnpm audit:dependencies`は`pnpm audit --json`で開発用を含むnpm依存の全重大度を報告します。High・Criticalがある場合、通信に失敗した場合、応答を解釈できない場合は失敗し、Moderate以下だけなら成功します。自動修復や一律の除外は行いません。依存の更新時と公開前に実行し、検出内容と更新の影響を確認してください。

npmの検査だけでは、GitサブモジュールのVim、独自patch、WASM内部の依存を網羅できません。更新時と公開前には[上流Vim](https://github.com/replit/codemirror-vim/security)と[Lindera](https://github.com/lindera/lindera/security)のセキュリティ情報・リリース変更を確認し、次の固定情報と照合します。

- Vimのgitlinkと`patches/series.json`の`baseCommit`を照合し、patchの適用と対応する回帰テストを確認する。
- `lindera-wasm`のバージョンとlockfileのintegrity、同梱WASMの出所を確認する。
- `scripts/lindera-assets.mjs`の辞書版・取得元・SHA-256を照合する。ハッシュだけを更新して検証エラーを解消せず、取得元と変更内容を確認する。

## 検証

`pnpm check`で本体・テスト・配布物を検査します。`typecheck`は上流ソースを準備した後、3回の`tsc`コマンドで上流JavaScriptの型宣言、`tsconfig.vendor.json`によるwrapperの型宣言、本体・テストの型検査を順に実行します。上流の型宣言生成は`--noCheck`、本体とテストはstrict設定を使います。整形・静的解析の対象外は各設定ファイルに定義し、上流ソース、patch本文、内容保持が必要なfixtureを一括整形しません。

`eslint-plugin-obsidianmd`の推奨設定は本体ソースとmanifest・package情報を対象とし、テスト・生成物・上流ソースを除外します。型情報を使うため、`pnpm lint:obsidian`は`pnpm typecheck`の後に実行します。Oxlintと併用し、警告も失敗として扱います。設定画面は`getSettingDefinitions()`で検索に対応し、日本語の表示、JSONの検証とエラー、保存・反映を実機でも確認します。

Vitestは`test/**/*.test.ts`の機能テストを実行します。`test/word/native-objects.json`はNeovimの動作に対応する固定期待値です。単体テストはこのfixtureを直接読み込み、Neovimを実行しません。設定の不正値回復、辞書失敗・破棄、provider交換、入力・履歴・セルの回帰テストとfixtureを維持します。

`test/input/operation-coverage.test.ts`は対応する操作をデータ駆動で実行し、本文とネイティブセルのDOMキー入力から、文書・カーソル・選択・モード・レジスタ・履歴を確認します。画面座標に依存する操作と実際のObsidian UI競合は実機suiteで確認します。engineのdispatcherを直接呼ぶ既存の詳細テストも維持しますが、それだけではホストとの入力競合の合格条件にはしません。

実機検証は`pnpm build`、`pnpm probe`で準備した独立Vaultで行います。`probe`と`test:e2e`は検証用の`lindvimera-test-harness`を別ビルドして導入します。専用profileとVaultは`.test-runtime/`内に作成し、インストール済みObsidianと1.13.7 archiveを使用します。別の配置先には`OBSIDIAN_EXECUTABLE`と`OBSIDIAN_ARCHIVE`を指定します。`node scripts/probe/run.mjs --prepare-only`はアプリを起動せず準備します。再実行は検証fixtureと設定を初期化します。

検証画面、入力診断、診断ファイルの書き込みと検証用CSSはharnessだけに含めます。本番には検証機能を登録せず、古い保存設定にある`probeEnabled`も無視します。harnessは本番インスタンスの読み取り専用`runtime`（契約バージョン`1`）からVim・セッション・単語・テーブル処理の同じ実装参照を使い、エンジンを再生成しません。契約が一致しなければ検証を失敗させます。この接続口は内部検証用で、安定した外部拡張APIではありません。esbuildの入力一覧で本番への検証コード混入と、harnessへの本体・Vimエンジンの再取り込みを検査します。

検証画面の各suiteで本文・セル編集、選択、記録再生、親Undo／Redo、ホットキー、モード切替を確認し、物理キー入力は別途確認します。実IME操作はこの検証の対象外です。`node scripts/probe/run.mjs --offline`はテストVaultのrendererでHTTP(S) fetch/XHRを失敗させ、同梱辞書での動作を検査するための模擬環境です。

`pnpm test:e2e`は現在の`dist/`を再ビルドせず新しい検証Vaultへ導入します。オフライン検証用プラグインを起動前から有効にし、harnessは無効・保存設定なしで通常起動を検証します。本番だけで検証コマンド・ビュー・診断ファイルが現れないこと、本文で`i → abcjj → Esc`を入力すると既定では`jj`が本文・挿入記録に残ることを確認してから、harnessを有効にして必須suiteを実行します。

Source・Live Preview・セルの入力競合、取消、ホストへの委譲、OS入力の代表ケース、本番とharnessのセッション・レジスタ共有を検証します。配布候補、導入直後、E2E終了後の標準3ファイルのSHA-256が一致することも確認します。必要な項目の欠落・失敗ではコマンドを失敗させます。実行結果と診断ファイルは`.test-runtime/results/`へ出力し、Gitへ追加しません。記録には入力や本文が含まれる場合があるため、独立Vaultだけで使い、共有前に内容を確認してください。

## GitHub Actionsとリリース

mainへのpushで`quality`、`unit`、`build`を独立したWindows 2025 runnerで実行します。`quality`は型検査の後に公式Lintを実行し、依存関係検査も行います。`e2e`はbuildのartifactをそのまま使用し、`release-ready`はすべての成功を必須にします。失敗・キャンセル・スキップはリリース可能と扱いません。Node.js 24、pnpm 12.4.2、固定版サブモジュールとlockfileを使用します。

Releaseの公開処理は`scripts/release/publish.ps1`で実行します。`quality`では`test/release/publish.test.ps1`も実行し、GitHub通信とGit操作をモック化してドラフト作成・再開・公開条件を検査します。ローカルでは`pwsh -NoProfile -File test/release/publish.test.ps1`で実行でき、実際のReleaseやタグは変更しません。

workflow全体はブランチ単位の共通concurrency groupで直列実行します。`cancel-in-progress: false`と`queue: max`により、実行中を中断せず最大100件を待機させます。GitHubの待機上限を超えた実行はキャンセルされます。リリースはタグ名にかかわらずreleaseブランチの共通groupを使用します。workflowとその子ジョブに同じgroupを重ねません。

pnpm storeのcacheはbuildだけが保存し、他ジョブは復元だけを行います。キーはブランチ、OS・architecture、Node・pnpm版、lockfileとworkspace設定のhashで分けます。IPADICの検証済み辞書ZIPはbuild、Obsidianの固定installer・archiveはe2eだけが保存します。cache miss時は通常のインストール・検証付き取得を行い、cacheがなくても検証できる構成です。`node_modules`、生成ソース、dist、Vault・profile・レポートはcacheしません。

自動E2Eはworkflow内でSHA-256固定の公式Obsidian 1.13.7を準備し、`pnpm test:e2e`で専用profileと新規Vaultを起動します。PlaywrightのCDP接続から既存suiteを実行し、OS入力はWindows `SendInput`で確認します。対話desktopや対象ウィンドウのフォーカスを取得できない場合は失敗します。本番プラグインには標準3ファイルだけを導入し、rendererのHTTP(S)通信を遮断してLinderaが初期化できることも検査します。実IMEや物理キーボード機器そのものの検証ではありません。`release-ready`はE2Eジョブの成功と配布ファイル・バージョン・source mapの有無を確認してパッケージ化します。

パッケージ作成後、`release-ready`で`actions/attest@v4`を使い、標準3ファイル・ZIP・`SHA256SUMS`・`provenance.json`の計6ファイルへGitHub Artifact Attestationを付与します。証明生成の書き込み権限は同ジョブだけに付与し、E2E済みの配布物を再ビルドしません。証明はGitHub側に保存し、Releaseの添付物は増やしません。

開発中の`release-ready`はバージョンが公開済みでも成功できます。実リリースは次の手順で行います。

1. mainへ開発コミットをpushし、CIの`release-ready`成功を確認します。
2. `package.json`・`manifest.json`の`version`を同じ`x.y.z`へ更新し、`versions.json`へ`"x.y.z": "minAppVersion"`を追加します。mainにコミットしてpushし、そのコミットのCI全成功を確認します。
3. `git fetch origin`後、releaseへ切り替え、`git merge --ff-only <CI成功済みSHA>`、`git push origin release`を実行します。mainがさらに進んでいても、確認済みSHAを指定します。初回は`git switch -c release <CI成功済みSHA>`で作成します。作業ツリーに未コミット変更がある場合は先に保存します。
4. `git tag -a x.y.z <CI成功済みSHA> -m x.y.z`、`git push origin refs/tags/x.y.z`を実行します。タグには`v`を付けません。

タグworkflowは対象SHAがreleaseの履歴内にあることと、同じSHAの最新main push CI・全5ジョブの成功を確認します。CIの公開artifactをそのまま取得し、run ID・attempt・バージョン・全ファイルのhashを照合します。検証ジョブと公開処理の両方で、全6ファイルのAttestationを`gh attestation verify`によりリポジトリ・CI workflow・main参照・対象コミットへ照合します。証明の欠落・不一致・通信失敗ではdraft作成・アップロード・公開を開始しません。公開直前にもタグを再確認し、draftへ全assetを揃えてからGitHub Releaseを公開します。添付物は標準3ファイル、ZIP、`SHA256SUMS`、検証元を記録した`provenance.json`です。公式レジストリへの申請やnpm公開は行いません。

artifactとE2E診断ファイルは90日間保持します。公開artifactの欠落・失効・CI失敗・provenance不一致の場合は公開しません。復旧時は同じコミットのmain CIで **Re-run all jobs** を実行し、全成功後にrelease workflowも全ジョブ再実行して新しいCIの出所を検証します。main CIの失敗ジョブだけの再実行ではattemptが揃わないため公開判定は通りません。公開前の通信障害で同じ検証済みartifactを使用する場合は、release workflowの失敗ジョブだけを再実行でき、同一内容のdraftを再開します。ジョブ間の検証済みartifactは7日間保持するため、失効後はrelease workflowの全ジョブを再実行します。公開済みReleaseと内容・出所が一致すれば何も変更せず成功し、違う場合は上書きしません。既に公開したバージョンの差し替えは新しいバージョンで行います。

将来Obsidianの公式ディレクトリへ登録するときは、公開済みmanifestを参照させるためGitHubのデフォルトブランチをreleaseに設定します。開発先はmainのままです。ブランチ・タグの強制更新を禁止するリポジトリルールも設定してください。
