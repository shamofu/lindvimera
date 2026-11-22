# Lindvimeraへの貢献

不具合報告、文書の修正、テストや実装の改善を歓迎します。対応操作と利用環境は[README](README.md)、実装の境界と詳しい手順は[開発仕様](docs/development.md)を参照してください。

## 不具合を報告する

GitHub Issuesで既存の報告を確認し、次の情報を添えてください。

- Windows・Obsidian・Lindvimeraのバージョン、Source／Live Previewの別、本文／テーブルセルの別、選択エンジンとホストVim設定。
- 最小限の再現用Markdown、操作前のカーソル位置、モード、入力したキー列、期待する結果と実際の結果。
- 関係する設定と、他のプラグインを無効にした独立Vaultでも再現するか。

実際のVault全体や個人情報を含むノートは添付せず、内容を置き換えた小さな再現例を使ってください。診断ファイルにも本文や入力が含まれることがあるため、共有する前に内容を確認してください。

## 開発環境と確認

Git、Node.js 24系（24.15.0以上）、pnpm **12.10.1**を用意し、リポジトリのルートで実行します。依存関係と初回ビルドの辞書取得にはネットワークが必要です。

```powershell
git submodule update --init --recursive
pnpm install --frozen-lockfile
pnpm check
pnpm audit:dependencies
```

`pnpm check`はOxlint、整形確認、型検査、Obsidian公式Lint、単体テスト、ビルドを実行します。公式Lintだけを実行するときも、先に`pnpm typecheck`で上流の型宣言を生成してください。入力やObsidianとの連携を変更した場合は、Windows・Obsidian 1.15.0以降で`pnpm test:e2e`も実行します。内蔵エンジンは`node scripts/probe/builtin-ci.mjs`で実際のネイティブVimとadapterを確認します。手動確認には`pnpm probe`を使います。これらは専用Vaultとprofileを使い、生成物や診断結果はコミットしません。

エンジン境界を変更した場合は`pnpm test:engines`と`pnpm verify:engines`で、片方のソースとテストを物理的に除いた環境も確認します。依存関係を新規インストールして検証するときは`pnpm verify:engines --install`を使い、通常のコピー済み依存環境とは区別して報告します。詳しくは[エンジンの削除手順](docs/engine-removal.md)を参照してください。

prepare・build・typecheck・testは同じ上流生成先を使うため、並列実行しないでください。実機環境の指定やsuiteの範囲は[検証手順](docs/development.md#検証)に記載しています。

## 変更とPull Request

変更理由、利用者から見た動作、実行した検証と未確認の範囲をPRに記載してください。不具合の修正や動作の変更には、その条件を確認できるテストを追加します。UI・入力の変更は独立Vaultで再現手順を確認してください。

GitHub Releaseの本文は英語に統一します。コミット件名は原文のままRelease本文に掲載されるため、英語で記述してください。

上流Vimの修正はサブモジュールや生成先だけの変更で終えず、[上流ソースとpatch](docs/development.md#上流ソースとpatch)の手順でpatchと`patches/series.json`へ記録し、回帰テストを対応付けてください。上流の汎用拡張点とObsidian固有処理の境界を維持します。依存更新では[依存関係の確認](docs/development.md#依存関係の確認)も行います。

バージョン更新と公開は[リリース手順](docs/development.md#github-actionsとリリース)に従って別途行います。PRでは通常、配布物やバージョンを更新しません。
